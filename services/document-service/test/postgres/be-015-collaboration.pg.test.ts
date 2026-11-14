// BE-015 (lane U-BE-015-028): the phase 2 tables of 06 §4.1 exist under the tenancy rules of BE-011,
// versions accept every kind of 08 §4, a read marker only moves forward, and a thread's mapped range
// is written all together or not at all. Runs against PostgreSQL; skips when it is not up.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  newTenant,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const CREATED_BY = 'U-BE-015-028';
const NEW_TABLES = ['versions', 'threads', 'comments', 'read_markers'] as const;
const ALL_SIX = ['region_states', 'region_leases', ...NEW_TABLES];

describe.skipIf(unavailable !== null)('BE-015 collaboration tables (PostgreSQL)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db?.drop());

  /** Runs fn in a transaction as the service role, bound to one tenant (BE-011). */
  async function inTenant<T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await db.service.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [tenant]);
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async function newDocument(tenant: string): Promise<string> {
    return inTenant(tenant, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO documents (id, tenant_id, cdm_version, created_by, created_at)
         VALUES (gen_random_uuid(), $1, 1, $2, now()) RETURNING id`,
        [tenant, CREATED_BY],
      );
      return r.rows[0]!.id;
    });
  }

  it('creates the four new tables and keeps the two grant tables, each with tenant_id and forced RLS', async () => {
    const rows = await db.admin.query<{
      t: string;
      has_tenant: boolean;
      rls: boolean;
      forced: boolean;
      policies: string[] | null;
    }>(
      `SELECT c.relname AS t,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                       AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant,
              c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT array_agg(pg_get_expr(p.polqual, p.polrelid)) FROM pg_policy p
                WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
      [ALL_SIX],
    );
    expect(rows.rows.map((r) => r.t).sort()).toEqual([...ALL_SIX].sort());
    for (const r of rows.rows) {
      expect({ table: r.t, tenant: r.has_tenant, rls: r.rls, forced: r.forced }).toEqual({
        table: r.t,
        tenant: true,
        rls: true,
        forced: true,
      });
      expect(r.policies, r.t).toEqual(['(tenant_id = docedit_current_tenant())']);
    }
  });

  it('accepts every version kind of 08 §4 and refuses any other', async () => {
    const tenant = newTenant();
    const doc = await newDocument(tenant);
    const kinds = ['named', 'export', 'pre-restore', 'restore', 'import', 'sent', 'completed'];
    let seq = 0;
    for (const kind of kinds) {
      seq += 1;
      await inTenant(tenant, (c) =>
        c.query(
          `INSERT INTO versions (doc_id, tenant_id, seq, kind, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [doc, tenant, seq, kind, CREATED_BY],
        ),
      );
    }
    const stored = await inTenant(
      tenant,
      async (c) =>
        (
          await c.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM versions WHERE doc_id = $1',
            [doc],
          )
        ).rows[0]!.n,
    );
    expect(stored).toBe(String(kinds.length));
    await expect(
      inTenant(tenant, (c) =>
        c.query(
          `INSERT INTO versions (doc_id, tenant_id, seq, kind, created_by, created_at)
           VALUES ($1, $2, 99, 'autosave', $3, now())`,
          [doc, tenant, CREATED_BY],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('moves a read marker forward only: a lower seq is refused and an equal or higher one is stored', async () => {
    const tenant = newTenant();
    const doc = await newDocument(tenant);
    await inTenant(tenant, (c) =>
      c.query(
        `INSERT INTO read_markers (doc_id, tenant_id, user_id, seq, updated_at)
         VALUES ($1, $2, 'user:a', 5, now())`,
        [doc, tenant],
      ),
    );
    await expect(
      inTenant(tenant, (c) =>
        c.query(`UPDATE read_markers SET seq = 4 WHERE doc_id = $1 AND user_id = 'user:a'`, [doc]),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'read_marker_forward_only' });
    await inTenant(tenant, (c) =>
      c.query(
        `UPDATE read_markers SET seq = 5, updated_at = now() WHERE doc_id = $1 AND user_id = 'user:a'`,
        [doc],
      ),
    );
    await inTenant(tenant, (c) =>
      c.query(
        `UPDATE read_markers SET seq = 9, updated_at = now() WHERE doc_id = $1 AND user_id = 'user:a'`,
        [doc],
      ),
    );
    const row = await inTenant(
      tenant,
      async (c) =>
        (
          await c.query<{ seq: string }>(
            `SELECT seq::text AS seq FROM read_markers WHERE doc_id = $1`,
            [doc],
          )
        ).rows[0],
    );
    expect(row?.seq).toBe('9');
  });

  it('writes a thread range with range_from, range_to and range_seq together, or not at all', async () => {
    const tenant = newTenant();
    const doc = await newDocument(tenant);
    const insertThread = (id: string, from: number | null, to: number | null, seq: number | null) =>
      inTenant(tenant, (c) =>
        c.query(
          `INSERT INTO threads (id, tenant_id, doc_id, scope, state, target, range_from, range_to, range_seq,
                                created_by, created_at)
           VALUES ($1, $2, $3, 'doc', 'open', '{}'::jsonb, $4, $5, $6, $7, now())`,
          [id, tenant, doc, from, to, seq, CREATED_BY],
        ),
      );
    await insertThread(crypto.randomUUID(), 0, 4, 7);
    await insertThread(crypto.randomUUID(), null, null, null);
    await expect(insertThread(crypto.randomUUID(), 0, 4, null)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertThread(crypto.randomUUID(), 0, null, 7)).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertThread(crypto.randomUUID(), 5, 2, 7)).rejects.toMatchObject({
      code: '23514',
    });
  });

  it("keeps one tenant's threads and comments out of another tenant's reads", async () => {
    const a = newTenant();
    const b = newTenant();
    const doc = await newDocument(a);
    const thread = crypto.randomUUID();
    await inTenant(a, async (c) => {
      await c.query(
        `INSERT INTO threads (id, tenant_id, doc_id, scope, state, target, created_by, created_at)
         VALUES ($1, $2, $3, 'doc', 'open', '{}'::jsonb, $4, now())`,
        [thread, a, doc, CREATED_BY],
      );
      await c.query(
        `INSERT INTO comments (id, tenant_id, thread_id, author, body, created_at)
         VALUES (gen_random_uuid(), $1, $2, 'user:a', '{}'::jsonb, now())`,
        [a, thread],
      );
    });
    const seenByB = await inTenant(b, async (c) => {
      const t = await c.query('SELECT 1 FROM threads');
      const cm = await c.query('SELECT 1 FROM comments');
      return t.rowCount! + cm.rowCount!;
    });
    expect(seenByB).toBe(0);
  });
});
