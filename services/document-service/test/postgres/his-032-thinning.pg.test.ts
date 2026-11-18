// HIS-032 (lane w7, 2026-11-17): thinning old payloads for a tenant policy, on PostgreSQL, through
// the scheduler. The policy is set through `PUT /retention` (`thin_payloads`, 30 days), commits are
// appended as a room does, with times in the past, and the task `payloads.thin` runs through
// `Scheduler.handler` with the held documents of the hold store. Its rows are deleted by
// `PgThinningStore` over a pool whose connections `SET ROLE docedit_purge` (migration 0073), so the
// test also shows that the role's grants are enough.
//
// Criteria covered: 1 (payloads older than the period are removed, checkpoints remain), 4 (a read,
// a rebuild, a comparison, an attribution and the dry run of a restore inside the range answer that the detail is no longer
// available, and the history list still shows the metadata) and 5 (a document under a legal hold
// is not thinned). Criteria 2 and 3 are tested at package level, and the chain is verified here too.
// The database is made for this file and dropped afterwards. Test values only.
import { createHash } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS } from '../../src/control-plane/document-purge.ts';
import {
  PayloadThinning,
  payloadThinningTask,
  type ThinningStore,
} from '../../src/control-plane/payload-thinning.ts';
import { PgThinningStore } from '../../src/control-plane/payload-thinning-pg.ts';
import type { JobQueue } from '../../src/control-plane/jobs/queue.ts';
import { Scheduler } from '../../src/control-plane/scheduler.ts';
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
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

describe.skipIf(skip !== null)('thinning old payloads (HIS-032, PostgreSQL)', () => {
  let h: Harness;
  let purgePool: pg.Pool;
  let inner: ThinningStore | null = null;
  const lazy: ThinningStore = {
    documents: (...a) => inner!.documents(...a),
    facts: (...a) => inner!.facts(...a),
    remove: (...a) => inner!.remove(...a),
  };
  let doc: string;
  let held: string;
  let plain: string;
  let verdictBefore: unknown;
  const docAt: Record<number, unknown> = {};

  beforeAll(async () => {
    h = await startHarness('postgres', { parts: { thinningStore: lazy } });
    purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 3 });
    purgePool.on('error', () => {});
    purgePool.on('connect', (c) => {
      void c.query('SET ROLE docedit_purge');
    });
    inner = new PgThinningStore(purgePool);
  }, 60_000);
  afterAll(async () => {
    await purgePool?.end();
    await h?.close();
  });

  const ref = (d: string): DocRef => ({ tenant: h.tenant, doc: d });

  /**
   * A document with six typing commits. The first five are 40 days old and the sixth is new, so
   * with a period of 30 days the first five are due. Checkpoints cover seq 2 and 4, and a named
   * version is made at seq 3.
   */
  async function documentWithHistory(title: string): Promise<string> {
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
    for (let i = 0; i < 6; i++) {
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
            time: i < 5 ? h.now() - 40 * DAY_MS + i * 1000 : h.now(),
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
      if (i === 2) {
        const v = await h.parts.versions!.create(r, {
          kind: 'named',
          name: 'Kept',
          createdBy: bob,
          createdAt: h.now(),
        });
        if (!v.ok) throw new Error('version refused');
      }
    }
    for (const seq of [2, 4]) {
      const at = (await h.call('GET', `/v1/documents/${d}/content?seq=${seq}`, { token: h.apiKey }))
        .json;
      await new ObjectCheckpointStore(h.parts.objects).put(r, seq, {
        cdm: at.cdm,
        requires: at.requires,
        doc: at.doc,
      });
      await h.parts.checkpointIndex!.record(r, {
        seq,
        key: objectKeys.checkpoint(h.tenant, d, seq),
        bytes: 1,
        hash: sha(`cp${seq}`),
      });
    }
    return d;
  }

  const payloadsOf = async (d: string) =>
    (
      await h.db!.admin.query<{ seq: string }>(
        'SELECT seq FROM doc_commit_payloads WHERE doc_id = $1 ORDER BY seq',
        [d],
      )
    ).rows.map((x) => Number(x.seq));

  /** Runs the scheduled task as the scheduler does, for the tenant, with the held documents. */
  async function runTask(): Promise<{ failures: number; count: number }> {
    const thinning = new PayloadThinning({
      store: inner!,
      retention: h.parts.retention!,
      audit: h.parts.audit!,
      now: () => h.now(),
    });
    const task = payloadThinningTask(thinning);
    const scheduler = new Scheduler({
      queue: { enqueue: async () => undefined } as unknown as JobQueue,
      tasks: [task],
      tenants: async () => [h.tenant],
      heldDocuments: (tenant) => h.parts.holds!.heldDocuments(tenant),
      now: () => h.now(),
    });
    const slot = Math.floor(h.now() / task.everyMs);
    return (await scheduler.handler(
      { payload: { task: task.name, slot } } as unknown as Parameters<Scheduler['handler']>[0],
      {} as unknown as Parameters<Scheduler['handler']>[1],
    )) as { failures: number; count: number };
  }

  it('removes nothing while the tenant keeps everything (the default)', async () => {
    doc = await documentWithHistory('Thinned');
    held = await documentWithHistory('Held');
    plain = await documentWithHistory('Own policy');
    // What each seq reads as, from the document that is never thinned (it has the same history).
    // The thinned document is not read before the run, so no cache stands in for its checkpoints.
    for (const seq of [2, 3, 4, 5])
      docAt[seq] = (
        await h.call('GET', `/v1/documents/${plain}/content?seq=${seq}`, { token: h.apiKey })
      ).json.doc;
    verdictBefore = await (h.parts.logs as PgLogStore).verify(ref(doc));
    expect(verdictBefore).toMatchObject({ ok: true });

    const r = await runTask();
    expect(r.failures).toBe(0);
    expect(await payloadsOf(doc)).toEqual([1, 2, 3, 4, 5, 6]);
  }, 90_000);

  it('thins the payloads below the newest checkpoint that no version needs, and audits it (criterion 1)', async () => {
    expect(
      (
        await h.call('PUT', '/v1/retention', {
          token: h.apiKey,
          body: { mode: 'thin_payloads', afterDays: 30 },
          headers: { 'If-Match': '"0"' },
        })
      ).status,
    ).toBe(200);
    // A document with its own policy keeps everything, whatever the tenant says.
    expect(
      (
        await h.call('PUT', `/v1/documents/${plain}/retention`, {
          token: h.apiKey,
          body: { mode: 'keep_all' },
          headers: { 'If-Match': '"0"' },
        })
      ).status,
    ).toBe(200);
    // A legal hold on one document (criterion 5).
    expect(
      (
        await h.call('POST', `/v1/documents/${held}/holds`, {
          token: h.apiKey,
          body: { reason: 'Matter 2026-41' },
        })
      ).status,
    ).toBe(201);

    const r = await runTask();
    expect(r.failures).toBe(0);
    // Seq 1, 2 and 4 go. Seq 3 stays for the named version (it needs the commits after the
    // checkpoint at 2), seq 5 is above the newest checkpoint, and seq 6 is newer than the period.
    expect(await payloadsOf(doc)).toEqual([3, 5, 6]);
    // The metadata rows stay, and the chain still verifies from the stored hashes.
    const rows = await h.db!.admin.query('SELECT 1 FROM doc_commits WHERE doc_id = $1', [doc]);
    expect(rows.rowCount).toBe(6);
    expect(await (h.parts.logs as PgLogStore).verify(ref(doc))).toEqual(verdictBefore);

    // Criterion 5 and the document's own policy: nothing of theirs was touched.
    expect(await payloadsOf(held)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await payloadsOf(plain)).toEqual([1, 2, 3, 4, 5, 6]);
    expect((await runTask()).failures).toBe(0);
    expect(await payloadsOf(held)).toEqual([1, 2, 3, 4, 5, 6]);

    const events = await h.parts.audit!.query(h.tenant, { kind: 'history.thinned', limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      doc,
      actor: 'system',
      data: { removed: 3, keptForVersions: 1, afterDays: 30 },
    });

    // A second run has nothing left to do.
    expect((await runTask()).failures).toBe(0);
    expect(await payloadsOf(doc)).toEqual([3, 5, 6]);
    expect(
      await h.parts.audit!.query(h.tenant, { kind: 'history.thinned', limit: 10 }),
    ).toHaveLength(1);
  }, 90_000);

  it('answers that the detail is gone inside the range, and serves the rest (criterion 4)', async () => {
    const owner = h.userToken({ [doc]: 'owner' }, { sub: 'olga' });
    const get = (path: string) => h.call('GET', `/v1/documents/${doc}${path}`, { token: owner });

    // The history list needs no payload: all six commits are in it.
    const list = await get('/history');
    expect(list.status, list.text).toBe(200);
    const changes = (list.json.items as Array<{ changes?: number }>).reduce(
      (n, i) => n + (i.changes ?? 0),
      0,
    );
    expect(changes).toBe(6);

    // The checkpoints and the kept payloads still serve what they cover.
    expect((await get('/content?seq=2')).json.doc).toEqual(docAt[2]);
    expect((await get('/content?seq=3')).json.doc).toEqual(docAt[3]);
    expect((await get('/content?seq=4')).json.doc).toEqual(docAt[4]);
    expect((await get('/content?seq=5')).json.doc).toEqual(docAt[5]);
    expect((await get('/content')).status).toBe(200);

    // A rebuild, a comparison and an attribution that need a removed payload say so.
    for (const path of [
      '/content?seq=1',
      '/diff?fromSeq=0&toSeq=2',
      '/diff?fromSeq=3&toSeq=5',
      '/attribution?seq=4',
    ]) {
      const r = await get(path);
      expect(r.status, `${path}: ${r.text}`).toBe(404);
      expect(r.json.code, path).toBe('not_found');
      expect(r.json.detail, path).toMatch(/removed|no longer available/);
    }

    // A restore to a version inside the range needs the content at that seq. The test service has
    // no data plane that replaces content (BE-037), so the applied restore is not run; the dry run
    // rebuilds the same target and stores nothing.
    const headBefore = (await get('/content')).json.seq;
    const restore = await h.call('POST', `/v1/documents/${doc}/restore`, {
      token: owner,
      body: { toSeq: 1, dryRun: true },
    });
    expect(restore.status, restore.text).toBe(404);
    expect(restore.json.detail).toMatch(/removed|no longer available/);
    expect((await get('/content')).json.seq).toBe(headBefore);
  }, 90_000);

  it('gives the thinning role no more than it needs', async () => {
    for (const s of ['UPDATE doc_commits SET size = 0', 'DELETE FROM audit_events']) {
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
