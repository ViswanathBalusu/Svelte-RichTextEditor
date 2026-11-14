// EXP-009: the monthly compile-minute ledger, its UTC months and its refusal (09 §9.1; 06 §12).
import { describe, expect, it } from 'vitest';
import {
  CompileBudget,
  MS_PER_MINUTE,
  monthOf,
  secondsToNextMonth,
} from './exp-009-compile-budget.ts';
import { MemoryQuotaStore } from './quotas.ts';

const JUNE_10 = Date.UTC(2026, 5, 10, 12, 0, 0);
const JULY_1 = Date.UTC(2026, 6, 1, 0, 0, 0);

function budgetWith(values: Record<string, number>): CompileBudget {
  const store = new MemoryQuotaStore(() => true);
  for (const [tenant, minutes] of Object.entries(values))
    store.set(tenant, 'exportMinutes', minutes);
  return new CompileBudget(store);
}

describe('EXP-009 UTC months', () => {
  it('names the month of a time in UTC, so that a month starts at its first instant', () => {
    expect(monthOf(JUNE_10)).toBe('2026-06');
    expect(monthOf(JULY_1)).toBe('2026-07');
    expect(monthOf(JULY_1 - 1)).toBe('2026-06');
  });

  it('gives the seconds to the next month, at least one', () => {
    expect(secondsToNextMonth(JULY_1 - 1000)).toBe(1);
    expect(secondsToNextMonth(JUNE_10)).toBe(Math.ceil((JULY_1 - JUNE_10) / 1000));
  });
});

describe('EXP-009 compile-minute ledger', () => {
  it('counts the worker time of settled jobs against the tenant, not against another (criterion 1)', () => {
    const budget = budgetWith({});
    budget.record('t1', 90_000, JUNE_10);
    budget.record('t1', 30_000, JUNE_10 + 1000);
    budget.record('t2', 60_000, JUNE_10);
    expect(budget.usedMinutes('t1', JUNE_10)).toBeCloseTo(2, 9);
    expect(budget.usedMinutes('t2', JUNE_10)).toBeCloseTo(1, 9);
    expect(budget.usedMinutes('t3', JUNE_10)).toBe(0);
  });

  it('ignores a run time that is not a positive finite number', () => {
    const budget = budgetWith({});
    budget.record('t1', -5, JUNE_10);
    budget.record('t1', Number.NaN, JUNE_10);
    budget.record('t1', 0, JUNE_10);
    expect(budget.usedMinutes('t1', JUNE_10)).toBe(0);
  });

  it('starts a new month with no minutes used', () => {
    const budget = budgetWith({ t1: 1 });
    budget.record('t1', MS_PER_MINUTE, JUNE_10);
    expect(budget.refusal('t1', JUNE_10)).not.toBeNull();
    expect(budget.usedMinutes('t1', JULY_1)).toBe(0);
    expect(budget.refusal('t1', JULY_1)).toBeNull();
  });

  it('refuses once the minutes used reach the budget, with Retry-After to the next month (criterion 2)', () => {
    const budget = budgetWith({ t1: 1 });
    expect(budget.refusal('t1', JUNE_10)).toBeNull();
    budget.record('t1', MS_PER_MINUTE, JUNE_10);
    const refused = budget.refusal('t1', JUNE_10);
    expect(refused).toEqual({
      retryAfterS: secondsToNextMonth(JUNE_10),
      usedMinutes: 1,
      budgetMinutes: 1,
    });
  });

  it('refuses at once when the budget is zero, and never when no budget is set', () => {
    expect(budgetWith({ t1: 0 }).refusal('t1', JUNE_10)).not.toBeNull();
    expect(budgetWith({}).refusal('t1', JUNE_10)).toBeNull();
    const unlimited = new CompileBudget(null);
    unlimited.record('t1', 10 * MS_PER_MINUTE, JUNE_10);
    expect(unlimited.refusal('t1', JUNE_10)).toBeNull();
  });

  it('reads the budget at each decision, so a raised budget lets the export through again', () => {
    const store = new MemoryQuotaStore(() => true);
    store.set('t1', 'exportMinutes', 1);
    const budget = new CompileBudget(store);
    budget.record('t1', MS_PER_MINUTE, JUNE_10);
    expect(budget.refusal('t1', JUNE_10)).not.toBeNull();
    store.set('t1', 'exportMinutes', 5);
    expect(budget.refusal('t1', JUNE_10)).toBeNull();
  });
});
