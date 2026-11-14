/**
 * SEC-045 — one tenant can never reach another's data (10 §3.7, §1; 06 §4.1, §12). The adversarial
 * client calls every REST route and the WebSocket with tenant A's credentials and tenant B's
 * identifiers, and the catalogue is checked so a table without tenant isolation fails the build.
 *
 * Phase-1a scope: documents, content, regions, grants, exports and the data plane exist, so the
 * suite attacks those. Caches, per-tenant encryption keys and tenant fonts (SEC-045 criteria 5–7)
 * arrive with later features and are noted in the story.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { objectKeys } from '@docedit/document-service';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null; // probed at collection so skipIf-style skips apply (SEC harness)
  describe(`SEC-045 one tenant cannot reach another's data (${storage})`, () => {
    let h: Harness;
    let docB: string; // a document owned by tenant B
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        docB = await h.createDocument(h.b, documentWithRegions());
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    t()(
      "tenant A's service credential cannot read, change or reach tenant B's document on any route",
      async () => {
        // Every route with a resource identifier, called as tenant A against tenant B's document.
        const asA = (method: string, path: string, body?: unknown) =>
          h.call(method, path, { token: h.a.apiKey, ...(body !== undefined ? { body } : {}) });
        const cases: Array<{ method: string; path: string; body?: unknown }> = [
          { method: 'GET', path: `/v1/documents/${docB}` },
          { method: 'PATCH', path: `/v1/documents/${docB}`, body: { state: 'locked' } },
          { method: 'DELETE', path: `/v1/documents/${docB}` },
          { method: 'GET', path: `/v1/documents/${docB}/content` },
          { method: 'GET', path: `/v1/documents/${docB}/commits?after=0` },
          { method: 'GET', path: `/v1/documents/${docB}/regions` },
          { method: 'GET', path: `/v1/documents/${docB}/grants` },
        ];
        for (const { method, path, body } of cases) {
          const r = await asA(method, path, body);
          // B's document is invisible to tenant A (row-level security): nothing is returned.
          expect([403, 404], `${method} ${path}`).toContain(r.status);
          expect(JSON.stringify(r.json ?? {}), `${method} ${path}`).not.toContain('Liability');
        }
      },
    );

    t()(
      "a user token minted by tenant A, even naming tenant B's document, cannot open or read it",
      async () => {
        // Tenant A can only mint tokens for tenant A; naming B's document id changes nothing.
        const token = h.userToken(h.a, 'ann', { [docB]: 'owner' });
        const rest = await h.call('GET', `/v1/documents/${docB}`, { token });
        expect(rest.status).toBe(404);

        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          expect((await c.hello(token)).t).toBe('welcome');
          const opened = await c.open(1, docB);
          expect(opened.t).toBe('ch.rejected');
          // Under tenant A the document does not exist.
          expect(opened.d?.['code']).toBe('not_found');
        } finally {
          c.terminate();
        }
      },
    );

    t()(
      'object keys are namespaced by tenant and the two tenants never share a prefix',
      async () => {
        expect(objectKeys.prefix(h.a.id)).toBe(`tenants/${h.a.id}/`);
        expect(objectKeys.prefix(h.b.id)).toBe(`tenants/${h.b.id}/`);
        expect(objectKeys.checkpoint(h.b.id, docB, 0).startsWith(`tenants/${h.b.id}/`)).toBe(true);
        expect(objectKeys.prefix(h.a.id)).not.toBe(objectKeys.prefix(h.b.id));
      },
    );

    // The catalogue check needs the database; it is PostgreSQL-only.
    (storage === 'postgres' ? it : it.skip)(
      'every table carrying a tenant_id has row-level security enabled, forced and a policy',
      async () => {
        if (skip) return;
        const admin = h.db!.admin;
        const withTenant = await admin.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.columns
            WHERE table_schema = 'public' AND column_name = 'tenant_id'`,
        );
        expect(withTenant.rows.length).toBeGreaterThan(0);
        for (const { table_name } of withTenant.rows) {
          const cls = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
            `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
              WHERE oid = ('public.' || $1)::regclass`,
            [table_name],
          );
          expect(cls.rows[0]?.relrowsecurity, `${table_name} RLS enabled`).toBe(true);
          expect(cls.rows[0]?.relforcerowsecurity, `${table_name} RLS forced`).toBe(true);
          const pol = await admin.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = $1`,
            [table_name],
          );
          expect(Number(pol.rows[0]?.n ?? 0), `${table_name} has a policy`).toBeGreaterThan(0);
        }
        // The core tables all carry a tenant_id.
        const names = new Set(withTenant.rows.map((r) => r.table_name));
        for (const core of [
          'documents',
          'doc_heads',
          'doc_commits',
          'grant_revisions',
          'region_grants',
        ])
          expect(names, `${core} is tenant-scoped`).toContain(core);
      },
    );
  });
}
