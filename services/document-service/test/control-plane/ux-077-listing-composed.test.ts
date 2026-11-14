// UX-077 criterion 4 in the composed service (lane V-UX-076-090, round 5): `GET /v1/origins` and
// `GET /v1/keys` answer the caller's own tenant only. The harness registers one tenant with its
// keys and origin (support.ts); a second tenant is registered beside it through the parts' registry,
// and must not appear in either listing. Runs in memory and on PostgreSQL (a database of its own,
// dropped afterwards), where the registry is the row-level-secured tables of migration 0004.
// Criteria 1 to 3 and 5 of UX-077 are not claimed here: the key and origin writes have no route yet.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostKey, skipReason, startHarness, type Harness, type Storage } from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`/origins and /keys in the composed service (${storage}; UX-077 criterion 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const other = randomUUID();
    const otherKey = hostKey('EdDSA', `v-ux-076-090-other-${randomUUID()}`);

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      await h.parts.registry.putTenant(other, 'V-UX-076-090 other tenant');
      await h.parts.registry.addOrigin(other, 'https://other.v-ux-076-090.example.test');
      await h.parts.registry.addKey(other, {
        kid: otherKey.kid,
        use: 'user',
        alg: otherKey.alg,
        jwk: otherKey.jwk,
      });
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)("lists the origin the tenant registered, and no other tenant's", async () => {
      const r = await h.call('GET', '/v1/origins', { token: h.apiKey });
      expect(r.status, r.text).toBe(200);
      expect(r.json.origins).toEqual(['https://app.example.test']);
      expect(r.text).not.toContain('v-ux-076-090');
    });

    it.skipIf(skip)(
      "lists the public keys of the tenant, user keys then service keys, and no other tenant's",
      async () => {
        const r = await h.call('GET', '/v1/keys', { token: h.apiKey });
        expect(r.status, r.text).toBe(200);
        const keys = r.json.keys as Array<{
          kid: string;
          use: string;
          jwk: Record<string, unknown>;
        }>;
        expect(keys.map((k) => [k.kid, k.use])).toEqual([
          [h.host.kid, 'user'],
          [h.serviceKey.kid, 'service'],
        ]);
        // Public parts only: a private member of the key never appears in a listing.
        for (const k of keys) expect(k.jwk).not.toHaveProperty('d');
        expect(r.text).not.toContain(otherKey.kid);
      },
    );

    it.skipIf(skip)('refuses a user token with forbidden on both listings', async () => {
      const user = h.userToken({});
      expect((await h.call('GET', '/v1/origins', { token: user })).status).toBe(403);
      expect((await h.call('GET', '/v1/keys', { token: user })).status).toBe(403);
    });
  });
}
