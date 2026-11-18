// BE-030 criterion 3: the message limits of a tenant are held in its registration (BE-012), in
// memory and in PostgreSQL, and the service applies them. The registry stores and returns them
// (checked), and a limit registered for the tenant refuses its REST requests with 429 while the
// defaults would have passed them. The socket side and the isolation between tenants are in
// test/data-plane/be-030-tenant-isolation.test.ts and src/data-plane/limits.test.ts.
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KeyRegistrationError } from '../../src/control-plane/tenants.ts';
import { type Harness, skipReason, startHarness, type Storage } from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`limits held per tenant in the registry (${storage}, BE-030 criterion 3)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('stores, returns and clears the limits of a tenant', async () => {
      const r = h.parts.registry;
      expect(await r.rateLimits(h.tenant)).toBeNull();
      await r.setRateLimits(h.tenant, {
        tenant: { capacity: 40, refillPerSecond: 20 },
        user: { capacity: 5, refillPerSecond: 0.5 },
      });
      expect(await r.rateLimits(h.tenant)).toEqual({
        tenant: { capacity: 40, refillPerSecond: 20 },
        user: { capacity: 5, refillPerSecond: 0.5 },
      });
      // A scope left out stays out, and another tenant is not touched.
      await r.setRateLimits(h.tenant, { user: { capacity: 3, refillPerSecond: 1 } });
      expect(await r.rateLimits(h.tenant)).toEqual({ user: { capacity: 3, refillPerSecond: 1 } });
      expect(await r.rateLimits(uuid7())).toBeNull();
      await r.setRateLimits(h.tenant, null);
      expect(await r.rateLimits(h.tenant)).toBeNull();
    });

    it.skipIf(skip)(
      'refuses limits that are not buckets, and a tenant that is not registered',
      async () => {
        const r = h.parts.registry;
        for (const bad of [
          { tenant: { capacity: 0, refillPerSecond: 1 } },
          { tenant: { capacity: 1, refillPerSecond: -1 } },
          { tenant: { capacity: Number.NaN, refillPerSecond: 1 } },
          { tenant: { capacity: 1 } },
          { everyone: { capacity: 1, refillPerSecond: 1 } },
          { user: { capacity: 1, refillPerSecond: 1, burst: 3 } },
        ])
          await expect(r.setRateLimits(h.tenant, bad as never)).rejects.toBeInstanceOf(
            KeyRegistrationError,
          );
        await expect(
          r.setRateLimits(crypto.randomUUID(), { user: { capacity: 1, refillPerSecond: 1 } }),
        ).rejects.toBeInstanceOf(KeyRegistrationError);
        expect(await r.rateLimits(h.tenant)).toBeNull();
      },
    );
  });
}

describe('the service applies the registered limits (memory, BE-030 criterion 3)', () => {
  it('answers 429 to a user over the user limit registered for the tenant, where the defaults pass', async () => {
    const h = await startHarness('memory');
    try {
      await h.parts.registry.setRateLimits(h.tenant, {
        user: { capacity: 2, refillPerSecond: 0.001 },
      });
      const doc = await h.createDocument({});
      const token = h.userToken({ [doc]: 'viewer' }, { sub: `alice-${uuid7()}` });
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++)
        statuses.push((await h.call('GET', `/v1/documents/${doc}`, { token })).status);
      expect(statuses).toEqual([200, 200, 429, 429]);
    } finally {
      await h.close();
    }
  });
});

describe.skipIf(process.env['DOCEDIT_VALKEY_URL'] === undefined)(
  'the service with DOCEDIT_VALKEY_URL (BE-030 criterion 5)',
  () => {
    it('keeps the user counter in Valkey and limits as it does in memory', async () => {
      const valkeyUrl = process.env['DOCEDIT_VALKEY_URL']!;
      const h = await startHarness('memory', { config: { valkeyUrl } });
      try {
        await h.parts.registry.setRateLimits(h.tenant, {
          user: { capacity: 2, refillPerSecond: 0.001 },
        });
        const doc = await h.createDocument({});
        const token = h.userToken({ [doc]: 'viewer' }, { sub: `alice-${uuid7()}` });
        const statuses: number[] = [];
        for (let i = 0; i < 4; i++)
          statuses.push((await h.call('GET', `/v1/documents/${doc}`, { token })).status);
        expect(statuses).toEqual([200, 200, 429, 429]);
      } finally {
        await h.close();
      }
    });
  },
);
