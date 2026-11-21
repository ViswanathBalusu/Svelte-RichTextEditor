// EXP-009: the monthly compile-minute budget over the queue's record of worker time, its UTC
// months and its refusal (09 §9.1; 06 §12). The queue is the in-memory one with a clock the test
// moves; the same measure on PostgreSQL is tested in test/control-plane/exp-009-worker-time.test.ts.
import { describe, expect, it } from 'vitest';
import {
  CompileBudget,
  MS_PER_MINUTE,
  monthBounds,
  monthOf,
  secondsToNextMonth,
} from './exp-009-compile-budget.ts';
import { EXPORT_KINDS } from './exports.ts';
import { MemoryJobQueue } from './jobs/queue.ts';
import { MemoryQuotaStore } from './quotas.ts';

const JUNE_10 = Date.UTC(2026, 5, 10, 12, 0, 0);
const JULY_1 = Date.UTC(2026, 6, 1, 0, 0, 0);

/** A budget over a queue whose clock the test moves, with the budgets of `values` set. */
function setup(values: Record<string, number> = {}, start = JUNE_10) {
  let now = start;
  const queue = new MemoryJobQueue(() => now);
  const store = new MemoryQuotaStore(() => true);
  for (const [tenant, minutes] of Object.entries(values))
    store.set(tenant, 'exportMinutes', minutes);
  let reads = 0;
  const budget = new CompileBudget(store, (tenant, from, to) => {
    reads++;
    return queue.workerTime(tenant, EXPORT_KINDS, from, to);
  });
  /** Runs one job of `kind` to completion; its worker holds it for `ms` of the queue's clock. */
  const work = async (tenant: string, ms: number, kind = 'export'): Promise<void> => {
    const job = await queue.enqueue(tenant, { kind, payload: {}, createdBy: 'user-1' });
    expect((await queue.claim([kind], 'w', 600_000))?.id).toBe(job.id);
    now += ms;
    expect(await queue.complete({ tenant, id: job.id }, 'w', {})).toBe(true);
  };
  return {
    budget,
    queue,
    store,
    work,
    now: () => now,
    at: (t: number) => (now = t),
    reads: () => reads,
  };
}

describe('EXP-009 UTC months', () => {
  it('names the month of a time in UTC, so that a month starts at its first instant', () => {
    expect(monthOf(JUNE_10)).toBe('2026-06');
    expect(monthOf(JULY_1)).toBe('2026-07');
    expect(monthOf(JULY_1 - 1)).toBe('2026-06');
  });

  it('bounds the calendar month in UTC, the year end included', () => {
    expect(monthBounds(JUNE_10)).toEqual({ from: Date.UTC(2026, 5, 1), to: JULY_1 });
    expect(monthBounds(JULY_1 - 1)).toEqual({ from: Date.UTC(2026, 5, 1), to: JULY_1 });
    expect(monthBounds(JULY_1)).toEqual({ from: JULY_1, to: Date.UTC(2026, 7, 1) });
    expect(monthBounds(Date.UTC(2026, 11, 31, 23, 59, 59))).toEqual({
      from: Date.UTC(2026, 11, 1),
      to: Date.UTC(2027, 0, 1),
    });
  });

  it('gives the seconds to the next month, at least one', () => {
    expect(secondsToNextMonth(JULY_1 - 1000)).toBe(1);
    expect(secondsToNextMonth(JULY_1 - 1)).toBe(1);
    expect(secondsToNextMonth(JUNE_10)).toBe(Math.ceil((JULY_1 - JUNE_10) / 1000));
  });
});

describe('EXP-009 compile minutes from the queue', () => {
  it('counts the worker time of a tenant jobs against that tenant, not against another (criterion 1)', async () => {
    const s = setup();
    await s.work('t1', 90_000);
    await s.work('t1', 30_000);
    await s.work('t2', 60_000);
    expect(await s.budget.usedMinutes('t1', s.now())).toBeCloseTo(2, 9);
    expect(await s.budget.usedMinutes('t2', s.now())).toBeCloseTo(1, 9);
    expect(await s.budget.usedMinutes('t3', s.now())).toBe(0);
  });

  it('counts previews as well as requested exports, and no other kind of job', async () => {
    const s = setup();
    await s.work('t1', 60_000, 'export');
    await s.work('t1', 30_000, 'preview');
    await s.work('t1', 600_000, 'asset');
    expect(await s.budget.usedMinutes('t1', s.now())).toBeCloseTo(1.5, 9);
  });

  it('counts a job in the month it ended in, and starts a new month with no minutes used', async () => {
    // Claimed thirty seconds before the month ends, done thirty seconds into the next.
    const s = setup({ t1: 1 }, JULY_1 - 30_000);
    await s.work('t1', MS_PER_MINUTE);
    expect(s.now()).toBe(JULY_1 + 30_000);
    expect(await s.budget.usedMinutes('t1', JULY_1 - 1)).toBe(0);
    expect(await s.budget.usedMinutes('t1', s.now())).toBeCloseTo(1, 9);
    expect(await s.budget.refusal('t1', JULY_1 - 1)).toBeNull();
    expect(await s.budget.refusal('t1', s.now())).not.toBeNull();
    // The month after has none of it.
    const august = Date.UTC(2026, 7, 1);
    expect(await s.budget.usedMinutes('t1', august)).toBe(0);
    expect(await s.budget.refusal('t1', august)).toBeNull();
  });

  it('refuses once the minutes used reach the budget, with Retry-After to the next month (criterion 2)', async () => {
    const s = setup({ t1: 1 });
    expect(await s.budget.refusal('t1', s.now())).toBeNull();
    await s.work('t1', MS_PER_MINUTE - 1);
    expect(await s.budget.refusal('t1', s.now())).toBeNull();
    await s.work('t1', 1);
    expect(await s.budget.refusal('t1', s.now())).toEqual({
      retryAfterS: secondsToNextMonth(s.now()),
      usedMinutes: 1,
      budgetMinutes: 1,
    });
  });

  it('refuses at once when the budget is zero, and never when no budget is set', async () => {
    expect(await setup({ t1: 0 }).budget.refusal('t1', JUNE_10)).not.toBeNull();
    const none = setup();
    await none.work('t1', 10 * MS_PER_MINUTE);
    expect(await none.budget.refusal('t1', none.now())).toBeNull();
    // A tenant without a budget costs no read of the queue.
    expect(none.reads()).toBe(0);
    const unlimited = new CompileBudget(null, async () => 10 * MS_PER_MINUTE);
    expect(unlimited.budgetMinutes('t1')).toBeNull();
    expect(await unlimited.refusal('t1', JUNE_10)).toBeNull();
  });

  it('reads the budget at each decision, so a raised budget lets the export through again', async () => {
    const s = setup({ t1: 1 });
    await s.work('t1', MS_PER_MINUTE);
    expect(await s.budget.refusal('t1', s.now())).not.toBeNull();
    s.store.set('t1', 'exportMinutes', 5);
    expect(await s.budget.refusal('t1', s.now())).toBeNull();
  });

  it('reads a worker time that is not a positive finite number as none', async () => {
    for (const ms of [-5, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const store = new MemoryQuotaStore(() => true);
      store.set('t1', 'exportMinutes', 1);
      const budget = new CompileBudget(store, async () => ms);
      expect(await budget.usedMinutes('t1', JUNE_10)).toBe(0);
      expect(await budget.refusal('t1', JUNE_10)).toBeNull();
    }
  });
});
