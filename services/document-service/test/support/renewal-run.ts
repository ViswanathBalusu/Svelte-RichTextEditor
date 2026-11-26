// One run of the renewal schedule (FRW-056 criterion 2; BE-052) for a tenant, as the scheduler runs it.
import { renewalScheduleTask } from '../../src/control-plane/jobs/workflow-renewal.ts';
import type {
  RenewalDueSource,
  RenewalEnqueuer,
} from '../../src/control-plane/jobs/workflow-renewal.ts';

/** The most documents one run scans; the same as the task's own limit. */
const SCAN_LIMIT = 500;

/**
 * Runs `renewalScheduleTask` once and answers the documents it found due, which are the ones it
 * queued a job for (a job that already existed is counted too).
 */
export async function scheduleRenewals(
  deps: {
    readonly registry: RenewalDueSource;
    readonly queue: RenewalEnqueuer;
    readonly leadMs: number;
    readonly now: () => number;
  },
  tenant: string,
): Promise<{ queued: readonly { readonly doc: string; readonly expiresAtMs: number }[] }> {
  const now = deps.now();
  const due = await deps.registry.listDue(tenant, now, now + deps.leadMs, SCAN_LIMIT);
  const task = renewalScheduleTask({
    source: deps.registry,
    queue: deps.queue,
    leadMs: deps.leadMs,
  });
  const n = await task.forTenant!(tenant, now, { held: () => true } as never);
  if (n !== due.length) throw new Error(`the task queued ${String(n)} of ${String(due.length)}`);
  return { queued: due };
}
