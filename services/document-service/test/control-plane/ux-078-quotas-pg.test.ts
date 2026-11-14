// UX-078 criterion 1, durable half (lane U-UX-076-090): the tenant quota values are stored in
// PostgreSQL, validated as in the in-memory store, and read back by a store that did not write them
// (a restart). The table comes from migration 0069, under row-level security (lane V-UX-076-090,
// round 4), so the service role reads only the rows of the tenant its transaction names. Runs on a
// database of its own in the integration environment (infra/test-env.ps1 up), migrated as the
// service is; skipped with the reason when PostgreSQL is not reachable.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgQuotaStore } from '../../src/control-plane/quotas-pg.ts';
import { QUOTA_DIMENSIONS } from '../../src/control-plane/quotas.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const why = await postgresUnavailable();
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const TENANT_UNKNOWN = randomUUID();
const KNOWN = new Set<string>([TENANT_A, TENANT_B]);
const known = async (t: string) => KNOWN.has(t);

describe.skipIf(why)('UX-078 quota store on PostgreSQL (lanes U-UX-076-090, V-UX-076-090)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    // The admin role owns the tables and is not subject to their policies (it is a superuser in
    // the test environment), so it may register both tenants directly.
    for (const [id, name] of [
      [TENANT_A, 'V-UX-076-090 quota tenant A'],
      [TENANT_B, 'V-UX-076-090 quota tenant B'],
    ] as const) {
      await db.admin.query(
        'INSERT INTO tenants (id, tenant_id, name, created_at) VALUES ($1, $1, $2, now())',
        [id, name],
      );
    }
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('stores each dimension, reads unset dimensions as null, and keeps values after a restart', async () => {
    const store = new PgQuotaStore(db.service, known);
    expect(await store.set(TENANT_A, 'connections', 12)).toBe(12);
    expect(await store.set(TENANT_A, 'storage', 0)).toBe(0);
    expect(await store.set(TENANT_A, 'exportMinutes', 2.5)).toBe(2.5);

    // A second store on the same database stands for the service after a restart.
    const afterRestart = new PgQuotaStore(db.service, known);
    const got = await afterRestart.get(TENANT_A);
    expect(Object.keys(got).sort()).toEqual([...QUOTA_DIMENSIONS].sort());
    expect(got.connections).toBe(12);
    expect(got.storage).toBe(0);
    expect(got.exportMinutes).toBe(2.5);
    expect(got.commitRate).toBeNull();
  });

  it('replaces a value on a second set, without a second row', async () => {
    const store = new PgQuotaStore(db.service, known);
    await store.set(TENANT_A, 'connections', 40);
    expect((await store.get(TENANT_A)).connections).toBe(40);
    const rows = await db.admin.query(
      `SELECT count(*)::int AS n FROM tenant_quotas WHERE tenant_id = $1 AND dimension = 'connections'`,
      [TENANT_A],
    );
    expect(rows.rows[0]?.n).toBe(1);
  });

  it('refuses a negative, non-finite or non-numeric value, an unknown dimension and an unknown tenant, and writes nothing', async () => {
    const store = new PgQuotaStore(db.service, known);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
      await expect(store.set(TENANT_B, 'commitRate', bad)).rejects.toThrow();
    }
    await expect(store.set(TENANT_B, 'bandwidth', 1)).rejects.toThrow();
    await expect(store.set(TENANT_UNKNOWN, 'commitRate', 1)).rejects.toThrow('no such tenant');

    const none = await store.get(TENANT_B);
    expect(Object.values(none).every((v) => v === null)).toBe(true);
    const unknown = await store.get(TENANT_UNKNOWN);
    expect(Object.values(unknown).every((v) => v === null)).toBe(true);
  });

  it('refuses a bad value even when written past the code, through the CHECK clauses', async () => {
    // 23514 is check_violation: the row reached the table and the CHECK clause refused it.
    for (const value of ["'NaN'::float8", "'Infinity'::float8", '-3']) {
      await expect(
        db.admin.query(
          `INSERT INTO tenant_quotas (tenant_id, dimension, value) VALUES ($1, 'storage', ${value})`,
          [TENANT_B],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    // 23503 is foreign_key_violation: a row for a tenant that is not registered.
    await expect(
      db.admin.query(
        `INSERT INTO tenant_quotas (tenant_id, dimension, value) VALUES ($1, 'storage', 1)`,
        [TENANT_UNKNOWN],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it("keeps one tenant's values apart from another's", async () => {
    const store = new PgQuotaStore(db.service, known);
    await store.set(TENANT_B, 'connections', 3);
    expect((await store.get(TENANT_B)).connections).toBe(3);
    expect((await store.get(TENANT_A)).connections).toBe(40);
  });

  it('has the table from the migrations, under forced row-level security', async () => {
    const r = await db.admin.query<{ rls: boolean; forced: boolean }>(
      `select relrowsecurity as rls, relforcerowsecurity as forced from pg_class
        where relname = 'tenant_quotas'`,
    );
    expect(r.rows[0]).toEqual({ rls: true, forced: true });
  });

  it('shows the service role no row of another tenant, even without a WHERE clause, and none with no tenant set', async () => {
    // Both tenants have rows by now (the tests above); the admin role sees them all.
    const all = await db.admin.query<{ tenant_id: string }>(
      'SELECT DISTINCT tenant_id FROM tenant_quotas ORDER BY tenant_id',
    );
    expect(all.rows.map((x) => x.tenant_id)).toEqual([TENANT_A, TENANT_B].sort());

    const c = await db.service.connect();
    try {
      // Under tenant B's context the whole table holds tenant B's rows only.
      await c.query('BEGIN');
      await c.query(`SELECT set_config('docedit.tenant_id', $1, true)`, [TENANT_B]);
      const seen = await c.query<{ tenant_id: string }>('SELECT tenant_id FROM tenant_quotas');
      expect(seen.rows.length).toBeGreaterThan(0);
      expect(new Set(seen.rows.map((x) => x.tenant_id))).toEqual(new Set([TENANT_B]));
      const asked = await c.query('SELECT 1 FROM tenant_quotas WHERE tenant_id = $1', [TENANT_A]);
      expect(asked.rowCount).toBe(0);
      await c.query('COMMIT');

      // With no tenant set, the policy matches no row.
      const none = await c.query('SELECT 1 FROM tenant_quotas');
      expect(none.rowCount).toBe(0);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });

  it("refuses the service role a write to another tenant's quotas, and leaves those rows unchanged", async () => {
    const c = await db.service.connect();
    try {
      // An insert for tenant A under tenant B's context fails the policy's WITH CHECK (42501).
      await c.query('BEGIN');
      await c.query(`SELECT set_config('docedit.tenant_id', $1, true)`, [TENANT_B]);
      await expect(
        c.query(
          `INSERT INTO tenant_quotas (tenant_id, dimension, value) VALUES ($1, 'storage', 99)`,
          [TENANT_A],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');

      // An update aimed at tenant A's rows under tenant B's context touches nothing.
      await c.query('BEGIN');
      await c.query(`SELECT set_config('docedit.tenant_id', $1, true)`, [TENANT_B]);
      const updated = await c.query(`UPDATE tenant_quotas SET value = 99 WHERE tenant_id = $1`, [
        TENANT_A,
      ]);
      expect(updated.rowCount).toBe(0);
      await c.query('COMMIT');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    expect((await new PgQuotaStore(db.service, known).get(TENANT_A)).connections).toBe(40);
  });

  it('reads a tenant identifier that is not a UUID as unset and refuses to write it', async () => {
    const store = new PgQuotaStore(db.service, async () => true);
    expect(Object.values(await store.get('V-UX-076-090-not-a-uuid')).every((v) => v === null)).toBe(
      true,
    );
    await expect(store.set('V-UX-076-090-not-a-uuid', 'storage', 1)).rejects.toThrow(
      'no such tenant',
    );
  });
});
