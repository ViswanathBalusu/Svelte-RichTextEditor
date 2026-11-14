// Named versions over real HTTP, with in-memory storage and with PostgreSQL (PRO-054 criteria 2, 3
// and 4; HIS-006; HIS-007 criterion 5; 05 section 6.2; 08 section 4; lane U-PRO-052-068). Test values
// only. The versions are the `versions` table of migration 0050 in the PostgreSQL run.
//
// Not claimed here: the history filters and grouped history of `GET /documents/{id}/history` (PRO-054
// criterion 1 needs `@docedit/history`, which `services/document-service` does not depend on yet), and
// a creation below the history gate by a caller with `edit` (under the default `editors` setting such
// a caller sees full history, so no gate refusal can be reached over HTTP; the store refuses it).
import { randomUUID } from 'node:crypto';
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

/** Appends one text commit per entry of `texts`, as an editor's steps would (as routes.exports-gate). */
async function append(h: Harness, doc: string, user: string, texts: string[]): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'test-node');
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
    session: 'session-test',
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
  describe(`named versions over HTTP (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A document with a head of 2 (two commits by alice). */
    async function twoCommitDocument(): Promise<string> {
      const doc = await h.createDocument({ content: documentWithRegions() });
      await append(h, doc, 'u-alice', ['a', 'b']);
      return doc;
    }

    const versions = (doc: string) => `/v1/documents/${doc}/versions`;

    it.skipIf(skip)(
      'names the head by default and a seq given, with name and note, and sends version.created once (PRO-054 criterion 2)',
      async () => {
        const doc = await twoCommitDocument();
        const editor = h.userToken({ [doc]: 'editor' });
        const before = h.events.of('dep.version.created.v1').length;

        const atHead = await h.call('POST', versions(doc), {
          token: editor,
          body: { name: 'Sent to legal', note: 'after the second review' },
        });
        expect(atHead.status, atHead.text).toBe(201);
        expect(atHead.json).toEqual({
          seq: 2,
          kind: 'named',
          name: 'Sent to legal',
          note: 'after the second review',
        });
        expect(h.events.of('dep.version.created.v1').length).toBe(before + 1);
        const notice = h.stub.notices.find(
          (n) => n.kind === 'notify' && n.notification?.type === 'version.created',
        );
        expect(notice?.notification?.resource).toBe(`/documents/${doc}/versions`);

        const atSeq = await h.call('POST', versions(doc), {
          token: editor,
          body: { seq: 1, name: 'First draft' },
        });
        expect(atSeq.status, atSeq.text).toBe(201);
        expect(atSeq.json).toEqual({ seq: 1, kind: 'named', name: 'First draft' });
        expect(h.events.of('dep.version.created.v1').length).toBe(before + 2);

        // A caller with `view` only holds no `edit` somewhere: refused, nothing stored.
        const viewer = await h.call('POST', versions(doc), {
          token: h.userToken({ [doc]: 'viewer' }),
          body: { name: 'Not mine' },
        });
        expect(viewer.status).toBe(403);
        expect(viewer.json.code).toBe('forbidden');

        // A seq above the head is refused as a validation failure (criterion 5, above-head branch).
        const above = await h.call('POST', versions(doc), {
          token: editor,
          body: { seq: 3, name: 'Too far' },
        });
        expect(above.json.code).toBe('validation_failed');
        expect(above.status).toBeGreaterThanOrEqual(400);
      },
    );

    it.skipIf(skip)(
      'lists named versions as a cursor list, oldest seq first, and a viewer sees only versions at or above its gate (PRO-054 criterion 3)',
      async () => {
        const doc = await twoCommitDocument();
        const editor = h.userToken({ [doc]: 'editor' });
        for (const seq of [1, 2]) {
          const made = await h.call('POST', versions(doc), {
            token: editor,
            body: { seq, name: `Version ${seq}` },
          });
          expect(made.status).toBe(201);
        }

        // An owner's gate is the whole history (editors see it too): both versions, in seq order.
        const owner = await h.call('GET', versions(doc), {
          token: h.userToken({ [doc]: 'owner' }),
        });
        expect(owner.status).toBe(200);
        expect(owner.json.items.map((v: { seq: number }) => v.seq)).toEqual([1, 2]);
        expect(owner.json.nextCursor).toBeNull();

        // A cursor list: one item a page, and the cursor continues it.
        const first = await h.call('GET', `${versions(doc)}?limit=1`, {
          token: h.userToken({ [doc]: 'owner' }),
        });
        expect(first.json.items).toHaveLength(1);
        expect(first.json.items[0].seq).toBe(1);
        expect(typeof first.json.nextCursor).toBe('string');
        const second = await h.call(
          'GET',
          `${versions(doc)}?limit=1&cursor=${encodeURIComponent(first.json.nextCursor)}`,
          { token: h.userToken({ [doc]: 'owner' }) },
        );
        expect(second.json.items.map((v: { seq: number }) => v.seq)).toEqual([2]);
        expect(second.json.nextCursor).toBeNull();

        // A viewer's gate is the head (ADR 0034): the version at seq 1 is not listed for them.
        const viewer = await h.call('GET', versions(doc), {
          token: h.userToken({ [doc]: 'viewer' }),
        });
        expect(viewer.status).toBe(200);
        expect(viewer.json.items.map((v: { seq: number }) => v.seq)).toEqual([2]);
      },
    );

    it.skipIf(skip)(
      'creates one version for a repeated POST with the same Idempotency-Key (PRO-054 criterion 4)',
      async () => {
        const doc = await twoCommitDocument();
        const editor = h.userToken({ [doc]: 'editor' });
        const key = randomUUID();
        const send = (k: string) =>
          h.call('POST', versions(doc), {
            token: editor,
            headers: { 'Idempotency-Key': k },
            body: { name: 'Once only' },
          });
        const first = await send(key);
        const second = await send(key);
        expect(first.status).toBe(201);
        expect(second.status).toBe(201);
        expect(second.headers.get('dep-idempotent-replayed')).toBe('true');
        expect(second.json).toEqual(first.json);

        const listed = await h.call('GET', versions(doc), {
          token: h.userToken({ [doc]: 'owner' }),
        });
        expect(listed.json.items).toHaveLength(1);

        // A different key for the same seq and kind returns the stored version (HIS-007 criterion 5).
        const other = await send(randomUUID());
        expect(other.status).toBe(200);
        expect(other.json.seq).toBe(first.json.seq);
        const again = await h.call('GET', versions(doc), {
          token: h.userToken({ [doc]: 'owner' }),
        });
        expect(again.json.items).toHaveLength(1);
      },
    );
  });
}
