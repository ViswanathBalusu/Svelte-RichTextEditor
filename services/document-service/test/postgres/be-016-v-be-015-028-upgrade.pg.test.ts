// BE-016 criterion 3 (lane V-BE-015-028): migrations run from an empty database and from the
// previous release's schema both end with the same schema. "Previous release" is the baseline the
// releases list (migrations/releases.json) names for 0.1.0-phase1a: migrations 0001 to 0007, applied
// with the migrator's `only` option, then every migration of the repository. Runs against PostgreSQL
// in Podman; skips when it is not up. Database names carry the lane tag and are dropped afterwards.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureServiceRole } from '../../src/index.ts';
import { loadMigrations, loadReleases, migrate } from '../../src/storage/migrate.ts';
import { ADMIN, postgresUnavailable, settings } from '../support/env.ts';

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

const created: string[] = [];

async function newDatabase(tag: string): Promise<{ name: string; pool: pg.Pool }> {
  const name = `docedit_v_be_015_028_${tag}_${randomBytes(4).toString('hex')}`;
  const root = new pg.Client(ADMIN);
  await root.connect();
  try {
    const s = settings();
    await root.query("SELECT pg_advisory_lock(hashtext('docedit.test-roles'))");
    try {
      await ensureServiceRole(
        root,
        s['DOCEDIT_PG_SERVICE_USER']!,
        s['DOCEDIT_PG_SERVICE_PASSWORD']!,
      );
    } finally {
      await root.query("SELECT pg_advisory_unlock(hashtext('docedit.test-roles'))");
    }
    await root.query(`CREATE DATABASE ${name}`);
  } finally {
    await root.end();
  }
  created.push(name);
  const pool = new pg.Pool({ ...ADMIN, database: name, max: 2 });
  pool.on('error', () => {});
  return { name, pool };
}

/** A description of the schema that ignores the migration log's own timestamps. */
async function describeSchema(pool: pg.Pool): Promise<Record<string, string[]>> {
  const queries: Record<string, string> = {
    tables: `SELECT c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relrowsecurity::text, '') || ' ' || c.relforcerowsecurity::text AS line
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','i') AND c.relname <> 'docedit_schema_migrations'`,
    columns: `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') || ' ' || ordinal_position AS line
              FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'docedit_schema_migrations'`,
    constraints: `SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS line
                  FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    indexes: `SELECT indexdef AS line FROM pg_indexes WHERE schemaname = 'public'`,
    policies: `SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS line
               FROM pg_policies WHERE schemaname = 'public'`,
    functions: `SELECT p.proname || ' ' || md5(p.prosrc) AS line FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`,
    triggers: `SELECT tgrelid::regclass::text || ' ' || tgname AS line FROM pg_trigger WHERE NOT tgisinternal`,
    partitions: `SELECT inhrelid::regclass::text || ' of ' || inhparent::regclass::text || ' ' || pg_get_expr(c.relpartbound, c.oid) AS line
                 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid`,
  };
  const out: Record<string, string[]> = {};
  for (const [key, sql] of Object.entries(queries)) {
    const r = await pool.query<{ line: string }>(sql);
    out[key] = r.rows.map((row) => row.line).sort();
  }
  return out;
}

async function migrateAll(pool: pg.Pool, only?: ReadonlySet<string>): Promise<string[]> {
  const c = await pool.connect();
  try {
    return await migrate(c, undefined, only ? { only } : {});
  } finally {
    c.release();
  }
}

describe.skipIf(unavailable !== null)(
  'migrations from an empty database and from the previous release (PostgreSQL)',
  () => {
    afterAll(async () => {
      const r = new pg.Client(ADMIN);
      await r.connect();
      try {
        for (const name of created) await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await r.end();
      }
    });

    it('ends with the same schema whether it starts empty or from the 0.1.0-phase1a schema', async () => {
      const releases = await loadReleases();
      const previous = releases.find((r) => r.version === '0.1.0-phase1a');
      expect(previous, 'the release list names 0.1.0-phase1a').toBeDefined();
      const previousSet = new Set(previous!.migrations);
      const all = await loadMigrations();
      expect(all.length).toBeGreaterThan(previousSet.size);

      const fresh = await newDatabase('fresh');
      const upgraded = await newDatabase('upgraded');
      try {
        await migrateAll(fresh.pool);
        const fromPrevious = await migrateAll(upgraded.pool, previousSet);
        expect(fromPrevious.sort()).toEqual([...previousSet].sort());
        await migrateAll(upgraded.pool);

        const a = await describeSchema(fresh.pool);
        const b = await describeSchema(upgraded.pool);
        for (const key of Object.keys(a)) {
          expect(b[key], `schema section ${key}`).toEqual(a[key]);
        }
        expect(a['tables']!.length).toBeGreaterThan(0);

        const versions = async (pool: pg.Pool) =>
          (
            await pool.query<{ version: string }>(
              'SELECT version FROM docedit_schema_migrations ORDER BY version',
            )
          ).rows.map((r) => r.version);
        expect(await versions(upgraded.pool)).toEqual(await versions(fresh.pool));
        expect(await versions(fresh.pool)).toEqual(all.map((m) => m.version).sort());
      } finally {
        await fresh.pool.end().catch(() => {});
        await upgraded.pool.end().catch(() => {});
      }
    }, 240_000);
  },
);
