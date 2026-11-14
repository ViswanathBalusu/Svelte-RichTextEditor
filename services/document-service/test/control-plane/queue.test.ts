// The job queue contract (BE-049), against the in-memory queue and against PostgreSQL: one
// claimant per job (FOR UPDATE SKIP LOCKED), lock expiry and attempts, run_after, dispatch by kind,
// and the tenant of the row for everything after the claim.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import { MemoryJobQueue, type JobQueue } from '../../src/control-plane/jobs/queue.ts';
import { JobFailure, JobRunner } from '../../src/control-plane/jobs/runner.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Subject {
  name: string;
  queue: JobQueue;
  /** Moves the queue's clock forward (memory) or waits (PostgreSQL uses the database clock). */
  pass(ms: number): Promise<void>;
  db?: TestDatabase;
}

async function subjects(): Promise<Array<Subject | { name: string; skip: string }>> {
  let t = Date.now();
  const memory: Subject = {
    name: 'memory',
    queue: new MemoryJobQueue(() => t),
    pass: async (ms) => {
      t += ms;
    },
  };
  const why = await postgresUnavailable();
  if (why) return [memory, { name: 'postgres', skip: why }];
  const db = await createTestDatabase();
  return [
    memory,
    { name: 'postgres', queue: new PgJobQueue(db.service), pass: (ms) => sleep(ms), db },
  ];
}

const all = await subjects();

for (const s of all) {
  describe(`job queue (${s.name})`, () => {
    const skip = 'skip' in s ? s.skip : null;
    const q = () => (s as Subject).queue;
    const tenant = randomUUID();
    const tenantB = randomUUID();
    afterAll(async () => {
      if (!('skip' in s)) await s.db?.drop();
    });
    beforeAll(() => {});

    it.skipIf(skip)('lets one worker hold a job at a time (criterion 1)', async () => {
      const kind = `k${randomUUID().slice(0, 8)}`;
      const ids = [];
      for (let i = 0; i < 6; i++)
        ids.push(
          (
            await q().enqueue(i % 2 ? tenant : tenantB, {
              kind,
              payload: { i },
              createdBy: 'system',
            })
          ).id,
        );
      const claims = await Promise.all(
        Array.from({ length: 10 }, (_, w) => q().claim([kind], `w${w}`, 60_000)),
      );
      const got = claims.filter((c) => c !== null).map((c) => c!.id);
      expect(new Set(got).size).toBe(got.length);
      expect(got.sort()).toEqual([...ids].sort());
      for (const c of claims.filter((x) => x !== null)) {
        expect(c!.state).toBe('running');
        expect(c!.lockedBy).toMatch(/^w\d$/);
        expect(c!.lockedUntil).toBeGreaterThan(c!.createdAt);
        expect(c!.attempts).toBe(1);
      }
      expect(await q().claim([kind], 'late', 60_000)).toBeNull();
    });

    it.skipIf(skip)(
      'claims a job again once its lock passed, with one more attempt, and fails it after the last (criterion 2)',
      async () => {
        const kind = `k${randomUUID().slice(0, 8)}`;
        const job = await q().enqueue(tenant, {
          kind,
          payload: {},
          createdBy: 'system',
          maxAttempts: 2,
        });
        expect((await q().claim([kind], 'a', 50))?.attempts).toBe(1);
        expect(await q().claim([kind], 'b', 50)).toBeNull();
        await (s as Subject).pass(120);
        const again = await q().claim([kind], 'b', 50);
        expect(again).toMatchObject({ id: job.id, attempts: 2, lockedBy: 'b' });
        // The first worker lost it: its heartbeat and its result are refused.
        expect(await q().heartbeat({ tenant, id: job.id }, 'a', 50)).toBe('lost');
        expect(await q().complete({ tenant, id: job.id }, 'a', {})).toBe(false);
        await (s as Subject).pass(120);
        expect(await q().claim([kind], 'c', 50)).toBeNull();
        expect(await q().get(tenant, job.id)).toMatchObject({
          state: 'failed',
          attempts: 2,
          error: { code: 'internal' },
        });
      },
    );

    it.skipIf(skip)('does not claim a job before run_after (criterion 3)', async () => {
      const kind = `k${randomUUID().slice(0, 8)}`;
      await q().enqueue(tenant, { kind, payload: {}, createdBy: 'system', delayMs: 150 });
      expect(await q().claim([kind], 'w', 1000)).toBeNull();
      await (s as Subject).pass(250);
      expect(await q().claim([kind], 'w', 1000)).not.toBeNull();
    });

    it.skipIf(skip)(
      'runs the handler of the kind, stores its outcome, and hands it the tenant of the row (criteria 4, 5)',
      async () => {
        const kind = `k${randomUUID().slice(0, 8)}`;
        const ok = await q().enqueue(tenant, { kind, payload: { n: 1 }, createdBy: 'system' });
        const bad = await q().enqueue(tenantB, {
          kind,
          payload: { n: 2 },
          createdBy: 'system',
          maxAttempts: 1,
        });
        const tenants: string[] = [];
        const runner = new JobRunner({
          queue: q(),
          worker: 'runner',
          leaseMs: 5000,
          idleMs: 10,
          retryAfterMs: 0,
          handlers: {
            [kind]: async (job, ctx) => {
              tenants.push(job.tenant);
              expect(await ctx.report('working', 50)).toBe('ok');
              if (job.payload['n'] === 2)
                throw new JobFailure('validation_failed', 'bundle refused');
              return { pages: 3 };
            },
          },
        });
        expect(await runner.runOnce()).toBe(true);
        expect(await runner.runOnce()).toBe(true);
        expect(await runner.runOnce()).toBe(false);
        expect(tenants.sort()).toEqual([tenant, tenantB].sort());
        expect(await q().get(tenant, ok.id)).toMatchObject({
          state: 'completed',
          result: { pages: 3 },
          progress: 100,
        });
        expect(await q().get(tenantB, bad.id)).toMatchObject({
          state: 'failed',
          error: { code: 'validation_failed', message: 'bundle refused' },
        });
        // Another tenant's job is invisible (row-level security, BE-011).
        expect(await q().get(tenantB, ok.id)).toBeNull();
        expect(await q().cancel(tenantB, ok.id)).toBeNull();
      },
    );

    it.skipIf(skip)(
      'retries a failed attempt when asked, and cancels queued and running jobs but not finished ones',
      async () => {
        const kind = `k${randomUUID().slice(0, 8)}`;
        const job = await q().enqueue(tenant, {
          kind,
          payload: {},
          createdBy: 'system',
          maxAttempts: 3,
        });
        await q().claim([kind], 'w', 5000);
        expect(
          await q().fail({ tenant, id: job.id }, 'w', { code: 'unavailable', message: 'retry' }, 0),
        ).toBe(true);
        expect((await q().get(tenant, job.id))?.state).toBe('queued');
        await q().claim([kind], 'w', 5000);
        expect((await q().cancel(tenant, job.id))?.state).toBe('cancelled');
        expect(await q().heartbeat({ tenant, id: job.id }, 'w', 5000)).toBe('cancelled');
        expect(await q().complete({ tenant, id: job.id }, 'w', {})).toBe(false);
        const done = await q().enqueue(tenant, { kind, payload: {}, createdBy: 'system' });
        await q().claim([kind], 'w', 5000);
        await q().complete({ tenant, id: done.id }, 'w', { ok: true });
        expect((await q().cancel(tenant, done.id))?.state).toBe('completed');
      },
    );
  });
}
