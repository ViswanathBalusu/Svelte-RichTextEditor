/**
 * Webhook events about permissions (05 §7; 07 §11, §14; PRM-053). The authority builds the bodies:
 * small CloudEvents 1.0 in structured JSON mode, whose `subject` is the document identifier and
 * whose `data` carries the `seq` and identifiers only, never document content. Delivery, subscriptions
 * and retries belong to the host (BE-055). Rejections are throttled; the throttle here is a pure
 * decision, so the number of deliveries it allows is bounded whatever arrives.
 *
 * The throttle's parameters are not stated in 05 or 07 (ADR 0146, Open questions). They are inputs
 * with no default, so no figure is invented here.
 */

/** The event names of 05 §7, with the version suffix that 05 §7's CloudEvent rule gives them. */
export const PERMISSION_EVENT_TYPES = {
  grantsChanged: 'dep.grants.changed.v1',
  regionStateChanged: 'dep.region.state_changed.v1',
  commitRejected: 'dep.commit.rejected.v1',
} as const;

export type PermissionEventType =
  (typeof PERMISSION_EVENT_TYPES)[keyof typeof PERMISSION_EVENT_TYPES];

/** The two refusals that raise `dep.commit.rejected` (05 §7). */
export type RejectionCode = 'permission_denied' | 'invalid_op';

export const REJECTION_CODES: readonly RejectionCode[] = ['permission_denied', 'invalid_op'];

export interface CloudEvent<T extends Record<string, string | number>> {
  specversion: '1.0';
  id: string;
  source: string;
  type: PermissionEventType;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  data: T;
}

/** What every permission event is built from: its identifier, source, document and time. */
export interface EventEnvelope {
  /** A fresh identifier for this delivery, made by the host (the authority holds no clock or RNG). */
  id: string;
  /** The producer, as the host names it. */
  source: string;
  /** The document identifier (the CloudEvents `subject`). */
  document: string;
  /** The document's `seq` the event refers to. */
  seq: number;
  /** Milliseconds since the epoch, from the room's clock. */
  now: number;
}

/** Keys a permission event's `data` may hold. Nothing else is allowed (no content, no steps). */
export const EVENT_DATA_KEYS = ['seq', 'revision', 'region', 'state', 'code'] as const;

function envelope<T extends Record<string, string | number>>(
  e: EventEnvelope,
  type: PermissionEventType,
  data: T,
): CloudEvent<T> {
  return {
    specversion: '1.0',
    id: e.id,
    source: e.source,
    type,
    subject: e.document,
    time: new Date(e.now).toISOString(),
    datacontenttype: 'application/json',
    data,
  };
}

/** `dep.grants.changed`: a grant change committed under a new grants revision. */
export function grantsChangedEvent(
  e: EventEnvelope & { revision: number },
): CloudEvent<{ seq: number; revision: number }> {
  return envelope(e, PERMISSION_EVENT_TYPES.grantsChanged, { seq: e.seq, revision: e.revision });
}

/** `dep.region.state_changed`: a region's state changed (PRM-046). `state` is a label, not content. */
export function regionStateChangedEvent(
  e: EventEnvelope & { region: string; state: 'draft' | 'in_review' | 'approved' },
): CloudEvent<{ seq: number; region: string; state: string }> {
  return envelope(e, PERMISSION_EVENT_TYPES.regionStateChanged, {
    seq: e.seq,
    region: e.region,
    state: e.state,
  });
}

/** `dep.commit.rejected`: a commit refused with `permission_denied` or `invalid_op`. */
export function commitRejectedEvent(
  e: EventEnvelope & { code: RejectionCode },
): CloudEvent<{ seq: number; code: RejectionCode }> | null {
  if (!REJECTION_CODES.includes(e.code)) return null;
  return envelope(e, PERMISSION_EVENT_TYPES.commitRejected, { seq: e.seq, code: e.code });
}

/** Whether an event body holds only the keys 05 §7 allows and no string longer than an identifier. */
export function carriesNoContent(event: CloudEvent<Record<string, string | number>>): boolean {
  const allowed = new Set<string>(EVENT_DATA_KEYS);
  for (const [k, v] of Object.entries(event.data)) {
    if (!allowed.has(k)) return false;
    if (typeof v === 'string' && v.length > 255) return false;
  }
  return true;
}

export interface ThrottleOptions {
  /** At most this many deliveries in any window of `windowMs`. Caller-supplied; no default. */
  limit: number;
  /** The window, in milliseconds. Caller-supplied; no default. */
  windowMs: number;
}

export interface Throttle {
  /** Decides whether an event at time `now` is delivered now. Times must not go backwards. */
  offer(now: number): 'deliver' | 'drop';
  readonly delivered: number;
  readonly dropped: number;
}

/**
 * A sliding-window throttle: a delivery at time `t` is allowed only if fewer than `limit`
 * deliveries happened in `(t - windowMs, t]`. A dropped event is still counted, so the audit trail
 * (PRM-051) can record every rejection whatever the webhook does.
 */
export function createThrottle(opts: ThrottleOptions): Throttle {
  if (!Number.isInteger(opts.limit) || opts.limit < 0)
    throw new RangeError('limit must be a non-negative integer');
  if (!(opts.windowMs > 0)) throw new RangeError('windowMs must be positive');
  const times: number[] = [];
  let last = -Infinity;
  let delivered = 0;
  let dropped = 0;
  return {
    offer(now: number) {
      if (now < last) throw new RangeError('time went backwards');
      last = now;
      while (times.length > 0 && times[0]! <= now - opts.windowMs) times.shift();
      if (times.length < opts.limit) {
        times.push(now);
        delivered++;
        return 'deliver';
      }
      dropped++;
      return 'drop';
    },
    get delivered() {
      return delivered;
    },
    get dropped() {
      return dropped;
    },
  };
}
