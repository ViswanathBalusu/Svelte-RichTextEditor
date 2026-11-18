// HIS-040 (lane w7, 2026-11-17): replacing one commit's payload with a tombstone, through the service
// on PostgreSQL. The route is `POST /documents/{id}/commits/{seq}/tombstone`; its rows are written
// by `PgTombstoneStore` over a pool whose connections `SET ROLE docedit_purge` (migrations 0073 and
// 0074), so the test also shows that the role's grants are enough.
//
// Criteria covered: 1 (the metadata row, the payload hash and the chain stay), 2 (a read, a
// comparison or a rebuild that needs the payload fails cleanly with a message that the detail was
// removed, and the history list still works), 3 (a service credential, refused under a legal hold,
// audited with the actor and the reason) and 4 (the answer reports the copies that remain).
// The database is made for this file and dropped afterwards. Test values only.
import { createHash } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgTombstoneStore } from '../../src/control-plane/commit-tombstone-pg.ts';
import type { TombstoneStore } from '../../src/control-plane/commit-tombstone.ts';
import { ObjectCheckpointStore } from '../../src/objects/checkpoints.ts';
import { objectKeys } from '../../src/objects/store.ts';
import type { PgLogStore } from '../../src/storage/log-store.ts';
import type { DocRef } from '../../src/storage/types.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';
import { ADMIN } from '../support/env.ts';

const skip = await skipReason('postgres');
if (skip) console.warn(`skipped: ${skip}`);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const LETTERS = ['A', 'B', 'C', 'D'];

describe.skipIf(skip !== null)('tombstoning a commit payload (HIS-040, PostgreSQL)', () => {
  let h: Harness;
  let purgePool: pg.Pool;
  // The store needs a pool that exists only once the harness has made its database.
  let inner: TombstoneStore | null = null;
  const lazy: TombstoneStore = {
    state: (...a) => inner!.state(...a),
    remove: (...a) => inner!.remove(...a),
  };
  let doc: string;
  let other: string;
  let textBefore = '';

  beforeAll(async () => {
    h = await startHarness('postgres', { parts: { tombstoneStore: lazy } });
    purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 3 });
    purgePool.on('error', () => {});
    purgePool.on('connect', (c) => {
      void c.query('SET ROLE docedit_purge');
    });
    inner = new PgTombstoneStore(purgePool);
  }, 60_000);
  afterAll(async () => {
    await purgePool?.end();
    await h?.close();
  });

  const ref = (d: string): DocRef => ({ tenant: h.tenant, doc: d });

  /** A document with `n` typing commits (the letters A, B, C, D at the start of the first block). */
  async function documentWithCommits(title: string, n: number): Promise<string> {
    const d = await h.createDocument({ content: documentWithRegions(), title });
    const root = cdmSchema().nodeFromJSON(
      (await h.call('GET', `/v1/documents/${d}/content`, { token: h.apiKey })).json.doc,
    );
    let pos = -1;
    root.descendants((node, p) => {
      if (pos < 0 && node.isTextblock) pos = p + 1;
      return pos < 0;
    });
    const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    const r = ref(d);
    const epoch = await h.parts.ownership.claim(r, 'test-node');
    for (let i = 0; i < n; i++) {
      const head = await h.parts.logs.head(r);
      const perms = await h.parts.grants.current(r);
      const res = await h.parts.logs.append(r, {
        epoch,
        revision: perms.revision,
        fromSeq: head.seq + 1,
        commits: [
          {
            seq: head.seq + 1,
            id: uuid7(),
            kind: 'steps' as const,
            steps: [
              {
                stepType: 'replace',
                from: pos,
                to: pos,
                slice: { content: [{ type: 'text', text: LETTERS[i]! }] },
              },
            ] as never,
            user: bob,
            session: 's',
            time: h.now(),
            origin: 'input',
            scopes: ['body'],
            revision: perms.revision,
            cdm: 1,
            engine: 'pm-steps/1',
            retired: [],
            claimed: [],
          },
        ],
      });
      if (res.status !== 'ok') throw new Error(`append refused: ${res.status}`);
    }
    return d;
  }

  const tombstone = (d: string, seq: number | string, body: unknown, token?: string) =>
    h.call('POST', `/v1/documents/${d}/commits/${seq}/tombstone`, {
      token: token ?? h.apiKey,
      body,
    });

  async function rowsOf(d: string): Promise<string> {
    const r = await h.db!.admin.query<{ t: string }>(
      'SELECT to_jsonb(c)::text AS t FROM doc_commits c WHERE doc_id = $1 ORDER BY seq',
      [d],
    );
    return r.rows.map((x) => x.t).join('\n');
  }

  it('refuses what it must, and changes nothing', async () => {
    doc = await documentWithCommits('Tombstone', 4);
    other = await documentWithCommits('Held', 3);
    // A checkpoint covers seq 1 to 3 of the document, and a cold segment covers seq 1 to 2.
    const at3 = (await h.call('GET', `/v1/documents/${doc}/content?seq=3`, { token: h.apiKey }))
      .json;
    await new ObjectCheckpointStore(h.parts.objects).put(ref(doc), 3, {
      cdm: at3.cdm,
      requires: at3.requires,
      doc: at3.doc,
    });
    await h.parts.checkpointIndex!.record(ref(doc), {
      seq: 3,
      key: objectKeys.checkpoint(h.tenant, doc, 3),
      bytes: 1,
      hash: sha('cp'),
    });
    await h.parts.checkpointIndex!.record(ref(other), {
      seq: 3,
      key: objectKeys.checkpoint(h.tenant, other, 3),
      bytes: 1,
      hash: sha('cp'),
    });
    await h.parts.objects.put(
      objectKeys.segment(h.tenant, doc, 1, 2),
      new TextEncoder().encode('s'),
    );
    const before = await rowsOf(doc);

    const user = h.userToken({ [doc]: 'owner' }, { sub: 'olga' });
    expect((await tombstone(doc, 2, { reason: 'Personal data' }, user)).status).toBe(403);
    for (const body of [{}, { reason: '' }, { reason: 7 }, { reason: 'x', extra: 1 }])
      expect((await tombstone(doc, 2, body)).status, JSON.stringify(body)).toBe(400);
    expect((await tombstone(doc, 'two', { reason: 'r' })).status).toBe(400);
    expect((await tombstone(doc, 9, { reason: 'r' })).status).toBe(404);
    expect(
      (await tombstone('0190c9d8-0000-7000-8000-000000000000', 1, { reason: 'r' })).status,
    ).toBe(404);
    // Seq 4 is above the newest checkpoint: a room would need its payload to load.
    const above = await tombstone(doc, 4, { reason: 'r' });
    expect(above.status, above.text).toBe(409);
    // A document under a legal hold is refused (criterion 3).
    expect(
      (
        await h.call('POST', `/v1/documents/${other}/holds`, {
          token: h.apiKey,
          body: { reason: 'Matter 2026-41' },
        })
      ).status,
    ).toBe(201);
    const held = await tombstone(other, 1, { reason: 'Personal data' });
    expect(held.status, held.text).toBe(409);
    expect(held.json.detail).toContain('legal hold');

    expect(await rowsOf(doc)).toBe(before);
    const none = await h.db!.admin.query('SELECT 1 FROM commit_tombstones');
    expect(none.rowCount).toBe(0);
    expect(
      (await h.parts.audit!.query(h.tenant, { kind: 'commit.tombstoned', limit: 10 })).length,
    ).toBe(0);
  }, 60_000);

  it('removes the payload, keeps the metadata and the chain, reports the copies and audits it (criteria 1, 3 and 4)', async () => {
    const logs = h.parts.logs as PgLogStore;
    textBefore = (await h.call('GET', `/v1/documents/${doc}/content?seq=1`, { token: h.apiKey }))
      .text;
    const before = await rowsOf(doc);
    const verdictBefore = await logs.verify(ref(doc));
    expect(verdictBefore).toMatchObject({ ok: true });
    const hashBefore = await h.db!.admin.query<{ payload_hash: Buffer }>(
      'SELECT payload_hash FROM doc_commits WHERE doc_id = $1 AND seq = 2',
      [doc],
    );

    const r = await tombstone(doc, 2, { reason: '  Personal data in the text  ' });
    expect(r.status, r.text).toBe(200);
    expect(r.json.seq).toBe(2);
    expect(r.json.copies).toMatchObject({
      checkpoints: [3],
      coldSegments: [objectKeys.segment(h.tenant, doc, 1, 2)],
      attributionMap: 'may-hold-runs',
    });
    expect(r.json.copies.involves).toContain('rebuild or remove each listed checkpoint');

    // Criterion 1: the metadata row and the payload hash are as they were, and the chain verifies.
    expect(await rowsOf(doc)).toBe(before);
    const hashAfter = await h.db!.admin.query<{ payload_hash: Buffer }>(
      'SELECT payload_hash FROM doc_commits WHERE doc_id = $1 AND seq = 2',
      [doc],
    );
    expect(hashAfter.rows[0]!.payload_hash.equals(hashBefore.rows[0]!.payload_hash)).toBe(true);
    expect(await logs.verify(ref(doc))).toEqual(verdictBefore);
    // The payload row is gone and the others are not; one tombstone row says who and why.
    const left = await h.db!.admin.query<{ seq: string }>(
      'SELECT seq FROM doc_commit_payloads WHERE doc_id = $1 ORDER BY seq',
      [doc],
    );
    expect(left.rows.map((x) => Number(x.seq))).toEqual([1, 3, 4]);
    const stone = await h.db!.admin.query(
      'SELECT actor, reason FROM commit_tombstones WHERE doc_id = $1',
      [doc],
    );
    expect(stone.rows).toEqual([{ actor: 'system', reason: 'Personal data in the text' }]);

    // Criterion 3: audited with the actor and the reason, and the payload is nowhere in the event.
    const events = await h.parts.audit!.query(h.tenant, { kind: 'commit.tombstoned', limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      doc,
      actor: 'system',
      data: { seq: 2, reason: 'Personal data in the text' },
    });

    // A second tombstone of the same commit is refused.
    expect((await tombstone(doc, 2, { reason: 'again' })).status).toBe(409);
  }, 60_000);

  it('lists the history, and fails cleanly where the payload is needed (criterion 2)', async () => {
    const owner = h.userToken({ [doc]: 'editor' }, { sub: 'erin' });
    const get = (path: string) => h.call('GET', `/v1/documents/${doc}${path}`, { token: owner });

    // The list needs no payload: all four commits are still in it.
    const list = await get('/history');
    expect(list.status, list.text).toBe(200);
    const changes = (list.json.items as Array<{ changes?: number }>).reduce(
      (n, i) => n + (i.changes ?? 0),
      0,
    );
    expect(changes).toBe(4);

    // A state before the commit does not need it, and is the same as before. The head is rebuilt from
    // the checkpoint at 3, which holds the text (and is among the copies the answer reported).
    expect((await get('/content?seq=1')).text).toBe(textBefore);
    expect((await get('/content?seq=4')).status).toBe(200);

    // Everything that replays the commit says that the detail was removed, and returns no content.
    for (const path of [
      '/content?seq=2',
      '/diff?fromSeq=1&toSeq=4',
      '/diff?fromSeq=0&toSeq=3',
      '/attribution?seq=4',
      '/commits?after=0',
    ]) {
      const r = await get(path);
      expect(r.status, `${path}: ${r.text}`).toBe(404);
      expect(r.json.code, path).toBe('not_found');
      expect(r.json.detail, path).toMatch(/removed|no longer available/);
    }
  }, 60_000);

  it('gives the tombstone role no more than it needs', async () => {
    for (const s of [
      'UPDATE doc_commits SET size = 0',
      'UPDATE doc_commit_payloads SET seq = seq',
      'DELETE FROM audit_events',
    ]) {
      const c = await purgePool.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [h.tenant]);
        await expect(c.query(s), s).rejects.toThrow(/permission denied/);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    }
  });
});
