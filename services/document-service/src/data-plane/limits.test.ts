/**
 * Unit tests of the gateway's token buckets and their keys (BE-030). Time is passed in, so every
 * case is deterministic: no timers, no sockets.
 */
import { describe, expect, it } from 'vitest';
import type { RateSettings } from '../seams.ts';
import {
  MemoryRateStore,
  RateLimits,
  TokenBucket,
  retryAfterSeconds,
  type RateStore,
  type TenantLimitOverride,
} from './limits.ts';

const rates = (over: Partial<RateSettings> = {}): RateSettings => ({
  addressConnections: { capacity: 2, refillPerSecond: 1 },
  addressFrames: { capacity: 2, refillPerSecond: 1 },
  connection: { capacity: 3, refillPerSecond: 1 },
  user: { capacity: 2, refillPerSecond: 1 },
  tenant: { capacity: 2, refillPerSecond: 1 },
  closeAfterRefusals: 5,
  ...over,
});

describe('TokenBucket (BE-030)', () => {
  it('admits its capacity at one instant, then answers the wait for the next token', () => {
    const b = new TokenBucket({ capacity: 3, refillPerSecond: 2 }, 0);
    expect([b.take(0), b.take(0), b.take(0)]).toEqual([0, 0, 0]);
    // Empty: one token needs 1 / 2 s at two tokens a second.
    expect(b.take(0)).toBe(500);
  });

  it('refills continuously and never above its capacity', () => {
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1 }, 0);
    expect(b.take(0, 2)).toBe(0);
    expect(b.take(0)).toBe(1000);
    expect(b.take(1000)).toBe(0);
    // Ten seconds idle still give only the capacity back.
    expect(b.take(11_000)).toBe(0);
    expect(b.take(11_000)).toBe(0);
    expect(b.take(11_000)).toBeGreaterThan(0);
  });

  it('never refills when the rate is zero', () => {
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 0 }, 0);
    expect(b.take(0)).toBe(0);
    expect(b.take(60_000)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('reports full only once the bucket has refilled', () => {
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1 }, 0);
    b.take(0, 2);
    expect(b.full(0)).toBe(false);
    expect(b.full(2000)).toBe(true);
  });
});

describe('RateLimits keys (BE-030)', () => {
  it('limits an address on its upgrades and leaves another address alone', async () => {
    const r = new RateLimits(
      rates({ addressConnections: { capacity: 1, refillPerSecond: 0.001 } }),
    );
    expect(r.connection('10.0.0.1', 0)).toBe(0);
    expect(r.connection('10.0.0.1', 0)).toBeGreaterThan(0);
    expect(r.connection('10.0.0.2', 0)).toBe(0);
  });

  it('counts frames before hello on their own bucket, separate from upgrades', async () => {
    const r = new RateLimits(rates({ addressFrames: { capacity: 1, refillPerSecond: 0.001 } }));
    expect(r.frame('10.0.0.1', 0)).toBe(0);
    expect(r.frame('10.0.0.1', 0)).toBeGreaterThan(0);
    expect(r.connection('10.0.0.1', 0)).toBe(0);
  });

  it('holds one tenant at its limit without refusing another tenant', async () => {
    const r = new RateLimits(rates({ tenant: { capacity: 2, refillPerSecond: 0.001 } }));
    expect(await r.message('t1', 'alice', 0)).toBeNull();
    expect(await r.message('t1', 'alice', 0)).toBeNull();
    expect(await r.message('t1', 'alice', 0)).toEqual({
      scope: 'tenant',
      waitMs: expect.any(Number),
    });
    expect(await r.message('t2', 'carol', 0)).toBeNull();
  });

  it('keys a user by tenant as well as identifier, so the same identifier is not shared across tenants', async () => {
    const r = new RateLimits(rates({ user: { capacity: 1, refillPerSecond: 0.001 } }));
    expect(await r.message('t1', 'alice', 0)).toBeNull();
    expect(await r.message('t1', 'alice', 0)).toEqual({
      scope: 'user',
      waitMs: expect.any(Number),
    });
    expect(await r.message('t2', 'alice', 0)).toBeNull();
  });

  it('gives each connection its own bucket from the connection settings', async () => {
    const r = new RateLimits(rates({ connection: { capacity: 2, refillPerSecond: 1 } }));
    const a = r.connectionBucket(0);
    const b = r.connectionBucket(0);
    expect([a.take(0), a.take(0), a.take(0) > 0]).toEqual([0, 0, true]);
    expect(b.take(0)).toBe(0);
  });
});

describe('REST limits (BE-030 criterion 2, REST half)', () => {
  it('rounds the wait up to whole Retry-After seconds, at least one', async () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1000)).toBe(1);
    expect(retryAfterSeconds(1001)).toBe(2);
    expect(retryAfterSeconds(2500)).toBe(3);
  });

  it('answers a request over the tenant limit with the scope and a Retry-After in seconds', async () => {
    const r = new RateLimits(rates({ tenant: { capacity: 1, refillPerSecond: 0.5 } }));
    expect(await r.rest('t1', 'alice', 0)).toBeNull();
    // One token at half a token a second needs two seconds.
    expect(await r.rest('t1', 'alice', 0)).toEqual({
      scope: 'tenant',
      waitMs: 2000,
      retryAfterSeconds: 2,
    });
    expect(await r.rest('t1', 'alice', 2000)).toBeNull();
  });

  it('shares the user bucket with socket messages, so one user cannot spend it on both surfaces', async () => {
    const r = new RateLimits(rates({ user: { capacity: 1, refillPerSecond: 1 } }));
    expect(await r.message('t1', 'alice', 0)).toBeNull();
    expect(await r.rest('t1', 'alice', 0)).toEqual({
      scope: 'user',
      waitMs: 1000,
      retryAfterSeconds: 1,
    });
  });

  it('leaves another tenant unaffected while one tenant is over its REST limit', async () => {
    const r = new RateLimits(rates({ tenant: { capacity: 1, refillPerSecond: 0.001 } }));
    expect(await r.rest('t1', 'alice', 0)).toBeNull();
    expect(await r.rest('t1', 'alice', 0)).not.toBeNull();
    expect(await r.rest('t2', 'carol', 0)).toBeNull();
  });
});

describe('limits held per tenant (BE-030 criterion 3)', () => {
  const tight = { capacity: 1, refillPerSecond: 0.001 };

  it('applies the registered limits of one tenant and leaves another tenant on the defaults', async () => {
    const registered = new Map<string, TenantLimitOverride>([['t1', { tenant: tight }]]);
    const r = new RateLimits(
      rates({
        tenant: { capacity: 50, refillPerSecond: 50 },
        user: { capacity: 50, refillPerSecond: 50 },
      }),
      {
        tenantLimits: async (t) => registered.get(t) ?? null,
      },
    );
    expect(await r.message('t1', 'alice', 0)).toBeNull();
    expect(await r.message('t1', 'alice', 0)).toEqual({
      scope: 'tenant',
      waitMs: expect.any(Number),
    });
    // The other tenant has its own bucket at the default size and is never refused here.
    for (let i = 0; i < 20; i++) expect(await r.message('t2', 'carol', 0)).toBeNull();
  });

  it('keeps a scope that the registration leaves out at the default', async () => {
    const r = new RateLimits(rates({ user: { capacity: 1, refillPerSecond: 0.001 } }), {
      tenantLimits: async () => ({ tenant: { capacity: 100, refillPerSecond: 100 } }),
    });
    expect(await r.message('t1', 'alice', 0)).toBeNull();
    expect(await r.message('t1', 'alice', 0)).toEqual({
      scope: 'user',
      waitMs: expect.any(Number),
    });
  });

  it('reads the registry again after the time to live, so a change applies without a restart', async () => {
    let reads = 0;
    let current: TenantLimitOverride | null = { tenant: tight };
    const r = new RateLimits(rates({ tenant: { capacity: 50, refillPerSecond: 50 } }), {
      tenantLimits: async () => {
        reads++;
        return current;
      },
      tenantLimitsTtlMs: 1000,
    });
    expect(await r.message('t1', 'a', 0)).toBeNull();
    expect(await r.message('t1', 'a', 10)).not.toBeNull();
    expect(reads).toBe(1);
    current = null;
    expect(await r.message('t1', 'a', 500)).not.toBeNull();
    expect(reads).toBe(1);
    // After the time to live the registration is read again; the default bucket is bigger.
    expect(await r.message('t1', 'a', 1500)).toBeNull();
    expect(reads).toBe(2);
    // `forget` makes the next message read at once.
    current = { tenant: tight };
    r.forget('t1');
    expect(await r.message('t1', 'a', 1600)).toBeNull();
    expect(reads).toBe(3);
    expect(await r.message('t1', 'a', 1600)).not.toBeNull();
  });

  it('keeps limiting with the defaults when the registry cannot be read', async () => {
    const r = new RateLimits(rates({ tenant: { capacity: 1, refillPerSecond: 0.001 } }), {
      tenantLimits: async () => {
        throw new Error('registry down');
      },
    });
    expect(await r.message('t1', 'a', 0)).toBeNull();
    expect(await r.message('t1', 'a', 0)).toEqual({ scope: 'tenant', waitMs: expect.any(Number) });
  });
});

describe('counters behind a store (BE-030 criterion 5)', () => {
  /** A store that answers asynchronously, as a store over the network does, and records its keys. */
  class AsyncStore implements RateStore {
    readonly inner = new MemoryRateStore();
    readonly keys = new Set<string>();
    async take(key: string, s: { capacity: number; refillPerSecond: number }, now: number, n = 1) {
      await Promise.resolve();
      this.keys.add(key);
      return this.inner.take(key, s, now, n);
    }
  }

  it('answers the same as process memory for the same messages, and puts only tenant and user counters in the store', async () => {
    const settings = rates({
      tenant: { capacity: 3, refillPerSecond: 2 },
      user: { capacity: 2, refillPerSecond: 1 },
    });
    const memory = new RateLimits(settings);
    const store = new AsyncStore();
    const stored = new RateLimits(settings, { store });
    const script: Array<[string, string, number]> = [
      ['t1', 'a', 0],
      ['t1', 'a', 0],
      ['t1', 'a', 0],
      ['t1', 'b', 0],
      ['t1', 'b', 400],
      ['t2', 'a', 400],
      ['t1', 'a', 1000],
      ['t1', 'b', 2000],
      ['t1', 'b', 2000],
      ['t1', 'a', 9000],
    ];
    for (const [t, u, at] of script)
      expect(await stored.message(t, u, at)).toEqual(await memory.message(t, u, at));
    expect([...store.keys].every((k) => k.startsWith('t:') || k.startsWith('u:'))).toBe(true);
    // Address counters stay in this node's memory, before any token is verified.
    expect(stored.connection('10.0.0.1', 0)).toBe(0);
    expect(store.keys.has('c:10.0.0.1')).toBe(false);
  });
});
