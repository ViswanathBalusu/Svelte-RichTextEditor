/**
 * The REST side of the quotas (BE-091, BE-092; 05 §5.8; 06 §12). A REST request that authors a
 * commit (`PUT /documents/{id}/content`, the restore of a version) counts against the tenant's
 * commit-rate quota and its room CPU budget like a commit from a socket. A refusal is the registry
 * code with `Retry-After` in whole seconds (at least 1, rounded up from the gate's milliseconds).
 */
import type { LiveQuotas, QuotaSource } from './live-quotas.ts';
import type { QuotaDimension } from './quotas.ts';
import { ApiError } from './problems.ts';

/** Answers with the refusal a spent quota gives, or returns when the request is admitted. */
export async function admitRestCommit(
  quotas: LiveQuotas | undefined,
  tenant: string,
): Promise<void> {
  if (!quotas) return;
  await quotas.prepare(tenant);
  const cpu = quotas.admitCpu(tenant);
  const adm = cpu.ok ? quotas.admitCommit(tenant) : cpu;
  if (adm.ok) return;
  throw new ApiError(
    adm.code,
    cpu.ok
      ? 'the commit-rate quota of the tenant is reached'
      : 'the room CPU budget of the tenant is spent',
    { retryAfterS: Math.max(1, Math.ceil(adm.retryAfterMs / 1000)) },
  );
}

/**
 * The retry hint of a refusal that no clock ends: a tenant at its storage or export-concurrency
 * quota waits for its own work to finish or be removed. The seconds equal the retry delay of the
 * count quotas of the live-use gate (LIVE_QUOTA_COUNT_RETRY_MS); a setting, not a spec figure
 * (docs/adr/0371-w5-BE-092-storage-and-concurrency.md).
 */
export const COUNT_QUOTA_RETRY_AFTER_S = 1;

/** The quota of one dimension of a tenant, or null when none is set. */
export function quotaOf(
  source: QuotaSource | undefined,
  tenant: string,
  dimension: QuotaDimension,
): number | null {
  return source?.get(tenant)[dimension] ?? null;
}

/**
 * Refuses an upload that would take a tenant's assets past its storage quota (BE-092 criterion 1,
 * assets). `stored` is read only when the tenant has a storage quota.
 */
export async function admitStorage(
  source: QuotaSource | undefined,
  tenant: string,
  adding: number,
  stored: (tenant: string) => Promise<number>,
): Promise<void> {
  await source?.load?.(tenant);
  const limit = quotaOf(source, tenant, 'storage');
  if (limit === null) return;
  if ((await stored(tenant)) + adding <= limit) return;
  throw new ApiError('quota_exceeded', 'the tenant has reached its storage quota', {
    retryAfterS: COUNT_QUOTA_RETRY_AFTER_S,
  });
}

/**
 * Refuses an export when the tenant already has as many exports queued or running as its
 * concurrency quota allows. The refusal is `quota_exceeded`, not a wait in the queue (ADR 0246,
 * decision 1, proposed; 06 §12). Other tenants are not asked.
 */
export async function admitExportConcurrency(
  source: QuotaSource | undefined,
  tenant: string,
  active: (tenant: string) => Promise<number>,
): Promise<void> {
  await source?.load?.(tenant);
  const limit = quotaOf(source, tenant, 'exportConcurrency');
  if (limit === null) return;
  if ((await active(tenant)) < limit) return;
  throw new ApiError('quota_exceeded', 'the tenant has reached its export concurrency quota', {
    retryAfterS: COUNT_QUOTA_RETRY_AFTER_S,
  });
}
