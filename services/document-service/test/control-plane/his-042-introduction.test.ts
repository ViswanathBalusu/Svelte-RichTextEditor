// HIS-042 criteria 2 and 4 in the service: `GET /documents/{id}/suggestions/{sid}/introduction`
// answers the commit that introduced a suggestion from the index that the log store writes as each
// commit is stored, with the server time of that commit (not a time carried by the mark), under the
// history gate. The lowest `seq` wins when an identifier is claimed again. The answer does not need
// the payload (a thinned commit still answers), which a scan of the log could not do. A document
// stored before the index existed is filled by the backfill (owner decision 86). PostgreSQL:
// pwsh -NoProfile -File infra/test-env.ps1 up (FND-010); those cases skip without it.
import { type StoredCommit } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PgSuggestionIndexStore,
  backfillSuggestionIntroductions,
} from '../../src/storage/suggestion-index.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { objectKeys } from '../../src/objects/store.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const INTRO = 'pIntro0000000001';
const S1 = 'sgOne00000000001';
const S2 = 'sgTwo00000000001';
const STEP_MS = 10_000;

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

/** The test document with a suggested insertion `id` on the first paragraph's text. */
function withSuggestion(id: string) {
  const content = documentWithRegions();
  const walk = (n: {
    type?: string;
    attrs?: Record<string, unknown>;
    content?: unknown[];
    marks?: unknown[];
  }): boolean => {
    if (n.type === 'paragraph' && n.attrs?.['id'] === INTRO) {
      for (const c of (n.content ?? []) as Array<{ type?: string; marks?: unknown[] }>)
        if (c.type === 'text') c.marks = [{ type: 'ins', attrs: { id, user: 'u-suggester' } }];
      return true;
    }
    return (n.content ?? []).some((c) => walk(c as never));
  };
  walk((content as { doc: never }).doc);
  return content;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`the commit that introduced a suggestion (HIS-042, ${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const settings = new Map<string, string>();

    async function appendOne(
      doc: string,
      text: string,
      claimed: string[],
      origin = 'input',
    ): Promise<number> {
      const ref: DocRef = { tenant: h.tenant, doc };
      const epoch = await h.parts.ownership.claim(ref, 'his-042-node');
      const head = await h.parts.logs.head(ref);
      const perms = await h.parts.grants.current(ref);
      const pos = inside(documentWithRegions()['doc'], INTRO);
      const time = h.now();
      const commit: StoredCommit = {
        seq: head.seq + 1,
        id: uuid7(),
        kind: 'steps',
        steps: [
          { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
        ] as StoredCommit['steps'],
        user: 'u-test',
        session: 'session-test',
        time,
        origin,
        scopes: ['body'],
        revision: perms.revision,
        cdm: 1,
        engine: 'pm-steps/1',
        retired: [],
        claimed,
      };
      const r = await h.parts.logs.append(ref, {
        epoch,
        revision: perms.revision,
        fromSeq: head.seq + 1,
        commits: [commit],
      });
      expect(r.status).toBe('ok');
      return time;
    }

    /** Four commits: S1 claimed at 2 and again at 4, S2 claimed at 3 (by an accept, to show the origin). */
    async function makeDoc(setting: 'all' | 'editors', content = documentWithRegions()) {
      const doc = await h.createDocument({ content, title: 'Suggestions' });
      if (h.db)
        await h.db.admin.query(`UPDATE documents SET history_visibility = $2 WHERE id = $1`, [
          doc,
          setting,
        ]);
      else settings.set(doc, setting);
      const times: number[] = [];
      for (const [i, claimed] of [[], [S1], [S2], [S1]].entries()) {
        h.advance(STEP_MS);
        times.push(
          await appendOne(
            doc,
            `c${i + 1}`,
            claimed as string[],
            i === 2 ? 'suggestion.accept' : 'input',
          ),
        );
      }
      return { doc, times };
    }
    const get = (doc: string, token: string, sid: string) =>
      h.call('GET', `/v1/documents/${doc}/suggestions/${sid}/introduction`, { token });

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { realDataPlane: true });
      if (!h.db) {
        const store = h.parts.documents;
        const original = store.get.bind(store);
        store.get = async (ref) => {
          const r = await original(ref);
          const setting = settings.get(ref.doc);
          return r && setting ? { ...r, historyVisibility: setting } : r;
        };
      }
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip !== null)(
      'answers the lowest seq of the identifier, with the server time, user and origin of that commit',
      async () => {
        const { doc, times } = await makeDoc('all');
        const token = h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' });
        const one = await get(doc, token, S1);
        expect(one.status, one.text).toBe(200);
        // S1 was claimed at seq 2 and again at seq 4: the first commit introduced it.
        expect(one.json).toMatchObject({
          suggestion: S1,
          seq: 2,
          time: new Date(times[1]!).toISOString().replace(/\.\d+Z$/, (m) => m),
          origin: 'input',
        });
        expect(typeof one.json.user).toBe('string');
        const two = await get(doc, token, S2);
        expect(two.json).toMatchObject({ seq: 3, origin: 'suggestion.accept' });
        // An identifier that no commit introduced is not found.
        expect((await get(doc, token, 'sgNone0000000001')).status).toBe(404);
        // A service credential asks as well.
        expect((await get(doc, h.apiKey, S1)).status).toBe(200);
      },
    );

    it.skipIf(skip !== null)(
      'refuses a suggestion that is not in the document when its commit is below the gate, and answers one that is',
      async () => {
        const plain = await makeDoc('editors');
        const viewer = h.userToken({ [plain.doc]: 'viewer' }, { sub: 'u-viewer' });
        // Gate = head 4: seq 2 is below it, and the document holds no mark with that identifier.
        const refused = await get(plain.doc, viewer, S1);
        expect(refused.status, refused.text).toBe(403);
        expect(refused.json.code).toBe('forbidden');
        // An editor sees full history.
        const editor = h.userToken({ [plain.doc]: 'editor' }, { sub: 'u-editor' });
        expect((await get(plain.doc, editor, S1)).status).toBe(200);

        // The same identifier as a mark in the document the viewer reads: its date is part of what they
        // read, so it is answered, without the seq that lies below the gate.
        const marked = await makeDoc('editors', withSuggestion(S1));
        const viewer2 = h.userToken({ [marked.doc]: 'viewer' }, { sub: 'u-viewer' });
        const shown = await get(marked.doc, viewer2, S1);
        expect(shown.status, shown.text).toBe(200);
        expect(shown.json.seq).toBeUndefined();
        expect(typeof shown.json.time).toBe('string');
        // S2 is not a mark of that document, so it stays refused.
        expect((await get(marked.doc, viewer2, S2)).status).toBe(403);
      },
    );

    it.skipIf(skip !== null)(
      'answers although the payload of the introducing commit is gone, so the index is not a scan of the log',
      async () => {
        if (!h.db) return;
        const { doc } = await makeDoc('all');
        // A checkpoint at the head, so that the head still rebuilds once the older payloads go, as
        // after the payload thinning of HIS-032 (a room replays only what follows the newest one).
        const at = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey })).json;
        await new ObjectCheckpointStore(h.parts.objects).put({ tenant: h.tenant, doc }, 4, {
          cdm: at.cdm,
          requires: at.requires,
          doc: at.doc,
        });
        await h.parts.checkpointIndex!.record(
          { tenant: h.tenant, doc },
          {
            seq: 4,
            key: objectKeys.checkpoint(h.tenant, doc, 4),
            bytes: 1,
            hash: '00'.repeat(32),
          },
        );
        await h.db.admin.query('DELETE FROM doc_commit_payloads WHERE doc_id = $1 AND seq < 4', [
          doc,
        ]);
        const token = h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' });
        const r = await get(doc, token, S1);
        expect(r.status, r.text).toBe(200);
        expect(r.json).toMatchObject({ seq: 2 });
      },
    );

    it.skipIf(skip !== null)(
      'fills the index of a document stored before it, by the backfill, and says what it could not read',
      async () => {
        if (!h.db) return;
        const { doc } = await makeDoc('all');
        const ref: DocRef = { tenant: h.tenant, doc };
        const rows = () =>
          h.db!.admin.query<{ suggestion_id: string; seq: string }>(
            'SELECT suggestion_id, seq FROM suggestion_introductions WHERE doc_id = $1 ORDER BY suggestion_id',
            [doc],
          );
        expect((await rows()).rows.map((r) => [r.suggestion_id, Number(r.seq)])).toEqual([
          [S1, 2],
          [S2, 3],
        ]);
        // A document from before the index: no rows.
        await h.db.admin.query('DELETE FROM suggestion_introductions WHERE doc_id = $1', [doc]);
        const token = h.userToken({ [doc]: 'viewer' }, { sub: 'u-viewer' });
        expect((await get(doc, token, S1)).status).toBe(404);
        const store = new PgSuggestionIndexStore(h.db.service);
        const done = await backfillSuggestionIntroductions(h.parts.logs, store, ref, 2);
        expect(done).toEqual({ scanned: 4, recorded: 2, absent: 0 });
        expect((await rows()).rows.map((r) => [r.suggestion_id, Number(r.seq)])).toEqual([
          [S1, 2],
          [S2, 3],
        ]);
        expect((await get(doc, token, S1)).status).toBe(200);
        // Running it again changes nothing; a commit whose payload is gone is counted.
        await h.db.admin.query('DELETE FROM doc_commit_payloads WHERE doc_id = $1 AND seq = 3', [
          doc,
        ]);
        await h.db.admin.query('DELETE FROM suggestion_introductions WHERE doc_id = $1', [doc]);
        const again = await backfillSuggestionIntroductions(h.parts.logs, store, ref, 2);
        expect(again).toEqual({ scanned: 3, recorded: 1, absent: 1 });
        expect((await rows()).rows.map((r) => [r.suggestion_id, Number(r.seq)])).toEqual([[S1, 2]]);
      },
    );
  });
}
