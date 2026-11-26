// The time-stamp renewal job of a sealed workflow (12 §8.2 step 5; FRW-056 criterion 5; lane
// V-FRW-055-072). The rules are the pure functions of `@docedit/authority` (`planRenewal`,
// `applyRenewalResult`); this module runs them as a job of the queue.
//
// One expiry, one request to the signer: a run first claims the expiry in the store (an atomic
// reserve step), and only the run holding the claim asks the signer. Every other run planned
// against that expiry is refused as `stale` without reaching the signer. The holder then moves the
// expiry by compare and set. The claim lapses after `claimMs`, so a run that died while holding it
// does not block the renewal; a later run may then ask again, and it sends the same idempotency
// key (`renewalJobId` of the document and the expiry), which the signing service must answer with
// the time-stamp it already made rather than append a second one.
//
// The signing service makes the time-stamp (`RenewalSigner` is its port; `sealedRenewalSigner` in
// `src/workflow/extend-sealed.ts` is the implementation). The scheduled task that enqueues the job
// before each expiry is `scheduleRenewals` in `src/workflow/renewal-schedule.ts`. The PostgreSQL
// store is `src/workflow/renewal-state-pg.ts` (migration 0068); the in-memory one is
// `renewal-state-memory.ts`.
import { createHash, randomUUID } from 'node:crypto';
import {
  applyRenewalResult,
  planRenewal,
  type RenewalResult,
  type RenewalState,
} from '@docedit/authority';
import { JobFailure, type JobHandler } from './runner.ts';
import type { JobRecord } from './queue.ts';

export const RENEWAL_KIND = 'workflow.renewal';

/** A UUID-shaped identifier derived from the document and the expiry: one expiry, one job. */
export function renewalJobId(doc: string, expiryMs: number): string {
  const h = createHash('sha256').update(`renewal:${doc}:${expiryMs}`).digest('hex');
  const v = '5' + h.slice(13, 16);
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/**
 * The answer to a claim. Refused with `heldUntilMs` when another run holds a live claim on the same
 * expiry; refused with null when the chain no longer has that expiry.
 */
export type RenewalClaim =
  { readonly claimed: true } | { readonly claimed: false; readonly heldUntilMs: number | null };

/** The newest expiry of a sealed document's time-stamp chain, kept by the workflow service. */
export interface RenewalStore {
  load(tenant: string, doc: string): Promise<RenewalState | null>;
  /**
   * Reserves `expected` for `holder` until `untilMs`, as one atomic step: granted only while the
   * chain still has that expiry and no other claim on it is live at `nowMs`. Of any number of
   * concurrent claims on one expiry, at most one is granted.
   */
  claim(
    tenant: string,
    doc: string,
    expected: number,
    holder: string,
    nowMs: number,
    untilMs: number,
  ): Promise<RenewalClaim>;
  /** Drops `holder`'s claim on `expected` after a renewal that did not happen. */
  release(tenant: string, doc: string, expected: number, holder: string): Promise<void>;
  /**
   * Sets the expiry to `next` and clears the claim, only when the expiry still is `expected` and
   * `holder` holds the claim, as one atomic step; false otherwise (the compare and set of FRW-056
   * criterion 5).
   */
  swap(
    tenant: string,
    doc: string,
    expected: number,
    next: number,
    holder: string,
    nowMs: number,
  ): Promise<boolean>;
}

/**
 * The signing service's port: asks for one further time-stamp on the sealed chain. A request with
 * an `idempotencyKey` already served must return that request's result and add nothing.
 */
export interface RenewalSigner {
  renew(
    tenant: string,
    doc: string,
    expectedExpiresAtMs: number,
    idempotencyKey: string,
  ): Promise<RenewalResult>;
}

export interface RenewalHandlerOptions {
  store: RenewalStore;
  signer: RenewalSigner;
  /** The lead time before the expiry at which renewal starts; a setting, with no default here. */
  leadMs: number;
  /**
   * How long a claim holds; a setting, with no default here. It must outlast one call to the
   * signer, or a second run may ask before the first has recorded its answer.
   */
  claimMs: number;
  now: () => number;
  /** A fresh holder name for each run; defaults to a random UUID. */
  holder?: () => string;
}

/** The handler of `workflow.renewal` jobs: plans, claims, renews, and records the result. */
export function renewalHandler(opts: RenewalHandlerOptions): JobHandler {
  if (!Number.isSafeInteger(opts.claimMs) || opts.claimMs <= 0) {
    throw new RangeError('claimMs must be a positive safe integer of milliseconds');
  }
  const newHolder = opts.holder ?? (() => randomUUID());
  return async (job: JobRecord) => {
    const expected = job.payload['expiry'];
    if (typeof expected !== 'number' || !Number.isFinite(expected)) {
      throw new JobFailure('invalid_payload', 'the renewal job names no expiry', false);
    }
    const tenant = job.tenant;
    const doc = job.doc;
    if (doc === null)
      throw new JobFailure('invalid_payload', 'the renewal job names no document', false);
    const state = await opts.store.load(tenant, doc);
    if (state === null)
      throw new JobFailure('not_found', 'the sealed document has no time-stamp chain', false);
    const nowMs = opts.now();
    const plan = planRenewal(state, nowMs, opts.leadMs);
    if (plan.action === 'expired') {
      throw new JobFailure(
        'expired',
        'the newest time-stamp has expired; nothing can be renewed',
        false,
        { alert: true },
      );
    }
    if (plan.action === 'wait') {
      throw new JobFailure('not_due', 'the renewal window has not opened yet', true, {
        renewAtMs: plan.renewAtMs,
      });
    }
    if (plan.expectedExpiresAtMs !== expected) {
      // The job was planned against an expiry the chain no longer has: nothing to add.
      throw new JobFailure('stale', 'the job names an expiry the chain no longer has', false, {
        alert: true,
      });
    }
    // Reserve the expiry before asking the signer, so that one expiry leads to one request.
    const holder = newHolder();
    const claim = await opts.store.claim(
      tenant,
      doc,
      expected,
      holder,
      nowMs,
      nowMs + opts.claimMs,
    );
    if (!claim.claimed) {
      if (claim.heldUntilMs === null) {
        throw new JobFailure('stale', 'another run renewed this expiry first', false, {
          alert: true,
        });
      }
      // Another run holds the expiry. Try again once its claim lapses: by then it has either moved
      // the expiry (and this run is stale) or died, and this run may claim in its place.
      throw new JobFailure('stale', 'another run holds the claim on this expiry', true, {
        alert: false,
        heldUntilMs: claim.heldUntilMs,
      });
    }
    let result: RenewalResult;
    try {
      result = await opts.signer.renew(tenant, doc, expected, renewalJobId(doc, expected));
    } catch {
      result = { ok: false, reason: 'signing_unavailable' };
    }
    const applied = applyRenewalResult(state, expected, result, nowMs);
    if (!applied.ok) {
      // Free the expiry for the retry; if this fails, the claim lapses after `claimMs`.
      await opts.store.release(tenant, doc, expected, holder).catch(() => {});
      throw new JobFailure(
        applied.code,
        `the renewal did not happen: ${applied.code}`,
        applied.retry,
        {
          alert: applied.alert,
          expiresAtMs: state.expiresAtMs,
        },
      );
    }
    const swapped = await opts.store.swap(
      tenant,
      doc,
      expected,
      applied.state.expiresAtMs,
      holder,
      nowMs,
    );
    if (!swapped) {
      // The claim lapsed and another run took it over while the signer answered this one.
      throw new JobFailure(
        'stale',
        'the claim on this expiry lapsed before the renewal was recorded',
        false,
        {
          alert: true,
        },
      );
    }
    return { renewed: true, expiresAtMs: applied.state.expiresAtMs };
  };
}
