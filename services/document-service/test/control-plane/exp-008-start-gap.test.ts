// EXP-008 criteria 2 and 3, the queue's half, against the in-memory queue and PostgreSQL.
//
// Criterion 2: a job with a start gap is not claimed within the gap after the latest start of a job
// of the same tenant, document and kind, so at most one of them starts in any window of that
// length. The start is the claim, in the queue's own clock. A job that names a start stage starts
// when it reports that stage, and holds the document's other jobs until it has, so the starts of
// that stage (for a preview: its compile) are a gap apart, however long a job takes to reach it.
//
// Criterion 3: `findCompletedWith` finds the newest completed job of a document and kind whose
// result holds a given string, which is how a worker finds an earlier preview of the same bundle.
//
// The memory queue has a clock the test moves; PostgreSQL keeps the database's clock, so there the
// test waits, with a gap of 700 ms.
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import {
  MAX_START_GAP_MS,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '../../src/control-plane/jobs/queue.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Subject {
  name: string;
  queue: JobQueue;
  /** The gap the tests use, ms. */
  gap: number;
  /** Lets `ms` pass in the queue's clock: moves it (memory) or waits (PostgreSQL). */
  pass(ms: number): Promise<void>;
  /**
   * About the time of the queue's clock, ms: the clock the test moves (memory), or this machine's,
   * which the tests compare with the database's only with a margin of a minute (PostgreSQL).
   */
  now(): number;
  db?: TestDatabase;
}

async function subjects(): Promise<Array<Subject | { name: string; skip: string }>> {
  let t = Date.now();
  const memory: Subject = {
    name: 'memory',
    queue: new MemoryJobQueue(() => t),
    gap: 10_000,
    pass: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  const why = await postgresUnavailable();
  if (why) return [memory, { name: 'postgres', skip: why }];
  const db = await createTestDatabase();
  return [
    memory,
    {
      name: 'postgres',
      queue: new PgJobQueue(db.service),
      gap: 700,
      pass: (ms) => sleep(ms),
      now: () => Date.now(),
      db,
    },
  ];
}

const all = await subjects();

afterAll(async () => {
  for (const s of all) if (!('skip' in s)) await s.db?.drop();
});

for (const s of all) {
  describe(`EXP-008 the start gap of a job (${s.name})`, () => {
    const skip = 'skip' in s ? s.skip : null;
    const q = () => (s as Subject).queue;
    const gap = 'skip' in s ? 0 : s.gap;
    const pass = (ms: number) => (s as Subject).pass(ms);
    const tenant = randomUUID();

    /** A new kind for each test, so that the claims of one test never see the jobs of another. */
    const newKind = () => `p${randomUUID().slice(0, 8)}`;
    const preview = (kind: string, doc: string, t = tenant, withGap = true) =>
      q().enqueue(t, {
        kind,
        doc,
        payload: {},
        createdBy: 'user-1',
        ...(withGap ? { startGapMs: gap } : {}),
      });
    const claim = (kind: string, worker = 'w1') => q().claim([kind], worker, 60_000);

    it.skipIf(skip)(
      'starts one job of a document per gap, and each start is a gap after the one before (criterion 2)',
      async () => {
        const kind = newKind();
        const doc = randomUUID();
        const a = await preview(kind, doc);
        const b = await preview(kind, doc);
        const c = await preview(kind, doc);
        expect(a.startedAt ?? null).toBeNull();
        expect(a.startGapMs).toBe(gap);

        const first = await claim(kind);
        expect(first?.id).toBe(a.id);
        expect(typeof first?.startedAt).toBe('number');
        // Inside the gap nothing more of this document starts, however often a worker asks.
        expect(await claim(kind)).toBeNull();
        await pass(gap / 2);
        expect(await claim(kind)).toBeNull();
        // The waiting jobs are held until the gap has passed since the start.
        const held = await q().get(tenant, b.id);
        expect(held?.state).toBe('queued');
        expect(held!.runAfter).toBeGreaterThanOrEqual(first!.startedAt! + gap);

        await pass(gap / 2 + 60);
        const second = await claim(kind);
        expect(second?.id).toBe(b.id);
        expect(second!.startedAt! - first!.startedAt!).toBeGreaterThanOrEqual(gap);
        expect(await claim(kind)).toBeNull();

        await pass(gap + 60);
        const third = await claim(kind);
        expect(third?.id).toBe(c.id);
        expect(third!.startedAt! - second!.startedAt!).toBeGreaterThanOrEqual(gap);
      },
    );

    it.skipIf(skip)(
      'counts the gap from the start of the earlier job, not from the time it was asked for',
      async () => {
        const kind = newKind();
        const doc = randomUUID();
        const a = await preview(kind, doc);
        const b = await preview(kind, doc);
        // No worker is free for longer than the gap: both jobs have waited that long.
        await pass(gap + 60);
        const first = await claim(kind);
        expect(first?.id).toBe(a.id);
        // The second job was asked for more than a gap ago, and still does not start now.
        expect(first!.startedAt! - b.createdAt).toBeGreaterThanOrEqual(gap);
        expect(await claim(kind)).toBeNull();
        await pass(gap + 60);
        const second = await claim(kind);
        expect(second?.id).toBe(b.id);
        expect(second!.startedAt! - first!.startedAt!).toBeGreaterThanOrEqual(gap);
      },
    );

    it.skipIf(skip)(
      'holds only the same tenant, document and kind; a held job lets the others through',
      async () => {
        const kind = newKind();
        const otherKind = newKind();
        const doc = randomUUID();
        const otherTenant = randomUUID();
        const first = await preview(kind, doc);
        expect((await claim(kind))?.id).toBe(first.id);
        const held = await preview(kind, doc);
        const otherDoc = await preview(kind, randomUUID());
        const sameDocOtherKind = await preview(otherKind, doc);
        const sameDocOtherTenant = await preview(kind, doc, otherTenant);
        const got = [await claim(kind), await claim(kind), await claim(otherKind)].map(
          (j) => j?.id,
        );
        expect(got.slice(0, 2).sort()).toEqual([otherDoc.id, sameDocOtherTenant.id].sort());
        expect(got[2]).toBe(sameDocOtherKind.id);
        expect(await claim(kind)).toBeNull();
        expect((await q().get(tenant, held.id))?.state).toBe('queued');
      },
    );

    it.skipIf(skip)(
      'does not hold a job that carries no gap or names no document, and counts their starts',
      async () => {
        const kind = newKind();
        const doc = randomUUID();
        const first = await preview(kind, doc);
        expect((await claim(kind))?.id).toBe(first.id);
        // A job without the rule starts at once, although one of the document has just started.
        const free = await preview(kind, doc, tenant, false);
        expect(free.startGapMs ?? null).toBeNull();
        expect((await claim(kind))?.id).toBe(free.id);
        // A job with a gap but no document is not held either: there is nothing to count against.
        const noDoc = await q().enqueue(tenant, {
          kind,
          payload: {},
          createdBy: 'system',
          startGapMs: gap,
        });
        expect((await claim(kind))?.id).toBe(noDoc.id);
        // The start of the job without the rule counts for the next job that has it.
        const next = await preview(kind, doc);
        expect(await claim(kind)).toBeNull();
        await pass(gap + 60);
        expect((await claim(kind))?.id).toBe(next.id);
      },
    );

    it.skipIf(skip)('lets only one of several workers start a job of the document', async () => {
      const kind = newKind();
      const doc = randomUUID();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push((await preview(kind, doc)).id);
      const claims = await Promise.all(Array.from({ length: 6 }, (_, w) => claim(kind, `w${w}`)));
      const got = claims.filter((c): c is JobRecord => c !== null);
      expect(got).toHaveLength(1);
      expect(ids).toContain(got[0]!.id);
    });

    it.skipIf(skip)(
      'answers every one of many claims at once over several held documents, and then starts one job of each',
      async () => {
        // Several workers that each look at the waiting jobs of several documents in one claim. No
        // claim waits for a document while it holds another, so none can fail with a deadlock.
        const kind = newKind();
        const docs = [randomUUID(), randomUUID(), randomUUID()];
        for (const doc of docs) await preview(kind, doc);
        const firsts = [await claim(kind), await claim(kind), await claim(kind)];
        expect(firsts.map((j) => j?.doc).sort()).toEqual([...docs].sort());
        for (const doc of docs) for (let i = 0; i < 3; i++) await preview(kind, doc);
        const inside = await Promise.all(Array.from({ length: 8 }, (_, w) => claim(kind, `w${w}`)));
        expect(inside.every((j) => j === null)).toBe(true);
        await pass(gap + 60);
        const after = (
          await Promise.all(Array.from({ length: 8 }, (_, w) => claim(kind, `w${w}`)))
        ).filter((j): j is JobRecord => j !== null);
        // At most one start of each document, however the claims interleave.
        const started = after.map((j) => j.doc);
        expect(new Set(started).size).toBe(started.length);
        for (const j of after) {
          const first = firsts.find((f) => f!.doc === j.doc)!;
          expect(j.startedAt! - first.startedAt!).toBeGreaterThanOrEqual(gap);
        }
        // Whatever these claims left is started by the claims that follow, one of each document.
        const later = [...after];
        for (let i = 0; i < 6 && later.length < docs.length; i++) {
          const j = await claim(kind);
          if (j) later.push(j);
        }
        expect(later.map((j) => j.doc).sort()).toEqual([...docs].sort());
        expect(await claim(kind)).toBeNull();
      },
    );

    it.skipIf(skip)('holds a job that is tried again until a gap after its own start', async () => {
      const kind = newKind();
      const doc = randomUUID();
      const job = await q().enqueue(tenant, {
        kind,
        doc,
        payload: {},
        createdBy: 'user-1',
        maxAttempts: 2,
        startGapMs: gap,
      });
      const first = await claim(kind);
      expect(first?.id).toBe(job.id);
      expect(
        await q().fail({ tenant, id: job.id }, 'w1', { code: 'internal', message: 'again' }, 0),
      ).toBe(true);
      expect((await q().get(tenant, job.id))?.state).toBe('queued');
      expect(await claim(kind)).toBeNull();
      await pass(gap + 60);
      const again = await claim(kind);
      expect(again?.id).toBe(job.id);
      expect(again?.attempts).toBe(2);
      expect(again!.startedAt! - first!.startedAt!).toBeGreaterThanOrEqual(gap);
    });

    it.skipIf(skip)(
      'refuses a gap that is not a whole number of milliseconds, or over a day',
      async () => {
        for (const startGapMs of [-1, 1.5, Number.NaN, MAX_START_GAP_MS + 1])
          await expect(
            (async () =>
              q().enqueue(tenant, { kind: 'k', payload: {}, createdBy: 'system', startGapMs }))(),
          ).rejects.toThrow(/start gap/);
      },
    );

    it.skipIf(skip)(
      'refuses a start stage without a gap, or one that is not a stage name',
      async () => {
        const bad = [
          { startGapStage: 'compiling' },
          { startGapMs: gap, startGapStage: 'Compiling' },
          { startGapMs: gap, startGapStage: '' },
        ];
        for (const more of bad)
          await expect(
            (async () =>
              q().enqueue(tenant, { kind: 'k', payload: {}, createdBy: 'system', ...more }))(),
          ).rejects.toThrow(/start gap stage/);
      },
    );
  });

  describe(`EXP-008 the start stage of a job (${s.name})`, () => {
    const skip = 'skip' in s ? s.skip : null;
    const q = () => (s as Subject).queue;
    const gap = 'skip' in s ? 0 : s.gap;
    const pass = (ms: number) => (s as Subject).pass(ms);
    const tenant = randomUUID();
    const STAGE = 'compiling';
    const newKind = () => `s${randomUUID().slice(0, 8)}`;
    /** A job whose start is the time it reports `compiling`, as a preview's is. */
    const preview = (kind: string, doc: string, more: { maxAttempts?: number } = {}) =>
      q().enqueue(tenant, {
        kind,
        doc,
        payload: {},
        createdBy: 'user-1',
        startGapMs: gap,
        startGapStage: STAGE,
        ...more,
      });
    // A lease far longer than the test: a job holds the document for as long as its lock lives.
    const claim = (kind: string, worker = 'w1') => q().claim([kind], worker, 600_000);
    const report = (job: JobRecord, stage: string, worker = 'w1') =>
      q().heartbeat({ tenant, id: job.id }, worker, 600_000, { stage, progress: 10 });
    const stored = async (job: JobRecord) => (await q().get(tenant, job.id))!;

    it.skipIf(skip)(
      'counts the gap from the time a job reports its start stage, and holds the document until it has (criterion 2)',
      async () => {
        const kind = newKind();
        const doc = randomUUID();
        const a = await preview(kind, doc);
        const b = await preview(kind, doc);
        expect(a.startGapStage).toBe(STAGE);
        const first = await claim(kind);
        expect(first?.id).toBe(a.id);
        // The first job takes longer than the gap to reach its stage. The second is not claimed,
        // although the gap has passed since the first was claimed: the stage may begin any moment.
        await pass(gap + 60);
        expect(await claim(kind, 'w2')).toBeNull();
        expect(await report(a, 'converting')).toBe('ok');
        expect((await stored(a)).startedAt).toBe(first!.startedAt);
        expect(await claim(kind, 'w2')).toBeNull();
        // It reports the stage: that is its start, later than its claim by more than the gap.
        expect(await report(a, STAGE)).toBe('ok');
        const startA = (await stored(a)).startedAt!;
        expect(startA - first!.startedAt!).toBeGreaterThanOrEqual(gap);
        // A second report of the same stage does not move the start.
        await pass(40);
        expect(await report(a, STAGE)).toBe('ok');
        expect((await stored(a)).startedAt).toBe(startA);
        // The second job now waits a gap from that start, not from the claim.
        expect(await claim(kind, 'w2')).toBeNull();
        expect((await stored(b)).runAfter).toBeGreaterThanOrEqual(startA + gap);
        await pass(gap + 60);
        const second = await claim(kind, 'w2');
        expect(second?.id).toBe(b.id);
        expect(second!.startedAt! - startA).toBeGreaterThanOrEqual(gap);
        expect(await report(b, STAGE, 'w2')).toBe('ok');
        const startB = (await stored(b)).startedAt!;
        expect(startB - startA).toBeGreaterThanOrEqual(gap);
      },
    );

    it.skipIf(skip)(
      'stops holding the document when the job ends without its stage, and counts its claim as its start',
      async () => {
        const kind = newKind();
        const doc = randomUUID();
        const a = await preview(kind, doc);
        const b = await preview(kind, doc);
        const c = await preview(kind, doc);
        const first = await claim(kind);
        expect(first?.id).toBe(a.id);
        await pass(gap + 60);
        expect(await claim(kind, 'w2')).toBeNull();
        // It ends without a compile (for a preview: an earlier preview's files were shown).
        expect(await q().complete({ tenant, id: a.id }, 'w1', { output: 'output.pdf' })).toBe(true);
        const second = await claim(kind, 'w2');
        expect(second?.id).toBe(b.id);
        expect(second!.startedAt! - first!.startedAt!).toBeGreaterThanOrEqual(gap);
        // A cancelled job does not hold the document either; its claim still counts for the gap.
        await q().cancel(tenant, b.id);
        expect(await claim(kind, 'w3')).toBeNull();
        await pass(gap + 60);
        expect((await claim(kind, 'w3'))?.id).toBe(c.id);
      },
    );

    it.skipIf(skip)(
      'treats a job that is tried again as not started until it reports the stage again',
      async () => {
        const kind = newKind();
        const doc = randomUUID();
        const a = await preview(kind, doc, { maxAttempts: 2 });
        const b = await preview(kind, doc);
        expect((await claim(kind))?.id).toBe(a.id);
        expect(await report(a, STAGE)).toBe('ok');
        const startA = (await stored(a)).startedAt!;
        expect(
          await q().fail({ tenant, id: a.id }, 'w1', { code: 'internal', message: 'again' }, 0),
        ).toBe(true);
        // Inside the gap after its own start neither it nor the other job is claimed.
        expect(await claim(kind)).toBeNull();
        await pass(gap + 60);
        const again = await claim(kind);
        expect(again?.id).toBe(a.id);
        expect(again?.attempts).toBe(2);
        // The new attempt has reported nothing: the stage of the first attempt is cleared.
        expect(again?.stage).toBeNull();
        expect(again!.startedAt! - startA).toBeGreaterThanOrEqual(gap);
        await pass(gap + 60);
        expect(await claim(kind, 'w2')).toBeNull();
        expect(await report(a, STAGE)).toBe('ok');
        const restart = (await stored(a)).startedAt!;
        expect(restart - again!.startedAt!).toBeGreaterThanOrEqual(gap);
        expect(await claim(kind, 'w2')).toBeNull();
        await pass(gap + 60);
        expect((await claim(kind, 'w2'))?.id).toBe(b.id);
      },
    );

    it.skipIf(skip)(
      'holds only jobs of the same document and kind, and leaves a job without a stage as it was',
      async () => {
        const kind = newKind();
        const doc = randomUUID();
        const a = await preview(kind, doc);
        expect((await claim(kind))?.id).toBe(a.id);
        // Another document of the kind is claimed while the first job has not reported its stage.
        const other = await preview(kind, randomUUID());
        expect((await claim(kind, 'w2'))?.id).toBe(other.id);
        // A job without a start stage keeps the stage and progress of its earlier attempt when it
        // is claimed again, as before.
        const plainKind = newKind();
        const plain = await q().enqueue(tenant, {
          kind: plainKind,
          doc,
          payload: {},
          createdBy: 'user-1',
          maxAttempts: 2,
        });
        const claimed = await q().claim([plainKind], 'w3', 600_000);
        expect(claimed?.id).toBe(plain.id);
        expect(typeof claimed?.startedAt).toBe('number');
        await pass(40);
        await q().heartbeat({ tenant, id: plain.id }, 'w3', 600_000, {
          stage: STAGE,
          progress: 60,
        });
        // No start stage: reporting a stage does not move the start.
        expect((await stored(plain)).startedAt).toBe(claimed!.startedAt);
        await q().fail({ tenant, id: plain.id }, 'w3', { code: 'internal', message: 'again' }, 0);
        const again = await q().claim([plainKind], 'w3', 600_000);
        expect(again).toMatchObject({ id: plain.id, stage: STAGE, progress: 60 });
      },
    );
  });

  describe(`EXP-008 finding an earlier job by a member of its result (${s.name})`, () => {
    const skip = 'skip' in s ? s.skip : null;
    const q = () => (s as Subject).queue;
    const tenant = randomUUID();
    const other = randomUUID();

    /** Runs one job of `kind` to completion with `result`. */
    async function completed(
      kind: string,
      doc: string,
      result: Record<string, unknown>,
      t = tenant,
    ): Promise<JobRecord> {
      const job = await q().enqueue(t, { kind, doc, payload: {}, createdBy: 'user-1' });
      const got = await q().claim([kind], 'w1', 60_000);
      expect(got?.id).toBe(job.id);
      expect(await q().complete({ tenant: t, id: job.id }, 'w1', result)).toBe(true);
      return (await q().get(t, job.id))!;
    }

    it.skipIf(skip)(
      'finds the newest completed job of the document and kind with that value, and no other (criterion 3)',
      async () => {
        const kind = `p${randomUUID().slice(0, 8)}`;
        const otherKind = `x${randomUUID().slice(0, 8)}`;
        const doc = randomUUID();
        const key = 'ab'.repeat(32);
        // The queue's own clock: the tests above have moved the one of the memory queue.
        const now = () => (s as Subject).now();
        const since = now() - 60 * 60 * 1000;
        const find = (d = doc, k = kind, v = key, t = tenant, from = since) =>
          q().findCompletedWith(t, d, k, 'previewKey', v, from);

        expect(await find()).toBeNull();
        const first = await completed(kind, doc, { output: 'output.pdf', previewKey: key });
        expect((await find())?.id).toBe(first.id);
        await (s as Subject).pass(5);
        const second = await completed(kind, doc, { output: 'output.pdf', previewKey: key });
        expect(second.finishedAt!).toBeGreaterThan(first.finishedAt!);
        expect((await find())?.id).toBe(second.id);

        // Not another value, another document, another kind or another tenant.
        expect(await find(doc, kind, 'cd'.repeat(32))).toBeNull();
        expect(await find(randomUUID())).toBeNull();
        expect(await find(doc, otherKind)).toBeNull();
        expect(await find(doc, kind, key, other)).toBeNull();
        await completed(otherKind, doc, { previewKey: key });
        await completed(kind, doc, { previewKey: key }, other);
        expect((await find())?.id).toBe(second.id);
        expect((await find(doc, kind, key, other))?.tenant).toBe(other);

        // Not a job that finished before `since`.
        expect(await find(doc, kind, key, tenant, now() + 60_000)).toBeNull();
      },
    );

    it.skipIf(skip)(
      'does not find a job that is waiting, failed or cancelled, or a value that is not a string',
      async () => {
        const kind = `p${randomUUID().slice(0, 8)}`;
        const doc = randomUUID();
        const find = (v: string) => q().findCompletedWith(tenant, doc, kind, 'previewKey', v, 0);
        // A number in the result is not the string of the same digits.
        await completed(kind, doc, { previewKey: 5 });
        expect(await find('5')).toBeNull();
        // A job that failed with the key in its result.
        const failed = await q().enqueue(tenant, { kind, doc, payload: {}, createdBy: 'u' });
        await q().claim([kind], 'w1', 60_000);
        await q().fail(
          { tenant, id: failed.id },
          'w1',
          { code: 'internal', message: 'no' },
          undefined,
          {
            previewKey: 'k-failed',
          },
        );
        expect(await find('k-failed')).toBeNull();
        // A queued job has no result at all.
        await q().enqueue(tenant, {
          kind,
          doc,
          payload: { previewKey: 'k-queued' },
          createdBy: 'u',
        });
        expect(await find('k-queued')).toBeNull();
        // A document identifier that is not one names no job.
        expect(
          await q().findCompletedWith(tenant, 'not-a-document', kind, 'previewKey', '5', 0),
        ).toBeNull();
      },
    );
  });
}

describe('EXP-008 the start gap, for any order of requests and claims (memory, property)', () => {
  it('never starts two jobs of one document and kind within the gap', async () => {
    const GAP = 10_000;
    const step = fc.oneof(
      fc.record({ op: fc.constant('ask' as const), doc: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ op: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 12_000 }) }),
      fc.record({ op: fc.constant('claim' as const) }),
      fc.record({ op: fc.constant('finish' as const) }),
      fc.record({ op: fc.constant('retry' as const) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 60 }), async (steps) => {
        let now = 1_000_000;
        const queue = new MemoryJobQueue(() => now);
        const tenant = 'tenant-1';
        const starts = new Map<string, number[]>();
        const running: JobRecord[] = [];
        for (const s of steps) {
          if (s.op === 'ask')
            await queue.enqueue(tenant, {
              kind: 'preview',
              doc: `doc-${s.doc}`,
              payload: {},
              createdBy: 'u',
              maxAttempts: 3,
              startGapMs: GAP,
            });
          else if (s.op === 'wait') now += s.ms;
          else if (s.op === 'claim') {
            const job = await queue.claim(['preview'], 'w', 60_000);
            if (job) {
              running.push(job);
              starts.set(job.doc!, [...(starts.get(job.doc!) ?? []), job.startedAt!]);
            }
          } else if (s.op === 'finish') {
            const job = running.shift();
            if (job) await queue.complete({ tenant, id: job.id }, 'w', {});
          } else {
            const job = running.shift();
            if (job)
              await queue.fail({ tenant, id: job.id }, 'w', { code: 'internal', message: 'x' }, 0);
          }
        }
        for (const times of starts.values())
          for (let i = 1; i < times.length; i++)
            expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(GAP);
      }),
      { numRuns: 300 },
    );
  });

  it('never starts the stage of two jobs of one document within the gap, however long each takes to reach it', async () => {
    const GAP = 10_000;
    // A lease longer than any run: a job whose lock ran out is another case (see the ADR).
    const LEASE = 24 * 60 * 60 * 1000;
    const step = fc.oneof(
      fc.record({ op: fc.constant('ask' as const), doc: fc.integer({ min: 0, max: 2 }) }),
      fc.record({ op: fc.constant('wait' as const), ms: fc.integer({ min: 0, max: 12_000 }) }),
      fc.record({ op: fc.constant('claim' as const) }),
      fc.record({ op: fc.constant('claim' as const) }),
      fc.record({ op: fc.constant('compile' as const) }),
      fc.record({ op: fc.constant('compile' as const) }),
      fc.record({ op: fc.constant('finish' as const) }),
      fc.record({ op: fc.constant('retry' as const) }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 80 }), async (steps) => {
        let now = 1_000_000;
        const queue = new MemoryJobQueue(() => now);
        const tenant = 'tenant-1';
        /** The jobs a worker holds, in the order they were claimed, and whether each compiles. */
        const running: Array<{ job: JobRecord; compiling: boolean }> = [];
        /** The latest claim or compile start of each document. */
        const latest = new Map<string, number>();
        const compiles = new Map<string, number[]>();
        for (const s of steps) {
          if (s.op === 'ask')
            await queue.enqueue(tenant, {
              kind: 'preview',
              doc: `doc-${s.doc}`,
              payload: {},
              createdBy: 'u',
              maxAttempts: 3,
              startGapMs: GAP,
              startGapStage: 'compiling',
            });
          else if (s.op === 'wait') now += s.ms;
          else if (s.op === 'claim') {
            const job = await queue.claim(['preview'], 'w', LEASE);
            if (job) {
              const doc = job.doc!;
              // No job of the document is taken while another has yet to start its compile.
              expect(running.some((r) => r.job.doc === doc && !r.compiling)).toBe(false);
              const last = latest.get(doc);
              if (last !== undefined) expect(now - last).toBeGreaterThanOrEqual(GAP);
              expect(job.startedAt).toBe(now);
              expect(job.stage).toBeNull();
              latest.set(doc, now);
              running.push({ job, compiling: false });
            }
          } else if (s.op === 'compile') {
            const r = running.find((x) => !x.compiling);
            if (r) {
              expect(
                await queue.heartbeat({ tenant, id: r.job.id }, 'w', LEASE, { stage: 'compiling' }),
              ).toBe('ok');
              r.compiling = true;
              const doc = r.job.doc!;
              expect((await queue.get(tenant, r.job.id))?.startedAt).toBe(now);
              latest.set(doc, now);
              compiles.set(doc, [...(compiles.get(doc) ?? []), now]);
            }
          } else {
            const r = running.shift();
            if (!r) continue;
            if (s.op === 'finish') await queue.complete({ tenant, id: r.job.id }, 'w', {});
            else
              await queue.fail(
                { tenant, id: r.job.id },
                'w',
                { code: 'internal', message: 'x' },
                0,
              );
          }
        }
        for (const times of compiles.values())
          for (let i = 1; i < times.length; i++)
            expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(GAP);
      }),
      { numRuns: 300 },
    );
  });
});
