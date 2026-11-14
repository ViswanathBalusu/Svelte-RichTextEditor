// The time-stamp renewal rules of a sealed workflow (FRW-056 criteria 2 and 5, for the pure rules
// only; the incremental update, the scheduler and the store are not built here).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyRenewalResult,
  planRenewal,
  type RenewalResult,
  type RenewalState,
} from '../src/workflow/renewal.ts';

const T0 = 1_700_000_000_000;
const msArb = fc.integer({ min: 0, max: 10_000_000_000 });

describe('a renewal is planned only inside the lead window before the expiry (FRW-056 criterion 2)', () => {
  it('waits before the window, renews inside it, and is expired from the expiry on (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: T0, max: T0 + 1_000_000_000 }),
        fc.integer({ min: 0, max: 100_000_000 }),
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        (expiresAtMs, leadMs, offset) => {
          const state: RenewalState = { expiresAtMs };
          const nowMs = expiresAtMs - leadMs + offset;
          const plan = planRenewal(state, nowMs, leadMs);
          if (nowMs >= expiresAtMs) expect(plan).toEqual({ action: 'expired', alert: true });
          else if (nowMs < expiresAtMs - leadMs)
            expect(plan).toEqual({ action: 'wait', renewAtMs: expiresAtMs - leadMs });
          else expect(plan).toEqual({ action: 'renew', expectedExpiresAtMs: expiresAtMs });
        },
      ),
    );
  });

  it('refuses a negative or non-finite lead time, and a non-finite instant', () => {
    expect(() => planRenewal({ expiresAtMs: T0 }, T0, -1)).toThrow(RangeError);
    expect(() => planRenewal({ expiresAtMs: T0 }, T0, Number.NaN)).toThrow(RangeError);
    expect(() => planRenewal({ expiresAtMs: T0 }, Number.POSITIVE_INFINITY, 0)).toThrow(RangeError);
  });
});

describe('one time-stamp per expiry: a renewal is a compare and set on the expiry (FRW-056 criterion 5)', () => {
  it('a successful renewal moves the expiry, and a second run planned on the old expiry adds nothing (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: T0, max: T0 + 1_000_000_000 }),
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (expiresAtMs, leadMs, extra) => {
          const before: RenewalState = { expiresAtMs };
          const nowMs = expiresAtMs - leadMs;
          const plan = planRenewal(before, nowMs, leadMs);
          expect(plan.action).toBe('renew');
          if (plan.action !== 'renew') return;
          const newExpiresAtMs = expiresAtMs + extra;
          const first = applyRenewalResult(
            before,
            plan.expectedExpiresAtMs,
            { ok: true, newExpiresAtMs },
            nowMs,
          );
          expect(first).toMatchObject({ ok: true, alert: false, retry: false });
          if (!first.ok) return;
          expect(first.state).toEqual({ expiresAtMs: newExpiresAtMs });
          // The second run planned against the same old expiry: refused, state unchanged.
          const second = applyRenewalResult(
            first.state,
            plan.expectedExpiresAtMs,
            { ok: true, newExpiresAtMs: newExpiresAtMs + extra },
            nowMs,
          );
          expect(second).toMatchObject({ ok: false, code: 'stale', alert: true, retry: false });
          expect(second.state).toEqual({ expiresAtMs: newExpiresAtMs });
          // A run planned on the new expiry is outside the lead window: it waits.
          expect(planRenewal(first.state, nowMs, leadMs).action).toBe('wait');
        },
      ),
    );
  });
});

describe('a failed renewal is visible and retried while time remains (FRW-056 criterion 5)', () => {
  const failures: RenewalResult[] = [
    { ok: false, reason: 'tsa_unreachable' },
    { ok: false, reason: 'signing_unavailable' },
    { ok: false, reason: 'seal_failed' },
  ];

  it('alerts always, and retries only before the expiry (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: T0, max: T0 + 1_000_000_000 }),
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.constantFrom(...failures),
        (expiresAtMs, offset, result) => {
          const state: RenewalState = { expiresAtMs };
          const nowMs = expiresAtMs + offset;
          const out = applyRenewalResult(state, expiresAtMs, result, nowMs);
          expect(out).toMatchObject({ ok: false, code: 'renewal_failed', alert: true });
          expect(out.state).toEqual(state);
          expect(out.retry).toBe(nowMs < expiresAtMs);
        },
      ),
    );
  });
});

describe('a new time-stamp must extend the chain and still be valid when recorded', () => {
  it('refuses an expiry that does not extend the chain, or that has already passed', () => {
    const state: RenewalState = { expiresAtMs: T0 + 1000 };
    const nowMs = T0 + 500;
    for (const newExpiresAtMs of [T0 + 1000, T0 + 999, T0 + 400, Number.NaN]) {
      const out = applyRenewalResult(state, T0 + 1000, { ok: true, newExpiresAtMs }, nowMs);
      expect(out).toMatchObject({ ok: false, code: 'invalid_timestamp', alert: true, retry: true });
      expect(out.state).toEqual(state);
    }
  });

  it('a stale expected expiry is refused before the result is looked at (property)', () => {
    fc.assert(
      fc.property(msArb, msArb, fc.integer({ min: 1, max: 1_000_000 }), (expiresAtMs, nowMs, d) => {
        const state: RenewalState = { expiresAtMs };
        const out = applyRenewalResult(
          state,
          expiresAtMs + d,
          { ok: true, newExpiresAtMs: expiresAtMs + d + 1 },
          nowMs,
        );
        expect(out).toMatchObject({ ok: false, code: 'stale', retry: false });
        expect(out.state).toEqual(state);
      }),
    );
  });
});
