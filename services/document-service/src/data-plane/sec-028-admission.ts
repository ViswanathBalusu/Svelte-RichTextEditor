/**
 * The room's admission control as the node configures it (04 §12; SYN-037; SEC-028).
 *
 * Each room gets a budget per connection from the settings. The tenant's budget is one bucket per
 * tenant for the whole node, shared by every room of that tenant (06 §12), so it is kept here and
 * not in a room. Nothing is configured by default: the spec gives no figure for either budget.
 */
import { TokenBucket, type AdmissionConfig } from '@docedit/authority';
import type { Settings } from './settings.ts';

const tenantBudgets = new WeakMap<Settings, Map<string, TokenBucket>>();

/** The admission configuration of a room of `tenant`, or undefined when no budget is set. */
export function admissionFor(
  settings: Settings,
  tenant: string,
  now: number,
): AdmissionConfig | undefined {
  const a = settings.admission;
  if (!a) return undefined;
  if (!a.tenant) return { connection: a.connection };
  let byTenant = tenantBudgets.get(settings);
  if (!byTenant) {
    byTenant = new Map();
    tenantBudgets.set(settings, byTenant);
  }
  let bucket = byTenant.get(tenant);
  if (!bucket) {
    bucket = new TokenBucket(a.tenant, now);
    byTenant.set(tenant, bucket);
  }
  return { connection: a.connection, tenant: bucket };
}
