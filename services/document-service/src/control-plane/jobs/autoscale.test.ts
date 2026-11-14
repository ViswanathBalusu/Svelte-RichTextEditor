// Export workers that follow the queue depth (BE-065; BE-050 for priorities and tenant limits).
// The in-memory queue and real job runners are the subject; the policy numbers are the test's own
// settings, not measurements.
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EXPORT_KIND, EXPORT_PRIORITIES, PREVIEW_KIND } from '../exports.ts';
import { Autoscaler, WorkerPool, desiredWorkers, type ScalePolicy } from './autoscale.ts';
import { MemoryJobQueue, type JobRecord } from './queue.ts';
import type { JobHandler } from './runner.ts';

const LEASE = 60_000;

const priorityOf = (kind: string): number => {
  const p = EXPORT_PRIORITIES[kind];
  if (p === undefined) throw new Error(`no priority for ${kind}`);
  return p;
};

function enqueue(q: MemoryJobQueue, tenant: string, kind: string) {
  return q.enqueue(tenant, {
    kind,
    doc: randomUUID(),
    payload: {},
    createdBy: 'system',
    priority: priorityOf(kind),
  });
}

/** Polls until a condition holds, failing after a time (the runners use real timers). */
async function until(cond: () => Promise<boolean> | boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A promise the test resolves by hand. */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { wait: () => p, open };
}

const fastHandler: JobHandler = async () => ({ ok: true });

function poolOver(
  queue: MemoryJobQueue,
  handlers: Record<string, JobHandler>,
  extra: { concurrency?: number; claim?: { defaultLimit?: number | null } } = {},
) {
  return new WorkerPool({
    queue,
    handlers,
    kinds: [PREVIEW_KIND, EXPORT_KIND],
    name: 'exp',
    leaseMs: LEASE,
    idleMs: 3,
    retryAfterMs: 1,
    ...(extra.concurrency !== undefined ? { concurrency: extra.concurrency } : {}),
    ...(extra.claim ? { claim: extra.claim } : {}),
  });
}

describe('the scale policy (BE-065 criteria 1 and 2)', () => {
  const policyArb = fc
    .record({
      minWorkers: fc.integer({ min: 0, max: 5 }),
      extra: fc.integer({ min: 0, max: 10 }),
      jobsPerWorker: fc.integer({ min: 1, max: 6 }),
    })
    .map((p) => ({
      minWorkers: p.minWorkers,
      maxWorkers: p.minWorkers + p.extra,
      jobsPerWorker: p.jobsPerWorker,
    }));

  it('keeps the warm floor on an empty queue and never exceeds the ceiling', () => {
    fc.assert(
      fc.property(policyArb, fc.integer({ min: 0, max: 500 }), (policy: ScalePolicy, backlog) => {
        const n = desiredWorkers(backlog, policy);
        expect(n).toBeGreaterThanOrEqual(policy.minWorkers);
        expect(n).toBeLessThanOrEqual(policy.maxWorkers);
        expect(desiredWorkers(0, policy)).toBe(policy.minWorkers);
      }),
    );
  });

  it('adds workers as the backlog rises and never removes them while it rises', () => {
    fc.assert(
      fc.property(
        policyArb,
        fc.integer({ min: 0, max: 300 }),
        fc.integer({ min: 0, max: 50 }),
        (policy, backlog, more) => {
          expect(desiredWorkers(backlog + more, policy)).toBeGreaterThanOrEqual(
            desiredWorkers(backlog, policy),
          );
        },
      ),
    );
  });

  it('rejects a policy whose ceiling is below its floor', () => {
    expect(() => desiredWorkers(1, { minWorkers: 3, maxWorkers: 2, jobsPerWorker: 1 })).toThrow(
      RangeError,
    );
    expect(() => desiredWorkers(1, { minWorkers: 0, maxWorkers: 2, jobsPerWorker: 0 })).toThrow(
      RangeError,
    );
  });
});

describe('a pool that follows the queue (BE-065 criteria 1 and 2)', () => {
  it('adds workers while the backlog rises, up to the ceiling, and drains the backlog', async () => {
    const q = new MemoryJobQueue();
    const tenant = randomUUID();
    const policy: ScalePolicy = { minWorkers: 1, maxWorkers: 4, jobsPerWorker: 2 };
    const pool = poolOver(q, { [EXPORT_KIND]: fastHandler });
    const scaler = new Autoscaler({ queue: q, pool, policy });
    try {
      for (let i = 0; i < 10; i++) await enqueue(q, tenant, EXPORT_KIND);
      const up = await scaler.tick();
      expect(up).toEqual({ backlog: 10, wanted: 4, workers: 4 });
      expect(pool.size).toBe(4);
      await until(async () => (await q.depth()).every((d) => d.queued + d.running === 0));
    } finally {
      await pool.stop();
    }
  });

  it('keeps the warm floor up when the queue is empty, and does not drop below it', async () => {
    const q = new MemoryJobQueue();
    const pool = poolOver(q, { [EXPORT_KIND]: fastHandler });
    const scaler = new Autoscaler({
      queue: q,
      pool,
      policy: { minWorkers: 2, maxWorkers: 5, jobsPerWorker: 1 },
    });
    try {
      expect((await scaler.tick()).workers).toBe(2);
      expect((await scaler.tick()).workers).toBe(2);
      expect(pool.size).toBe(2);
    } finally {
      await pool.stop();
    }
  });

  it('removes workers down to the floor once the queue has drained', async () => {
    const q = new MemoryJobQueue();
    const tenant = randomUUID();
    const pool = poolOver(q, { [EXPORT_KIND]: fastHandler });
    const scaler = new Autoscaler({
      queue: q,
      pool,
      policy: { minWorkers: 1, maxWorkers: 3, jobsPerWorker: 1 },
    });
    try {
      for (let i = 0; i < 3; i++) await enqueue(q, tenant, EXPORT_KIND);
      expect((await scaler.tick()).workers).toBe(3);
      await until(async () => (await q.depth()).every((d) => d.queued + d.running === 0));
      expect((await scaler.tick()).workers).toBe(1);
    } finally {
      await pool.stop();
    }
  });
});

describe('a worker leaves after its job (BE-065 criterion 3)', () => {
  it('waits for the running job to finish before the pool shrinks', async () => {
    const q = new MemoryJobQueue();
    const tenant = randomUUID();
    const hold = gate();
    let started = 0;
    const pool = poolOver(q, {
      [EXPORT_KIND]: async () => {
        started++;
        await hold.wait();
        return { done: true };
      },
    });
    const job = await enqueue(q, tenant, EXPORT_KIND);
    await pool.scaleTo(1);
    await until(() => started === 1);

    let stopped = false;
    const shrink = pool.scaleTo(0).then((n) => {
      stopped = true;
      return n;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(stopped).toBe(false);
    expect((await q.get(tenant, job.id))?.state).toBe('running');

    hold.open();
    expect(await shrink).toBe(0);
    expect((await q.get(tenant, job.id))?.state).toBe('completed');
    expect(pool.size).toBe(0);
  });
});

describe('priorities and tenant limits are unchanged by the pool (BE-065 criterion 4; BE-050)', () => {
  it('serves previews first and keeps a tenant at its limit while the pool has three workers', async () => {
    const q = new MemoryJobQueue();
    const a = randomUUID();
    const b = randomUUID();
    await q.setLimit(a, EXPORT_KIND, 1);
    const hold = gate();
    const started: Array<{ tenant: string; kind: string }> = [];
    const handler: JobHandler = async (job: JobRecord) => {
      started.push({ tenant: job.tenant, kind: job.kind });
      await hold.wait();
      return {};
    };
    const pool = poolOver(
      q,
      { [PREVIEW_KIND]: handler, [EXPORT_KIND]: handler },
      { claim: { defaultLimit: null } },
    );
    const exportA1 = await enqueue(q, a, EXPORT_KIND);
    const exportA2 = await enqueue(q, a, EXPORT_KIND);
    const previewA = await enqueue(q, a, PREVIEW_KIND);
    const exportB = await enqueue(q, b, EXPORT_KIND);
    try {
      await pool.scaleTo(3);
      await until(() => started.length === 3);
      expect(started[0]).toEqual({ tenant: a, kind: PREVIEW_KIND });
      // Tenant A is at its limit of one export, so B's export runs in its place.
      expect(started.filter((s) => s.tenant === a && s.kind === EXPORT_KIND)).toHaveLength(1);
      expect(started.some((s) => s.tenant === b)).toBe(true);
      const jobs: Array<[string, JobRecord]> = [
        [a, exportA1],
        [a, exportA2],
        [a, previewA],
        [b, exportB],
      ];
      const states = await Promise.all(jobs.map(async ([t, j]) => (await q.get(t, j.id))?.state));
      expect(states).toEqual(['running', 'queued', 'running', 'running']);
    } finally {
      hold.open();
      await pool.stop();
    }
  });

  it('applies the default limit to every worker, however many the pool runs', async () => {
    const q = new MemoryJobQueue();
    const tenant = randomUUID();
    const hold = gate();
    let running = 0;
    let peak = 0;
    const handler: JobHandler = async () => {
      running++;
      peak = Math.max(peak, running);
      await hold.wait();
      running--;
      return {};
    };
    const pool = poolOver(q, { [EXPORT_KIND]: handler }, { claim: { defaultLimit: 2 } });
    for (let i = 0; i < 5; i++) await enqueue(q, tenant, EXPORT_KIND);
    try {
      await pool.scaleTo(4);
      await until(() => running === 2);
      await new Promise((r) => setTimeout(r, 20));
      expect(peak).toBe(2);
    } finally {
      hold.open();
      await pool.stop();
    }
  });
});
