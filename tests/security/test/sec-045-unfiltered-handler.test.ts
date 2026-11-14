/**
 * SEC-045 criterion 3 (lane U-SEC-033-048): a handler written without a tenant filter sees no rows
 * of another tenant. This is a deliberate fault: the query below names no tenant, so the only thing
 * that keeps tenant B's rows out of tenant A's result is row-level security (BE-011, 0001_platform.sql
 * `docedit_protect`). The test runs against PostgreSQL (Podman, infra/test-env.ps1) in a database it
 * creates for itself, as the service role the service uses, and skips when PostgreSQL is down.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { beginForTenant, inTenant } from '../../../services/document-service/src/storage/db.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from './support/harness.ts';

const skip = await postgresUnavailable();
const TABLE = 'sec045_u_sec_033_048_probe';

describe.skipIf(skip !== null)(`SEC-045 unfiltered handler (${skip ?? 'PostgreSQL'})`, () => {
  let db: TestDatabase;
  let app: pg.Pool;
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    db = await createTestDatabase();
    // A table with the same protection the migrations give every tenant table.
    await db.admin.query(
      `CREATE TABLE public.${TABLE} (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         tenant_id uuid NOT NULL,
         note text NOT NULL)`,
    );
    await db.admin.query(`SELECT docedit_protect('public.${TABLE}')`);
    const role = decodeURIComponent(new URL(db.url).username);
    await db.admin.query(`GRANT SELECT, INSERT, UPDATE ON public.${TABLE} TO ${role}`);
    app = new pg.Pool({ connectionString: db.url, max: 2 });
    app.on('error', () => {});
    await inTenant(app, tenantA, (c) =>
      c.query(`INSERT INTO ${TABLE} (tenant_id, note) VALUES ($1, 'tenant A price 10')`, [tenantA]),
    );
    await inTenant(app, tenantB, (c) =>
      c.query(`INSERT INTO ${TABLE} (tenant_id, note) VALUES ($1, 'tenant B price 99')`, [tenantB]),
    );
  });

  afterAll(async () => {
    await app?.end().catch(() => {});
    await db?.drop();
  });

  it('a query without a tenant filter, run as tenant A, returns only tenant A rows', async () => {
    const notes = await inTenant(app, tenantA, async (c) => {
      const r = await c.query<{ note: string }>(`SELECT note FROM ${TABLE}`);
      return r.rows.map((row) => row.note);
    });
    expect(notes).toEqual(['tenant A price 10']);
    expect(notes.join(' ')).not.toContain('tenant B');
  });

  it('the same unfiltered query as tenant B returns only tenant B rows (control)', async () => {
    const notes = await inTenant(app, tenantB, async (c) => {
      const r = await c.query<{ note: string }>(`SELECT note FROM ${TABLE}`);
      return r.rows.map((row) => row.note);
    });
    expect(notes).toEqual(['tenant B price 99']);
  });

  it('an unfiltered query with no tenant set in its transaction returns no rows', async () => {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query<{ note: string }>(`SELECT note FROM ${TABLE}`);
      await client.query('ROLLBACK');
      expect(r.rows).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('an unfiltered update as tenant A cannot change tenant B rows', async () => {
    const changed = await inTenant(app, tenantA, async (c) => {
      const r = await c.query(`UPDATE ${TABLE} SET note = 'overwritten'`);
      return r.rowCount ?? 0;
    });
    // Only tenant A's own row is matched by the unfiltered update; tenant B's row is untouched.
    expect(changed).toBe(1);
    const b = await inTenant(app, tenantB, async (c) => {
      const r = await c.query<{ note: string }>(`SELECT note FROM ${TABLE}`);
      return r.rows.map((row) => row.note);
    });
    expect(b).toEqual(['tenant B price 99']);
  });

  it('beginForTenant rejects a tenant that is not a UUID before it sets anything', async () => {
    const client = await app.connect();
    try {
      await expect(beginForTenant(client, 'not-a-tenant')).rejects.toThrow(/lower-case UUID/);
    } finally {
      client.release();
    }
  });
});
