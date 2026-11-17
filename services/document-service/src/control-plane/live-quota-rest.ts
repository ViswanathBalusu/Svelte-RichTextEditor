/**
 * The REST side of the live-use quotas (BE-091; 05 §5.8; 06 §12). A REST request that authors a
 * commit (`PUT /documents/{id}/content`, the restore of a version) counts against the tenant's
 * commit-rate quota and its room CPU budget like a commit from a socket. A refusal is the registry
 * code with `Retry-After` in whole seconds (at least 1, rounded up from the gate's milliseconds).
 */
import type { LiveQuotas } from './live-quotas.ts';
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
