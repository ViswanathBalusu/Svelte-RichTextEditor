/**
 * Rate limits at the gateway (06 §1, §8; 10 §3.2; BE-030). Before authentication an address may
 * open so many connections and send so many frames, and nothing is verified for one over its
 * limit; after `hello`, messages are limited per connection, per user and per tenant, so one noisy
 * client or tenant cannot take editing away from the others. Presence is coalesced by the room's
 * relay, which runs before anything reaches the room (SYN-035).
 *
 * Stage 1 keeps the counters in process memory; stage 2 moves them to Redis or Valkey (BE-063)
 * behind the same `RateLimits` interface. The figures are ADR 0053's; the spec names none.
 */
/*
 * The settings shapes mirror `BucketSettings` and `RateSettings` in `../seams.ts`. They are
 * declared here, not imported, because `seams.ts` imports `RateLimits` from this file and a
 * type-only import in each direction is still a cycle for the dependency checker.
 */
export interface BucketSettings {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface RateSettings {
  readonly addressConnections: BucketSettings;
  readonly addressFrames: BucketSettings;
  readonly connection: BucketSettings;
  readonly user: BucketSettings;
  readonly tenant: BucketSettings;
  readonly closeAfterRefusals: number;
}

/** A token bucket: `capacity` tokens, refilled continuously at `refillPerSecond`. */
export class TokenBucket {
  readonly #capacity: number;
  readonly #rate: number;
  #tokens: number;
  #at: number;

  constructor(s: BucketSettings, now: number) {
    this.#capacity = Math.max(1, s.capacity);
    this.#rate = Math.max(0, s.refillPerSecond);
    this.#tokens = this.#capacity;
    this.#at = now;
  }

  #refill(now: number): void {
    if (now > this.#at) {
      this.#tokens = Math.min(
        this.#capacity,
        this.#tokens + ((now - this.#at) / 1000) * this.#rate,
      );
      this.#at = now;
    }
  }

  /** Takes `n` tokens: 0 when they were there, otherwise the milliseconds until they would be. */
  take(now: number, n = 1): number {
    this.#refill(now);
    if (this.#tokens >= n) {
      this.#tokens -= n;
      return 0;
    }
    if (this.#rate === 0) return Number.MAX_SAFE_INTEGER;
    return Math.ceil(((n - this.#tokens) / this.#rate) * 1000);
  }

  /** Whether the bucket is full, so that it can be forgotten. */
  full(now: number): boolean {
    this.#refill(now);
    return this.#tokens >= this.#capacity;
  }
}

/** Buckets keyed by address, user or tenant; full buckets are forgotten now and then. */
class BucketMap {
  readonly #settings: BucketSettings;
  readonly #map = new Map<string, TokenBucket>();
  #swept = 0;

  constructor(s: BucketSettings) {
    this.#settings = s;
  }

  take(key: string, now: number, n = 1): number {
    let b = this.#map.get(key);
    if (!b) {
      b = new TokenBucket(this.#settings, now);
      this.#map.set(key, b);
    }
    const wait = b.take(now, n);
    if (now - this.#swept > 60_000) {
      this.#swept = now;
      for (const [k, v] of this.#map) if (v.full(now)) this.#map.delete(k);
    }
    return wait;
  }

  get size(): number {
    return this.#map.size;
  }
}

export type RateScope = 'address' | 'connection' | 'user' | 'tenant';

/** A wait in milliseconds as a `Retry-After` value in whole seconds, rounded up and at least 1. */
export function retryAfterSeconds(waitMs: number): number {
  return Math.max(1, Math.ceil(waitMs / 1000));
}

/** The node's shared rate limits (the connection's own bucket lives in its session). */
export class RateLimits {
  readonly settings: RateSettings;
  readonly #connections: BucketMap;
  readonly #frames: BucketMap;
  readonly #users: BucketMap;
  readonly #tenants: BucketMap;

  constructor(s: RateSettings) {
    this.settings = s;
    this.#connections = new BucketMap(s.addressConnections);
    this.#frames = new BucketMap(s.addressFrames);
    this.#users = new BucketMap(s.user);
    this.#tenants = new BucketMap(s.tenant);
  }

  /** A WebSocket upgrade from `address`: 0, or how long the address must wait. */
  connection(address: string, now: number): number {
    return this.#connections.take(address, now);
  }

  /** A frame from `address` before its session is open. */
  frame(address: string, now: number): number {
    return this.#frames.take(address, now);
  }

  /**
   * A message of an open session: the longest wait any of the user's and the tenant's buckets
   * asks for, with the scope that asked, or null when it may pass.
   */
  message(tenant: string, user: string, now: number): { scope: RateScope; waitMs: number } | null {
    const t = this.#tenants.take(tenant, now);
    if (t > 0) return { scope: 'tenant', waitMs: t };
    const u = this.#users.take(`${tenant}\u0000${user}`, now);
    if (u > 0) return { scope: 'user', waitMs: u };
    return null;
  }

  /**
   * A REST request by an authenticated user (BE-030 criterion 2, REST half). It takes from the
   * same tenant and user buckets as the socket messages, so a user who is over the limit on one
   * surface is over it on the other. Null when the request may pass; otherwise the scope that
   * asked and the seconds for a `Retry-After` header (RFC 9110 delta-seconds, at least 1).
   * The control plane's route pipeline calls this and answers 429 with `rate_limited`.
   */
  rest(
    tenant: string,
    user: string,
    now: number,
  ): { scope: RateScope; waitMs: number; retryAfterSeconds: number } | null {
    const hit = this.message(tenant, user, now);
    if (hit === null) return null;
    return { ...hit, retryAfterSeconds: retryAfterSeconds(hit.waitMs) };
  }

  /** A connection's own bucket. */
  connectionBucket(now: number): TokenBucket {
    return new TokenBucket(this.settings.connection, now);
  }
}
