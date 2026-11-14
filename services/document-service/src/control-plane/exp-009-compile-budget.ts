/**
 * The monthly compile-minute budget of a tenant (EXP-009; 09 §9.1; 06 §12).
 *
 * The worker time of every settled export and preview job counts against the tenant of the job,
 * in the UTC calendar month the job ended in. A requested export is refused with `quota_exceeded`
 * and a `Retry-After` of the seconds to the next month, once the minutes used reach the budget.
 *
 * Decisions taken here, because the spec leaves them open (see EXP-009 Notes):
 * - previews count, as the worker time of any compile does;
 * - the refusal covers previews too, and it is checked before a cached answer is given;
 * - a budget that is not set (`null`) is no limit: the spec gives no figures, so there is no default.
 *
 * The ledger is in memory only: the usage of a process lasts as long as the process. The durable
 * ledger and the administration write path of the budget are not built.
 */
import type { QuotaSource } from './live-quotas.ts';

export const MS_PER_MINUTE = 60_000;

/** The month a Unix time in milliseconds counts in, as `YYYY-MM` in UTC. */
export function monthOf(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Whole seconds from `now` to the start of the next UTC month, at least 1. */
export function secondsToNextMonth(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

export interface BudgetRefusal {
  /** The `Retry-After` of the refusal, in seconds. */
  retryAfterS: number;
  usedMinutes: number;
  budgetMinutes: number;
}

export class CompileBudget {
  readonly #quotas: QuotaSource | null;
  /** Milliseconds of worker time by `tenant` and month. */
  readonly #used = new Map<string, number>();

  /** `quotas` gives the `exportMinutes` budget of a tenant; absent, every budget is `null`. */
  constructor(quotas: QuotaSource | null) {
    this.#quotas = quotas;
  }

  /** Counts the worker time of a settled job against its tenant, in the month of `now`. */
  record(tenant: string, ranMs: number, now: number): void {
    if (!Number.isFinite(ranMs) || ranMs <= 0) return;
    const key = `${tenant}\n${monthOf(now)}`;
    this.#used.set(key, (this.#used.get(key) ?? 0) + ranMs);
  }

  /** The compile minutes a tenant has used in the month of `now`. */
  usedMinutes(tenant: string, now: number): number {
    return (this.#used.get(`${tenant}\n${monthOf(now)}`) ?? 0) / MS_PER_MINUTE;
  }

  /** The monthly budget of a tenant in minutes, or `null` when none is set. */
  budgetMinutes(tenant: string): number | null {
    return this.#quotas?.get(tenant).exportMinutes ?? null;
  }

  /** `null` when an export of the tenant may go ahead; otherwise the refusal to give. */
  refusal(tenant: string, now: number): BudgetRefusal | null {
    const budget = this.budgetMinutes(tenant);
    if (budget === null) return null;
    const used = this.usedMinutes(tenant, now);
    if (used < budget) return null;
    return { retryAfterS: secondsToNextMonth(now), usedMinutes: used, budgetMinutes: budget };
  }
}
