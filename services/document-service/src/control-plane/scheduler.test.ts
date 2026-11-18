// Scheduled maintenance (BE-052) against the in-memory queue: one instance runs each slot even
// when several instances start, a failed run is counted and the next slot is not lost, the
// schedule survives a restart. The legal-hold tests below cover the mechanism of criterion 4 only:
// they inject `onHold`, which `src/server.ts` does not pass until the hold store of HIS-031 exists,
// so they do not show that the running service honours a hold.
// PostgreSQL claims (`FOR UPDATE SKIP LOCKED`) are the same contract and are not run here.
import { describe, expect, it } from 'vitest';
import { MemoryIdempotencyStore, type IdempotencyScope } from './idempotency.ts';
import { Metrics } from './metrics.ts';
import { MemoryJobQueue } from './jobs/queue.ts';
import { JobRunner } from './jobs/runner.ts';
import { PLATFORM_TENANT, SCHEDULE_KIND, Scheduler, type ScheduledTask } from './scheduler.ts';

const EVERY = 1_000;
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function setup(start: number) {
  let t = start;
  const now = () => t;
  const queue = new MemoryJobQueue(now);
  const metrics = new Metrics();
  const errors: Array<{ task: string; message: string }> = [];
  const make = (
    tasks: readonly ScheduledTask[],
    tenants: readonly string[],
    onHold?: (x: string) => Promise<boolean>,
  ) =>
    new Scheduler({
      queue,
      tasks,
      tenants: async () => tenants,
      ...(onHold ? { onHold } : {}),
      metrics,
      now,
      onError: (e, task) => errors.push({ task, message: (e as Error).message }),
    });
  const runner = (s: Scheduler, worker: string) =>
    new JobRunner({
      queue,
      handlers: { [SCHEDULE_KIND]: s.handler },
      worker,
      leaseMs: 60_000,
      idleMs: 1,
      retryAfterMs: 1,
      now,
    });
  /** Runs every ready job of the given runners until none is ready. */
  const drain = async (runners: JobRunner[]) => {
    for (;;) {
      let any = false;
      for (const r of runners) if (await r.runOnce()) any = true;
      if (!any) return;
    }
  };
  return {
    queue,
    metrics,
    errors,
    make,
    runner,
    drain,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}

describe('scheduled maintenance (BE-052)', () => {
  it('runs each slot once when several service instances start and every one of them ensures the schedule (criterion 1)', async () => {
    const env = setup(10 * EVERY);
    const runs: number[] = [];
    const task: ScheduledTask = {
      name: 'test.once',
      everyMs: EVERY,
      run: async (now) => {
        runs.push(now);
      },
    };
    const a = env.make([task], []);
    const b = env.make([task], []);
    await a.ensure();
    await b.ensure();
    await b.ensure();
    // One queued job for the current slot, whoever ensured it.
    const first = await env.queue.get(PLATFORM_TENANT, Scheduler.jobId('test.once', 10));
    expect(first?.state).toBe('queued');
    await env.drain([env.runner(a, 'a'), env.runner(b, 'b')]);
    expect(runs).toEqual([10 * EVERY]);
    // The next slot is queued by the run itself, and runs once when its time comes.
    env.set(11 * EVERY);
    await env.drain([env.runner(a, 'a'), env.runner(b, 'b')]);
    expect(runs).toEqual([10 * EVERY, 11 * EVERY]);
    // Ensuring again at the same time does not add a second job for a slot.
    await b.ensure();
    await env.drain([env.runner(a, 'a'), env.runner(b, 'b')]);
    expect(runs).toHaveLength(2);
  });

  it('counts a failed run, keeps the next slot queued, and keeps the schedule across a restart (criteria 3)', async () => {
    const env = setup(10 * EVERY);
    let calls = 0;
    const task: ScheduledTask = {
      name: 'test.flaky',
      everyMs: EVERY,
      run: async () => {
        calls++;
        if (calls === 1) throw new Error('the first run fails');
      },
    };
    const first = env.make([task], []);
    await first.ensure();
    await env.drain([env.runner(first, 'a')]);
    expect(env.errors).toEqual([{ task: 'test.flaky', message: 'the first run fails' }]);
    expect(
      env.metrics.value('docedit_scheduled_runs_total', { task: 'test.flaky', outcome: 'failed' }),
    ).toBe(1);
    expect(
      env.metrics.value('docedit_scheduled_runs_total', { task: 'test.flaky', outcome: 'ok' }),
    ).toBe(0);
    // The next slot was queued before the failed run did its work, so it is not lost.
    const next = await env.queue.get(PLATFORM_TENANT, Scheduler.jobId('test.flaky', 11));
    expect(next?.state).toBe('queued');
    // A restart: a new instance on the same queue finds the schedule and does not duplicate it.
    const restarted = env.make([task], []);
    await restarted.ensure();
    env.set(11 * EVERY);
    await env.drain([env.runner(restarted, 'b')]);
    expect(calls).toBe(2);
    expect(
      env.metrics.value('docedit_scheduled_runs_total', { task: 'test.flaky', outcome: 'ok' }),
    ).toBe(1);
    const again = await env.queue.get(PLATFORM_TENANT, Scheduler.jobId('test.flaky', 12));
    expect(again?.state).toBe('queued');
  });

  it('runs a tenant task for each tenant and skips a tenant an injected onHold reports, for tasks that delete (criterion 4 mechanism only)', async () => {
    const env = setup(10 * EVERY);
    const seen: Record<string, string[]> = { purge: [], report: [] };
    const purge: ScheduledTask = {
      name: 'test.purge',
      everyMs: EVERY,
      deletes: true,
      forTenant: async (tenant) => {
        seen['purge']!.push(tenant);
        return 2;
      },
    };
    const report: ScheduledTask = {
      name: 'test.report',
      everyMs: EVERY,
      forTenant: async (tenant) => {
        seen['report']!.push(tenant);
      },
    };
    const held = new Set([T1]);
    const s = env.make([purge, report], [T1, T2], async (t) => held.has(t));
    await s.ensure();
    await env.drain([env.runner(s, 'a')]);
    expect(seen['purge']).toEqual([T2]);
    expect(seen['report']).toEqual([T1, T2]);
    expect(env.metrics.value('docedit_scheduled_items_total', { task: 'test.purge' })).toBe(2);
    expect(env.errors).toEqual([]);
  });

  it("hands a task that deletes the tenant's held documents, read in that run, and other tasks none (criterion 4)", async () => {
    const env = setup(10 * EVERY);
    const heldBy: Record<string, string[]> = { [T1]: ['d1', 'd2'], [T2]: [] };
    const reads: string[] = [];
    const got: Array<{ task: string; tenant: string; held: string[] }> = [];
    const record = (task: string): ScheduledTask => ({
      name: `test.${task}`,
      everyMs: EVERY,
      ...(task === 'purge' ? { deletes: true } : {}),
      forTenant: async (tenant, _now, scope) => {
        got.push({ task, tenant, held: [...scope.held] });
      },
    });
    const s = new Scheduler({
      queue: env.queue,
      tasks: [record('purge'), record('report')],
      tenants: async () => [T1, T2],
      heldDocuments: async (t) => {
        reads.push(t);
        return new Set(heldBy[t]);
      },
      now: () => 10 * EVERY,
    });
    await s.ensure();
    await env.drain([env.runner(s, 'a')]);
    expect(got.filter((g) => g.task === 'purge')).toEqual([
      { task: 'purge', tenant: T1, held: ['d1', 'd2'] },
      { task: 'purge', tenant: T2, held: [] },
    ]);
    expect(got.filter((g) => g.task === 'report').every((g) => g.held.length === 0)).toBe(true);
    // The hold source is read for the deleting task only: once per tenant.
    expect(reads).toEqual([T1, T2]);
  });

  it("purges each tenant's expired idempotency keys in that tenant's own run, and none of a tenant an injected onHold reports (criterion 4 mechanism only)", async () => {
    const env = setup(0);
    const store = new MemoryIdempotencyStore();
    const scope = (tenant: string, key: string): IdempotencyScope => ({
      tenant,
      principal: 'service',
      route: 'POST /documents',
      key,
    });
    // Two expired keys and one live key for T1, one expired key for T2.
    await store.claim(scope(T1, 'a'), 'f', 0, EVERY, EVERY);
    await store.claim(scope(T1, 'b'), 'f', 0, EVERY, EVERY);
    await store.claim(scope(T2, 'c'), 'f', 0, EVERY, EVERY);
    await store.claim(scope(T1, 'live'), 'f', 0, 100 * EVERY, 100 * EVERY);
    env.set(10 * EVERY);
    const runs: Array<{ tenant: string; removed: number }> = [];
    // The same shape as the task `src/server.ts` registers as `idempotency.purge`.
    const purge: ScheduledTask = {
      name: 'idempotency.purge',
      everyMs: EVERY,
      deletes: true,
      forTenant: async (tenant, at) => {
        const removed = await store.purge(tenant, at);
        runs.push({ tenant, removed });
        return removed;
      },
    };
    const held = new Set([T2]);
    const s = env.make([purge], [T1, T2], async (t) => held.has(t));
    await s.ensure();
    await env.drain([env.runner(s, 'a')]);
    // T1's run removes only T1's two expired keys; T2 is skipped and keeps its expired key.
    expect(runs).toEqual([{ tenant: T1, removed: 2 }]);
    expect(await store.read(scope(T1, 'live'), 10 * EVERY)).not.toBeNull();
    expect(store.size).toBe(2);
    // Released: the next slot purges T2 in its own run.
    held.clear();
    env.set(11 * EVERY);
    await env.drain([env.runner(s, 'a')]);
    expect(runs.slice(1)).toEqual([
      { tenant: T1, removed: 0 },
      { tenant: T2, removed: 1 },
    ]);
    expect(store.size).toBe(1);
  });

  it('keeps going for the other tenants when one tenant fails', async () => {
    const env = setup(10 * EVERY);
    const done: string[] = [];
    const task: ScheduledTask = {
      name: 'test.partial',
      everyMs: EVERY,
      forTenant: async (tenant) => {
        if (tenant === T1) throw new Error('one tenant fails');
        done.push(tenant);
      },
    };
    const s = env.make([task], [T1, T2]);
    await s.ensure();
    await env.drain([env.runner(s, 'a')]);
    expect(done).toEqual([T2]);
    expect(
      env.metrics.value('docedit_scheduled_runs_total', {
        task: 'test.partial',
        outcome: 'failed',
      }),
    ).toBe(1);
  });

  it('refuses a task with a name that is not lower-case or a period under one second', () => {
    const env = setup(0);
    expect(() => env.make([{ name: 'Bad Name', everyMs: EVERY }], [])).toThrow(RangeError);
    expect(() => env.make([{ name: 'ok.name', everyMs: 999 }], [])).toThrow(RangeError);
  });
});
