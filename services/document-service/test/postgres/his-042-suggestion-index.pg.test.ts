// HIS-042 criterion 4 (lane V-HIS-033-046): the suggestion index is kept in PostgreSQL, answers by
// the suggestion's identifier from the primary key, keeps the lowest seq a suggestion was given, and
// is tenant-scoped under row-level security. Runs against PostgreSQL in Podman (infra/test-env.ps1
// up); skips when it is not up. The database is made for this file and dropped afterwards.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgTenantRegistry } from '../../src/control-plane/tenants.ts';
import { inTenant } from '../../src/storage/db.ts';
import { PgSuggestionIndexStore } from '../../src/storage/suggestion-index.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const skip = await postgresUnavailable();
if (skip) console.warn(`skipped: ${skip}`);

describe.skipIf(skip !== null)('the suggestion index (HIS-042 criterion 4, PostgreSQL)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function newDoc(tenant: string): Promise<string> {
    await new PgTenantRegistry(db.service).putTenant(tenant, 'V-HIS-033-046 suggestions');
    const doc = randomUUID();
    await inTenant(db.service, tenant, (c) =>
      c.query(
        `INSERT INTO documents (id, tenant_id, cdm_version, created_by, created_at)
         VALUES ($1, $2, 1, 'V-HIS-033-046', now())`,
        [doc, tenant],
      ),
    );
    return doc;
  }

  it('answers the introducing commit by identifier and keeps the lowest seq of a suggestion', async () => {
    const tenant = randomUUID();
    const doc = await newDoc(tenant);
    const ref = { tenant, doc };
    const store = new PgSuggestionIndexStore(db.service);

    await store.record(ref, [
      { suggestionId: 'sg-1', seq: 9 },
      { suggestionId: 'sg-2', seq: 12 },
    ]);
    // A later batch that names sg-1 again, at a higher seq, does not move it.
    await store.record(ref, [{ suggestionId: 'sg-1', seq: 15 }]);
    // An earlier seq for sg-2 replaces it.
    await store.record(ref, [{ suggestionId: 'sg-2', seq: 11 }]);

    expect(await store.introducedBy(ref, 'sg-1')).toBe(9);
    expect(await store.introducedBy(ref, 'sg-2')).toBe(11);
    expect(await store.introducedBy(ref, 'sg-unknown')).toBeUndefined();
  });

  it('is served by the primary key, so the lookup does not scan the table', async () => {
    const tenant = randomUUID();
    const doc = await newDoc(tenant);
    const store = new PgSuggestionIndexStore(db.service);
    const rows = Array.from({ length: 2000 }, (_, i) => ({ suggestionId: `sg-${i}`, seq: i + 1 }));
    await store.record({ tenant, doc }, rows);

    const plan = await inTenant(db.service, tenant, async (c: pg.PoolClient) => {
      await c.query('SET LOCAL enable_seqscan = off');
      const r = await c.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN select seq from suggestion_introductions
          where tenant_id = $1 and doc_id = $2 and suggestion_id = $3`,
        [tenant, doc, 'sg-1500'],
      );
      return r.rows.map((x) => x['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/Index/);
    expect(await store.introducedBy({ tenant, doc }, 'sg-1500')).toBe(1501);
  });

  it("keeps one tenant's index out of another tenant's reach", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const docA = await newDoc(tenantA);
    await newDoc(tenantB);
    const store = new PgSuggestionIndexStore(db.service);
    await store.record({ tenant: tenantA, doc: docA }, [{ suggestionId: 'sg-shared', seq: 4 }]);
    // Tenant B asks for the same document id under its own tenant: nothing is returned.
    expect(await store.introducedBy({ tenant: tenantB, doc: docA }, 'sg-shared')).toBeUndefined();
    expect(await store.introducedBy({ tenant: tenantA, doc: docA }, 'sg-shared')).toBe(4);
  });
});
