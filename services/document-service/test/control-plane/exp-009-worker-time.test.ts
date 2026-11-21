// EXP-009 criterion 1, the queue's half, against the in-memory queue and PostgreSQL: the queue
// measures the worker time of every job, from each claim to the end of that attempt, keeps it with
// the job, and sums it for a tenant, a set of kinds and a period (`JobQueue.workerTime`).
//
// The memory queue has a clock the test moves, so its times are exact. PostgreSQL keeps the
// database's clock, so there the test waits and the times are checked within a margin.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import {
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '../../src/control-plane/jobs/queue.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Subject {
  name: string;
  queue: JobQueue;
  /** Lets `ms` pass in the queue's clock: moves it (memory) or waits (PostgreSQL). */
  pass(ms: number): Promise<void>;
  /** How much more than the time passed a measured time may be, ms: none where the clock is moved. */
  margin: number;
  /**
   * How much less it may be, ms: a timer of this process may fire a moment early by the database's
   * clock. None where the clock is moved.
   */
  slack: number;
  db?: TestDatabase;
}

async function subjects(): Promise<Array<Subject | { name: string; skip: string }>> {
  let t = Date.UTC(2026, 5, 10, 12, 0, 0);
  const memory: Subject = {
    name: 'memory',
    queue: new MemoryJobQueue(() => t),
    pass: async (ms) => {
      t += ms;
    },
    margin: 0,
    slack: 0,
  };
  const why = await postgresUnavailable();
  if (why) return [memory, { name: 'postgres', skip: why }];
  const db = await createTestDatabase();
  return [
    memory,
    {
      name: 'postgres',
      queue: new PgJobQueue(db.service),
      pass: (ms) => sleep(ms),
      margin: 1500,
      slack: 10,
      db,
    },
  ];
}

const all = await subjects();

afterAll(async () => {
  for (const s of all) if (!('skip' in s)) await s.db?.drop();
});

for (const s of all) {
  describe(`EXP-009 the worker time of a job (${s.name})`, () => {
    const skip = 'skip' in s ? s.skip : null;
    const q = () => (s as Subject).queue;
    const pass = (ms: number) => (s as Subject).pass(ms);
    const margin = 'skip' in s ? 0 : s.margin;
    const slack = 'skip' in s ? 0 : s.slack;
    const tenant = randomUUID();
    const newKind = () => `k${randomUUID().slice(0, 8)}`;
    const add = (kind: string, more: { maxAttempts?: number; tenant?: string } = {}) =>
      q().enqueue(more.tenant ?? tenant, {
        kind,
        doc: randomUUID(),
        payload: {},
        createdBy: 'user-1',
        ...(more.maxAttempts !== undefined ? { maxAttempts: more.maxAttempts } : {}),
      });
    const stored = async (job: JobRecord, t = tenant) => (await q().get(t, job.id))!;
    /** `ms` is the time that passed while a worker held the job, within the subject's margin. */
    const expectWorked = (job: JobRecord, ms: number, attempts = 1) => {
      expect(job.workerMs!).toBeGreaterThanOrEqual(ms - attempts * slack);
      expect(job.workerMs!).toBeLessThanOrEqual(ms + attempts * margin);
    };

    it.skipIf(skip)(
      'measures an attempt from its claim to its end, not from the request (criterion 1)',
      async () => {
        const kind = newKind();
        const job = await add(kind);
        expect(job.workerMs).toBe(0);
        expect(job.claimedAt ?? null).toBeNull();
        // The job waits for a worker: that is not worker time.
        await pass(200);
        const claimed = await q().claim([kind], 'w1', 60_000);
        expect(claimed?.id).toBe(job.id);
        expect(typeof claimed?.claimedAt).toBe('number');
        expect(claimed!.claimedAt! - job.createdAt).toBeGreaterThanOrEqual(200 - slack);
        expect(claimed?.workerMs).toBe(0);
        await pass(150);
        // Heartbeats and stage reports change nothing of it.
        await q().heartbeat({ tenant, id: job.id }, 'w1', 60_000, { stage: 'compiling' });
        expect((await stored(job)).workerMs).toBe(0);
        expect(await q().complete({ tenant, id: job.id }, 'w1', { output: 'o' })).toBe(true);
        const done = await stored(job);
        expectWorked(done, 150);
        expect(done.claimedAt).toBe(claimed!.claimedAt);
      },
    );

    it.skipIf(skip)(
      'adds the attempts of a job that is tried again, and counts a failed job',
      async () => {
        const kind = newKind();
        const job = await add(kind, { maxAttempts: 2 });
        await q().claim([kind], 'w1', 60_000);
        await pass(100);
        expect(
          await q().fail({ tenant, id: job.id }, 'w1', { code: 'internal', message: 'again' }, 0),
        ).toBe(true);
        const waiting = await stored(job);
        expect(waiting.state).toBe('queued');
        expectWorked(waiting, 100);
        // Waiting for the second attempt is not worker time.
        await pass(300);
        const again = await q().claim([kind], 'w1', 60_000);
        expect(again?.attempts).toBe(2);
        await pass(120);
        expect(
          await q().fail({ tenant, id: job.id }, 'w1', { code: 'internal', message: 'no' }),
        ).toBe(true);
        const failed = await stored(job);
        expect(failed.state).toBe('failed');
        expectWorked(failed, 220, 2);
      },
    );

    it.skipIf(skip)(
      'counts a job cancelled while it runs until the cancel, and nothing for one cancelled while it waits',
      async () => {
        const kind = newKind();
        const running = await add(kind);
        await q().claim([kind], 'w1', 60_000);
        await pass(130);
        expect((await q().cancel(tenant, running.id))?.state).toBe('cancelled');
        expectWorked(await stored(running), 130);
        // Its worker notices later; what it then reports is refused and adds nothing.
        await pass(100);
        expect(await q().complete({ tenant, id: running.id }, 'w1', {})).toBe(false);
        expectWorked(await stored(running), 130);

        const waiting = await add(kind);
        await pass(100);
        expect((await q().cancel(tenant, waiting.id))?.state).toBe('cancelled');
        expect((await stored(waiting)).workerMs).toBe(0);
      },
    );

    it.skipIf(skip)('does not count an attempt whose worker stopped', async () => {
      const kind = newKind();
      const job = await add(kind, { maxAttempts: 2 });
      // The first worker claims with a short lease and is never heard of again.
      await q().claim([kind], 'gone', 50);
      await pass(250);
      const second = await q().claim([kind], 'w2', 60_000);
      expect(second).toMatchObject({ id: job.id, attempts: 2, workerMs: 0 });
      await pass(110);
      expect(await q().complete({ tenant, id: job.id }, 'w2', {})).toBe(true);
      expectWorked(await stored(job), 110);

      // With no attempt left the claim fails the job, and nothing is counted for it.
      const last = await add(kind, { maxAttempts: 1 });
      await q().claim([kind], 'gone', 50);
      await pass(250);
      expect(await q().claim([kind], 'w2', 60_000)).toBeNull();
      const failed = await stored(last);
      expect(failed.state).toBe('failed');
      expect(failed.workerMs).toBe(0);
    });

    it.skipIf(skip)(
      'sums the worker time of a tenant by kind and by the time each job ended',
      async () => {
        const [exportKind, previewKind, otherKind] = [newKind(), newKind(), newKind()];
        const other = randomUUID();
        /** Runs a job of `kind` to completion with `ms` of worker time, for tenant `t`. */
        const work = async (kind: string, ms: number, t = tenant): Promise<JobRecord> => {
          const job = await add(kind, { tenant: t });
          expect((await q().claim([kind], 'w1', 60_000))?.id).toBe(job.id);
          await pass(ms);
          expect(await q().complete({ tenant: t, id: job.id }, 'w1', {})).toBe(true);
          return stored(job, t);
        };
        const a = await work(exportKind, 100);
        await pass(20);
        const b = await work(previewKind, 140);
        await pass(20);
        const c = await work(otherKind, 160);
        const theirs = await work(exportKind, 180, other);
        const kinds = [exportKind, previewKind];
        const from = a.finishedAt! - 1000;
        const to = theirs.finishedAt! + 1000;

        // Both kinds asked for, none of the third kind, none of the other tenant.
        expect(await q().workerTime(tenant, kinds, from, to)).toBe(a.workerMs! + b.workerMs!);
        expect(await q().workerTime(tenant, [exportKind], from, to)).toBe(a.workerMs);
        expect(await q().workerTime(tenant, [otherKind], from, to)).toBe(c.workerMs);
        expect(await q().workerTime(other, kinds, from, to)).toBe(theirs.workerMs);
        expect(await q().workerTime(randomUUID(), kinds, from, to)).toBe(0);
        expect(await q().workerTime(tenant, [], from, to)).toBe(0);
        // The period is from its start up to, and not with, its end, by the time a job ended.
        expect(await q().workerTime(tenant, kinds, from, a.finishedAt!)).toBe(0);
        expect(await q().workerTime(tenant, kinds, a.finishedAt!, a.finishedAt! + 1)).toBe(
          a.workerMs,
        );
        expect(await q().workerTime(tenant, kinds, a.finishedAt! + 1, to)).toBe(b.workerMs);
        expect(await q().workerTime(tenant, kinds, to, to + 1000)).toBe(0);
      },
    );

    it.skipIf(skip)(
      'counts a job only once it has ended, and nothing for a cached copy',
      async () => {
        const kind = newKind();
        const job = await add(kind, { maxAttempts: 2 });
        const sum = () => q().workerTime(tenant, [kind], 0, Date.UTC(2100, 0, 1));
        await q().claim([kind], 'w1', 60_000);
        await pass(100);
        expect(await sum()).toBe(0);
        await q().fail({ tenant, id: job.id }, 'w1', { code: 'internal', message: 'again' }, 0);
        // Queued again: its first attempt is kept with the job and counts when the job ends.
        expect(await sum()).toBe(0);
        await q().claim([kind], 'w1', 60_000);
        await pass(100);
        await q().complete({ tenant, id: job.id }, 'w1', {});
        const done = await stored(job);
        expectWorked(done, 200, 2);
        expect(await sum()).toBe(done.workerMs);
        // A job created already completed (a cached result, EXP-006) was never claimed.
        const copy = await q().enqueue(tenant, {
          kind,
          doc: randomUUID(),
          payload: {},
          createdBy: 'user-1',
          completedWith: { output: 'o' },
        });
        expect(copy.workerMs).toBe(0);
        expect(await sum()).toBe(done.workerMs);
      },
    );
  });
}
