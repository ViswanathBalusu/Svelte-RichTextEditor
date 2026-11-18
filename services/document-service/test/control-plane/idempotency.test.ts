// Idempotency keys over real HTTP (05 §6.1; 10 §3.2; PRO-043, BE-034; D140), in memory and with
// PostgreSQL: a retried creating request returns the first response and creates nothing, a key is
// scoped to the tenant, the caller, the route and the body, two requests at once create one thing,
// the key ends after its retention time, and the scheduler deletes expired keys (BE-052).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const RETENTION_MS = 60_000;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`idempotency keys (${storage})`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    beforeAll(async () => {
      if (!skip)
        h = await startHarness(storage, {
          config: { idempotencyTtlMs: RETENTION_MS, idempotencyWaitMs: 5_000 },
        });
    });
    afterAll(async () => {
      await h?.close();
    });

    const create = (key: string, body: unknown, token = h.apiKey) =>
      h.call('POST', '/v1/documents', { token, body, headers: { 'Idempotency-Key': key } });

    it.skipIf(skip)(
      'returns the first response to a retry with the same key and body, and creates nothing (PRO-043 criterion 1; BE-034 criterion 1)',
      async () => {
        const key = `k-${randomUUID()}`;
        const body = { title: 'once', externalId: `x-${randomUUID()}` };
        const first = await create(key, body);
        expect(first.status).toBe(201);
        const second = await create(key, body);
        expect(second.status).toBe(201);
        expect(second.json).toEqual(first.json);
        expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
        expect(second.headers.get('location')).toBe(first.headers.get('location'));
        expect(second.headers.get('dep-idempotent-replayed')).toBe('true');
        expect(first.headers.get('dep-idempotent-replayed')).toBeNull();
        const listed = await h.call(
          'GET',
          `/v1/documents?externalId=${encodeURIComponent(body.externalId)}`,
          { token: h.apiKey },
        );
        expect(listed.json.items).toHaveLength(1);
      },
    );

    it.skipIf(skip)(
      'answers idempotency_mismatch for the same key with another body (PRO-043 criterion 3; BE-034 criterion 2)',
      async () => {
        const key = `k-${randomUUID()}`;
        expect((await create(key, { title: 'a' })).status).toBe(201);
        const other = await create(key, { title: 'b' });
        expect(other.status).toBe(422);
        expect(other.json.code).toBe('idempotency_mismatch');
        // A malformed key is refused before anything runs.
        const bad = await create('has space', { title: 'c' });
        expect(bad.status).toBe(400);
        expect(bad.json.violations[0].path).toBe('Idempotency-Key');
      },
    );

    it.skipIf(skip)(
      'scopes a key to the tenant, the caller and the route: others are independent (PRO-043 criteria 2, 6; BE-034 criterion 3)',
      async () => {
        const key = `k-${randomUUID()}`;
        const first = await create(key, { title: 'tenant A' });
        // Another tenant, same key and body: its own document.
        const tenant = randomUUID();
        await h.parts.registry.putTenant(tenant, 'second');
        const k2 = newApiKey(tenant);
        await h.parts.registry.addApiKey(tenant, { id: k2.id, secretHash: hashSecret(k2.secret) });
        const elsewhere = await create(key, { title: 'tenant A' }, k2.credential);
        expect(elsewhere.status).toBe(201);
        expect(elsewhere.json.id).not.toBe(first.json.id);
        expect(elsewhere.headers.get('dep-idempotent-replayed')).toBeNull();
        // Two users of one tenant with one key on one export route: each gets their own job, and
        // neither can read the other's (10 §3.2: no taking over another caller's job).
        const doc = first.json.id as string;
        const ann = h.userToken({ [doc]: 'editor' }, { sub: 'ann' });
        const ben = h.userToken({ [doc]: 'editor' }, { sub: 'ben' });
        const exp = (token: string, body: unknown) =>
          h.call('POST', `/v1/documents/${doc}/exports`, {
            token,
            body,
            headers: { 'Idempotency-Key': key },
          });
        const a = await exp(ann, { target: 'pdf' });
        const b = await exp(ben, { target: 'pdf', options: { profile: 'final' } });
        expect(a.status).toBe(202);
        expect(b.status).toBe(202);
        expect(b.json.id).not.toBe(a.json.id);
        expect((await h.call('GET', `/v1/exports/${a.json.id}`, { token: ben })).status).toBe(404);
        const again = await exp(ann, { target: 'pdf' });
        expect(again.json.id).toBe(a.json.id);
        // The service used the key on POST /documents; on another route it is a new key.
        const svc = await exp(h.apiKey, { target: 'pdf', options: { profile: 'preview' } });
        expect(svc.status).toBe(202);
        expect(svc.headers.get('dep-idempotent-replayed')).toBeNull();
      },
    );

    it.skipIf(skip)(
      'creates one document when two identical requests arrive at once (PRO-043 criterion 5; BE-034 criterion 4)',
      async () => {
        const key = `k-${randomUUID()}`;
        const externalId = `race-${randomUUID()}`;
        const body = { content: documentWithRegions(), externalId };
        const results = await Promise.all([
          create(key, body),
          create(key, body),
          create(key, body),
        ]);
        for (const r of results) expect(r.status).toBe(201);
        expect(new Set(results.map((r) => r.json.id)).size).toBe(1);
        const listed = await h.call(
          'GET',
          `/v1/documents?externalId=${encodeURIComponent(externalId)}`,
          { token: h.apiKey },
        );
        expect(listed.json.items).toHaveLength(1);
      },
    );

    it.skipIf(skip)(
      'treats a key as new after the retention time, and the scheduler deletes expired keys (PRO-043 criterion 4; BE-034 criterion 5)',
      async () => {
        const key = `k-${randomUUID()}`;
        const first = await create(key, { title: 'old' });
        h.advance(RETENTION_MS + 1);
        const later = await create(key, { title: 'old' });
        expect(later.status).toBe(201);
        expect(later.json.id).not.toBe(first.json.id);
        expect(later.headers.get('dep-idempotent-replayed')).toBeNull();
        // A different body is new as well once the key expired.
        h.advance(RETENTION_MS + 1);
        expect((await create(key, { title: 'another' })).status).toBe(201);
        h.advance(RETENTION_MS + 1);
        const purged = await h.parts.idempotency.purge(h.tenant, h.now());
        expect(purged).toBeGreaterThan(0);
        expect(await h.parts.idempotency.purge(h.tenant, h.now())).toBe(0);
      },
    );

    it.skipIf(skip)('does not keep a failed request, so a retry runs again', async () => {
      const key = `k-${randomUUID()}`;
      const bad = await create(key, { content: { cdm: 1, requires: [], doc: { type: 'doc' } } });
      expect(bad.status).toBe(400);
      const fixed = await create(key, { content: { cdm: 1, requires: [], doc: { type: 'doc' } } });
      expect(fixed.status).toBe(400);
      expect(fixed.headers.get('dep-idempotent-replayed')).toBeNull();
    });
  });
}
