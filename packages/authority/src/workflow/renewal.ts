/**
 * The time-stamp renewal rules of a sealed workflow (12 §8.2 step 5, §13; FRW-056 criteria 2 and 5),
 * as pure functions.
 *
 * A sealed PDF is never rewritten. A scheduled job adds a further time-stamp as an incremental
 * update before the newest time-stamp expires. This module decides when that job renews, and
 * how a renewal result changes the recorded state. The PDF update itself is the signing service's
 * and the export's; the job's storage is the workflow service's.
 *
 * - `planRenewal` renews only inside the lead window before the newest expiry. The lead time is a
 *   parameter with no default: the spec gives no value, and no number is invented here.
 * - Once the newest expiry has passed, the plan is `expired`: nothing can be renewed, and the
 *   operator is alerted.
 * - One time-stamp per expiry (FRW-056 criterion 5): a renewal is accepted only when the state it
 *   was planned against still holds the same expiry (compare and set). A second run that planned
 *   against the same expiry is refused as `stale` and adds nothing.
 * - A failed renewal is visible to operators (`alert` is always true) and is retried while time
 *   remains before the expiry (`retry`). The retry interval is the scheduler's, not this module's.
 *
 * Not built here: the incremental update, the byte-for-byte check of the sealed prefix, the
 * `/workflow/final` pointer and the scheduler. Those are FRW-056 criteria 1, 3 and 4.
 */

export interface RenewalState {
  /** Expiry of the newest time-stamp on the sealed chain, in epoch milliseconds. */
  readonly expiresAtMs: number;
}

export type RenewalPlan =
  | { readonly action: 'wait'; readonly renewAtMs: number }
  | { readonly action: 'renew'; readonly expectedExpiresAtMs: number }
  | { readonly action: 'expired'; readonly alert: true };

/** The result of one renewal attempt, as the signing service reports it. */
export type RenewalResult =
  | { readonly ok: true; readonly newExpiresAtMs: number }
  | {
      readonly ok: false;
      readonly reason: 'tsa_unreachable' | 'signing_unavailable' | 'seal_failed';
    };

export type RenewalApplication =
  | {
      readonly ok: true;
      readonly state: RenewalState;
      readonly alert: false;
      readonly retry: false;
    }
  | {
      readonly ok: false;
      readonly code: 'stale' | 'renewal_failed' | 'invalid_timestamp';
      readonly state: RenewalState;
      /** Always true: a renewal that did not happen is visible to operators. */
      readonly alert: true;
      /** True while time remains before the expiry and the job should try again. */
      readonly retry: boolean;
    };

function requireFiniteMs(name: string, value: number): void {
  if (!Number.isFinite(value))
    throw new RangeError(`${name} must be a finite number of milliseconds`);
}

/** Whether a renewal should be planned now, and against which expiry. */
export function planRenewal(state: RenewalState, nowMs: number, leadMs: number): RenewalPlan {
  requireFiniteMs('nowMs', nowMs);
  requireFiniteMs('expiresAtMs', state.expiresAtMs);
  if (!Number.isFinite(leadMs) || leadMs < 0) {
    throw new RangeError('leadMs must be a non-negative finite number of milliseconds');
  }
  if (nowMs >= state.expiresAtMs) return { action: 'expired', alert: true };
  const renewAtMs = state.expiresAtMs - leadMs;
  if (nowMs < renewAtMs) return { action: 'wait', renewAtMs };
  return { action: 'renew', expectedExpiresAtMs: state.expiresAtMs };
}

/**
 * Applies the result of a renewal planned against `expectedExpiresAtMs`. The state changes only on
 * success, and only when it still holds that expiry.
 */
export function applyRenewalResult(
  state: RenewalState,
  expectedExpiresAtMs: number,
  result: RenewalResult,
  nowMs: number,
): RenewalApplication {
  requireFiniteMs('nowMs', nowMs);
  if (state.expiresAtMs !== expectedExpiresAtMs) {
    return { ok: false, code: 'stale', state, alert: true, retry: false };
  }
  const beforeExpiry = nowMs < state.expiresAtMs;
  if (!result.ok) {
    return { ok: false, code: 'renewal_failed', state, alert: true, retry: beforeExpiry };
  }
  // A new time-stamp must still be valid when it is recorded, and must extend the chain.
  if (!Number.isFinite(result.newExpiresAtMs) || result.newExpiresAtMs <= state.expiresAtMs) {
    return { ok: false, code: 'invalid_timestamp', state, alert: true, retry: beforeExpiry };
  }
  if (result.newExpiresAtMs <= nowMs) {
    return { ok: false, code: 'invalid_timestamp', state, alert: true, retry: beforeExpiry };
  }
  return {
    ok: true,
    state: { expiresAtMs: result.newExpiresAtMs },
    alert: false,
    retry: false,
  };
}
