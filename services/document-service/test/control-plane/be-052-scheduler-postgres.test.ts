// Scheduled maintenance (BE-052) on PostgreSQL, lane U-BE-043-056. The in-memory tests in
// src/control-plane/scheduler.test.ts state that the PostgreSQL claim (FOR UPDATE SKIP LOCKED) was
// not run. This file runs it: two scheduler instances and two job runners share one database, the
// claims race, and one run per slot happens (criterion 1). A second scheduler on the same database,
// started as after a restart, runs the slot the first one queued (criterion 3). It skips when
// PostgreSQL is not up (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import { JobRunner } from '../../src/control-plane/jobs/runner.ts';
import {
  PLATFORM_TENANT,
  SCHEDULE_KIND,
  Scheduler,
  type ScheduledTask,
} from '../../src/control-plane/scheduler.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const EVERY = 3_600_000;
// A fixed slot, well in the future of any real clock, so the test is deterministic. The schedule
// queues the next slot an hour ahead, which the test never reaches.
const SLOT = 400_000;
const at = (slot: number) => slot * EVERY + 1_000;

const why = await postgresUnavailable();

describe.skipIf(why)('scheduled maintenance on PostgreSQL (BE-052 U-BE-043-056)', () => {
  let db: TestDatabase;
  const runs: number[] = [];
  const task: ScheduledTask = {
    name: 'test.pg-once',
    everyMs: EVERY,
    run: async (now) => {
      runs.push(now);
    },
  };

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  const instance = (now: () => number) => {
    const queue = new PgJobQueue(db.service);
    const scheduler = new Scheduler({
      queue,
      tasks: [task],
      tenants: async () => [],
      now,
    });
    return { queue, scheduler };
  };

  const runner = (queue: PgJobQueue, scheduler: Scheduler, worker: string, now: () => number) =>
    new JobRunner({
      queue,
      handlers: { [SCHEDULE_KIND]: scheduler.handler },
      worker,
      leaseMs: 60_000,
      idleMs: 1,
      retryAfterMs: 1,
      now,
    });

  it('runs each slot once when two instances ensure it and two runners race for it (criterion 1)', async () => {
    const now = () => at(SLOT);
    const a = instance(now);
    const b = instance(now);
    await a.scheduler.ensure();
    await b.scheduler.ensure();
    await b.scheduler.ensure();
    const ra = runner(a.queue, a.scheduler, 'pg-a', now);
    const rb = runner(b.queue, b.scheduler, 'pg-b', now);
    for (let i = 0; i < 5; i++) await Promise.all([ra.runOnce(), rb.runOnce()]);
    expect(runs).toEqual([at(SLOT)]);
    // The run queued the next slot in the database; it is not due yet.
    const next = await a.queue.get(PLATFORM_TENANT, Scheduler.jobId(task.name, SLOT + 1));
    expect(next?.state).toBe('queued');
    expect(next?.kind).toBe(SCHEDULE_KIND);
  });

  it('keeps the schedule across a restart: a new instance on the same database runs the queued slot (criterion 3)', async () => {
    // The service restarts with its clock in the next slot. Nothing is held in memory: the job the
    // previous run queued is in the database and is claimed by the new instance.
    const now = () => at(SLOT + 1);
    // The next slot is an hour away on the database clock, which claims use (06 §2.1). Passing that
    // hour is simulated by moving its run_after to now, through the schema owner.
    await db.admin.query('UPDATE jobs SET run_after = now() WHERE id = $1', [
      Scheduler.jobId(task.name, SLOT + 1),
    ]);
    const restarted = instance(now);
    await restarted.scheduler.ensure();
    const r = runner(restarted.queue, restarted.scheduler, 'pg-restarted', now);
    for (let i = 0; i < 3; i++) await r.runOnce();
    expect(runs).toEqual([at(SLOT), at(SLOT + 1)]);
    const following = await restarted.queue.get(
      PLATFORM_TENANT,
      Scheduler.jobId(task.name, SLOT + 2),
    );
    expect(following?.state).toBe('queued');
  });
});
