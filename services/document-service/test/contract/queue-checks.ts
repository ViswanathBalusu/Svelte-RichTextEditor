/**
 * Contract checks for the `Queue` port of 06 §14 (declared as `JobQueue`; BE-002, BE-049, BE-050,
 * EXP-006, EXP-007). Like the storage checks of `checks.ts` they are plain async functions that
 * throw on a violation, so the same list runs against the in-memory queue, against PostgreSQL,
 * against any other implementation (a managed queue, BE-072), and against deliberately wrong
 * queues, to show that the suite catches them.
 *
 * A check makes job kinds of its own, so that checks that share one queue (one database) do not
 * take each other's jobs: a claim names its kinds, and `depth` is read for one kind.
 *
 * Time: a lock, a delay and a retry are judged by the queue's own clock (the database's, for
 * PostgreSQL). The harness lets time pass on that clock: a test clock moves, a real one is waited
 * for. Where a check says that something has not happened yet, the lease or delay it uses leaves
 * several hundred milliseconds of margin, so that a busy machine does not fail it.
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { JobQueue, JobRecord, NewJob } from '../../src/control-plane/jobs/queue.ts';

export interface QueueHarness {
  queue: JobQueue;
  tenant: string;
  otherTenant: string;
  /** Lets `ms` milliseconds pass on the clock the queue judges locks and delays by. */
  pass(ms: number): Promise<void>;
}

export interface QueueCheck {
  name: string;
  run(h: QueueHarness): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A lease no check outlives: the job stays its worker's for the whole check. */
const HELD = 60_000;
/** A lease that passes quickly, and the wait after which it has certainly passed. */
const BRIEF = 40;
const AFTER_BRIEF = 160;

const newKind = (): string => `k${randomBytes(6).toString('hex')}`;
const cacheKey = (): string => randomBytes(32).toString('hex');
const UNAVAILABLE = { code: 'unavailable', message: 'the store did not answer' };

/** Enqueues a plain job of `kind` for `tenant`. */
function put(
  h: QueueHarness,
  kind: string,
  over: Partial<NewJob> = {},
  tenant = h.tenant,
): Promise<JobRecord> {
  return h.queue.enqueue(tenant, { kind, payload: {}, createdBy: 'system', ...over });
}

async function claimed(h: QueueHarness, kind: string, worker: string, lease = HELD) {
  const job = await h.queue.claim([kind], worker, lease);
  assert.ok(job, `a job of ${kind} was ready for ${worker}`);
  return job;
}

export const QUEUE_CHECKS: QueueCheck[] = [
  {
    name: 'a new job is queued with the defaults and is read back by its tenant only',
    async run(h) {
      const kind = newKind();
      const doc = randomUUID();
      const payload = { n: 1, nested: { list: [1, 'two', null], flag: true } };
      const job = await h.queue.enqueue(h.tenant, { kind, doc, payload, createdBy: 'u-1' });
      assert.match(job.id, UUID);
      const { id, createdAt, updatedAt, runAfter, ...rest } = job;
      assert.deepStrictEqual(rest, {
        tenant: h.tenant,
        doc,
        kind,
        state: 'queued',
        stage: null,
        progress: null,
        payload,
        result: null,
        error: null,
        attempts: 0,
        maxAttempts: 3,
        lockedBy: null,
        lockedUntil: null,
        createdBy: 'u-1',
        finishedAt: null,
        priority: 0,
        cacheKey: null,
      });
      for (const t of [createdAt, updatedAt, runAfter]) assert.ok(Number.isSafeInteger(t));
      assert.deepStrictEqual(await h.queue.get(h.tenant, id), job);
      // Another tenant, an unknown identifier and a malformed one all name no job.
      assert.equal(await h.queue.get(h.otherTenant, id), null);
      assert.equal(await h.queue.get(h.tenant, randomUUID()), null);
      assert.equal(await h.queue.get(h.tenant, 'not-an-identifier'), null);

      // A job without a document, with an identifier and limits of the caller's choosing.
      const chosen = randomUUID();
      const other = await put(h, kind, { id: chosen, maxAttempts: 7, priority: -2 });
      assert.deepStrictEqual(
        { id: other.id, doc: other.doc, maxAttempts: other.maxAttempts, priority: other.priority },
        { id: chosen, doc: null, maxAttempts: 7, priority: -2 },
      );
    },
  },
  {
    name: 'a job the port cannot hold is refused and nothing is stored',
    async run(h) {
      const kind = newKind();
      const refused: Array<Partial<NewJob>> = [
        { kind: 'Not A Kind' },
        { kind: '' },
        { maxAttempts: 0 },
        { maxAttempts: 1.5 },
        { priority: 0.5 },
        { cacheKey: 'not-a-hash' },
        { notBefore: Number.NaN },
      ];
      for (const over of refused) {
        const id = randomUUID();
        await assert.rejects(
          async () => put(h, kind, { id, ...over }),
          RangeError,
          JSON.stringify(over),
        );
        assert.equal(await h.queue.get(h.tenant, id), null, JSON.stringify(over));
      }
      assert.equal(await h.queue.claim([kind], 'w', HELD), null);
    },
  },
  {
    name: 'an identifier in use is refused, or its job is returned unchanged when asked for',
    async run(h) {
      const kind = newKind();
      const id = randomUUID();
      const first = await put(h, kind, { id, payload: { v: 1 } });
      await assert.rejects(async () => put(h, kind, { id, payload: { v: 2 } }));
      assert.deepStrictEqual(await h.queue.get(h.tenant, id), first);

      // `ifAbsent` (the scheduler's deterministic identifiers): the job that exists, and no second.
      assert.deepStrictEqual(await put(h, kind, { id, payload: { v: 2 }, ifAbsent: true }), first);
      const running = await claimed(h, kind, 'w');
      assert.equal(running.id, id);
      const again = await put(h, kind, { id, payload: { v: 3 }, ifAbsent: true });
      assert.deepStrictEqual(
        { state: again.state, attempts: again.attempts, payload: again.payload },
        { state: 'running', attempts: 1, payload: { v: 1 } },
      );
      assert.equal(await h.queue.claim([kind], 'w2', HELD), null);

      // Another tenant never gets the job, with or without `ifAbsent`.
      await assert.rejects(async () => put(h, kind, { id, ifAbsent: true }, h.otherTenant));
      await assert.rejects(async () => put(h, kind, { id }, h.otherTenant));
      assert.equal(await h.queue.get(h.otherTenant, id), null);
      assert.equal((await h.queue.get(h.tenant, id))?.state, 'running');
    },
  },
  {
    name: 'one worker holds a job at a time, and a claim carries the tenant of the job',
    async run(h) {
      const kind = newKind();
      const owner = new Map<string, string>();
      for (let i = 0; i < 6; i++) {
        const tenant = i % 2 ? h.tenant : h.otherTenant;
        owner.set((await put(h, kind, { payload: { i } }, tenant)).id, tenant);
      }
      const claims = await Promise.all(
        Array.from({ length: 10 }, (_, w) => h.queue.claim([kind], `w${w}`, HELD)),
      );
      const got = claims.filter((c): c is JobRecord => c !== null);
      assert.equal(new Set(got.map((c) => c.id)).size, got.length, 'no job was claimed twice');
      assert.deepStrictEqual(got.map((c) => c.id).sort(), [...owner.keys()].sort());
      for (const [w, c] of claims.entries()) {
        if (!c) continue;
        assert.deepStrictEqual(
          { state: c.state, attempts: c.attempts, lockedBy: c.lockedBy, tenant: c.tenant },
          { state: 'running', attempts: 1, lockedBy: `w${w}`, tenant: owner.get(c.id) },
        );
        assert.ok(c.lockedUntil !== null && c.lockedUntil > c.createdAt);
        assert.deepStrictEqual(await h.queue.get(c.tenant, c.id), c);
      }
      assert.equal(await h.queue.claim([kind], 'late', HELD), null);
    },
  },
  {
    name: 'a claim takes only the kinds it names, the highest priority first, then the one ready longest',
    async run(h) {
      const kind = newKind();
      const otherKind = newKind();
      // Ready in this order: `early`, then `late`; `urgent` is enqueued last and outranks both.
      const early = await put(h, kind, { delayMs: 0 });
      const late = await put(h, kind, { delayMs: 60 });
      const elsewhere = await put(h, otherKind, { priority: 9 });
      const urgent = await put(h, kind, { priority: 5 }, h.otherTenant);
      await h.pass(200);

      assert.equal(await h.queue.claim([], 'w', HELD), null);
      const order = [];
      for (let i = 0; i < 3; i++) order.push((await h.queue.claim([kind], 'w', HELD))?.id);
      assert.deepStrictEqual(order, [urgent.id, early.id, late.id]);
      assert.equal(await h.queue.claim([kind], 'w', HELD), null);
      // The job of the other kind was never offered to a claim that did not name its kind.
      assert.equal((await h.queue.get(h.tenant, elsewhere.id))?.state, 'queued');
      assert.equal((await h.queue.claim([kind, otherKind], 'w', HELD))?.id, elsewhere.id);
    },
  },
  {
    name: 'a job is not claimed before its delay or its notBefore, whichever is later',
    async run(h) {
      const delayed = newKind();
      const held = newKind();
      const both = newKind();
      const reference = await put(h, newKind());
      const a = await put(h, delayed, { delayMs: 500 });
      // A time in the queue's own clock: taken from a record the queue returned (BE-051).
      const b = await put(h, held, { notBefore: reference.createdAt + 500 });
      const c = await put(h, both, { delayMs: 1500, notBefore: reference.createdAt + 100 });
      assert.ok(a.runAfter >= a.createdAt + 500);
      assert.ok(b.runAfter >= reference.createdAt + 500);
      assert.ok(c.runAfter >= c.createdAt + 1500);

      for (const kind of [delayed, held, both])
        assert.equal(await h.queue.claim([kind], 'w', HELD), null, 'nothing is ready yet');
      await h.pass(700);
      assert.equal((await h.queue.claim([delayed], 'w', HELD))?.id, a.id);
      assert.equal((await h.queue.claim([held], 'w', HELD))?.id, b.id);
      assert.equal(await h.queue.claim([both], 'w', HELD), null, 'the later of the two applies');
      await h.pass(1100);
      assert.equal((await h.queue.claim([both], 'w', HELD))?.id, c.id);
    },
  },
  {
    name: 'a lock that has passed gives the job to another worker with one more attempt, until none is left',
    async run(h) {
      const kind = newKind();
      const job = await put(h, kind, { maxAttempts: 2 });
      const ref = { tenant: h.tenant, id: job.id };

      // While the lock holds, nobody else gets the job.
      const guarded = await put(h, newKind());
      await claimed(h, guarded.kind, 'a');
      assert.equal(await h.queue.claim([guarded.kind], 'b', HELD), null);

      assert.equal((await claimed(h, kind, 'a', BRIEF)).attempts, 1);
      await h.pass(AFTER_BRIEF);
      const second = await claimed(h, kind, 'b', BRIEF);
      assert.deepStrictEqual(
        { id: second.id, attempts: second.attempts, lockedBy: second.lockedBy },
        { id: job.id, attempts: 2, lockedBy: 'b' },
      );
      // The first worker lost the job: its heartbeat, its result and its failure are refused.
      assert.equal(await h.queue.heartbeat(ref, 'a', HELD), 'lost');
      assert.equal(await h.queue.complete(ref, 'a', { late: true }), false);
      assert.equal(await h.queue.fail(ref, 'a', UNAVAILABLE, 0), false);
      assert.equal((await h.queue.get(h.tenant, job.id))?.lockedBy, 'b');

      // The second worker stops too. No attempt is left: the job fails instead of running again.
      await h.pass(AFTER_BRIEF);
      assert.equal(await h.queue.claim([kind], 'c', HELD), null);
      const failed = await h.queue.get(h.tenant, job.id);
      assert.deepStrictEqual(
        {
          state: failed?.state,
          attempts: failed?.attempts,
          code: failed?.error?.code,
          lockedBy: failed?.lockedBy,
          lockedUntil: failed?.lockedUntil,
        },
        { state: 'failed', attempts: 2, code: 'internal', lockedBy: null, lockedUntil: null },
      );
      assert.ok(failed?.finishedAt);
      assert.equal(await h.queue.claim([kind], 'c', HELD), null);
    },
  },
  {
    name: 'a heartbeat renews the lock and records the stage and the progress',
    async run(h) {
      const kind = newKind();
      const job = await put(h, kind);
      const ref = { tenant: h.tenant, id: job.id };
      const first = await claimed(h, kind, 'a', 2000);
      await h.pass(1200);
      assert.equal(
        await h.queue.heartbeat(ref, 'a', 2000, { stage: 'compiling', progress: 40 }),
        'ok',
      );
      // Past the first lease, and still the first worker's: the heartbeat moved the lock.
      await h.pass(1200);
      assert.equal(await h.queue.claim([kind], 'b', HELD), null);
      const now = await h.queue.get(h.tenant, job.id);
      assert.deepStrictEqual(
        { state: now?.state, stage: now?.stage, progress: now?.progress, lockedBy: now?.lockedBy },
        { state: 'running', stage: 'compiling', progress: 40, lockedBy: 'a' },
      );
      assert.ok((now?.lockedUntil ?? 0) > (first.lockedUntil ?? 0));

      // A heartbeat without a report keeps what was reported; a report of one keeps the other.
      assert.equal(await h.queue.heartbeat(ref, 'a', HELD), 'ok');
      assert.equal(await h.queue.heartbeat(ref, 'a', HELD, { progress: 70 }), 'ok');
      const later = await h.queue.get(h.tenant, job.id);
      assert.deepStrictEqual([later?.stage, later?.progress], ['compiling', 70]);

      // Only the holder renews: another worker, another tenant and an unknown job are told `lost`.
      assert.equal(await h.queue.heartbeat(ref, 'b', HELD), 'lost');
      assert.equal(
        await h.queue.heartbeat({ tenant: h.otherTenant, id: job.id }, 'a', HELD),
        'lost',
      );
      assert.equal(
        await h.queue.heartbeat({ tenant: h.tenant, id: randomUUID() }, 'a', HELD),
        'lost',
      );
    },
  },
  {
    name: 'a result is stored once, by the worker that holds the job',
    async run(h) {
      const kind = newKind();
      const job = await put(h, kind);
      const ref = { tenant: h.tenant, id: job.id };
      await claimed(h, kind, 'holder');

      assert.equal(await h.queue.complete(ref, 'someone-else', { pages: 1 }), false);
      assert.equal(
        await h.queue.complete({ tenant: h.tenant, id: randomUUID() }, 'holder', {}),
        false,
      );
      assert.equal((await h.queue.get(h.tenant, job.id))?.state, 'running');

      const result = { pages: 3, files: [{ name: 'main.pdf', bytes: 1024 }] };
      assert.equal(await h.queue.complete(ref, 'holder', result), true);
      const done = await h.queue.get(h.tenant, job.id);
      assert.deepStrictEqual(
        {
          state: done?.state,
          result: done?.result,
          progress: done?.progress,
          error: done?.error,
          lockedBy: done?.lockedBy,
          lockedUntil: done?.lockedUntil,
          attempts: done?.attempts,
        },
        {
          state: 'completed',
          result,
          progress: 100,
          error: null,
          lockedBy: null,
          lockedUntil: null,
          attempts: 1,
        },
      );
      assert.ok(done?.finishedAt !== null && done!.finishedAt! >= job.createdAt);

      // Finished is final: no second result, no failure, no heartbeat and no further claim.
      assert.equal(await h.queue.complete(ref, 'holder', { pages: 4 }), false);
      assert.equal(await h.queue.fail(ref, 'holder', UNAVAILABLE, 0), false);
      assert.equal(await h.queue.heartbeat(ref, 'holder', HELD), 'lost');
      assert.equal(await h.queue.claim([kind], 'holder', HELD), null);
      assert.deepStrictEqual(await h.queue.get(h.tenant, job.id), done);
    },
  },
  {
    name: 'a failed attempt is queued again when asked and attempts are left, and ends failed otherwise',
    async run(h) {
      const kind = newKind();
      const job = await put(h, kind, { maxAttempts: 2 });
      const ref = { tenant: h.tenant, id: job.id };
      await claimed(h, kind, 'w');
      assert.equal(await h.queue.fail(ref, 'someone-else', UNAVAILABLE, 0), false);
      assert.equal(await h.queue.fail(ref, 'w', UNAVAILABLE, 0, { log: 'first' }), true);
      const queued = await h.queue.get(h.tenant, job.id);
      assert.deepStrictEqual(
        {
          state: queued?.state,
          error: queued?.error,
          attempts: queued?.attempts,
          lockedBy: queued?.lockedBy,
          finishedAt: queued?.finishedAt,
          result: queued?.result,
        },
        {
          state: 'queued',
          error: UNAVAILABLE,
          attempts: 1,
          lockedBy: null,
          finishedAt: null,
          result: null,
        },
      );

      // The last attempt: asking for a retry no longer queues it, and its result is kept.
      assert.equal((await claimed(h, kind, 'w')).attempts, 2);
      const invalid = { code: 'validation_failed', message: 'the bundle was refused' };
      assert.equal(await h.queue.fail(ref, 'w', invalid, 0, { log: 'second' }), true);
      const failed = await h.queue.get(h.tenant, job.id);
      assert.deepStrictEqual(
        {
          state: failed?.state,
          error: failed?.error,
          result: failed?.result,
          lockedBy: failed?.lockedBy,
        },
        { state: 'failed', error: invalid, result: { log: 'second' }, lockedBy: null },
      );
      assert.ok(failed?.finishedAt);
      assert.equal(await h.queue.claim([kind], 'w', HELD), null);

      // Without a retry time the first failure is final, attempts left or not.
      const once = newKind();
      const final = await put(h, once, { maxAttempts: 5 });
      await claimed(h, once, 'w');
      assert.equal(await h.queue.fail({ tenant: h.tenant, id: final.id }, 'w', invalid), true);
      const ended = await h.queue.get(h.tenant, final.id);
      assert.deepStrictEqual([ended?.state, ended?.result, ended?.attempts], ['failed', null, 1]);

      // A retry time holds the next attempt back.
      const slow = newKind();
      const retried = await put(h, slow);
      await claimed(h, slow, 'w');
      assert.equal(
        await h.queue.fail({ tenant: h.tenant, id: retried.id }, 'w', UNAVAILABLE, 800),
        true,
      );
      assert.equal(await h.queue.claim([slow], 'w', HELD), null);
      await h.pass(1000);
      assert.equal((await claimed(h, slow, 'w')).attempts, 2);
    },
  },
  {
    name: 'cancel stops a queued or a running job and leaves a finished one as it is',
    async run(h) {
      const kind = newKind();
      const waiting = await put(h, kind);
      const stopped = await h.queue.cancel(h.tenant, waiting.id);
      assert.equal(stopped?.state, 'cancelled');
      assert.ok(stopped?.finishedAt);
      assert.equal(await h.queue.claim([kind], 'w', HELD), null);

      const job = await put(h, kind);
      const ref = { tenant: h.tenant, id: job.id };
      await claimed(h, kind, 'w');
      const cancelled = await h.queue.cancel(h.tenant, job.id);
      assert.deepStrictEqual(
        [cancelled?.state, cancelled?.lockedBy, cancelled?.lockedUntil],
        ['cancelled', null, null],
      );
      // The worker learns it at its next heartbeat, and its result is not taken.
      assert.equal(await h.queue.heartbeat(ref, 'w', HELD), 'cancelled');
      assert.equal(await h.queue.complete(ref, 'w', { pages: 1 }), false);
      assert.equal(await h.queue.fail(ref, 'w', UNAVAILABLE, 0), false);
      assert.deepStrictEqual(await h.queue.get(h.tenant, job.id), cancelled);
      assert.deepStrictEqual(await h.queue.cancel(h.tenant, job.id), cancelled);
      assert.equal(await h.queue.claim([kind], 'w', HELD), null);

      const finished = await put(h, kind);
      await claimed(h, kind, 'w');
      await h.queue.complete({ tenant: h.tenant, id: finished.id }, 'w', { ok: true });
      const done = await h.queue.get(h.tenant, finished.id);
      assert.deepStrictEqual(await h.queue.cancel(h.tenant, finished.id), done);
      assert.equal(done?.state, 'completed');

      // No job: an unknown identifier, a malformed one, and another tenant's job.
      assert.equal(await h.queue.cancel(h.tenant, randomUUID()), null);
      assert.equal(await h.queue.cancel(h.tenant, 'not-an-identifier'), null);
      const theirs = await put(h, kind);
      assert.equal(await h.queue.cancel(h.otherTenant, theirs.id), null);
      assert.equal((await h.queue.get(h.tenant, theirs.id))?.state, 'queued');
    },
  },
  {
    name: 'another tenant cannot read, change, find or count a job',
    async run(h) {
      const kind = newKind();
      const doc = randomUUID();
      const key = cacheKey();
      const job = await put(h, kind, { doc, cacheKey: key });
      const theirs = { tenant: h.otherTenant, id: job.id };
      await claimed(h, kind, 'w');

      assert.equal(await h.queue.get(h.otherTenant, job.id), null);
      assert.equal(await h.queue.heartbeat(theirs, 'w', HELD, { stage: 'x' }), 'lost');
      assert.equal(await h.queue.complete(theirs, 'w', { stolen: true }), false);
      assert.equal(await h.queue.fail(theirs, 'w', UNAVAILABLE), false);
      assert.equal(await h.queue.cancel(h.otherTenant, job.id), null);
      assert.equal(await h.queue.latestFor(h.otherTenant, doc, kind), null);
      assert.equal(await h.queue.activeCount(h.otherTenant, kind), 0);

      const mine = await h.queue.get(h.tenant, job.id);
      assert.deepStrictEqual(
        [mine?.state, mine?.lockedBy, mine?.stage, mine?.result],
        ['running', 'w', null, null],
      );
      assert.equal(await h.queue.complete({ tenant: h.tenant, id: job.id }, 'w', { v: 1 }), true);
      assert.equal(await h.queue.findCompleted(h.otherTenant, key, 0), null);
      assert.equal((await h.queue.findCompleted(h.tenant, key, 0))?.id, job.id);
    },
  },
  {
    name: 'the result of an earlier job is found by its cache key, the newest first',
    async run(h) {
      const kind = newKind();
      const key = cacheKey();
      const first = await put(h, kind, { cacheKey: key });
      assert.equal(first.cacheKey, key);
      assert.equal(await h.queue.findCompleted(h.tenant, key, 0), null, 'queued is not found');
      await claimed(h, kind, 'w');
      assert.equal(await h.queue.findCompleted(h.tenant, key, 0), null, 'running is not found');
      await h.queue.complete({ tenant: h.tenant, id: first.id }, 'w', { v: 1 });
      const done = await h.queue.get(h.tenant, first.id);
      assert.deepStrictEqual(await h.queue.findCompleted(h.tenant, key, 0), done);
      // `since` is inclusive: a result as old as the limit counts, an older one does not.
      assert.equal((await h.queue.findCompleted(h.tenant, key, done!.finishedAt!))?.id, first.id);
      assert.equal(await h.queue.findCompleted(h.tenant, key, done!.finishedAt! + 1), null);
      assert.equal(await h.queue.findCompleted(h.tenant, cacheKey(), 0), null);

      // A job created already completed (an earlier job's result, EXP-006) is the newest now.
      await h.pass(20);
      const copy = await put(h, kind, { cacheKey: key, completedWith: { v: 2 } });
      assert.deepStrictEqual(
        {
          state: copy.state,
          result: copy.result,
          progress: copy.progress,
          attempts: copy.attempts,
        },
        { state: 'completed', result: { v: 2 }, progress: 100, attempts: 0 },
      );
      assert.ok(copy.finishedAt);
      assert.equal((await h.queue.findCompleted(h.tenant, key, 0))?.id, copy.id);
      assert.equal(await h.queue.claim([kind], 'w', HELD), null, 'a completed job is not run');

      // A job that failed or was cancelled has no result to reuse.
      const other = cacheKey();
      const bad = await put(h, kind, { cacheKey: other });
      await claimed(h, kind, 'w');
      await h.queue.fail({ tenant: h.tenant, id: bad.id }, 'w', UNAVAILABLE);
      await h.queue.cancel(h.tenant, (await put(h, kind, { cacheKey: other })).id);
      assert.equal(await h.queue.findCompleted(h.tenant, other, 0), null);
    },
  },
  {
    name: 'the newest job of a kind for a document is found, whatever its state',
    async run(h) {
      const kind = newKind();
      const doc = randomUUID();
      assert.equal(await h.queue.latestFor(h.tenant, doc, kind), null);
      const first = await put(h, kind, { doc });
      assert.deepStrictEqual(await h.queue.latestFor(h.tenant, doc, kind), first);
      await h.pass(20);
      const second = await put(h, kind, { doc });
      assert.equal((await h.queue.latestFor(h.tenant, doc, kind))?.id, second.id);
      const cancelled = await h.queue.cancel(h.tenant, second.id);
      assert.deepStrictEqual(await h.queue.latestFor(h.tenant, doc, kind), cancelled);

      // Other kinds and other documents do not count.
      await h.pass(20);
      await put(h, newKind(), { doc });
      await put(h, kind, { doc: randomUUID() });
      await put(h, kind);
      assert.equal((await h.queue.latestFor(h.tenant, doc, kind))?.id, second.id);
      assert.equal(await h.queue.latestFor(h.tenant, randomUUID(), kind), null);
    },
  },
  {
    name: 'depth counts the queued and the running jobs by kind and priority, across tenants',
    async run(h) {
      const kind = newKind();
      const depth = async () => (await h.queue.depth()).filter((d) => d.kind === kind);
      assert.deepStrictEqual(await depth(), []);
      const waiting = await put(h, kind);
      await put(h, kind);
      await put(h, kind, {}, h.otherTenant);
      const urgent = await put(h, kind, { priority: 7 });
      assert.deepStrictEqual(await depth(), [
        { kind, priority: 0, queued: 3, running: 0 },
        { kind, priority: 7, queued: 1, running: 0 },
      ]);
      assert.equal((await claimed(h, kind, 'w')).id, urgent.id);
      assert.deepStrictEqual(await depth(), [
        { kind, priority: 0, queued: 3, running: 0 },
        { kind, priority: 7, queued: 0, running: 1 },
      ]);
      // Finished jobs are no depth: completed, cancelled and delayed-but-queued are told apart.
      await h.queue.complete({ tenant: h.tenant, id: urgent.id }, 'w', {});
      await h.queue.cancel(h.tenant, waiting.id);
      await put(h, kind, { delayMs: 60_000 });
      assert.deepStrictEqual(await depth(), [{ kind, priority: 0, queued: 3, running: 0 }]);
    },
  },
  {
    name: 'a tenant at its limit of running jobs of a kind waits while other tenants run',
    async run(h) {
      const kind = newKind();
      await h.queue.setLimit(h.tenant, kind, 1);
      const mine = [await put(h, kind), await put(h, kind)];
      const theirs = await put(h, kind, {}, h.otherTenant);

      const one = await claimed(h, kind, 'w1');
      const two = await claimed(h, kind, 'w2');
      assert.deepStrictEqual([one.tenant, two.tenant].sort(), [h.tenant, h.otherTenant].sort());
      assert.equal(await h.queue.claim([kind], 'w3', HELD), null);
      const running = one.tenant === h.tenant ? one : two;
      const waiting = mine.find((j) => j.id !== running.id)!;
      assert.equal((await h.queue.get(h.tenant, waiting.id))?.state, 'queued');
      assert.equal((await h.queue.get(h.otherTenant, theirs.id))?.state, 'running');

      // When the running job ends, the tenant's next one may start.
      await h.queue.complete({ tenant: h.tenant, id: running.id }, running.lockedBy!, {});
      assert.equal((await claimed(h, kind, 'w3')).id, waiting.id);

      // A limit of nought holds every job of the kind; clearing the limit frees them.
      await h.queue.setLimit(h.tenant, kind, 0);
      await h.queue.complete({ tenant: h.tenant, id: waiting.id }, 'w3', {});
      await put(h, kind);
      await put(h, kind);
      assert.equal(await h.queue.claim([kind], 'w4', HELD), null);
      await h.queue.setLimit(h.tenant, kind, null);
      assert.ok(await h.queue.claim([kind], 'w4', HELD));
      assert.ok(await h.queue.claim([kind], 'w5', HELD));

      for (const bad of [-1, 1.5, Number.NaN])
        await assert.rejects(async () => h.queue.setLimit(h.tenant, kind, bad), RangeError);
      await assert.rejects(async () => h.queue.setLimit(h.tenant, 'Not A Kind', 1), RangeError);
    },
  },
  {
    name: 'the default limit applies to a tenant without a limit of its own',
    async run(h) {
      const kind = newKind();
      for (let i = 0; i < 3; i++) await put(h, kind);
      await put(h, kind, {}, h.otherTenant);
      const byDefault = { defaultLimit: 1 };
      // One job of each tenant starts: each is then at the default, whichever was claimed first.
      const first = await h.queue.claim([kind], 'w1', HELD, byDefault);
      const second = await h.queue.claim([kind], 'w2', HELD, byDefault);
      assert.deepStrictEqual(
        [first?.tenant, second?.tenant].sort(),
        [h.tenant, h.otherTenant].sort(),
      );
      assert.equal(await h.queue.claim([kind], 'w3', HELD, byDefault), null);

      // The tenant's own limit takes precedence over the default; no default is no limit.
      await h.queue.setLimit(h.tenant, kind, 2);
      assert.equal((await h.queue.claim([kind], 'w3', HELD, byDefault))?.tenant, h.tenant);
      assert.equal(await h.queue.claim([kind], 'w4', HELD, byDefault), null);
      assert.equal(await h.queue.claim([kind], 'w4', HELD, { defaultLimit: null }), null);
      await h.queue.setLimit(h.tenant, kind, null);
      assert.equal(await h.queue.claim([kind], 'w4', HELD, byDefault), null);
      assert.equal((await h.queue.claim([kind], 'w4', HELD))?.tenant, h.tenant);
    },
  },
  {
    name: 'activeCount is the queued and running jobs of a kind for one tenant',
    async run(h) {
      const kind = newKind();
      const count = () => h.queue.activeCount(h.tenant, kind);
      assert.equal(await count(), 0);
      const jobs = [await put(h, kind), await put(h, kind), await put(h, kind)];
      // Another kind of the tenant, and another tenant's job of the kind, are not counted.
      await put(h, newKind());
      await put(h, kind, { delayMs: 60_000 }, h.otherTenant);
      assert.equal(await count(), 3);
      assert.equal(await h.queue.activeCount(h.otherTenant, kind), 1);

      const running = await claimed(h, kind, 'w');
      assert.equal(running.tenant, h.tenant);
      assert.equal(await count(), 3, 'a running job counts');
      await h.queue.complete({ tenant: h.tenant, id: running.id }, 'w', {});
      assert.equal(await count(), 2, 'a completed job does not');
      const [next, last] = jobs.filter((j) => j.id !== running.id);
      await h.queue.cancel(h.tenant, next!.id);
      assert.equal(await count(), 1, 'nor a cancelled one');
      assert.equal((await claimed(h, kind, 'w')).id, last!.id);
      await h.queue.fail({ tenant: h.tenant, id: last!.id }, 'w', UNAVAILABLE);
      assert.equal(await count(), 0, 'nor a failed one');
      // A job that waits for its time is queued, so it counts.
      await put(h, kind, { delayMs: 60_000 });
      assert.equal(await count(), 1);
      assert.equal(await h.queue.activeCount(h.otherTenant, kind), 1);
    },
  },
];

/** Runs every check and returns `name: first line of the failure` for those that failed. */
export async function failingQueueChecks(
  checks: readonly QueueCheck[],
  harness: () => QueueHarness,
): Promise<string[]> {
  const failed: string[] = [];
  for (const c of checks) {
    try {
      await c.run(harness());
    } catch (e) {
      failed.push(`${c.name}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  return failed;
}
