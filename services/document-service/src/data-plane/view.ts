/**
 * Read restrictions at the data plane (ADR 0019, proposed; spike S12; PRO-130). One visibility
 * function decides, per connection, what it may not see; the projection gateway of
 * `@docedit/authority` applies it to the outgoing stream, and the content reads and presence of
 * this folder apply the same function, one visibility class at a time. Until read restrictions are
 * accepted the default hides nothing, so every reader is in one class and sees the full document.
 *
 * View tokens. The gateway names a class with an unkeyed hash of its key. On the wire the data
 * plane replaces it with a keyed token, HMAC-SHA-256 of the class key under a deployment key, so
 * that a token reveals nothing about which scopes a class hides and cannot be computed for
 * another class (ADR 0019 change 1; ADR 0035). `keyedViewToken` is the one definition: content
 * reads over REST (decision D70 of packet A2) must use it with the same key, so that a client
 * that joins from REST can resume a channel (G101).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  NOTHING_HIDDEN,
  viewToken,
  visibilityKey,
  type Connection,
  type HiddenSet,
  type PermissionState,
  type Visibility,
} from '@docedit/authority';

/** The default visibility: nothing is hidden from anyone (ADR 0019 is proposed, not accepted). */
export const SEES_EVERYTHING: Visibility = () => NOTHING_HIDDEN;

export function hidesNothing(h: HiddenSet): boolean {
  return h.regions.size === 0 && h.values.size === 0;
}

/** The view token of a visibility class under a deployment key: opaque to clients. */
export function keyedViewToken(key: Uint8Array, hidden: HiddenSet): string {
  const mac = createHmac('sha256', key)
    .update(`dep-view\n${visibilityKey(hidden)}`, 'utf8')
    .digest();
  return `v1.${mac.subarray(0, 18).toString('base64url')}`;
}

type FullDoc = Parameters<Visibility>[1];

export class ViewTokens {
  readonly #key: Uint8Array;
  readonly #visibility: Visibility;

  constructor(key: Uint8Array, visibility: Visibility) {
    this.#key = key;
    this.#visibility = visibility;
  }

  /** What `conn` may not see in `doc` under `perms`. */
  hidden(conn: Connection, doc: FullDoc, perms: PermissionState): HiddenSet {
    return this.#visibility(conn, doc, perms);
  }

  /** The gateway's own token for a class (`viewToken` of `@docedit/authority`). */
  gatewayToken(hidden: HiddenSet): string {
    return viewToken(visibilityKey(hidden));
  }

  /** The gateway's token of the class that sees the full document (for `sync.check`, SYN-043). */
  get fullGatewayToken(): string {
    return viewToken(visibilityKey(NOTHING_HIDDEN));
  }

  /** The token the client sees for a class. */
  tokenFor(hidden: HiddenSet): string {
    return keyedViewToken(this.#key, hidden);
  }

  /** Whether a token a client sent names the class `hidden` (compared in constant time). */
  matches(hidden: HiddenSet, sent: string | undefined): boolean {
    if (sent === undefined) return false;
    const want = Buffer.from(this.tokenFor(hidden), 'utf8');
    const got = Buffer.from(sent, 'utf8');
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
