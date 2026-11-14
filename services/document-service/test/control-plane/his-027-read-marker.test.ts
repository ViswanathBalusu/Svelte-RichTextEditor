// PUT /documents/{id}/read-marker over HTTP, on memory and on PostgreSQL (HIS-027 criterion 1 and
// the forward-only half of criterion 2; 08 §10; 05 §6.2). The table read_markers (migration 0050)
// is inspected through the admin pool on PostgreSQL: one row per user and document. PostgreSQL:
// pwsh -NoProfile -File infra/test-env.ps1 up (FND-010). Each PostgreSQL harness has its own database.
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

/** Appends `count` text commits for `user`, so that the head moves to `count` (from 0). */
async function advance(h: Harness, doc: string, count: number): Promise<void> {
  const ref: DocRef = { tenant: h.tenant, doc };
  const epoch = await h.parts.ownership.claim(ref, 'his-027-test-node');
  const head = await h.parts.logs.head(ref);
  const perms = await h.parts.grants.current(ref);
  const pos = inside(documentWithRegions()['doc'], INTRO);
  const commits = Array.from({ length: count }, (_, i): StoredCommit => ({
    seq: head.seq + 1 + i,
    id: uuid7(),
    kind: 'steps',
    steps: [
      {
        stepType: 'replace',
        from: pos,
        to: pos,
        slice: { content: [{ type: 'text', text: `t${i}` }] },
      },
    ] as StoredCommit['steps'],
    user: 'system',
    session: 'session-his-027',
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
  const skip = await skipReason(storage);
  describe.skipIf(skip !== null)(`PUT /documents/{id}/read-marker (HIS-027, ${storage})`, () => {
    let h: Harness;

    beforeAll(async () => {
      h = await startHarness(storage, {});
    });
    afterAll(async () => {
      await h?.close();
    });

    /** A document with its head at 3, and the caller's token for `user`. */
    async function docAt3(): Promise<string> {
      const doc = await h.createDocument({ content: documentWithRegions(), title: 'HIS-027' });
      await advance(h, doc, 3);
      return doc;
    }

    const put = (doc: string, token: string, seq: unknown) =>
      h.call('PUT', `/v1/documents/${doc}/read-marker`, { token, body: { seq } });

    /** The rows of the read_markers table for a document (PostgreSQL only). */
    async function rows(doc: string): Promise<Array<{ user_id: string; seq: string }>> {
      const r = await h.db!.admin.query<{ user_id: string; seq: string }>(
        'select user_id, seq from read_markers where doc_id = $1 order by user_id',
        [doc],
      );
      return r.rows;
    }

    it('records the caller marker and reports it (criterion 1)', async () => {
      const doc = await docAt3();
      const alice = h.userToken({ [doc]: 'viewer' }, { sub: `alice-${uuid7()}` });
      const r = await put(doc, alice, 2);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ seq: 2 });
      if (storage === 'postgres') {
        const stored = await rows(doc);
        expect(stored.map((x) => Number(x.seq))).toEqual([2]);
      }
    });

    it('keeps a lower or equal seq from moving the marker (criterion 2, forward only)', async () => {
      const doc = await docAt3();
      const alice = h.userToken({ [doc]: 'viewer' }, { sub: `alice-${uuid7()}` });
      expect((await put(doc, alice, 2)).json).toEqual({ seq: 2 });
      expect((await put(doc, alice, 1)).json).toEqual({ seq: 2 });
      expect((await put(doc, alice, 2)).json).toEqual({ seq: 2 });
      expect((await put(doc, alice, 3)).json).toEqual({ seq: 3 });
      if (storage === 'postgres') {
        expect((await rows(doc)).map((x) => Number(x.seq))).toEqual([3]);
      }
    });

    it('keeps one marker per user and document (criterion 1)', async () => {
      const doc = await docAt3();
      const alice = h.userToken({ [doc]: 'viewer' }, { sub: `alice-${uuid7()}` });
      const bob = h.userToken({ [doc]: 'viewer' }, { sub: `bob-${uuid7()}` });
      expect((await put(doc, alice, 3)).json).toEqual({ seq: 3 });
      expect((await put(doc, bob, 1)).json).toEqual({ seq: 1 });
      if (storage === 'postgres') {
        const stored = await rows(doc);
        expect(stored.map((x) => Number(x.seq)).sort()).toEqual([1, 3]);
      }
      // Another document has no marker of this user's (the markers are per document).
      const other = await docAt3();
      const aliceOther = h.userToken({ [other]: 'viewer' }, { sub: `alice-${uuid7()}` });
      expect((await put(other, aliceOther, 0)).json).toEqual({ seq: 0 });
    });

    it('refuses a seq above the head as not_found', async () => {
      const doc = await docAt3();
      const alice = h.userToken({ [doc]: 'viewer' }, { sub: `alice-${uuid7()}` });
      const r = await put(doc, alice, 4);
      expect(r.status).toBe(404);
      expect(r.json.code ?? r.json.type ?? r.json.error ?? '').toMatch(/not_found/);
    });

    it('refuses a seq that is not a whole number of 0 or more', async () => {
      const doc = await docAt3();
      const alice = h.userToken({ [doc]: 'viewer' }, { sub: `alice-${uuid7()}` });
      expect((await put(doc, alice, -1)).status).toBe(400);
      expect((await put(doc, alice, 1.5)).status).toBe(400);
      expect((await put(doc, alice, 'two')).status).toBe(400);
    });

    it('refuses a service credential, because a marker belongs to a user', async () => {
      const doc = await docAt3();
      const r = await put(doc, h.apiKey, 1);
      expect(r.status).toBe(403);
    });

    it('refuses a user whose token does not cover the document', async () => {
      const doc = await docAt3();
      const stranger = h.userToken({}, { sub: `stranger-${uuid7()}` });
      // The host's token names no document, so the request is refused before the route runs.
      expect((await put(doc, stranger, 1)).status).toBe(401);
      expect((await put(doc, stranger, 1)).json).not.toEqual({ seq: 1 });
    });
  });
}
