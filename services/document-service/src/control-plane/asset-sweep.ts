/**
 * Abandoned asset uploads (BE-046 criterion 3; BE-052 scheduler; decision in ADR 0335).
 *
 * A quarantined upload that nobody completed is removed once its upload window has ended: the
 * object under `tenants/{tenant}/quarantine/{asset}` first, then the row. The window is the
 * `upload_expires_at` the row carries from its creation. The spec gives no retention period for
 * these (see the Open questions of the backlog), so the window stands in for it until the owner
 * decides one (ADR 0335). A row a worker has taken (`processing`, `ready`, `failed`) is never
 * selected: `expiredUploads` reads quarantined rows only and `remove` deletes only those.
 *
 * Orphan ready assets (BE-046 criterion 1) are removed when `orphanRetentionMs` is set; they are
 * found through the `doc_assets` table (migration 0064), so an attached asset is never selected.
 * Attachments written by the persist path (BE-044) are not built yet, so the composition leaves the
 * retention unset. Legal holds (criterion 4) need the hold store of HIS-031.
 * The scheduler's `deletes` flag makes the task skip a tenant that `onHold` reports.
 */
import type { AssetRegistry } from './assets.ts';
import type { ScheduledTask } from './scheduler.ts';
import { objectKeys, TenantObjects, type ObjectStore } from '../objects/store.ts';

export const ABANDONED_UPLOADS_TASK = 'assets.abandoned-uploads';

export interface AbandonedUploadsOptions {
  assets: AssetRegistry;
  objects: ObjectStore;
  /** Rows handled per tenant and run. */
  batch?: number;
  /**
   * How long a ready asset that no document attaches is kept after it settled (BE-046 criterion 1).
   * Not set means orphan ready assets are kept: the owner has not decided the period, and until
   * BE-044 writes attachments every referenced asset would look unattached (ADR 0335).
   */
  orphanRetentionMs?: number;
  /**
   * The documents a legal hold covers (BE-046 criterion 4; HIS-029, HIS-030). Their assets are kept
   * by both sweeps. Not set means no document is held. A held upload stays in its batch, so a
   * large number of held uploads can delay the others until the hold is handled (see Notes).
   */
  heldDocuments?: (tenant: string) => Promise<ReadonlySet<string>>;
}

/** Removes the tenant's abandoned uploads whose window ended before `now`; returns how many. */
export async function sweepAbandonedUploads(
  o: AbandonedUploadsOptions,
  tenant: string,
  now: number,
): Promise<number> {
  const expired = await o.assets.expiredUploads(tenant, now, o.batch ?? 100);
  const held = o.heldDocuments ? await o.heldDocuments(tenant) : new Set<string>();
  const objects = new TenantObjects(o.objects, tenant);
  let removed = 0;
  for (const a of expired) {
    if (held.has(a.doc)) continue;
    // The object goes first: a failure here leaves the row, and the next run tries again.
    await objects.delete(objectKeys.quarantine(tenant, a.id));
    if (await o.assets.remove(tenant, a.id)) removed++;
  }
  if (o.orphanRetentionMs !== undefined)
    removed += await sweepOrphanAssets(o, tenant, now - o.orphanRetentionMs, held);
  return removed;
}

/**
 * Ready assets settled before `before` that no attachment names. The row goes first, then the
 * object if no other asset of the tenant shares it: a failure after the row leaves an unreferenced
 * object (storage waste), never a row that points at a missing object.
 */
async function sweepOrphanAssets(
  o: AbandonedUploadsOptions,
  tenant: string,
  before: number,
  held: ReadonlySet<string>,
): Promise<number> {
  const orphans = await o.assets.orphanedReady(tenant, before, o.batch ?? 100);
  const objects = new TenantObjects(o.objects, tenant);
  let removed = 0;
  for (const a of orphans) {
    if (held.has(a.doc)) continue;
    const r = await o.assets.removeOrphan(tenant, a.id);
    if (!r.removed) continue;
    removed++;
    if (r.objectKey !== null) await objects.delete(r.objectKey);
  }
  return removed;
}

/** The scheduled task for abandoned uploads, run hourly for every tenant that is not on hold. */
export function abandonedUploadsTask(o: AbandonedUploadsOptions): ScheduledTask {
  return {
    name: ABANDONED_UPLOADS_TASK,
    everyMs: 3_600_000,
    deletes: true,
    forTenant: (tenant, now) => sweepAbandonedUploads(o, tenant, now),
  };
}
