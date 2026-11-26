/**
 * The monthly compile-minute budget of a tenant (EXP-009; 09 §9.1; 06 §12).
 *
 * The worker time of every export and preview job counts against the tenant of the job, in the UTC
 * calendar month the job ended in (the usage window is the calendar month in UTC, owner decision
 * 69). A requested export is refused with `quota_exceeded` and a `Retry-After` of the seconds to the
 * next month, once the minutes used reach the budget.
 *
 * The minutes come from the job queue, which measures the worker time of each job and keeps it with
 * the job (`JobQueue.workerTime`). So they are counted whichever process ran the job, the export
 * worker's own process included, they are the same on every node of the service, and they outlast a
 * restart. Nothing is counted in this process.
 *
 * Decisions taken here, because the spec leaves them open (see EXP-009 Notes and
 * docs/adr/0422-w2-EXP-009-compile-minutes-from-the-queue.md, proposed):
 * - previews count, as the worker time of any compile does;
 * - the refusal covers previews too, and it is checked before a cached answer is given;
 * - a budget that is not set (`null`) is no limit: the spec gives no figures, so there is no default;
 * - a job counts in the month it ended in, with all its attempts.
 */
import type { QuotaSource } from './live-quotas.ts';
import { monthOf } from './month.ts';

export { monthOf };

export const MS_PER_MINUTE = 60_000;

/** The UTC calendar month of `now`: its first millisecond, and the first of the month after. */
export function monthBounds(now: number): { from: number; to: number } {
  const d = new Date(now);
  return {
    from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    to: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  };
}

/** Whole seconds from `now` to the start of the next UTC month, at least 1. */
export function secondsToNextMonth(now: number): number {
  return Math.max(1, Math.ceil((monthBounds(now).to - now) / 1000));
}

export interface BudgetRefusal {
  /** The `Retry-After` of the refusal, in seconds. */
  retryAfterS: number;
  usedMinutes: number;
  budgetMinutes: number;
}

/**
 * The worker time, in milliseconds, of a tenant's export and preview jobs that ended at or after
 * `from` and before `to` (Unix ms). The composition reads it from the job queue.
 */
export type WorkerTimeReader = (tenant: string, from: number, to: number) => Promise<number>;

export class CompileBudget {
  readonly #quotas: QuotaSource | null;
  readonly #workerTime: WorkerTimeReader;

  /**
   * `quotas` gives the `exportMinutes` budget of a tenant; absent, every budget is `null`.
   * `workerTime` gives the worker time a tenant has used in a period.
   */
  constructor(quotas: QuotaSource | null, workerTime: WorkerTimeReader) {
    this.#quotas = quotas;
    this.#workerTime = workerTime;
  }

  /** The compile minutes a tenant has used in the month of `now` (for the usage figures too). */
  async usedMinutes(tenant: string, now: number): Promise<number> {
    const { from, to } = monthBounds(now);
    const ms = await this.#workerTime(tenant, from, to);
    return Number.isFinite(ms) && ms > 0 ? ms / MS_PER_MINUTE : 0;
  }

  /** The monthly budget of a tenant in minutes, or `null` when none is set. */
  budgetMinutes(tenant: string): number | null {
    return this.#quotas?.get(tenant).exportMinutes ?? null;
  }

  /**
   * `null` when an export of the tenant may go ahead; otherwise the refusal to give. The usage is
   * read only for a tenant that has a budget.
   */
  async refusal(tenant: string, now: number): Promise<BudgetRefusal | null> {
    const budget = this.budgetMinutes(tenant);
    if (budget === null) return null;
    const used = await this.usedMinutes(tenant, now);
    if (used < budget) return null;
    return { retryAfterS: secondsToNextMonth(now), usedMinutes: used, budgetMinutes: budget };
  }
}
