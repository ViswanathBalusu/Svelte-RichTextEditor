/**
 * Unit tests of the gateway's token buckets and their keys (BE-030). Time is passed in, so every
 * case is deterministic: no timers, no sockets.
 */
import { describe, expect, it } from 'vitest';
import type { RateSettings } from '../seams.ts';
import { RateLimits, TokenBucket, retryAfterSeconds } from './limits.ts';

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
  it('limits an address on its upgrades and leaves another address alone', () => {
    const r = new RateLimits(
      rates({ addressConnections: { capacity: 1, refillPerSecond: 0.001 } }),
    );
    expect(r.connection('10.0.0.1', 0)).toBe(0);
    expect(r.connection('10.0.0.1', 0)).toBeGreaterThan(0);
    expect(r.connection('10.0.0.2', 0)).toBe(0);
  });

  it('counts frames before hello on their own bucket, separate from upgrades', () => {
    const r = new RateLimits(rates({ addressFrames: { capacity: 1, refillPerSecond: 0.001 } }));
    expect(r.frame('10.0.0.1', 0)).toBe(0);
    expect(r.frame('10.0.0.1', 0)).toBeGreaterThan(0);
    expect(r.connection('10.0.0.1', 0)).toBe(0);
  });

  it('holds one tenant at its limit without refusing another tenant', () => {
    const r = new RateLimits(rates({ tenant: { capacity: 2, refillPerSecond: 0.001 } }));
    expect(r.message('t1', 'alice', 0)).toBeNull();
    expect(r.message('t1', 'alice', 0)).toBeNull();
    expect(r.message('t1', 'alice', 0)).toEqual({ scope: 'tenant', waitMs: expect.any(Number) });
    expect(r.message('t2', 'carol', 0)).toBeNull();
  });

  it('keys a user by tenant as well as identifier, so the same identifier is not shared across tenants', () => {
    const r = new RateLimits(rates({ user: { capacity: 1, refillPerSecond: 0.001 } }));
    expect(r.message('t1', 'alice', 0)).toBeNull();
    expect(r.message('t1', 'alice', 0)).toEqual({ scope: 'user', waitMs: expect.any(Number) });
    expect(r.message('t2', 'alice', 0)).toBeNull();
  });

  it('gives each connection its own bucket from the connection settings', () => {
    const r = new RateLimits(rates({ connection: { capacity: 2, refillPerSecond: 1 } }));
    const a = r.connectionBucket(0);
    const b = r.connectionBucket(0);
    expect([a.take(0), a.take(0), a.take(0) > 0]).toEqual([0, 0, true]);
    expect(b.take(0)).toBe(0);
  });
});

describe('REST limits (BE-030 criterion 2, REST half)', () => {
  it('rounds the wait up to whole Retry-After seconds, at least one', () => {
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1000)).toBe(1);
    expect(retryAfterSeconds(1001)).toBe(2);
    expect(retryAfterSeconds(2500)).toBe(3);
  });

  it('answers a request over the tenant limit with the scope and a Retry-After in seconds', () => {
    const r = new RateLimits(rates({ tenant: { capacity: 1, refillPerSecond: 0.5 } }));
    expect(r.rest('t1', 'alice', 0)).toBeNull();
    // One token at half a token a second needs two seconds.
    expect(r.rest('t1', 'alice', 0)).toEqual({
      scope: 'tenant',
      waitMs: 2000,
      retryAfterSeconds: 2,
    });
    expect(r.rest('t1', 'alice', 2000)).toBeNull();
  });

  it('shares the user bucket with socket messages, so one user cannot spend it on both surfaces', () => {
    const r = new RateLimits(rates({ user: { capacity: 1, refillPerSecond: 1 } }));
    expect(r.message('t1', 'alice', 0)).toBeNull();
    expect(r.rest('t1', 'alice', 0)).toEqual({ scope: 'user', waitMs: 1000, retryAfterSeconds: 1 });
  });

  it('leaves another tenant unaffected while one tenant is over its REST limit', () => {
    const r = new RateLimits(rates({ tenant: { capacity: 1, refillPerSecond: 0.001 } }));
    expect(r.rest('t1', 'alice', 0)).toBeNull();
    expect(r.rest('t1', 'alice', 0)).not.toBeNull();
    expect(r.rest('t2', 'carol', 0)).toBeNull();
  });
});
