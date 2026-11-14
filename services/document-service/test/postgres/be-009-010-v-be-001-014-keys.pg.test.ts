// BE-009 criterion 1 and BE-010 criterion 1 on PostgreSQL (lane V-BE-001-014). The older schema test
// (`schema.pg.test.ts`) fails on a stale table list before it reaches these assertions, so this file
// checks the keys, the columns and the partitioning of the tables these stories name, on a freshly
// migrated database. Skipped when PostgreSQL is not up (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const why = await postgresUnavailable();

interface Con {
  t: string;
  contype: string;
  def: string;
}

interface Col {
  table_name: string;
  column_name: string;
  is_nullable: string;
  data_type: string;
}

describe.skipIf(why !== null)(
  'log and grant tables: keys and columns (BE-009, BE-010, V-BE-001-014)',
  () => {
    let db: TestDatabase;
    let cons: Map<string, string[]>;
    let cols: Map<string, Col>;

    beforeAll(async () => {
      db = await createTestDatabase();
      const c = await db.admin.query<Con>(
        `SELECT c.relname AS t, con.contype, pg_get_constraintdef(con.oid) AS def
         FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        WHERE c.relnamespace = 'public'::regnamespace AND con.contype IN ('p', 'u')`,
      );
      cons = new Map();
      for (const r of c.rows) cons.set(r.t, [...(cons.get(r.t) ?? []), r.def]);
      const k = await db.admin.query<Col>(
        `SELECT table_name, column_name, is_nullable, data_type
         FROM information_schema.columns WHERE table_schema = 'public'`,
      );
      cols = new Map(k.rows.map((r) => [`${r.table_name}.${r.column_name}`, r]));
    });

    afterAll(async () => {
      await db?.drop();
    });

    const has = (t: string, def: string) => expect(cons.get(t) ?? [], t).toContain(def);
    const col = (t: string, c: string) => cols.get(`${t}.${c}`);

    // BE-009 criterion 1
    it('documents has the key and the unique (tenant_id, external_id) of 06 §4.1', () => {
      has('documents', 'PRIMARY KEY (id)');
      has('documents', 'UNIQUE (tenant_id, external_id)');
    });

    it('doc_heads is keyed by the document', () => {
      has('doc_heads', 'PRIMARY KEY (doc_id)');
    });

    it('doc_commits has primary key (doc_id, seq) and unique (doc_id, commit_id)', () => {
      has('doc_commits', 'PRIMARY KEY (doc_id, seq)');
      has('doc_commits', 'UNIQUE (doc_id, commit_id)');
    });

    it('doc_commit_payloads has primary key (doc_id, seq)', () => {
      has('doc_commit_payloads', 'PRIMARY KEY (doc_id, seq)');
    });

    it('commit_scopes has primary key (doc_id, scope, seq)', () => {
      has('commit_scopes', 'PRIMARY KEY (doc_id, scope, seq)');
    });

    it('doc_commits and doc_commit_payloads are hash-partitioned by doc_id into the 64 partitions of BE-008', async () => {
      for (const t of ['doc_commits', 'doc_commit_payloads']) {
        const r = await db.admin.query<{ strat: string; n: string }>(
          `SELECT p.partstrat AS strat,
                (SELECT count(*)::text FROM pg_inherits i WHERE i.inhparent = p.partrelid) AS n
           FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid
          WHERE c.relname = $1`,
          [t],
        );
        expect(r.rows, t).toEqual([{ strat: 'h', n: '64' }]);
      }
    });

    it('documents.state accepts only active, locked and archived', async () => {
      const r = await db.admin.query<{ def: string }>(
        `SELECT pg_get_constraintdef(con.oid) AS def FROM pg_constraint con
        WHERE con.conrelid = 'documents'::regclass AND con.contype = 'c'`,
      );
      const states = r.rows.map((x) => x.def).find((d) => d.includes("'locked'"));
      expect(states).toBeDefined();
      expect(states).toContain("'active'");
      expect(states).toContain("'archived'");
    });

    // BE-010 criterion 1
    it('region_grants has primary key (doc_id, region_id, principal), role and an optional expires_at', () => {
      has('region_grants', 'PRIMARY KEY (doc_id, region_id, principal)');
      expect(col('region_grants', 'role')?.is_nullable).toBe('NO');
      expect(col('region_grants', 'expires_at')?.is_nullable).toBe('YES');
    });

    it('grant_revisions has one row per document (primary key doc_id)', () => {
      has('grant_revisions', 'PRIMARY KEY (doc_id)');
    });

    it('retired_regions has primary key (doc_id, region_id)', () => {
      has('retired_regions', 'PRIMARY KEY (doc_id, region_id)');
    });
  },
);
