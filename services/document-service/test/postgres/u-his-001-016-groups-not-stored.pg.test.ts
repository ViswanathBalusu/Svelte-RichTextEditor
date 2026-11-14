// U-HIS-001-016 lane. HIS-007 criterion 7 (08 §4): "Automatic versions are not stored. The history
// list groups commits when it is read." Two things are checked against a real PostgreSQL database
// of the test's own (created by the test support, migrated, and dropped afterwards):
//
// 1. The schema cannot hold a group as a version. No table or column in the migrated schema is
//    named for a group, the `versions` table has exactly the columns of a pointer to a seq with a
//    kind, and a group's kind is refused both by PgVersionStore and by the table's check constraint.
// 2. Reading the history list writes nothing. The read is the one the list will make (the log from
//    seq 1, the stored versions, then `groupCommits` from @docedit/history at read time). Every
//    table's row count and content digest is taken before and after; they must be equal. A control
//    then stores one version and shows that the same snapshot does see a stored row, so the
//    comparison can fail.
//
// The HTTP route `GET /documents/{id}/history` is not built (HIS-026, HIS-008); when it is, its test
// should take the same snapshot around the route.
import type { StoredCommit } from '@docedit/authority';
// document-service has no @docedit/history dependency (a package.json change for the main session),
// so the package is imported by its source path, as the HIS-017 test imports authority's fixtures.
import {
  groupCommits,
  type CommitMeta,
  type HistoryGroup,
  type StoredVersion,
} from '../../../../packages/history/src/index.ts';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DocRef, PgLogStore } from '../../src/index.ts';
import { PgVersionStore, type StoredVersionRow } from '../../src/storage/versions-store.ts';
import { newDocument, stepCommit, write, type StoreHarness } from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const MINUTE = 60_000;

/** A row of the store as the history package types it; no cast, so a type drift fails the build. */
function toHistoryVersion(v: StoredVersionRow): StoredVersion {
  const out: StoredVersion = {
    seq: v.seq,
    kind: v.kind,
    createdBy: v.createdBy,
    createdAt: v.createdAt,
  };
  if (v.name !== undefined) out.name = v.name;
  if (v.note !== undefined) out.note = v.note;
  return out;
}

function toCommitMeta(c: StoredCommit): CommitMeta {
  const out: CommitMeta = {
    seq: c.seq,
    kind: c.kind,
    user: c.user,
    session: c.session,
    time: c.time,
    origin: c.origin,
    scopes: c.scopes,
  };
  if (c.agent !== undefined) out.agent = c.agent;
  return out;
}

type Snapshot = Map<string, { rows: number; digest: string }>;

const quoteIdent = (s: string) => `"${s.replaceAll('"', '""')}"`;

/**
 * Every ordinary table of the database (leaf partitions included, partitioned parents left out so a
 * row is counted once), with its row count and an MD5 of its rows as text in a fixed order. Taken by
 * the admin role, which owns the schema and is not held back by row-level security.
 */
async function snapshot(admin: TestDatabase['admin']): Promise<Snapshot> {
  const tables = await admin.query<{ schema: string; name: string }>(
    `select n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r'
        and n.nspname not in ('pg_catalog', 'information_schema')
        and n.nspname not like 'pg_toast%'
      order by 1, 2`,
  );
  const out: Snapshot = new Map();
  for (const t of tables.rows) {
    const q = `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
    const r = await admin.query<{ rows: number; digest: string }>(
      `select count(*)::int as rows,
              md5(coalesce(string_agg(x::text, E'\\n' order by x::text), '')) as digest
         from ${q} x`,
    );
    out.set(`${t.schema}.${t.name}`, r.rows[0]!);
  }
  return out;
}

const changedTables = (a: Snapshot, b: Snapshot): string[] =>
  [...new Set([...a.keys(), ...b.keys()])]
    .filter((k) => JSON.stringify(a.get(k)) !== JSON.stringify(b.get(k)))
    .sort();

describe.skipIf(unavailable !== null)(
  'U-HIS-001-016: history groups are not stored (HIS-007 criterion 7)',
  () => {
    let db: TestDatabase;
    let h: StoreHarness;
    beforeAll(async () => {
      db = await createTestDatabase();
      const s = pgStores(db.service);
      h = {
        tenant: newTenant(),
        otherTenant: newTenant(),
        docs: s.docs,
        logs: s.logs,
        grants: s.grants,
      };
    });
    afterAll(() => db?.drop());

    /** A document with six commits by two authors, idle gaps of ten minutes, and one named version. */
    async function seeded(): Promise<{ ref: DocRef; logs: PgLogStore; versions: PgVersionStore }> {
      const { ref, epoch } = await newDocument(h);
      const logs = h.logs as PgLogStore;
      const versions = new PgVersionStore(db.service);
      const offsets = [0, MINUTE, 2 * MINUTE, 12 * MINUTE, 13 * MINUTE, 25 * MINUTE];
      const authors = [
        'surrogate-alice',
        'surrogate-alice',
        'surrogate-bob',
        'surrogate-bob',
        'surrogate-bob',
        'surrogate-alice',
      ];
      const commits: StoredCommit[] = offsets.map((offset, i) =>
        stepCommit(i + 1, {
          id: uuid7(),
          user: authors[i]!,
          session: `s-${authors[i]}`,
          time: T0 + offset,
        }),
      );
      expect(await logs.append(ref, write(epoch, commits))).toEqual({ status: 'ok' });
      const named = await versions.create(ref, {
        seq: 3,
        kind: 'named',
        name: 'Draft',
        note: '',
        createdBy: 'surrogate-alice',
        createdAt: T0 + 3 * MINUTE,
      });
      expect(named.ok).toBe(true);
      return { ref, logs, versions };
    }

    /** The history list's read: the log, the stored versions, and the groups computed from them. */
    async function readHistoryList(
      ref: DocRef,
      logs: PgLogStore,
      versions: PgVersionStore,
    ): Promise<{ groups: HistoryGroup[]; stored: StoredVersion[] }> {
      const commits = (await logs.read(ref, 1))
        .filter((c): c is StoredCommit => c.kind !== 'snapshot')
        .map(toCommitMeta);
      const stored = (await versions.list(ref)).map(toHistoryVersion);
      return { groups: groupCommits(commits, stored), stored };
    }

    it('the schema has no table or column for a group, and versions are pointers to a seq with a kind', async () => {
      const tables = await db.admin.query<{ name: string }>(
        `select table_schema || '.' || table_name as name from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema') and table_name ilike '%group%'`,
      );
      expect(tables.rows).toEqual([]);
      const columns = await db.admin.query<{ name: string }>(
        `select table_name || '.' || column_name as name from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema') and column_name ilike '%group%'`,
      );
      expect(columns.rows).toEqual([]);

      const versionColumns = await db.admin.query<{ column_name: string }>(
        `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'versions' order by column_name`,
      );
      expect(versionColumns.rows.map((r) => r.column_name)).toEqual([
        'created_at',
        'created_by',
        'doc_id',
        'kind',
        'name',
        'note',
        'seq',
        'tenant_id',
      ]);
    });

    it('a group cannot be stored as a version, through the store or by SQL', async () => {
      const { ref, versions } = await seeded();
      for (const kind of ['group', 'auto', 'session']) {
        const r = await versions.create(ref, {
          seq: 2,
          kind,
          createdBy: 'surrogate-alice',
          createdAt: T0,
        });
        expect(r).toMatchObject({ ok: false, code: 'validation_failed' });
      }
      // Below the store: the table's own check constraint refuses the kind (SQLSTATE 23514).
      const err = await db.admin
        .query(
          `insert into versions (doc_id, tenant_id, seq, kind, created_by, created_at)
         values ($1, $2, 2, 'group', 'surrogate-alice', now())`,
          [ref.doc, ref.tenant],
        )
        .then(
          () => null,
          (e: unknown) => e as { code?: string },
        );
      expect(err?.code).toBe('23514');
      expect((await versions.list(ref)).map((v) => [v.seq, v.kind])).toEqual([[3, 'named']]);
    });

    it('listing and grouping the history writes nothing to any table', async () => {
      const { ref, logs, versions } = await seeded();

      const before = await snapshot(db.admin);
      // The snapshot sees the seeded rows; the admin role is not hidden from them by row-level security.
      expect(before.get('public.versions')?.rows).toBeGreaterThanOrEqual(1);
      expect([...before.values()].reduce((n, t) => n + t.rows, 0)).toBeGreaterThan(6);

      const first = await readHistoryList(ref, logs, versions);
      const second = await readHistoryList(ref, logs, versions);
      // The groups exist only in the result: several of them, the version at seq 3 ending one.
      expect(first.groups.length).toBeGreaterThan(1);
      expect(
        first.groups.some((g) => g.versions.some((v) => v.seq === 3 && v.kind === 'named')),
      ).toBe(true);
      expect(second).toEqual(first);
      expect(first.stored.map((v) => [v.seq, v.kind])).toEqual([[3, 'named']]);

      const after = await snapshot(db.admin);
      expect(changedTables(before, after)).toEqual([]);

      // Control: storing one version is seen by the same snapshot, in `versions` and nowhere else.
      expect(
        (
          await versions.create(ref, {
            seq: 5,
            kind: 'export',
            createdBy: 'surrogate-bob',
            createdAt: T0,
          })
        ).ok,
      ).toBe(true);
      const control = await snapshot(db.admin);
      expect(changedTables(after, control)).toEqual(['public.versions']);
      expect(control.get('public.versions')!.rows).toBe(after.get('public.versions')!.rows + 1);
    });
  },
);
