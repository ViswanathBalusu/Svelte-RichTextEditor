// HIS-006 over HTTP (lane V-HIS-001-016, fix of group 3, round 3): `POST /v1/documents/{id}/versions`
// (`control-plane/versions-routes.ts`), with in-memory storage and with PostgreSQL
// (`docedit-test-postgres`, a database of its own that the harness drops). Test values only.
// Criteria: 1 (the stored row: kind named, the head or the seq given, name, note, creator and time),
// 2 (view, comment, suggest and fill refused with forbidden), 3 (a seq above the head, and a seq
// below the caller's gate), 4 (version.created and dep.version.created with the seq and the chain head).
import type { StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const INTRO = 'pIntro0000000001';

function inside(doc: unknown, id: string): number {
  let at = -1;
  cdmSchema()
    .nodeFromJSON(doc)
    .descendants((n, pos) => {
      if (n.attrs['id'] === id) at = pos + 1;
      return at < 0;
    });
  return at;
}

/** Appends one text commit per entry of `texts`, as an editor's steps would. */
async function append(h: Harness, doc: string, user: string, texts: string[]): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node-v-his-001-016');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const commits = texts.map((t, i): StoredCommit => ({
    seq: head.seq + 1 + i,
    id: uuid7(),
    kind: 'steps',
    steps: [
      { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text: t }] } },
    ] as StoredCommit['steps'],
    user,
    session: 'session-v-his-001-016',
    time: h.now(),
    origin: 'input',
    scopes: ['body'],
    revision: perms.revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
  }));
  const r = await h.parts.logs.append(ref, {
    epoch,
    revision: perms.revision,
    fromSeq: head.seq + 1,
    commits,
  });
  expect(r.status).toBe('ok');
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`HIS-006 name a version over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    async function twoCommitDocument(): Promise<string> {
      const doc = await h.createDocument({
        content: documentWithRegions(),
        title: 'V-HIS-001-016',
      });
      await append(h, doc, 'u-alice', ['a', 'b']);
      return doc;
    }
    const versions = (doc: string) => `/v1/documents/${doc}/versions`;

    it.skipIf(skip)(
      'stores a named version at the head with name, note, creator and time (criterion 1)',
      async () => {
        const doc = await twoCommitDocument();
        const ref: DocRef = { tenant: h.tenant, doc };
        const t0 = h.now();
        const r = await h.call('POST', versions(doc), {
          token: h.userToken({ [doc]: 'editor' }, { sub: 'v-his-001-016-editor' }),
          body: { name: 'Sent to legal', note: 'after review' },
        });
        expect(r.status, r.text).toBe(201);
        const t1 = h.now();
        const rows = await h.parts.versions!.list(ref, { kind: 'named' });
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row).toMatchObject({
          seq: 2,
          kind: 'named',
          name: 'Sent to legal',
          note: 'after review',
        });
        expect(typeof row.createdBy).toBe('string');
        expect(row.createdBy.length).toBeGreaterThan(0);
        expect(row.createdAt).toBeGreaterThanOrEqual(t0);
        expect(row.createdAt).toBeLessThanOrEqual(t1);

        // The seq given rather than the head.
        const atOne = await h.call('POST', versions(doc), {
          token: h.userToken({ [doc]: 'owner' }),
          body: { seq: 1, name: 'First draft' },
        });
        expect(atOne.status, atOne.text).toBe(201);
        expect((await h.parts.versions!.list(ref, { kind: 'named' })).map((v) => v.seq)).toEqual([
          1, 2,
        ]);
      },
    );

    it.skipIf(skip)(
      'refuses view, comment, suggest and fill with forbidden and stores nothing (criterion 2)',
      async () => {
        const doc = await twoCommitDocument();
        const ref: DocRef = { tenant: h.tenant, doc };
        for (const role of ['viewer', 'commenter', 'suggester', 'filler']) {
          const r = await h.call('POST', versions(doc), {
            token: h.userToken({ [doc]: role }),
            body: { name: `By a ${role}` },
          });
          expect(r.status, `${role}: ${r.text}`).toBe(403);
          expect(r.json.code).toBe('forbidden');
        }
        expect(await h.parts.versions!.list(ref, { kind: 'named' })).toEqual([]);
        // The control: an editor may.
        const ok = await h.call('POST', versions(doc), {
          token: h.userToken({ [doc]: 'editor' }),
          body: { name: 'By an editor' },
        });
        expect(ok.status).toBe(201);
      },
    );

    it.skipIf(skip)('refuses a seq above the head and stores nothing (criterion 3)', async () => {
      const doc = await twoCommitDocument();
      const ref: DocRef = { tenant: h.tenant, doc };
      const r = await h.call('POST', versions(doc), {
        token: h.userToken({ [doc]: 'editor' }),
        body: { seq: 3, name: 'Too far' },
      });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('validation_failed');
      expect(await h.parts.versions!.list(ref, { kind: 'named' })).toEqual([]);
    });

    it.skipIf(skip || storage !== 'postgres')(
      'refuses a seq below the caller gate with forbidden (criterion 3; since_access, PostgreSQL)',
      async () => {
        const doc = await twoCommitDocument();
        const ref: DocRef = { tenant: h.tenant, doc };
        // The setting has no route yet; it is set in storage. With `since_access` and no
        // `access_since` claim the caller's gate is the head (07 section 8).
        await h.db!.admin.query(
          `UPDATE documents SET history_visibility = 'since_access' WHERE id = $1`,
          [doc],
        );
        const editor = h.userToken({ [doc]: 'editor' });
        const below = await h.call('POST', versions(doc), {
          token: editor,
          body: { seq: 1, name: 'Hidden' },
        });
        expect(below.status, below.text).toBe(403);
        expect(below.json.code).toBe('forbidden');
        expect(await h.parts.versions!.list(ref, { kind: 'named' })).toEqual([]);
        // The control: the head is inside the gate.
        const atHead = await h.call('POST', versions(doc), {
          token: editor,
          body: { seq: 2, name: 'Head' },
        });
        expect(atHead.status, atHead.text).toBe(201);
      },
    );

    it.skipIf(skip)(
      'sends version.created and raises dep.version.created once, with the seq and the chain head (criterion 4)',
      async () => {
        const doc = await twoCommitDocument();
        const ref: DocRef = { tenant: h.tenant, doc };
        const state = await h.parts.logs.state!(ref);
        expect(state.seq).toBe(2);
        expect(state.chainHead).toMatch(/^[0-9a-f]{64}$/);
        const editor = h.userToken({ [doc]: 'editor' });
        const before = h.events
          .of('dep.version.created.v1')
          .filter((e) => e.subject === doc).length;

        const r = await h.call('POST', versions(doc), { token: editor, body: { name: 'At head' } });
        expect(r.status).toBe(201);
        const hooks = h.events.of('dep.version.created.v1').filter((e) => e.subject === doc);
        expect(hooks).toHaveLength(before + 1);
        expect(hooks.at(-1)!.data).toEqual({ seq: 2, chainHead: state.chainHead });
        const notices = h.stub.notices.filter(
          (n) =>
            n.kind === 'notify' && n.ref?.doc === doc && n.notification?.type === 'version.created',
        );
        expect(notices).toHaveLength(1);
        expect(notices[0]!.notification!.data).toEqual({ seq: 2, chainHead: state.chainHead });

        // The same seq and kind again: the stored version, and no second event.
        const again = await h.call('POST', versions(doc), {
          token: editor,
          body: { name: 'At head' },
        });
        expect(again.status).toBe(200);
        expect(h.events.of('dep.version.created.v1').filter((e) => e.subject === doc)).toHaveLength(
          before + 1,
        );

        if (storage === 'postgres') {
          // Below the head the chain head is the one of the state at that seq, not the head's.
          const r1 = await h.call('POST', versions(doc), {
            token: editor,
            body: { seq: 1, name: 'At one' },
          });
          expect(r1.status).toBe(201);
          const last = h.events
            .of('dep.version.created.v1')
            .filter((e) => e.subject === doc)
            .at(-1)!;
          const { rows } = await h.db!.admin.query<{ hash: Buffer }>(
            'SELECT hash FROM doc_commits WHERE doc_id = $1 AND seq = 1',
            [doc],
          );
          expect(last.data).toEqual({ seq: 1, chainHead: rows[0]!.hash.toString('hex') });
          expect(last.data['chainHead']).not.toBe(state.chainHead);
        }
      },
    );
  });
}
