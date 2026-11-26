/**
 * The schedule of time-stamp renewals (12 §8.2 step 5; FRW-056 criterion 2).
 *
 * - `recordFirstExpiry` is called when a workflow is finalised: it records when the seal's
 *   time-stamp ends, which is what the schedule reads.
 * - `scheduleRenewals` is one run of the scheduled task `workflow.renewal.schedule` for a tenant. It
 *   finds the sealed documents whose newest time-stamp ends within the lead time and queues one
 *   `workflow.renewal` job for each, with the identifier `renewalJobId` of the document and the
 *   expiry. A document seen again before its renewal is recorded finds the same job (`ifAbsent`), and
 *   once the renewal moves the expiry the document is no longer listed, so a time-stamp is renewed
 *   once for one expiry however often the task runs and however many instances run it.
 *
 * The renewal itself is `renewalHandler` (control-plane/jobs/workflow-renewal.ts), which claims the
 * expiry before it asks the signing service. The lead time and the claim time are settings with no
 * default: the specification gives none (`DOCEDIT_RENEWAL_LEAD_DAYS`, `DOCEDIT_RENEWAL_CLAIM_MS`).
 */
import { RENEWAL_KIND, renewalJobId } from '../control-plane/jobs/workflow-renewal.ts';
import type { JobQueue } from '../control-plane/jobs/queue.ts';

/** What the schedule needs of the chain's store; `PgRenewalStore` is one. */
export interface RenewalRegistry {
  /** Records the first expiry of a sealed document; false when the document was already recorded. */
  start(tenant: string, doc: string, expiresAtMs: number): Promise<boolean>;
  /** The documents whose newest time-stamp holds at `nowMs` and ends within `leadMs`. */
  listDue(
    tenant: string,
    nowMs: number,
    leadMs: number,
    limit: number,
  ): Promise<readonly { doc: string; expiresAtMs: number }[]>;
}

export interface RenewalScheduleDeps {
  readonly registry: RenewalRegistry;
  readonly queue: Pick<JobQueue, 'enqueue'>;
  /** How long before an expiry its renewal is queued, ms. */
  readonly leadMs: number;
  readonly now: () => number;
  /** The most renewals queued by one run; the rest are queued by the next. */
  readonly batch?: number;
}

export interface RenewalScheduleResult {
  /** The documents a renewal job was asked for (a job that already existed is counted too). */
  readonly queued: readonly { readonly doc: string; readonly expiresAtMs: number }[];
}

const DEFAULT_BATCH = 200;

/** Records the end of the seal's time-stamp, so that the schedule can renew it in time. */
export async function recordFirstExpiry(
  registry: Pick<RenewalRegistry, 'start'>,
  tenant: string,
  doc: string,
  expiresAtMs: number | undefined,
): Promise<boolean> {
  if (expiresAtMs === undefined || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0)
    return false;
  return registry.start(tenant, doc, expiresAtMs);
}

/** One run of the schedule for a tenant. */
export async function scheduleRenewals(
  deps: RenewalScheduleDeps,
  tenant: string,
): Promise<RenewalScheduleResult> {
  const due = await deps.registry.listDue(
    tenant,
    deps.now(),
    deps.leadMs,
    deps.batch ?? DEFAULT_BATCH,
  );
  const queued: { doc: string; expiresAtMs: number }[] = [];
  for (const { doc, expiresAtMs } of due) {
    await deps.queue.enqueue(tenant, {
      id: renewalJobId(doc, expiresAtMs),
      kind: RENEWAL_KIND,
      doc,
      payload: { expiry: expiresAtMs },
      createdBy: 'system',
      ifAbsent: true,
    });
    queued.push({ doc, expiresAtMs });
  }
  return { queued };
}
