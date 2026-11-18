// BE-015 criterion 1: after the migrations run on an empty database, each of the six tables has the
// columns (name, type, nullability), the primary key and the references of the sketch in
// 06 §4.1. The only column added to the sketch is `tenant_id` (BE-011). The row-level-security
// checks of BE-011 are in be-015-collaboration.pg.test.ts. Runs against PostgreSQL; skips when it is
// not up.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/** name: type + 'N' for not null, as 06 §4.1 writes them (tenant_id added). */
interface Sketch {
  columns: Record<string, string>;
  primaryKey: string[];
  references: Record<string, string>;
}

const TENANT = 'uuid N';

const SKETCH: Record<string, Sketch> = {
  versions: {
    columns: {
      doc_id: 'uuid N',
      tenant_id: TENANT,
      seq: 'bigint N',
      kind: 'text N',
      name: 'text',
      note: 'text',
      created_by: 'text N',
      created_at: 'timestamp with time zone N',
    },
    primaryKey: ['doc_id', 'seq', 'kind'],
    references: { doc_id: 'documents' },
  },
  region_states: {
    columns: {
      doc_id: 'uuid N',
      region_id: 'text N',
      tenant_id: TENANT,
      state: 'text N',
      approved_seq: 'bigint',
      content_hash: 'bytea',
      changed_by: 'text N',
      changed_at: 'timestamp with time zone N',
    },
    primaryKey: ['doc_id', 'region_id'],
    references: { doc_id: 'documents' },
  },
  region_leases: {
    columns: {
      doc_id: 'uuid N',
      region_id: 'text N',
      tenant_id: TENANT,
      lease_id: 'uuid N',
      holder: 'text N',
      acquired_at: 'timestamp with time zone N',
      expires_at: 'timestamp with time zone N',
    },
    primaryKey: ['doc_id', 'region_id'],
    references: { doc_id: 'documents' },
  },
  threads: {
    columns: {
      id: 'uuid N',
      tenant_id: TENANT,
      doc_id: 'uuid N',
      scope: 'text N',
      state: 'text N',
      target: 'jsonb N',
      range_from: 'integer',
      range_to: 'integer',
      range_seq: 'bigint',
      detached: 'boolean N',
      assignee: 'text',
      created_by: 'text N',
      created_at: 'timestamp with time zone N',
      resolved_by: 'text',
      resolved_at: 'timestamp with time zone',
    },
    primaryKey: ['id'],
    references: { doc_id: 'documents' },
  },
  comments: {
    columns: {
      id: 'uuid N',
      tenant_id: TENANT,
      thread_id: 'uuid N',
      author: 'text N',
      body: 'jsonb N',
      created_at: 'timestamp with time zone N',
      edited_at: 'timestamp with time zone',
      deleted_at: 'timestamp with time zone',
    },
    primaryKey: ['id'],
    references: { thread_id: 'threads' },
  },
  read_markers: {
    columns: {
      doc_id: 'uuid N',
      tenant_id: TENANT,
      user_id: 'text N',
      seq: 'bigint N',
      updated_at: 'timestamp with time zone N',
    },
    primaryKey: ['doc_id', 'user_id'],
    references: { doc_id: 'documents' },
  },
};

describe.skipIf(unavailable !== null)('BE-015 columns, keys and references of 06 §4.1', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(() => db?.drop());

  it('lists exactly the six tables of the criterion', () => {
    expect(Object.keys(SKETCH).sort()).toEqual(
      ['comments', 'read_markers', 'region_leases', 'region_states', 'threads', 'versions'].sort(),
    );
  });

  for (const [table, sketch] of Object.entries(SKETCH)) {
    it(`${table}: columns, primary key and references match the sketch`, async () => {
      const cols = await db.admin.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const actual: Record<string, string> = {};
      for (const c of cols.rows) {
        actual[c.column_name] = c.data_type + (c.is_nullable === 'NO' ? ' N' : '');
      }
      expect(actual).toEqual(sketch.columns);

      const pk = await db.admin.query<{ attname: string }>(
        `SELECT a.attname
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
          WHERE n.nspname = 'public' AND c.relname = $1 AND i.indisprimary
          ORDER BY k.ord`,
        [table],
      );
      expect(pk.rows.map((r) => r.attname)).toEqual(sketch.primaryKey);

      const fk = await db.admin.query<{ col: string; target: string }>(
        `SELECT a.attname AS col, tc.relname AS target
           FROM pg_constraint k
           JOIN pg_class c ON c.oid = k.conrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_class tc ON tc.oid = k.confrelid
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.conkey[1]
          WHERE n.nspname = 'public' AND c.relname = $1 AND k.contype = 'f'`,
        [table],
      );
      const refs: Record<string, string> = {};
      for (const r of fk.rows) refs[r.col] = r.target;
      expect(refs).toEqual(sketch.references);
    });
  }

  it('applies the migrations from an empty database to the tables of the criterion', async () => {
    const r = await db.admin.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
      [Object.keys(SKETCH)],
    );
    expect(r.rows.map((x) => x.relname).sort()).toEqual(Object.keys(SKETCH).sort());
  });
});
