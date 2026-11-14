// The schema after migrations: tables and keys of 06 §4.1 (BE-009, BE-010), the partition count
// set once (BE-008), row-level security on every table (BE-011), and what the service role may
// do. Skips when PostgreSQL is not up.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../src/index.ts';
import { TENANT_EXEMPT } from '../../src/storage/tenant-guard.ts';
import { initialPermissions } from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  SERVICE_USER,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('schema (PostgreSQL)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db?.drop());

  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    (await db.admin.query<T>(sql, params)).rows;

  /** Primary-key or unique columns of a table, in index order. */
  async function keyColumns(table: string, kind: 'p' | 'u'): Promise<string[][]> {
    const rows = await q<{ cols: string[] }>(
      `SELECT array_agg(a.attname ORDER BY k.ord)::text[] AS cols
         FROM pg_constraint c
         JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = $1::regclass AND c.contype = $2
        GROUP BY c.oid ORDER BY c.oid`,
      [table, kind],
    );
    return rows.map((r) => r.cols);
  }

  it('creates the log and grant tables of 06 §4.1 with their keys', async () => {
    const tables = (
      await q<{ t: string }>(
        `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
      )
    ).map((r) => r.t);
    expect(tables.sort()).toEqual(
      [
        'commit_scopes',
        'doc_commit_payloads',
        'doc_commits',
        'doc_heads',
        'docedit_schema_migrations',
        'documents',
        'grant_history',
        'grant_revisions',
        'region_grants',
        'region_leases',
        'region_states',
        'retired_regions',
        // The control plane (migrations 0004 to 0006, packet A2).
        'tenants',
        'tenant_keys',
        'tenant_api_keys',
        'tenant_origins',
        'tenant_users',
        'document_revocations',
        'jobs',
        // Phase 1b, packet C (migrations 0040 to 0042).
        'idempotency_keys',
        'tenant_job_limits',
        'assets',
        // Phase 1b, packet A (migrations 0030 to 0033).
        'doc_snapshots',
        'doc_checkpoints',
        'audit_events',
        'outbox',
        'node_leases',
        // Collaboration, history, workflow and tenant settings (migrations 0050 to 0070).
        'versions',
        'threads',
        'comments',
        'read_markers',
        'workflow_evidence',
        'workflow_sealed_pdf',
        'suggestion_introductions',
        'doc_assets',
        'tenant_retention',
        'document_holds',
        'tenant_capture_settings',
        'workflow_renewal_state',
        'tenant_quotas',
        'workflow_resource',
      ].sort(),
    );
    expect(await keyColumns('doc_commits', 'p')).toEqual([['doc_id', 'seq']]);
    expect(await keyColumns('doc_commits', 'u')).toEqual([['doc_id', 'commit_id']]);
    expect(await keyColumns('doc_commit_payloads', 'p')).toEqual([['doc_id', 'seq']]);
    expect(await keyColumns('commit_scopes', 'p')).toEqual([['doc_id', 'scope', 'seq']]);
    expect(await keyColumns('documents', 'u')).toEqual([['tenant_id', 'external_id']]);
    expect(await keyColumns('doc_heads', 'p')).toEqual([['doc_id']]);
    expect(await keyColumns('region_grants', 'p')).toEqual([['doc_id', 'region_id', 'principal']]);
    expect(await keyColumns('grant_revisions', 'p')).toEqual([['doc_id']]);
    expect(await keyColumns('retired_regions', 'p')).toEqual([['doc_id', 'region_id']]);
    const columns = (table: string) =>
      q<{ c: string }>(
        `SELECT column_name AS c FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [table],
      ).then((r) => r.map((x) => x.c));
    // 06 §4.1 and 08 §2, plus payload_hash (HIS-002 notes) and tenant_id (BE-011).
    expect(await columns('doc_commits')).toEqual([
      'doc_id',
      'seq',
      'tenant_id',
      'kind',
      'commit_id',
      'user_id',
      'session_id',
      'agent',
      'server_ts',
      'origin',
      'base',
      'rebased',
      'access_rev',
      'token_jti',
      'cdm_version',
      'engine',
      'size',
      'payload_hash',
      'prev_hash',
      'hash',
    ]);
    expect(await columns('doc_heads')).toEqual([
      'doc_id',
      'tenant_id',
      'head_seq',
      'incarnation',
      'owner',
      'epoch',
      'chain_head',
    ]);
    expect(await columns('region_grants')).toEqual([
      'doc_id',
      'region_id',
      'principal',
      'tenant_id',
      'role',
      'expires_at',
      'created_by',
      'created_at',
    ]);
  });

  it('hash-partitions the log tables by document, with the count set once in the migration (BE-008)', async () => {
    for (const table of ['doc_commits', 'doc_commit_payloads']) {
      const [p] = await q<{ strategy: string; key: string }>(
        `SELECT p.partstrat AS strategy, a.attname AS key
           FROM pg_partitioned_table p
           JOIN pg_attribute a ON a.attrelid = p.partrelid AND a.attnum = p.partattrs[0]
          WHERE p.partrelid = $1::regclass`,
        [table],
      );
      expect(p).toEqual({ strategy: 'h', key: 'doc_id' });
      const [n] = await q<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = $1::regclass',
        [table],
      );
      expect(n!.n).toBe(64);
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, '0002_documents_and_log.sql'), 'utf8');
    expect(sql.match(/partitions constant int := (\d+);/g)).toEqual([
      'partitions constant int := 64;',
    ]);
    expect(sql).toContain('docs/adr/0020-commit-log-storage.md');
  });

  it('gives every table a tenant_id, forced row-level security and a tenant policy (BE-011)', async () => {
    const rows = await q<{
      t: string;
      has_tenant: boolean;
      rls: boolean;
      forced: boolean;
      policies: string[] | null;
    }>(
      `SELECT c.relname AS t,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                         AND NOT a.attisdropped) AS has_tenant,
              c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              (SELECT array_agg(pg_get_expr(p.polqual, p.polrelid)) FROM pg_policy p
                WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND c.relname <> 'docedit_schema_migrations'`,
    );
    // 11 tables of the storage layer, 7 of the control plane (0004 to 0006, packet A2), 3 of the
    // control plane's phase 1b (0040 to 0042, packet C), 5 of phase 1b packet A (0030 to 0033) and
    // 14 of migrations 0050 to 0070; the 64 hash partitions of each log table (0002) and the 5
    // monthly partitions of audit_events that migration 0031 creates (the month before, this
    // month and the coming three).
    expect(rows.length).toBe(11 + 7 + 3 + 5 + 14 + 2 * 64 + 5);
    // A table in TENANT_EXEMPT holds no tenant data (node_leases, 0033: a lease names a node). It
    // must really have no tenant_id, so that the exemption cannot hide a tenant table. Whether the
    // exemption meets BE-011 is open for the owner (ADR 0332).
    const exempt = rows.filter((r) => TENANT_EXEMPT.has(r.t));
    expect(exempt.map((r) => r.t).sort()).toEqual([...TENANT_EXEMPT].sort());
    for (const r of exempt)
      expect({ table: r.t, tenant: r.has_tenant }).toEqual({ table: r.t, tenant: false });
    for (const r of rows.filter((x) => !TENANT_EXEMPT.has(x.t))) {
      expect({ table: r.t, tenant: r.has_tenant, rls: r.rls, forced: r.forced }).toEqual({
        table: r.t,
        tenant: true,
        rls: true,
        forced: true,
      });
      expect(r.policies, r.t).toEqual(['(tenant_id = docedit_current_tenant())']);
    }
  });

  it('stores no position maps and accepts only active, locked and archived as document states', async () => {
    const mapLike = await q<{ c: string }>(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
        WHERE table_schema = 'public' AND (column_name ~ 'map' OR table_name ~ 'map')`,
    );
    expect(mapLike).toEqual([]);
    const tenant = newTenant();
    const insert = (state: string) =>
      db.admin.query(
        `INSERT INTO documents (id, tenant_id, state, cdm_version, created_by, created_at)
         VALUES (gen_random_uuid(), $1, $2, 1, 'u', now())`,
        [tenant, state],
      );
    for (const s of ['active', 'locked', 'archived']) await insert(s);
    await expect(insert('deleted')).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts only the four principal forms and the region roles in grants (BE-010)', async () => {
    const { docs } = pgStores(db.service);
    const tenant = newTenant();
    const rec = await docs.create(tenant, { cdmVersion: 1, createdBy: 'u' });
    const grant = (principal: string, role = 'editor') =>
      db.admin.query(
        `INSERT INTO region_grants (doc_id, region_id, principal, tenant_id, role, created_by, created_at)
         VALUES ($1, 'rTerms000000000A', $2, $3, $4, 'u', now())`,
        [rec.id, principal, tenant, role],
      );
    for (const ok of ['user:alice', 'group:legal', 'everyone', 'role:role_tenant']) await grant(ok);
    for (const bad of ['alice', 'user:', 'everyone:x', 'team:legal', 'user:a b', 'Everyone'])
      await expect(grant(bad), bad).rejects.toMatchObject({ code: '23514' });
    for (const bad of ['owner', 'filler', 'manage'])
      await expect(grant('user:bob', bad), bad).rejects.toMatchObject({ code: '23514' });
  });

  it('connects the service as a role that is no superuser and cannot bypass row-level security; migrations ran as another role', async () => {
    const [role] = await q<{ super: boolean; bypass: boolean; createrole: boolean }>(
      `SELECT rolsuper AS super, rolbypassrls AS bypass, rolcreaterole AS createrole
         FROM pg_roles WHERE rolname = $1`,
      [SERVICE_USER],
    );
    expect(role).toEqual({ super: false, bypass: false, createrole: false });
    const owners = await q<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    expect(owners.map((o) => o.owner)).not.toContain(SERVICE_USER);
    const [who] = (await db.service.query<{ u: string }>('SELECT current_user AS u')).rows;
    expect(who!.u).toBe(SERVICE_USER);
  });

  it('returns no rows and refuses writes when no tenant is set (BE-011)', async () => {
    const { docs } = pgStores(db.service);
    await docs.create(newTenant(), { cdmVersion: 1, createdBy: 'u' });
    const c = await db.service.connect();
    try {
      expect((await c.query('SELECT * FROM documents')).rows).toEqual([]);
      expect((await c.query('SELECT * FROM doc_heads')).rows).toEqual([]);
      await expect(
        c.query(
          `INSERT INTO documents (id, tenant_id, cdm_version, created_by, created_at)
           VALUES (gen_random_uuid(), gen_random_uuid(), 1, 'u', now())`,
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      c.release();
    }
  });

  it("does not let tenant A select, update or delete tenant B's rows by primary key (BE-011)", async () => {
    const { docs, grants } = pgStores(db.service);
    const a = newTenant();
    const b = newTenant();
    const doc = await docs.create(b, {
      cdmVersion: 1,
      createdBy: 'u',
      permissions: initialPermissions(),
    });
    const asTenant = async (tenant: string, sql: string, params: unknown[]) => {
      const c = await db.service.connect();
      try {
        await c.query('BEGIN');
        await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [tenant]);
        const r = await c.query(sql, params);
        await c.query('COMMIT');
        return r.rowCount;
      } finally {
        c.release();
      }
    };
    expect(await asTenant(a, 'SELECT * FROM documents WHERE id = $1', [doc.id])).toBe(0);
    expect(await asTenant(a, "UPDATE documents SET title = 'x' WHERE id = $1", [doc.id])).toBe(0);
    expect(
      await asTenant(a, 'UPDATE doc_heads SET epoch = epoch + 1 WHERE doc_id = $1', [doc.id]),
    ).toBe(0);
    expect(await asTenant(a, 'DELETE FROM region_grants WHERE doc_id = $1', [doc.id])).toBe(0);
    expect(await asTenant(b, 'SELECT * FROM documents WHERE id = $1', [doc.id])).toBe(1);
    expect((await grants.current({ tenant: b, doc: doc.id })).grants).toHaveLength(2);
    expect((await docs.get({ tenant: b, doc: doc.id }))?.title).toBeNull();
  });

  it('keeps stored history append-only for the service role', async () => {
    for (const sql of [
      "UPDATE doc_commits SET origin = 'paste'",
      'DELETE FROM doc_commits',
      "UPDATE doc_commit_payloads SET payload = '\\x00'",
      'DELETE FROM commit_scopes',
      'DELETE FROM grant_history',
      'DELETE FROM retired_regions',
    ])
      await expect(db.service.query(sql), sql).rejects.toMatchObject({ code: '42501' });
  });
});
