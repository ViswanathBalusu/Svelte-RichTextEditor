/**
 * Rate limits at the gateway (06 §1, §8; 10 §3.2; BE-030). Before authentication an address may
 * open so many connections and send so many frames, and nothing is verified for one over its
 * limit; after `hello`, messages are limited per connection, per user and per tenant, so one noisy
 * client or tenant cannot take editing away from the others. Presence is coalesced by the room's
 * relay, which runs before anything reaches the room (SYN-035).
 *
 * Stage 1 keeps the counters in process memory; stage 2 moves them to Redis or Valkey (BE-063)
 * behind the same `RateStore` interface. The figures are ADR 0053's; the spec names none.
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

/**
 * Where counters live (BE-030 criterion 5). A store takes `n` tokens from the bucket named `key`
 * with the given settings and answers 0, or the milliseconds until they would be there. Stage 1
 * keeps them in this process (`MemoryRateStore`); stage 2 keeps them in Redis or Valkey
 * (`ValkeyTokenBuckets`, BE-063). Both answer the same numbers for the same takes.
 */
export interface RateStore {
  take(key: string, s: BucketSettings, now: number, n?: number): number | Promise<number>;
}

interface Held {
  readonly settings: BucketSettings;
  readonly bucket: TokenBucket;
}

/** Stage 1: buckets in process memory. Full buckets are forgotten now and then. */
export class MemoryRateStore implements RateStore {
  readonly #map = new Map<string, Held>();
  #swept = 0;

  take(key: string, s: BucketSettings, now: number, n = 1): number {
    let h = this.#map.get(key);
    // A changed setting (a tenant's limits edited) starts the bucket again at its new capacity.
    if (
      !h ||
      h.settings.capacity !== s.capacity ||
      h.settings.refillPerSecond !== s.refillPerSecond
    ) {
      h = { settings: s, bucket: new TokenBucket(s, now) };
      this.#map.set(key, h);
    }
    const wait = h.bucket.take(now, n);
    if (now - this.#swept > 60_000) {
      this.#swept = now;
      for (const [k, v] of this.#map) if (v.bucket.full(now)) this.#map.delete(k);
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

/** The limits registered for one tenant (BE-030 criterion 3); a scope left out is the default. */
export interface TenantLimitOverride {
  readonly tenant?: BucketSettings;
  readonly user?: BucketSettings;
}

/** Reads a tenant's registered limits (the registry of BE-012); null for the node's defaults. */
export type TenantLimitsSource = (tenant: string) => Promise<TenantLimitOverride | null>;

/**
 * How long a tenant's registered limits are kept before the registry is read again. The spec
 * names no figure; this is a setting of this story (docs/adr/0380-w5-BE-030-tenant-limits-and-store.md, proposed).
 */
export const DEFAULT_TENANT_LIMITS_TTL_MS = 5_000;

export interface RateLimitOptions {
  /** Where the tenant and user counters live; absent, this process's memory (stage 1). */
  readonly store?: RateStore;
  /** The registry of tenants, read for each tenant's own limits. Absent, every tenant has the defaults. */
  readonly tenantLimits?: TenantLimitsSource;
  readonly tenantLimitsTtlMs?: number;
}

/**
 * The node's shared rate limits (the connection's own bucket lives in its session). Address
 * counters, which run before a token is verified, stay in this node's memory in both stages: they
 * protect the node that receives the traffic and cost no round trip. Tenant and user counters go
 * through the `RateStore`, so a client that reaches two nodes shares one limit in stage 2.
 */
export class RateLimits {
  readonly settings: RateSettings;
  /** Address buckets, before authentication: always this node's memory (see the file comment). */
  readonly #addresses = new MemoryRateStore();
  /** Tenant and user buckets: memory in stage 1, a shared store in stage 2. */
  readonly #store: RateStore;
  readonly #source: TenantLimitsSource | undefined;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, { at: number; value: Promise<TenantLimitOverride | null> }>();

  constructor(s: RateSettings, opts: RateLimitOptions = {}) {
    this.settings = s;
    this.#store = opts.store ?? new MemoryRateStore();
    this.#source = opts.tenantLimits;
    this.#ttlMs = opts.tenantLimitsTtlMs ?? DEFAULT_TENANT_LIMITS_TTL_MS;
  }

  /** A WebSocket upgrade from `address`: 0, or how long the address must wait. */
  connection(address: string, now: number): number {
    return this.#addresses.take(`c:${address}`, this.settings.addressConnections, now);
  }

  /** A frame from `address` before its session is open. */
  frame(address: string, now: number): number {
    return this.#addresses.take(`f:${address}`, this.settings.addressFrames, now);
  }

  /**
   * The limits registered for the tenant (BE-030 criterion 3), read from the registry at most once
   * in `tenantLimitsTtlMs`, so a change applies within that time without a restart. A registry
   * that fails leaves the last answer, or the node's defaults, in force: the limits never stop
   * the messages of a tenant whose registration cannot be read.
   */
  async #limitsOf(tenant: string, now: number): Promise<TenantLimitOverride | null> {
    if (!this.#source) return null;
    const held = this.#cache.get(tenant);
    if (held && now - held.at < this.#ttlMs) return held.value;
    const previous = held?.value;
    const value = this.#source(tenant).catch(async () => (previous ? await previous : null));
    this.#cache.set(tenant, { at: now, value });
    if (this.#cache.size > 10_000) {
      for (const [k, v] of this.#cache) if (now - v.at >= this.#ttlMs) this.#cache.delete(k);
    }
    return value;
  }

  /** Forgets what was read for `tenant`, so that its next message reads the registry again. */
  forget(tenant: string): void {
    this.#cache.delete(tenant);
  }

  /**
   * A message of an open session: the longest wait any of the user's and the tenant's buckets
   * asks for, with the scope that asked, or null when it may pass.
   */
  async message(
    tenant: string,
    user: string,
    now: number,
  ): Promise<{ scope: RateScope; waitMs: number } | null> {
    const own = await this.#limitsOf(tenant, now);
    const t = await this.#store.take(`t:${tenant}`, own?.tenant ?? this.settings.tenant, now);
    if (t > 0) return { scope: 'tenant', waitMs: t };
    const u = await this.#store.take(
      `u:${tenant}\u0000${user}`,
      own?.user ?? this.settings.user,
      now,
    );
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
  async rest(
    tenant: string,
    user: string,
    now: number,
  ): Promise<{ scope: RateScope; waitMs: number; retryAfterSeconds: number } | null> {
    const hit = await this.message(tenant, user, now);
    if (hit === null) return null;
    return { ...hit, retryAfterSeconds: retryAfterSeconds(hit.waitMs) };
  }

  /** A connection's own bucket. */
  connectionBucket(now: number): TokenBucket {
    return new TokenBucket(this.settings.connection, now);
  }
}
