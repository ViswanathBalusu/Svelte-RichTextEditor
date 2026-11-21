/**
 * Check-out of a region, as the permissions pane offers it (PRM-043; 07 §10). The pane shows the
 * control only when the core has a leases service, which it has only when the backend announces
 * `leases` (05 §8.3). What it offers for one region follows from the region list (`leasedTo`, the
 * state), the user's access and the leases this session holds.
 *
 * The server decides. A control that is offered can still be refused (someone else took the lease
 * a moment ago), and the refusal is shown in words (`leaseFailureKey`).
 */
import type { AccessObject, HeldLease, RegionSummary } from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';
import { mayEditRegion } from './regions.ts';
import '../i18n/late/permissionsPane.ts';

/** What the pane shows for one region. */
export type CheckOut =
  /** No control: the region is hidden from this reader (ADR 0019). */
  | { readonly kind: 'none' }
  /** The user may take the region. */
  | { readonly kind: 'offer' }
  /** The user holds it and may give it back. */
  | { readonly kind: 'mine' }
  /** Someone else holds it; the region list names them (`whoCanEdit`). */
  | { readonly kind: 'other'; readonly holder: string }
  /** The user cannot take it, for the reason given. */
  | { readonly kind: 'blocked'; readonly reason: StringKey };

export function checkOutState(
  region: RegionSummary,
  access: AccessObject | null | undefined,
  held: readonly HeldLease[],
): CheckOut {
  if (region.title === null) return { kind: 'none' };
  const holder = region.editors?.leasedTo;
  if (holder !== undefined) {
    // The service's answer is kept only while the region list still names the same holder: a lease
    // that lapsed, or was broken and taken by someone else, is not the user's any more.
    const mine = held.some((l) => l.region === region.id && l.holder === holder);
    return mine ? { kind: 'mine' } : { kind: 'other', holder };
  }
  if (region.state === 'approved') return { kind: 'blocked', reason: 'lease.approved' };
  if (!mayEditRegion(access, region.id)) return { kind: 'blocked', reason: 'lease.noEdit' };
  return { kind: 'offer' };
}

/** The words for a refused or failed check-out (05 §5.8: the codes of the lease routes). */
export function leaseFailureKey(error: unknown): StringKey {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'conflict') return 'lease.conflict';
  if (code === 'forbidden') return 'lease.forbidden';
  return 'lease.failed';
}
