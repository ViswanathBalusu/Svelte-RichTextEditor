/**
 * The monthly limit on the recipient rows of a tenant's bulk sends (FRW-063 criterion 4; owner
 * decision 265). It is in its own module so that the kit of the control plane can name its type
 * without importing the routes (no import cycle).
 */
import { monthBounds, secondsToNextMonth } from './exp-009-compile-budget.ts';
import type { QuotaSource } from './live-quotas.ts';
import type { JobQueue } from './jobs/queue.ts';

/** The job kind of a bulk send. */
export const BULK_SEND_KIND = 'workflow.bulk_send';

export interface BulkSendRefusal {
  /** The `Retry-After` of the refusal, in seconds. */
  retryAfterS: number;
  usedRows: number;
  budgetRows: number;
}

/**
 * The monthly limit on the recipient rows of a tenant's bulk sends (the quota `bulkSendRows`; owner
 * decision 265: rows per calendar month in UTC, like other usage). The rows used are the rows of
 * the bulk-send jobs created in the month, as the queue holds them, whatever their state: a row
 * that fails still was submitted. A limit that is not set (`null`) is no limit.
 */
export class BulkSendBudget {
  readonly #quotas: QuotaSource | null;
  readonly #queue: JobQueue;

  constructor(quotas: QuotaSource | null, queue: JobQueue) {
    this.#quotas = quotas;
    this.#queue = queue;
  }

  /** The rows a tenant has submitted in the UTC month containing `now`. */
  usedRows(tenant: string, now: number): Promise<number> {
    const { from, to } = monthBounds(now);
    return this.#queue.payloadItems(tenant, BULK_SEND_KIND, 'rows', from, to);
  }

  /** The monthly limit of a tenant in rows, or `null` when none is set. */
  budgetRows(tenant: string): number | null {
    return this.#quotas?.get(tenant).bulkSendRows ?? null;
  }

  /** `null` when a request of `rows` rows may go ahead; otherwise the refusal to give. */
  async refusal(tenant: string, rows: number, now: number): Promise<BulkSendRefusal | null> {
    const budget = this.budgetRows(tenant);
    if (budget === null) return null;
    const used = await this.usedRows(tenant, now);
    if (used + rows <= budget) return null;
    return { retryAfterS: secondsToNextMonth(now), usedRows: used, budgetRows: budget };
  }
}
