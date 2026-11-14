// UX-080 criteria 1 and 4 in the composed service (lane U-UX-076-090, U4 group 1 round 3): the
// harness starts the service with the parts `pgParts` and `memoryParts` build, with no retention
// part of the test's own, so the routes run over the store, document store and audit trail the
// running service composes. On PostgreSQL that is `tenant_retention` (migration 0065) and
// `audit_events`; the test reads both tables directly as well as over HTTP. Each run has a database
// of its own (createTestDatabase), dropped afterwards. Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgParts } from '../../src/server.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`/retention in the composed service (${storage}; UX-080 criteria 1 and 4)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;

    beforeAll(async () => {
      if (!skip) h = await startHarness(storage);
    });
    afterAll(async () => {
      await h?.close();
    });

    it.skipIf(skip)('offers the routes: the parts compose a retention service', () => {
      expect(h.parts.retention).toBeDefined();
    });

    it.skipIf(skip)(
      'stores a tenant policy and a document policy, reads both back with the effective policy, and audits each change',
      async () => {
        const before = await h.call('GET', '/v1/retention', { token: h.apiKey });
        expect(before.status, before.text).toBe(200);
        expect(before.json).toEqual({ mode: 'keep_all' });
        expect(before.headers.get('etag')).toBe('"0"');

        const setTenant = await h.call('PUT', '/v1/retention', {
          token: h.apiKey,
          body: { mode: 'thin_payloads', afterDays: 30 },
          headers: { 'If-Match': '"0"' },
        });
        expect(setTenant.status, setTenant.text).toBe(200);
        expect(setTenant.headers.get('etag')).toBe('"1"');

        const doc = await h.createDocument();
        const inherited = await h.call('GET', `/v1/documents/${doc}/retention`, {
          token: h.apiKey,
        });
        expect(inherited.status, inherited.text).toBe(200);
        expect(inherited.json).toEqual({
          policy: null,
          effective: { mode: 'thin_payloads', afterDays: 30 },
          source: 'tenant',
        });

        const setDoc = await h.call('PUT', `/v1/documents/${doc}/retention`, {
          token: h.apiKey,
          body: { mode: 'keep_all' },
          headers: { 'If-Match': '"0"' },
        });
        expect(setDoc.status, setDoc.text).toBe(200);
        const own = await h.call('GET', `/v1/documents/${doc}/retention`, { token: h.apiKey });
        expect(own.json).toEqual({
          policy: { mode: 'keep_all' },
          effective: { mode: 'keep_all' },
          source: 'document',
        });
        expect(own.headers.get('etag')).toBe('"1"');

        // A document that does not exist, and an identifier that is not one, are not found.
        const missing = '0190c9d8-0000-7000-8000-000000000000';
        expect(
          (await h.call('GET', `/v1/documents/${missing}/retention`, { token: h.apiKey })).status,
        ).toBe(404);
        expect(
          (await h.call('GET', '/v1/documents/not-a-document/retention', { token: h.apiKey }))
            .status,
        ).toBe(404);

        // The audit trail the service composes holds both changes (criterion 4).
        const page = await h.call('GET', '/v1/audit?kind=retention.changed', { token: h.apiKey });
        expect(page.status, page.text).toBe(200);
        const items = page.json.items as Array<Record<string, unknown>>;
        expect(items).toHaveLength(2);
        const events = await h.parts.audit!.query(h.tenant, {
          kind: 'retention.changed',
          limit: 10,
        });
        expect(events).toHaveLength(2);
        const tenantEvent = events.find((e) => e.doc === null);
        const docEvent = events.find((e) => e.doc === doc);
        expect(tenantEvent?.data).toEqual({
          scope: 'tenant',
          previous: { mode: 'keep_all' },
          policy: { mode: 'thin_payloads', afterDays: 30 },
        });
        expect(docEvent?.data).toEqual({
          scope: 'document',
          previous: null,
          policy: { mode: 'keep_all' },
        });
        for (const e of events) expect(e.actor).toBe('system');

        if (!h.db) return;
        // PostgreSQL: the rows are in the migrated tables, under this test's tenant.
        const stored = await h.db.admin.query<{
          doc_id: string | null;
          mode: string;
          after_days: number | null;
          version: number;
        }>(
          `SELECT doc_id, mode, after_days, version FROM tenant_retention
            WHERE tenant_id = $1 ORDER BY doc_id NULLS FIRST`,
          [h.tenant],
        );
        expect(stored.rows).toEqual([
          { doc_id: null, mode: 'thin_payloads', after_days: 30, version: 1 },
          { doc_id: doc, mode: 'keep_all', after_days: null, version: 1 },
        ]);
        const audited = await h.db.admin.query<{ doc_id: string | null; data: unknown }>(
          `SELECT doc_id, data FROM audit_events
            WHERE tenant_id = $1 AND kind = 'retention.changed' ORDER BY at, id`,
          [h.tenant],
        );
        expect(audited.rows).toHaveLength(2);
        expect(audited.rows.map((r) => r.doc_id).sort()).toEqual([doc, null].sort());

        // A service started again over the same database reads the same policies (durable).
        const again = pgParts(h.db.service).retention!;
        expect(await again.tenant(h.tenant)).toEqual({
          policy: { mode: 'thin_payloads', afterDays: 30 },
          version: 1,
        });
        expect(await again.document(h.tenant, doc)).toMatchObject({
          policy: { mode: 'keep_all' },
          source: 'document',
          version: 1,
        });
      },
    );

    it.skipIf(skip)('refuses a stale change and audits nothing for it', async () => {
      const read = await h.call('GET', '/v1/retention', { token: h.apiKey });
      const stale = await h.call('PUT', '/v1/retention', {
        token: h.apiKey,
        body: { mode: 'keep_all' },
        headers: { 'If-Match': '"0"' },
      });
      expect(stale.status).toBe(412);
      const after = await h.call('GET', '/v1/retention', { token: h.apiKey });
      expect(after.headers.get('etag')).toBe(read.headers.get('etag'));
      const events = await h.parts.audit!.query(h.tenant, {
        kind: 'retention.changed',
        limit: 10,
      });
      expect(events).toHaveLength(2);
    });
  });
}
