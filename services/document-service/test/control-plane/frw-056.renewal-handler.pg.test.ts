// FRW-056 criterion 5 with the renewal wired to the job queue, on PostgreSQL (lane
// V-FRW-055-072). The queue runs `workflow.renewal` jobs through `JobRunner`; the handler plans and
// applies the renewal with `planRenewal` and `applyRenewalResult` from `@docedit/authority`; the
// expiry is kept by the product store `PgRenewalStore` (src/workflow/renewal-state-pg.ts) in table
// `workflow_renewal_state` (migration 0068), which the test database gets from the migrations.
// Covered: one request to the signer for one expiry however often the job is requested; one
// request to the signer when several runs race for one expiry, each loser refused as `stale`; a
// failed renewal that is recorded and retried while time remains; no retry after the expiry; and a
// claim left by a run that died, which blocks the signer until it lapses. The signing service is a
// stub (its port is `RenewalSigner`). Each file's database is its own and is dropped afterwards.
// The test skips when PostgreSQL is not up.
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { RenewalResult } from '@docedit/authority';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import {
  JobRunner,
  JobFailure,
  type JobContext,
  type JobOutcome,
} from '../../src/control-plane/jobs/runner.ts';
import type { JobRecord } from '../../src/control-plane/jobs/queue.ts';
import {
  RENEWAL_KIND,
  renewalHandler,
  renewalJobId,
  type RenewalSigner,
  type RenewalStore,
} from '../../src/control-plane/jobs/workflow-renewal.ts';
import { PgRenewalStore } from '../../src/workflow/renewal-state-pg.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const DAY = 24 * 60 * 60 * 1000;
const LEAD_MS = 30 * DAY;
const CLAIM_MS = 60_000;
const WORKER = 'v-frw-055-072';

interface SignerCall {
  doc: string;
  expected: number;
  key: string;
}

/** A signer that answers from a script, one answer per call, and records its calls. */
function scriptedSigner(
  answers: RenewalResult[],
  before?: () => Promise<void>,
): RenewalSigner & { calls: number; log: SignerCall[] } {
  const s = {
    calls: 0,
    log: [] as SignerCall[],
    async renew(
      _tenant: string,
      doc: string,
      expected: number,
      key: string,
    ): Promise<RenewalResult> {
      s.calls++;
      s.log.push({ doc, expected, key });
      if (before) await before();
      const next = answers.shift();
      if (next === undefined) throw new Error('the scripted signer has no answer left');
      return next;
    },
  };
  return s;
}

/**
 * The product store, with a gate that opens once `n` claims have been answered. The signer waits
 * on the gate, so the run that wins the claim cannot record its renewal before every other run has
 * tried to claim: the runs are concurrent at the claim, not one after another.
 */
function gatedStore(inner: RenewalStore, n: number) {
  let answered = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const store: RenewalStore = {
    load: (t, d) => inner.load(t, d),
    async claim(t, d, e, h, now, until) {
      const r = await inner.claim(t, d, e, h, now, until);
      if (++answered >= n) open();
      return r;
    },
    release: (t, d, e, h) => inner.release(t, d, e, h),
    swap: (t, d, e, next, h, now) => inner.swap(t, d, e, next, h, now),
  };
  const wait = () =>
    Promise.race([
      gate,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error(`only ${answered} of ${n} claims were answered`)),
          10_000,
        ),
      ),
    ]);
  return { store, wait, answered: () => answered };
}

const databases: TestDatabase[] = [];
const why = await postgresUnavailable();

describe.skipIf(why)(
  'the renewal job of a sealed workflow on PostgreSQL (FRW-056 criterion 5)',
  () => {
    afterAll(async () => {
      for (const db of databases) await db.drop();
    });

    /** A migrated database with one sealed document whose newest time-stamp expires at `expiry`. */
    async function setup(expiry: number) {
      const db = await createTestDatabase();
      databases.push(db);
      const tenant = randomUUID();
      const doc = randomUUID();
      const store = new PgRenewalStore(db.service);
      await store.start(tenant, doc, expiry);
      return { db, tenant, doc, store };
    }

    function enqueueRenewal(queue: PgJobQueue, tenant: string, doc: string, expiry: number) {
      return queue.enqueue(tenant, {
        id: renewalJobId(doc, expiry),
        kind: RENEWAL_KIND,
        doc,
        payload: { expiry },
        createdBy: 'system',
        ifAbsent: true,
      });
    }

    it('asks the signer once for one expiry however often the job is requested', async () => {
      const expiry = Date.UTC(2027, 0, 15);
      const { db, tenant, doc, store } = await setup(expiry);
      let clock = expiry - 20 * DAY; // inside the lead window
      const signer = scriptedSigner([{ ok: true, newExpiresAtMs: expiry + 365 * DAY }]);
      const queue = new PgJobQueue(db.service);
      const handlers = {
        [RENEWAL_KIND]: renewalHandler({
          store,
          signer,
          leadMs: LEAD_MS,
          claimMs: CLAIM_MS,
          now: () => clock,
        }),
      };
      const id = renewalJobId(doc, expiry);
      const first = await enqueueRenewal(queue, tenant, doc, expiry);
      const second = await enqueueRenewal(queue, tenant, doc, expiry);
      expect(second.id).toBe(first.id);

      const runner = new JobRunner({
        queue,
        handlers,
        worker: WORKER,
        leaseMs: 60_000,
        idleMs: 10,
        retryAfterMs: 0,
      });
      while (await runner.runOnce());

      expect(signer.calls).toBe(1);
      expect(signer.log).toEqual([{ doc, expected: expiry, key: id }]);
      expect(await store.load(tenant, doc)).toEqual({ expiresAtMs: expiry + 365 * DAY });
      expect(await store.currentClaim(tenant, doc)).toBeNull();
      const job = await queue.get(tenant, id);
      expect(job?.state).toBe('completed');
      expect(job?.result).toEqual({ renewed: true, expiresAtMs: expiry + 365 * DAY });
      // The run after the renewal plans against a later expiry, and nothing more is asked for.
      clock = expiry + 365 * DAY - 20 * DAY;
      expect(await enqueueRenewal(queue, tenant, doc, expiry)).toMatchObject({
        id,
        state: 'completed',
      });
      expect(signer.calls).toBe(1);
    });

    it('asks the signer once when several runs race for the same expiry, and refuses the rest as stale', async () => {
      const expiry = Date.UTC(2027, 0, 15);
      const { db, tenant, doc, store } = await setup(expiry);
      const clock = expiry - 20 * DAY;
      const RUNS = 6;
      const gated = gatedStore(store, RUNS);
      const signer = scriptedSigner(
        Array.from({ length: RUNS }, (_, i) => ({
          ok: true as const,
          newExpiresAtMs: expiry + (365 + i) * DAY,
        })),
        gated.wait,
      );
      const queue = new PgJobQueue(db.service);
      const job = await enqueueRenewal(queue, tenant, doc, expiry);
      const ctx = {} as JobContext;
      // Separate handlers, as separate workers would have, each run with its own holder.
      const runs = Array.from({ length: RUNS }, () =>
        renewalHandler({
          store: gated.store,
          signer,
          leadMs: LEAD_MS,
          claimMs: CLAIM_MS,
          now: () => clock,
        })(job, ctx),
      );
      const settled = await Promise.allSettled(runs);
      const won = settled.filter((s) => s.status === 'fulfilled');
      const lost = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');

      expect(gated.answered()).toBe(RUNS);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(RUNS - 1);
      for (const l of lost) {
        expect(l.reason).toBeInstanceOf(JobFailure);
        const f = l.reason as JobFailure;
        // Refused at the claim while the winner held it: concurrent, not planned after the renewal.
        expect(f.code).toBe('stale');
        expect(f.result).toMatchObject({ heldUntilMs: clock + CLAIM_MS });
      }
      // One request reached the signer, so one time-stamp; the chain holds its expiry.
      expect(signer.calls).toBe(1);
      expect(signer.log).toEqual([{ doc, expected: expiry, key: job.id }]);
      expect(await store.load(tenant, doc)).toEqual({ expiresAtMs: expiry + 365 * DAY });
      expect(await store.currentClaim(tenant, doc)).toBeNull();
    });

    it('records a failed renewal, keeps the chain, and retries while time remains', async () => {
      const expiry = Date.UTC(2027, 0, 15);
      const { db, tenant, doc, store } = await setup(expiry);
      const clock = expiry - 20 * DAY;
      const signer = scriptedSigner([
        { ok: false, reason: 'tsa_unreachable' },
        { ok: true, newExpiresAtMs: expiry + 365 * DAY },
      ]);
      const queue = new PgJobQueue(db.service);
      const outcomes: JobOutcome[] = [];
      const runner = new JobRunner({
        queue,
        handlers: {
          [RENEWAL_KIND]: renewalHandler({
            store,
            signer,
            leadMs: LEAD_MS,
            claimMs: CLAIM_MS,
            now: () => clock,
          }),
        },
        worker: WORKER,
        leaseMs: 60_000,
        idleMs: 10,
        retryAfterMs: 0,
        hooks: { settled: (_job, outcome) => outcomes.push(outcome) },
      });
      const id = renewalJobId(doc, expiry);
      await enqueueRenewal(queue, tenant, doc, expiry);

      expect(await runner.runOnce()).toBe(true);
      // The failure is recorded on the job, the job is queued again, and the claim is released.
      const afterFailure = await queue.get(tenant, id);
      expect(afterFailure?.state).toBe('queued');
      expect(afterFailure?.error?.code).toBe('renewal_failed');
      expect(await store.load(tenant, doc)).toEqual({ expiresAtMs: expiry });
      expect(await store.currentClaim(tenant, doc)).toBeNull();

      while (await runner.runOnce());
      expect(outcomes[0]).toMatchObject({
        state: 'failed',
        error: { code: 'renewal_failed' },
        retried: true,
      });
      expect(outcomes[1]).toMatchObject({ state: 'completed' });
      // Both requests name the same expiry and carry the same idempotency key.
      expect(signer.log).toEqual([
        { doc, expected: expiry, key: id },
        { doc, expected: expiry, key: id },
      ]);
      expect(await store.load(tenant, doc)).toEqual({ expiresAtMs: expiry + 365 * DAY });
    });

    it('does not retry a renewal once the newest time-stamp has expired, and alerts', async () => {
      const expiry = Date.UTC(2027, 0, 15);
      const { db, tenant, doc, store } = await setup(expiry);
      const clock = expiry + DAY;
      const signer = scriptedSigner([]);
      const queue = new PgJobQueue(db.service);
      const outcomes: JobOutcome[] = [];
      const runner = new JobRunner({
        queue,
        handlers: {
          [RENEWAL_KIND]: renewalHandler({
            store,
            signer,
            leadMs: LEAD_MS,
            claimMs: CLAIM_MS,
            now: () => clock,
          }),
        },
        worker: WORKER,
        leaseMs: 60_000,
        idleMs: 10,
        retryAfterMs: 0,
        hooks: { settled: (_job, outcome) => outcomes.push(outcome) },
      });
      const id = renewalJobId(doc, expiry);
      await enqueueRenewal(queue, tenant, doc, expiry);
      while (await runner.runOnce());
      expect(signer.calls).toBe(0);
      expect(outcomes).toEqual([
        expect.objectContaining({
          state: 'failed',
          error: { code: 'expired', message: expect.any(String) },
          retried: false,
        }),
      ]);
      const job: JobRecord | null = await queue.get(tenant, id);
      expect(job?.state).toBe('failed');
    });

    it('keeps the signer from a claim left by a run that died until the claim lapses', async () => {
      const expiry = Date.UTC(2027, 0, 15);
      const { db, tenant, doc, store } = await setup(expiry);
      let clock = expiry - 20 * DAY;
      // A run claimed the expiry and died before it asked the signer or released the claim.
      expect(
        await store.claim(tenant, doc, expiry, 'a-run-that-died', clock, clock + CLAIM_MS),
      ).toEqual({
        claimed: true,
      });
      const signer = scriptedSigner([{ ok: true, newExpiresAtMs: expiry + 365 * DAY }]);
      const queue = new PgJobQueue(db.service);
      const job = await enqueueRenewal(queue, tenant, doc, expiry);
      const handler = renewalHandler({
        store,
        signer,
        leadMs: LEAD_MS,
        claimMs: CLAIM_MS,
        now: () => clock,
      });
      const ctx = {} as JobContext;

      const refused = await handler(job, ctx).then(
        () => null,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(JobFailure);
      expect(refused).toMatchObject({
        code: 'stale',
        retry: true,
        result: { heldUntilMs: clock + CLAIM_MS },
      });
      expect(signer.calls).toBe(0);

      clock += CLAIM_MS; // the claim has lapsed
      expect(await handler(job, ctx)).toEqual({ renewed: true, expiresAtMs: expiry + 365 * DAY });
      expect(signer.log).toEqual([{ doc, expected: expiry, key: job.id }]);
      // The run that died cannot record anything now: its claim is gone and the expiry has moved.
      expect(
        await store.swap(tenant, doc, expiry, expiry + 400 * DAY, 'a-run-that-died', clock),
      ).toBe(false);
      expect(await store.load(tenant, doc)).toEqual({ expiresAtMs: expiry + 365 * DAY });
    });

    it("keeps one tenant from claiming or moving another tenant's chain", async () => {
      const expiry = Date.UTC(2027, 0, 15);
      const { tenant, doc, store } = await setup(expiry);
      const other = randomUUID();
      const clock = expiry - 20 * DAY;
      expect(await store.load(other, doc)).toBeNull();
      expect(
        await store.claim(other, doc, expiry, 'other-tenant', clock, clock + CLAIM_MS),
      ).toEqual({
        claimed: false,
        heldUntilMs: null,
      });
      expect(await store.swap(other, doc, expiry, expiry + DAY, 'other-tenant', clock)).toBe(false);
      expect(await store.load(tenant, doc)).toEqual({ expiresAtMs: expiry });
      expect(await store.currentClaim(tenant, doc)).toBeNull();
    });
  },
);
