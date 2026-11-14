/**
 * Region leases (07 §10, §4 limit 3, §12 rows 10 and 11; PRM-043 to PRM-045; ADR 0050 item 8). A
 * lease gives one user exclusive editing of a region for a short time. It has an identifier, a
 * holder and an expiry (default five minutes); the holder extends it with a heartbeat, up to a
 * total of eight hours; it ends when released, when it expires, or when a user with `manage` breaks
 * it. While it is held, everyone else has at most `view` and `comment` in the region (computed by
 * `computeAccess`), owners included.
 *
 * These functions decide the control-plane requests and return the leases to store under a new
 * grants revision; the room then records a control commit and sends `perm.changed` (07 §9). A
 * lease is never part of the document, so acquiring and releasing it leaves the content and its
 * hash unchanged.
 */
import type { Access } from './access.ts';
import type { Lease, PermissionState } from './model.ts';

/** 07 §10's targets: five minutes per acquisition or heartbeat, eight hours in all. */
export const LEASE_DEFAULTS = Object.freeze({ durationMs: 5 * 60_000, maxTotalMs: 8 * 3_600_000 });

export interface LeaseOptions {
  durationMs?: number;
  maxTotalMs?: number;
}

export type LeaseVerdict =
  | { ok: true; lease: Lease; leases: Lease[] }
  | {
      ok: false;
      code: 'permission_denied' | 'conflict' | 'not_found';
      reason: string;
      /** The lease in force, when another user holds it. */
      held?: Lease;
    };

export type LeaseEnd = { ok: true; leases: Lease[] } | Exclude<LeaseVerdict, { ok: true }>;

const live = (perms: PermissionState, region: string, now: number): Lease | undefined =>
  perms.leases.find((l) => l.region === region && l.expiresAt > now);

const others = (perms: PermissionState, region: string): Lease[] =>
  perms.leases.filter((l) => l.region !== region);

export interface AcquireRequest {
  /** The requester's access (07 §12 row 11: `edit` in that region). */
  access: Access;
  perms: PermissionState;
  region: string;
  holder: string;
  now: number;
  /** The lease identifier the control plane generated (05 §6.2 `Lease.id`). */
  id: string;
  options?: LeaseOptions;
}

/**
 * `POST /documents/{id}/regions/{rid}/lease` (PRM-043): needs `edit` in the region, which an
 * approved region gives no one, and no lease of another user in force. The holder acquiring again
 * keeps the lease it has.
 */
export function acquireLease(r: AcquireRequest): LeaseVerdict {
  const current = live(r.perms, r.region, r.now);
  if (current && current.holder !== r.holder)
    return {
      ok: false,
      code: 'conflict',
      reason: `the region is leased to someone else until ${current.expiresAt}`,
      held: current,
    };
  if ((r.perms.regionStates.get(r.region) ?? 'draft') === 'approved')
    return { ok: false, code: 'permission_denied', reason: 'the region is approved (07 §11)' };
  if (!(r.access.regions.get(r.region)?.has('edit') ?? false))
    return { ok: false, code: 'permission_denied', reason: 'a lease needs `edit` in the region' };
  if (current) return { ok: true, lease: current, leases: [...r.perms.leases] };
  const duration = r.options?.durationMs ?? LEASE_DEFAULTS.durationMs;
  const lease: Lease = {
    region: r.region,
    holder: r.holder,
    expiresAt: r.now + duration,
    id: r.id,
    acquiredAt: r.now,
  };
  return { ok: true, lease, leases: [...others(r.perms, r.region), lease] };
}

export interface HeartbeatRequest {
  perms: PermissionState;
  region: string;
  /** The lease the heartbeat names. */
  id: string;
  holder: string;
  now: number;
  options?: LeaseOptions;
}

/**
 * `PUT …/lease`, the heartbeat (PRM-044): only the holder of the lease in force; its expiry moves
 * to now plus the duration, but never past acquisition plus the maximum. A lease that expired or
 * was broken cannot be renewed, nor one without its acquisition time (the maximum could not be
 * enforced, so the renewal fails closed).
 */
export function renewLease(r: HeartbeatRequest): LeaseVerdict {
  const current = live(r.perms, r.region, r.now);
  if (!current || (current.id !== undefined && current.id !== r.id))
    return { ok: false, code: 'not_found', reason: 'you no longer hold this lease' };
  if (current.holder !== r.holder)
    return { ok: false, code: 'permission_denied', reason: 'only the holder renews a lease' };
  if (current.acquiredAt === undefined)
    return { ok: false, code: 'conflict', reason: 'the lease records no acquisition time' };
  const duration = r.options?.durationMs ?? LEASE_DEFAULTS.durationMs;
  const max = current.acquiredAt + (r.options?.maxTotalMs ?? LEASE_DEFAULTS.maxTotalMs);
  if (r.now >= max)
    return { ok: false, code: 'not_found', reason: 'the lease reached its maximum' };
  const lease: Lease = { ...current, expiresAt: Math.min(r.now + duration, max) };
  return { ok: true, lease, leases: [...others(r.perms, r.region), lease] };
}

export interface EndRequest {
  access: Access;
  perms: PermissionState;
  region: string;
  /** The caller. */
  user: string;
  now: number;
}

/**
 * `DELETE …/lease` (PRM-043, PRM-045; ADR 0050 item 8): the holder releases their own lease; anyone
 * else ends it only by breaking it, which needs `manage` (07 §2, §12 row 10). Breaking is then a
 * control commit and an audit entry, written by whoever stores the change.
 */
export function endLease(r: EndRequest): LeaseEnd & { broken?: boolean } {
  const current = live(r.perms, r.region, r.now);
  if (!current) return { ok: false, code: 'not_found', reason: 'the region has no lease' };
  if (current.holder === r.user) return { ok: true, leases: others(r.perms, r.region) };
  if (!r.access.docRole.has('manage'))
    return {
      ok: false,
      code: 'permission_denied',
      reason: "breaking another user's lease needs `manage` (`lease.break`)",
    };
  return { ok: true, leases: others(r.perms, r.region), broken: true };
}
