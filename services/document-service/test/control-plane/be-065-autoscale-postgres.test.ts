// Export workers that follow the queue depth on PostgreSQL (BE-065; BE-050 for priorities and tenant
// limits), lane U-BE-057-070. The in-memory version is src/control-plane/jobs/autoscale.test.ts,
// whose Notes say the PostgreSQL queue was not run. This file runs the same rules against the real
// job queue (docedit_claim_job_v2, docedit_job_depth) in a database of its own. The policy numbers
// are the test's own settings, not measurements. It skips when PostgreSQL is not up.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPORT_KIND, EXPORT_PRIORITIES, PREVIEW_KIND } from '../../src/control-plane/exports.ts';
import {
  Autoscaler,
  WorkerPool,
  type ScalePolicy,
} from '../../src/control-plane/jobs/autoscale.ts';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import type { JobHandler } from '../../src/control-plane/jobs/runner.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const LEASE = 60_000;
const databases: TestDatabase[] = [];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A PostgreSQL queue in a database of its own. */
async function freshQueue(): Promise<PgJobQueue> {
  const db = await createTestDatabase();
  databases.push(db);
  return new PgJobQueue(db.service);
}

const priorityOf = (kind: string): number => {
  const p = EXPORT_PRIORITIES[kind];
  if (p === undefined) throw new Error(`no priority for ${kind}`);
  return p;
};

function enqueue(q: PgJobQueue, tenant: string, kind: string) {
  return q.enqueue(tenant, {
    kind,
    doc: randomUUID(),
    payload: {},
    createdBy: 'system',
    priority: priorityOf(kind),
  });
}

/** Polls the database until a condition holds (the runners use real timers). */
async function until(cond: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await sleep(10);
  }
}

async function backlogOf(q: PgJobQueue, kinds: readonly string[]): Promise<number> {
  return (await q.depth())
    .filter((d) => kinds.includes(d.kind))
    .reduce((n, d) => n + d.queued + d.running, 0);
}

/** A promise the test resolves by hand. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { wait: () => p, open };
}

const fastHandler: JobHandler = async () => ({ ok: true });

function poolOver(
  q: PgJobQueue,
  handlers: Record<string, JobHandler>,
  kinds: string[],
  name: string,
) {
  return new WorkerPool({
    queue: q,
    handlers,
    kinds,
    name,
    leaseMs: LEASE,
    idleMs: 5,
    retryAfterMs: 1,
  });
}

const why = await postgresUnavailable();

describe.skipIf(why)('export workers that follow the queue on PostgreSQL (BE-065)', () => {
  afterAll(async () => {
    for (const db of databases) await db.drop();
  });

  it('adds workers while the backlog rises, drains it, and returns to the floor (BE-065 criteria 1 and 3)', async () => {
    const q = await freshQueue();
    const policy: ScalePolicy = { minWorkers: 1, maxWorkers: 4, jobsPerWorker: 3 };
    const t = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await enqueue(q, t, EXPORT_KIND)).id);
    const pool = poolOver(q, { [EXPORT_KIND]: fastHandler }, [EXPORT_KIND], 'be065-up');
    const scaler = new Autoscaler({ queue: q, pool, policy });
    try {
      // The first reading sees the whole backlog of ten: four workers, the ceiling.
      expect(await scaler.tick()).toEqual({ backlog: 10, wanted: 4, workers: 4 });
      await until(async () => (await backlogOf(q, [EXPORT_KIND])) === 0);
      for (const id of ids) expect((await q.get(t, id))?.state).toBe('completed');
      // Drained: the pool goes back to the floor of one.
      expect(await scaler.tick()).toEqual({ backlog: 0, wanted: 1, workers: 1 });
      expect(pool.size).toBe(1);
    } finally {
      await pool.stop();
    }
  }, 60_000);

  it('keeps the warm floor up on an empty queue and never goes above the ceiling (BE-065 criterion 2)', async () => {
    const q = await freshQueue();
    const policy: ScalePolicy = { minWorkers: 2, maxWorkers: 5, jobsPerWorker: 2 };
    // The handler waits on a gate so the backlog stays queued or running while it is read.
    const hold = gate();
    const pool = poolOver(
      q,
      {
        [EXPORT_KIND]: async () => {
          await hold.wait();
          return { ok: true };
        },
      },
      [EXPORT_KIND],
      'be065-floor',
    );
    const scaler = new Autoscaler({ queue: q, pool, policy });
    try {
      expect(await scaler.tick()).toEqual({ backlog: 0, wanted: 2, workers: 2 });
      expect(await scaler.tick()).toEqual({ backlog: 0, wanted: 2, workers: 2 });
      // A backlog far above the ceiling asks for the ceiling only.
      const t = randomUUID();
      for (let i = 0; i < 40; i++) await enqueue(q, t, EXPORT_KIND);
      const busy = await scaler.tick();
      expect(busy.backlog).toBe(40);
      expect(busy.wanted).toBe(5);
      expect(busy.workers).toBe(5);
    } finally {
      hold.open();
      await pool.stop();
    }
  }, 60_000);

  it('a worker that is removed finishes its running job before it stops (BE-065 criterion 3)', async () => {
    const q = await freshQueue();
    const t = randomUUID();
    const release = gate();
    const job = await enqueue(q, t, EXPORT_KIND);
    const pool = poolOver(
      q,
      {
        [EXPORT_KIND]: async () => {
          await release.wait();
          return { ok: true };
        },
      },
      [EXPORT_KIND],
      'be065-stop',
    );
    try {
      await pool.scaleTo(1);
      await until(async () => (await q.get(t, job.id))?.state === 'running');
      let stopped = false;
      const shrink = pool.scaleTo(0).then(() => {
        stopped = true;
      });
      await sleep(150);
      // The job is still running, so the worker has not stopped.
      expect(stopped).toBe(false);
      expect((await q.get(t, job.id))?.state).toBe('running');
      release.open();
      await shrink;
      expect(pool.size).toBe(0);
      expect((await q.get(t, job.id))?.state).toBe('completed');
    } finally {
      release.open();
      await pool.stop();
    }
  }, 60_000);

  it('keeps the tenant limit of exports while the pool scales (BE-065 criterion 4, BE-050 criterion 3)', async () => {
    const q = await freshQueue();
    const a = randomUUID();
    const b = randomUUID();
    await q.setLimit(a, EXPORT_KIND, 1);
    const ids = [
      (await enqueue(q, a, EXPORT_KIND)).id,
      (await enqueue(q, a, EXPORT_KIND)).id,
      (await enqueue(q, a, EXPORT_KIND)).id,
      (await enqueue(q, b, EXPORT_KIND)).id,
    ];
    let running = 0;
    let maxA = 0;
    const handler: JobHandler = async (job) => {
      if (job.tenant === a) {
        running++;
        maxA = Math.max(maxA, running);
      }
      await sleep(30);
      if (job.tenant === a) running--;
      return { ok: true };
    };
    const pool = poolOver(q, { [EXPORT_KIND]: handler }, [EXPORT_KIND], 'be065-limit');
    const scaler = new Autoscaler({
      queue: q,
      pool,
      policy: { minWorkers: 0, maxWorkers: 3, jobsPerWorker: 1 },
    });
    try {
      expect((await scaler.tick()).workers).toBe(3);
      await until(async () => (await backlogOf(q, [EXPORT_KIND])) === 0);
      expect(maxA).toBe(1);
      for (const id of ids)
        expect((await q.get(a, id))?.state ?? (await q.get(b, id))?.state).toBe('completed');
    } finally {
      await pool.stop();
    }
  }, 60_000);

  it('claims a preview before an earlier export when the pool scales (BE-065 criterion 4, BE-050 criterion 1)', async () => {
    const q = await freshQueue();
    const t = randomUUID();
    const exportJob = await enqueue(q, t, EXPORT_KIND);
    const previewJob = await enqueue(q, t, PREVIEW_KIND);
    const order: string[] = [];
    const record: JobHandler = async (job) => {
      order.push(job.kind);
      return { ok: true };
    };
    const pool = poolOver(
      q,
      { [EXPORT_KIND]: record, [PREVIEW_KIND]: record },
      [PREVIEW_KIND, EXPORT_KIND],
      'be065-prio',
    );
    const scaler = new Autoscaler({
      queue: q,
      pool,
      policy: { minWorkers: 0, maxWorkers: 1, jobsPerWorker: 10 },
    });
    try {
      expect((await scaler.tick()).workers).toBe(1);
      await until(async () => (await backlogOf(q, [PREVIEW_KIND, EXPORT_KIND])) === 0);
      expect(order).toEqual([PREVIEW_KIND, EXPORT_KIND]);
      expect((await q.get(t, previewJob.id))?.state).toBe('completed');
      expect((await q.get(t, exportJob.id))?.state).toBe('completed');
    } finally {
      await pool.stop();
    }
  }, 60_000);
});
