/**
 * The first expiry of a seal's time-stamp (12 §8.2 step 5; FRW-056 criterion 2).
 *
 * `recordFirstExpiry` is called when a workflow is finalised: it records when the seal's time-stamp
 * ends, which is what the renewal schedule reads. The schedule itself is `renewalScheduleTask`
 * (control-plane/jobs/workflow-renewal.ts, BE-052): it finds the sealed documents whose newest
 * time-stamp ends within the lead time and queues one `workflow.renewal` job for each expiry, so a
 * time-stamp is renewed once for one expiry however often the task runs and however many instances
 * run it. The renewal itself is `renewalHandler`, which claims the expiry before it asks the
 * signing service. The lead time and the claim time are settings with no default: the
 * specification gives none (`DOCEDIT_SEAL_RENEW_LEAD_DAYS`, `DOCEDIT_SEAL_RENEW_CLAIM_MS`).
 */

/** What the finalisation needs of the chain's store; `PgRenewalStore` is one. */
export interface RenewalRegistry {
  /** Records the first expiry of a sealed document; false when the document was already recorded. */
  start(tenant: string, doc: string, expiresAtMs: number): Promise<boolean>;
}

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
