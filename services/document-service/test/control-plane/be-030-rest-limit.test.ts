// REST half of BE-030 criterion 2 (lane U-BE-029-042): a user over the shared user bucket gets
// 429 with `rate_limited` and `Retry-After` on REST, and another user of the same tenant is not
// affected. The bucket is the one the data plane's sockets use (`limits` in src/server.ts).
// Memory storage; the rule is the same in PostgreSQL, which holds no rate counters (stage 1).
import { describe, expect, it } from 'vitest';
import { RateLimits } from '../../src/data-plane/limits.ts';
import { DEFAULT_RATES } from '../../src/data-plane/settings.ts';
import { startHarness, type Harness } from './support.ts';
import { uuid7 } from '@docedit/model';

describe('REST rate limit by user (BE-030 criterion 2, REST half)', () => {
  it('answers rate_limited with Retry-After over the user bucket, and leaves other users alone', async () => {
    const rateLimits = new RateLimits({
      ...DEFAULT_RATES,
      user: { capacity: 2, refillPerSecond: 0.001 },
    });
    const h: Harness = await startHarness('memory', { rateLimits });
    try {
      const doc = await h.createDocument({});
      const alice = h.userToken({ [doc]: 'viewer' }, { sub: `alice-${uuid7()}` });
      const first = await h.call('GET', `/v1/documents/${doc}`, { token: alice });
      const second = await h.call('GET', `/v1/documents/${doc}`, { token: alice });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const third = await h.call('GET', `/v1/documents/${doc}`, { token: alice });
      expect(third.status).toBe(429);
      expect(third.json.code).toBe('rate_limited');
      const retryAfter = Number(third.headers.get('Retry-After'));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThanOrEqual(1);

      // Another user of the same tenant has her own bucket.
      const bob = h.userToken({ [doc]: 'viewer' }, { sub: `bob-${uuid7()}` });
      expect((await h.call('GET', `/v1/documents/${doc}`, { token: bob })).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it('passes every request when no REST limit is configured', async () => {
    const h: Harness = await startHarness('memory');
    try {
      const doc = await h.createDocument({});
      const token = h.userToken({ [doc]: 'viewer' });
      for (let i = 0; i < 5; i++)
        expect((await h.call('GET', `/v1/documents/${doc}`, { token })).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
