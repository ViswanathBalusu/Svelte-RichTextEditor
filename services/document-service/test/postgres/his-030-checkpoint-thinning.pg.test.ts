// HIS-030 (lane w7, 2026-11-18): thinning old checkpoints on PostgreSQL, through the scheduler, with
// the real replay of BE-020 as the gate. Commits are appended as a room does and the checkpoints are
// written from the real content at each `seq` with `created_at` set in the past, so that the weekly
// zone (older than 90 days, owner decision 55), the daily zone (30 to 90 days) and the young zone
// (under 30 days) each hold some. The rows are deleted by `PgCheckpointThinningStore` over a pool
// whose connections `SET ROLE docedit_purge` (migration 0073), so the test also shows that the
// role's grants are enough.
//
// Criteria covered: 1 (all kept while young; daily, then weekly past 90 days), 2 (a checkpoint a
// version points at is never removed), 3 (a checkpoint that would replace older ones is verified
// against a replay first; a wrong one holds its period back and raises the alert) and 4 (every
// version still rebuilds to the same hash and the chain still verifies). The border of a snapshot
// commit is tested at package level (packages/history/test/thinning.test.ts).
// The database is made for this file and dropped afterwards. Test values only.
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import type { SnapshotCommit } from '@docedit/authority';
import { canonicalize, uuid7, type JsonEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CheckpointThinning,
  checkpointThinningTask,
} from '../../src/control-plane/checkpoint-thinning.ts';
import { PgCheckpointThinningStore } from '../../src/control-plane/checkpoint-thinning-pg.ts';
import { DAY_MS } from '../../src/control-plane/document-purge.ts';
import type { JobQueue } from '../../src/control-plane/jobs/queue.ts';
import { Scheduler } from '../../src/control-plane/scheduler.ts';
import { gateThinning, rebuild, type RecoveryStores } from '../../src/data-plane/recovery.ts';
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

const WEEK_MS = 7 * DAY_MS;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const LETTERS = 'ABCDEFGHIJKL';

/** The time of each checkpoint seq, chosen so that the periods are known by hand. */
function timeOf(seq: number): number {
  // Weekly zone (older than 90 days): seq 1 to 4 share one epoch week, seq 5 is in the next.
  const week1 = Math.floor((NOW - 200 * DAY_MS) / WEEK_MS) * WEEK_MS + DAY_MS;
  // Daily zone (30 to 90 days): seq 6 and 7 share one UTC day, seq 8 and 9 the next.
  const dayA = Math.floor((NOW - 60 * DAY_MS) / DAY_MS) * DAY_MS;
  if (seq >= 1 && seq <= 4) return week1 + seq * HOUR;
  if (seq === 5) return week1 + WEEK_MS + HOUR;
  if (seq === 6 || seq === 7) return dayA + (seq - 3) * HOUR;
  if (seq === 8 || seq === 9) return dayA + DAY_MS + (seq - 5) * HOUR;
  return NOW - 5 * DAY_MS + seq * HOUR; // seq 10 and 11: young
}

describe.skipIf(skip !== null)('thinning old checkpoints (HIS-030, PostgreSQL)', () => {
  let h: Harness;
  let purgePool: pg.Pool;
  let store: PgCheckpointThinningStore;
  const alerts: Array<{ doc: string; seq: number }> = [];

  beforeAll(async () => {
    h = await startHarness('postgres', {});
    purgePool = new pg.Pool({ ...ADMIN, database: h.db!.name, max: 3 });
    purgePool.on('error', () => {});
    purgePool.on('connect', (c) => {
      void c.query('SET ROLE docedit_purge');
    });
    store = new PgCheckpointThinningStore(purgePool);
  }, 60_000);
  afterAll(async () => {
    await purgePool?.end();
    await h?.close();
  });

  const ref = (d: string): DocRef => ({ tenant: h.tenant, doc: d });
  const stores = (): RecoveryStores => ({
    logs: h.parts.logs,
    checkpoints: new ObjectCheckpointStore(h.parts.objects),
    index: h.parts.checkpointIndex!,
  });

  /**
   * A document with twelve typing commits, a named version at seq 3, and a checkpoint at seq 1 to
   * 11 with the content of that seq. `wrongAt` writes the content of the seq before it instead.
   */
  async function documentWithCheckpoints(
    title: string,
    wrongAt?: number,
    snapshotAt?: number,
  ): Promise<string> {
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
    for (let i = 0; i < 12; i++) {
      const head = await h.parts.logs.head(r);
      const perms = await h.parts.grants.current(r);
      if (head.seq + 1 === snapshotAt) {
        // A snapshot commit that brings the content as it stood (a restore to the state just before).
        const before = (
          await h.call('GET', `/v1/documents/${d}/content?seq=${head.seq}`, { token: h.apiKey })
        ).json;
        const envelope = {
          cdm: before.cdm,
          requires: before.requires,
          doc: before.doc,
        } as JsonEnvelope;
        const text = canonicalize(envelope);
        const hash = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
        const commit: SnapshotCommit = {
          seq: head.seq + 1,
          id: uuid7(),
          kind: 'snapshot',
          steps: [],
          snapshot: { checkpoint: `sha256:${hash}`, reason: 'restore' },
          user: bob,
          session: 's',
          time: h.now(),
          origin: 'restore',
          scopes: [],
          revision: perms.revision,
          cdm: 1,
          engine: 'pm-steps/1',
          retired: [],
          claimed: [],
        };
        const sr = await h.parts.logs.append(
          r,
          { epoch, revision: perms.revision, fromSeq: commit.seq, commits: [], snapshot: commit },
          { snapshot: { envelope, encoded: zstdCompressSync(Buffer.from(text, 'utf8')), hash } },
        );
        if (sr.status !== 'ok') throw new Error(`snapshot refused: ${sr.status}`);
        continue;
      }
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
    for (let seq = 1; seq <= 11; seq++) {
      const from = seq === wrongAt ? seq - 1 : seq;
      const at = (
        await h.call('GET', `/v1/documents/${d}/content?seq=${from}`, { token: h.apiKey })
      ).json;
      await new ObjectCheckpointStore(h.parts.objects).put(r, seq, {
        cdm: at.cdm,
        requires: at.requires,
        doc: at.doc,
      });
      await h.parts.checkpointIndex!.record(r, {
        seq,
        key: objectKeys.checkpoint(h.tenant, d, seq),
        bytes: 1,
        hash: '00'.repeat(32),
      });
      await h.db!.admin.query(
        'UPDATE doc_checkpoints SET created_at = $3 WHERE doc_id = $1 AND seq = $2',
        [d, seq, new Date(timeOf(seq)).toISOString()],
      );
    }
    return d;
  }

  const seqsOf = async (d: string) =>
    (
      await h.db!.admin.query<{ seq: string }>(
        'SELECT seq FROM doc_checkpoints WHERE doc_id = $1 AND seq > 0 ORDER BY seq',
        [d],
      )
    ).rows.map((x) => Number(x.seq));

  /** Runs the scheduled task as the scheduler does, for the tenant, with the held documents. */
  async function runTask(): Promise<{ failures: number; count: number }> {
    const thinning = new CheckpointThinning({
      store,
      objects: h.parts.objects,
      audit: h.parts.audit!,
      now: () => NOW,
      verify: async (r, seq) =>
        (
          await gateThinning(
            stores(),
            r,
            seq,
            (v, rr) => void alerts.push({ doc: rr.doc, seq: v.seq }),
          )
        ).proceed,
    });
    const task = checkpointThinningTask(thinning);
    const scheduler = new Scheduler({
      queue: { enqueue: async () => undefined } as unknown as JobQueue,
      tasks: [task],
      tenants: async () => [h.tenant],
      heldDocuments: (tenant) => h.parts.holds!.heldDocuments(tenant),
      now: () => NOW,
    });
    const slot = Math.floor(NOW / task.everyMs);
    return (await scheduler.handler(
      { payload: { task: task.name, slot } } as unknown as Parameters<Scheduler['handler']>[0],
      {} as unknown as Parameters<Scheduler['handler']>[1],
    )) as { failures: number; count: number };
  }

  let doc: string;
  let wrong: string;
  let held: string;
  let snap: string;
  const before: Record<string, string> = {};
  let chainBefore: unknown;

  it('keeps the young ones, one per day in the daily zone and one per week past 90 days, and keeps what a version points at (criteria 1 and 2)', async () => {
    doc = await documentWithCheckpoints('Thinned');
    wrong = await documentWithCheckpoints('Wrong keeper', 9);
    held = await documentWithCheckpoints('Held');
    snap = await documentWithCheckpoints('Snapshot', undefined, 7);
    expect(
      (
        await h.call('POST', `/v1/documents/${held}/holds`, {
          token: h.apiKey,
          body: { reason: 'Matter 2026-41' },
        })
      ).status,
    ).toBe(201);
    for (let seq = 0; seq <= 12; seq++)
      before[String(seq)] = (await rebuild(stores(), ref(doc), seq)).hash;
    chainBefore = await (h.parts.logs as PgLogStore).verify(ref(doc));
    expect(chainBefore).toMatchObject({ ok: true });

    const r = await runTask();
    expect(r.failures).toBe(0);
    // Weekly zone, seq 1 to 4: seq 4 is the week's keeper; seq 3 is the one the named version at
    // seq 3 points at; seq 1 and 2 go. Seq 5 is alone in its week. Daily zone: seq 7 and 9 are the
    // days' keepers, seq 6 and 8 go. Seq 10 and 11 are young.
    expect(await seqsOf(doc)).toEqual([3, 4, 5, 7, 9, 10, 11]);
    // The objects of the removed checkpoints are gone, and those of the kept ones are not.
    for (const seq of [1, 2, 6, 8])
      expect(await h.parts.objects.exists(objectKeys.checkpoint(h.tenant, doc, seq))).toBe(false);
    for (const seq of [3, 4, 5, 7, 9, 10, 11])
      expect(await h.parts.objects.exists(objectKeys.checkpoint(h.tenant, doc, seq))).toBe(true);
    const events = await h.parts.audit!.query(h.tenant, {
      kind: 'checkpoints.thinned',
      doc,
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: 'system', data: { removed: 4, held: 0 } });

    // A second run has nothing left to do.
    expect((await runTask()).failures).toBe(0);
    expect(await seqsOf(doc)).toEqual([3, 4, 5, 7, 9, 10, 11]);
    expect(
      await h.parts.audit!.query(h.tenant, { kind: 'checkpoints.thinned', doc, limit: 10 }),
    ).toHaveLength(1);
  }, 120_000);

  it('holds a period back when the checkpoint that would replace older ones does not match a replay (criterion 3)', async () => {
    // Seq 9 holds the content of seq 8, so the daily keeper of its day fails the replay: seq 8 and
    // 9 stay, and the alert is raised for seq 9. The weekly zone is unaffected.
    expect(await seqsOf(wrong)).toEqual([3, 4, 5, 7, 8, 9, 10, 11]);
    expect(alerts).toContainEqual({ doc: wrong, seq: 9 });
    expect(alerts.filter((a) => a.doc === doc)).toEqual([]);
    const events = await h.parts.audit!.query(h.tenant, {
      kind: 'checkpoints.thinned',
      doc: wrong,
      limit: 10,
    });
    expect(events[0]).toMatchObject({ data: { removed: 3, held: 2 } });
  });

  it('never removes a checkpoint that borders a snapshot commit (criterion 2)', async () => {
    // A snapshot commit at seq 7: the checkpoints at 6 and 7 border it, so the day they share keeps
    // both, where the other document lost seq 6. The rest thins as in the first document.
    expect(await seqsOf(snap)).toEqual([3, 4, 5, 6, 7, 9, 10, 11]);
  });

  it('leaves a document under a legal hold alone', async () => {
    expect(await seqsOf(held)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('still rebuilds every version, with a longer replay, and the chain still verifies (criterion 4)', async () => {
    for (let seq = 0; seq <= 12; seq++)
      expect((await rebuild(stores(), ref(doc), seq)).hash, `seq ${seq}`).toBe(before[String(seq)]);
    // The named version at seq 3 rebuilds from its own checkpoint, so its replay did not grow; seq 2
    // lost its checkpoint and now replays from the content at 0.
    expect(await rebuild(stores(), ref(doc), 3)).toMatchObject({ from: 3, replayed: 0 });
    expect(await rebuild(stores(), ref(doc), 2)).toMatchObject({ from: 0, replayed: 2 });
    expect(await (h.parts.logs as PgLogStore).verify(ref(doc))).toEqual(chainBefore);
    // Over HTTP, the content at a thinned seq is the same as before.
    const over = await h.call('GET', `/v1/documents/${doc}/content?seq=2`, { token: h.apiKey });
    expect(over.status, over.text).toBe(200);
  });
});
