// UX-076 criterion 4 in the composed service (lane V-UX-076-090, round 6): every administration
// operation the running service offers is called (a) with no credential, (b) with a user token,
// which the administration API never accepts, and (c) with the API key of a second tenant, which
// must see and change none of the first tenant's settings. Runs in memory and on PostgreSQL (a
// database of its own, dropped afterwards). Test values only. Criteria 1 to 3, 5 and 6 of UX-076
// are not claimed here.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

const ADMIN_READS = [
  '/v1/quotas',
  '/v1/retention',
  '/v1/origins',
  '/v1/keys',
  '/v1/audit',
  '/v1/holds',
  '/v1/webhooks',
];

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`administration operations in the composed service (${storage}; UX-076 criterion 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    let otherCredential = '';
    const other = randomUUID();

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage);
      await h.parts.registry.putTenant(other, 'V-UX-076-090 other tenant');
      const key = newApiKey(other);
      await h.parts.registry.addApiKey(other, { id: key.id, secretHash: hashSecret(key.secret) });
      otherCredential = key.credential;
      // The first tenant has settings the other tenant must not see or change.
      const q = await h.call('GET', '/v1/quotas', { token: h.apiKey });
      const put = await h.call('PUT', '/v1/quotas', {
        token: h.apiKey,
        body: { connections: 7 },
        headers: { 'If-Match': q.headers.get('etag')! },
      });
      expect(put.status, put.text).toBe(200);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('refuses every administration read with no credential', async () => {
      for (const path of ADMIN_READS) {
        const r = await h.call('GET', path);
        expect([401, 403], path).toContain(r.status);
      }
    });

    it.skipIf(skip)('refuses every administration read with a user token', async () => {
      for (const path of ADMIN_READS) {
        const r = await h.call('GET', path, { token: h.userToken({}) });
        expect([401, 403], path).toContain(r.status);
      }
    });

    it.skipIf(skip)(
      'refuses the quota write with no credential and with a user token',
      async () => {
        const q = await h.call('GET', '/v1/quotas', { token: h.apiKey });
        const etag = q.headers.get('etag')!;
        const none = await h.call('PUT', '/v1/quotas', {
          body: { storage: 1 },
          headers: { 'If-Match': etag },
        });
        expect([401, 403]).toContain(none.status);
        const user = await h.call('PUT', '/v1/quotas', {
          token: h.userToken({}),
          body: { storage: 1 },
          headers: { 'If-Match': etag },
        });
        expect([401, 403]).toContain(user.status);
        const after = await h.call('GET', '/v1/quotas', { token: h.apiKey });
        expect(after.json.storage).toBeNull();
        expect(after.headers.get('etag')).toBe(etag);
      },
    );

    it.skipIf(skip)(
      'refuses the retention write with no credential and with a user token',
      async () => {
        const r = await h.call('GET', '/v1/retention', { token: h.apiKey });
        const etag = r.headers.get('etag');
        const body = { mode: 'keep_all' };
        const none = await h.call('PUT', '/v1/retention', {
          body,
          headers: etag ? { 'If-Match': etag } : {},
        });
        expect([401, 403, 428]).toContain(none.status);
        const user = await h.call('PUT', '/v1/retention', {
          token: h.userToken({}),
          body,
          headers: etag ? { 'If-Match': etag } : {},
        });
        expect([401, 403]).toContain(user.status);
      },
    );

    it.skipIf(skip)(
      "another tenant's key sees none of the first tenant's quota or origin",
      async () => {
        const q = await h.call('GET', '/v1/quotas', { token: otherCredential });
        expect(q.status, q.text).toBe(200);
        expect(q.json.connections).toBeNull();
        const o = await h.call('GET', '/v1/origins', { token: otherCredential });
        expect(o.status, o.text).toBe(200);
        expect(o.text).not.toContain('app.example.test');
        const k = await h.call('GET', '/v1/keys', { token: otherCredential });
        expect(k.status, k.text).toBe(200);
        expect(k.text).not.toContain(h.host.kid);
        expect(k.text).not.toContain(h.serviceKey.kid);
      },
    );

    it.skipIf(skip)("another tenant's key cannot change the first tenant's quotas", async () => {
      const before = await h.call('GET', '/v1/quotas', { token: h.apiKey });
      const their = await h.call('GET', '/v1/quotas', { token: otherCredential });
      const put = await h.call('PUT', '/v1/quotas', {
        token: otherCredential,
        body: { connections: 99 },
        headers: { 'If-Match': their.headers.get('etag')! },
      });
      expect(put.status, put.text).toBe(200);
      const after = await h.call('GET', '/v1/quotas', { token: h.apiKey });
      expect(after.json.connections).toBe(7);
      expect(after.headers.get('etag')).toBe(before.headers.get('etag'));
    });
  });
}
