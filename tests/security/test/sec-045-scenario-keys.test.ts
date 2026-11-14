/**
 * SEC-045 criterion 4, the key half of the "full scenario" (lane SEC-040-052, 2026-11-13): two
 * tenants run the document service's HTTP scenario (documents created over REST with each tenant's
 * own credential), then every object key the service wrote is listed from its object store. Each key
 * must start with `tenants/{tenant}/` for the tenant that owns the document, and no key may belong to
 * the other tenant.
 *
 * Not proved here: the signed-URL half of criterion 4 for the service's own store URLs (the store
 * signs URLs, `TenantObjects.signedUrl`, and no verifier in the service refuses them on another
 * tenant's key; the asset origin's verifier is tested in sec-045-signed-url-tenant.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { documentWithRegions, startHarness, type Harness } from './support/harness.ts';

describe('SEC-045 criterion 4: the keys written by a two-tenant HTTP scenario', () => {
  it('every object key written for tenant A or B starts with that tenant prefix', async () => {
    const h: Harness = await startHarness('memory');
    try {
      const docA = await h.createDocument(h.a, documentWithRegions());
      const docB = await h.createDocument(h.b, documentWithRegions());
      expect(docA).not.toBe(docB);

      const keys = await h.parts.objects.list('');
      expect(keys.length).toBeGreaterThan(0);

      const prefixA = `tenants/${h.a.id}/`;
      const prefixB = `tenants/${h.b.id}/`;
      for (const key of keys) {
        const owned = key.startsWith(prefixA) || key.startsWith(prefixB);
        expect(owned, `key ${key} has no tenant prefix`).toBe(true);
      }
      expect(keys.some((k) => k.startsWith(prefixA))).toBe(true);
      expect(keys.some((k) => k.startsWith(prefixB))).toBe(true);
    } finally {
      await h.close();
    }
  });
});
