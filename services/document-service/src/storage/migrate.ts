/**
 * Schema migrations: the plain SQL files in services/document-service/migrations, applied in name
 * order, once each, each in its own transaction, under an advisory lock so that two processes
 * never migrate at once. A file that changed after it was applied is refused. Migrations run as
 * the schema owner; the service connects as a member of docedit_app (BE-011).
 *
 * Expand and contract (06 §13; BE-016; ADR 0054). Every migration after the phase 1a baseline
 * (0001 to 0007) opens with a header of comment lines:
 *
 *   -- phase: expand            an addition the previous release can run against
 *   -- phase: contract          a removal or rename; it names the expand step it completes:
 *   -- contracts: 0041_job_priorities
 *   -- rollback: how to roll the release back, in a sentence or two
 *
 * The phase is recorded with the migration, so that a service of an older release (which does not
 * know the newer files) can tell from the database whether it may still run: it is ready when
 * every migration it knows is applied and every one it does not know is an expand step
 * (`compatibility`). A migration without a header counts as a contract step, which is the safe
 * reading. `releases.json` in the same folder lists the migrations of each release, for the
 * release notes and for the rule that a contract step ships at least one release after its expand
 * step (`planProblems`).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** The migrations of phase 1a, written before the header existed. */
export const BASELINE_LAST = '0007_readiness';

export type MigrationPhase = 'baseline' | 'expand' | 'contract';

export interface Migration {
  version: string;
  sql: string;
  checksum: string;
  phase: MigrationPhase;
  /** For a contract step: the expand step whose old shape it removes. */
  contracts: string | null;
  /** How to roll back the release that brought it, from the header; null when not written. */
  rollback: string | null;
  /** The first paragraph of the comment block after the header, for the release notes. */
  summary: string;
}

/** Reads the header and the summary from the opening comment block of a migration. */
export function parseHeader(
  version: string,
  sql: string,
): Pick<Migration, 'phase' | 'contracts' | 'rollback' | 'summary'> {
  const lines: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    if (!line.startsWith('--')) break;
    lines.push(line.replace(/^--\s?/, ''));
  }
  let phase: MigrationPhase | null = null;
  let contracts: string | null = null;
  let rollback: string | null = null;
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^(phase|contracts|rollback):\s*(.*)$/.exec(lines[i]!);
    if (!m) break;
    if (m[1] === 'phase' && (m[2] === 'expand' || m[2] === 'contract')) phase = m[2];
    else if (m[1] === 'contracts') contracts = m[2]!.trim() || null;
    else if (m[1] === 'rollback') {
      // The rollback note may run on over the following indented lines.
      const parts = [m[2]!.trim()];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      rollback = parts.join(' ') || null;
    }
  }
  const rest = lines.slice(i);
  while (rest.length && rest[0]!.trim() === '') rest.shift();
  const end = rest.findIndex((l) => l.trim() === '');
  const summary = (end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim()).join(' ');
  return {
    phase: version <= BASELINE_LAST ? 'baseline' : (phase ?? 'contract'),
    contracts,
    rollback,
    summary,
  };
}

export async function loadMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  return Promise.all(
    files.map(async (f) => {
      const sql = await readFile(join(dir, f), 'utf8');
      const version = f.slice(0, -4);
      return {
        version,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
        ...parseHeader(version, sql),
      };
    }),
  );
}

/** The schema version this code expects: the newest migration's name (BE-001 readiness). */
export async function expectedSchemaVersion(dir = MIGRATIONS_DIR): Promise<string> {
  const all = await loadMigrations(dir);
  const last = all[all.length - 1];
  if (!last) throw new Error(`no migrations in ${dir}`);
  return last.version;
}

/** The newest migration applied to the database, or null before the first. */
export async function schemaVersion(client: pg.ClientBase | pg.Pool): Promise<string | null> {
  const t = await client.query<{ t: string | null }>(
    "SELECT to_regclass('docedit_schema_migrations')::text AS t",
  );
  if (!t.rows[0]?.t) return null;
  const r = await client.query<{ version: string }>(
    'SELECT version FROM docedit_schema_migrations ORDER BY version DESC LIMIT 1',
  );
  return r.rows[0]?.version ?? null;
}

/** Every applied migration with its recorded phase (null for one applied before phases existed). */
export async function appliedMigrations(
  client: pg.ClientBase | pg.Pool,
): Promise<Array<{ version: string; phase: string | null }>> {
  const t = await client.query<{ t: string | null }>(
    "SELECT to_regclass('docedit_schema_migrations')::text AS t",
  );
  if (!t.rows[0]?.t) return [];
  const hasPhase = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'docedit_schema_migrations' AND column_name = 'phase'`,
  );
  const r = await client.query<{ version: string; phase: string | null }>(
    hasPhase.rowCount
      ? 'SELECT version, phase FROM docedit_schema_migrations ORDER BY version'
      : 'SELECT version, NULL::text AS phase FROM docedit_schema_migrations ORDER BY version',
  );
  return r.rows;
}

export interface Compatibility {
  /** Whether this code may serve against the schema. */
  ok: boolean;
  /** Migrations of the code that are not applied yet. */
  pending: string[];
  /** Applied migrations the code does not know (a newer release's), with their phases. */
  unknown: Array<{ version: string; phase: string | null }>;
}

/**
 * Whether code that knows `known` may run against a database with `applied`: every known
 * migration is applied, and every applied one it does not know is an expand step (BE-016
 * criterion 1; BE-006 criterion 4).
 */
export function compatibility(
  known: readonly string[],
  applied: ReadonlyArray<{ version: string; phase: string | null }>,
): Compatibility {
  const done = new Set(applied.map((a) => a.version));
  const knownSet = new Set(known);
  const pending = known.filter((v) => !done.has(v));
  const unknown = applied.filter((a) => !knownSet.has(a.version));
  return {
    ok: pending.length === 0 && unknown.every((u) => u.phase === 'expand'),
    pending,
    unknown,
  };
}

/** Applies the migrations not yet applied; returns their versions. */
export async function migrate(
  client: pg.ClientBase,
  dir = MIGRATIONS_DIR,
  opts: { only?: ReadonlySet<string> } = {},
): Promise<string[]> {
  const migrations = (await loadMigrations(dir)).filter(
    (m) => !opts.only || opts.only.has(m.version),
  );
  const applied: string[] = [];
  await client.query("SELECT pg_advisory_lock(hashtext('docedit.migrate'))");
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS docedit_schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    // The phase of each migration, so that an older release can judge the schema (BE-016).
    await client.query('ALTER TABLE docedit_schema_migrations ADD COLUMN IF NOT EXISTS phase text');
    const done = new Map(
      (
        await client.query<{ version: string; checksum: string }>(
          'SELECT version, checksum FROM docedit_schema_migrations',
        )
      ).rows.map((r) => [r.version, r.checksum]),
    );
    for (const m of migrations) {
      const prior = done.get(m.version);
      if (prior !== undefined) {
        if (prior !== m.checksum)
          throw new Error(`migration ${m.version} was changed after it was applied`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query(
          'INSERT INTO docedit_schema_migrations (version, checksum, phase) VALUES ($1, $2, $3)',
          [m.version, m.checksum, m.phase],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(
          `migration ${m.version} failed: ${e instanceof Error ? e.message : String(e)}`,
          {
            cause: e,
          },
        );
      }
      applied.push(m.version);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('docedit.migrate'))");
  }
  return applied;
}

/** A release and the migrations it shipped, from `releases.json` (BE-016 criteria 2, 5). */
export interface Release {
  version: string;
  migrations: string[];
  /**
   * Rollback notes for migrations whose file has no `-- rollback:` header and cannot get one,
   * because a file that changed after it was applied is refused (the baseline, 0001 to 0007).
   * The note in the file wins when both exist.
   */
  rollback?: Record<string, string>;
}

export async function loadReleases(dir = MIGRATIONS_DIR): Promise<Release[]> {
  const text = await readFile(join(dir, 'releases.json'), 'utf8');
  const parsed = JSON.parse(text) as { releases?: unknown };
  if (!Array.isArray(parsed.releases)) throw new Error('releases.json: an object with releases[]');
  return parsed.releases.map((r, i) => {
    const x = r as { version?: unknown; migrations?: unknown; rollback?: unknown };
    if (typeof x.version !== 'string' || !Array.isArray(x.migrations))
      throw new Error(`releases.json /releases/${i}: version and migrations[]`);
    const release: Release = { version: x.version, migrations: x.migrations.map(String) };
    if (x.rollback !== undefined) {
      if (typeof x.rollback !== 'object' || x.rollback === null || Array.isArray(x.rollback))
        throw new Error(`releases.json /releases/${i}/rollback: an object of notes by migration`);
      release.rollback = Object.fromEntries(
        Object.entries(x.rollback).map(([k, v]) => [k, String(v)]),
      );
    }
    return release;
  });
}

/**
 * Problems with the plan of migrations (BE-016 criterion 2): a contract step names an expand step
 * that exists, comes after it, and ships in a later release than the last one that uses the old
 * shape, which is the release of the expand step at the earliest. Migrations not yet in a release
 * belong to the next one.
 */
export function planProblems(
  migrations: readonly Migration[],
  releases: readonly Release[],
): string[] {
  const out: string[] = [];
  const releaseOf = new Map<string, number>();
  releases.forEach((r, i) => r.migrations.forEach((m) => releaseOf.set(m, i)));
  const next = releases.length;
  const byVersion = new Map(migrations.map((m) => [m.version, m]));
  for (const r of releases)
    for (const m of r.migrations)
      if (!byVersion.has(m)) out.push(`release ${r.version} lists ${m}, which is not a migration`);
  for (const m of migrations) {
    if (m.phase !== 'contract') continue;
    if (!m.contracts) {
      out.push(`${m.version} is a contract step but names no expand step (-- contracts:)`);
      continue;
    }
    const e = byVersion.get(m.contracts);
    if (!e || e.phase !== 'expand') {
      out.push(`${m.version} contracts ${m.contracts}, which is not an expand step`);
      continue;
    }
    const er = releaseOf.get(e.version) ?? next;
    const cr = releaseOf.get(m.version) ?? next;
    if (cr <= er)
      out.push(
        `${m.version} ships in the same release as ${e.version}; a contract step ships at least one release later`,
      );
  }
  return out;
}

/** The database steps of a release and how to roll it back, as Markdown (BE-016 criterion 5). */
export function releaseNotes(
  migrations: readonly Migration[],
  versions: readonly string[],
  notes: Readonly<Record<string, string>> = {},
): string {
  const chosen = migrations.filter((m) => versions.includes(m.version));
  if (chosen.length === 0) return 'No database steps.\n';
  const lines = ['| Migration | Phase | What it does | How to roll back |', '|---|---|---|---|'];
  for (const m of chosen)
    lines.push(
      `| \`${m.version}\` | ${m.phase}${m.contracts ? ` (completes \`${m.contracts}\`)` : ''} | ${m.summary.replace(/\|/g, '\\|')} | ${(m.rollback ?? notes[m.version] ?? 'not documented').replace(/\|/g, '\\|')} |`,
    );
  return `${lines.join('\n')}\n`;
}

/**
 * Creates docedit_app and the service's login role if they do not exist. The login role is a
 * member of docedit_app, not a superuser, and cannot bypass row-level security, create roles or
 * create databases (BE-011). Roles are cluster-wide, so callers that may race (parallel test
 * files) serialise on an advisory lock in one database first.
 */
export async function ensureServiceRole(
  admin: pg.ClientBase,
  name: string,
  password: string,
): Promise<void> {
  const role = admin.escapeIdentifier(name);
  const secret = admin.escapeLiteral(password);
  await admin.query(`DO $docedit$
    BEGIN
      BEGIN
        CREATE ROLE docedit_app NOLOGIN;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
      END;
      BEGIN
        CREATE ROLE ${role} LOGIN PASSWORD ${secret}
          NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
      END;
      IF NOT pg_has_role(${admin.escapeLiteral(name)}, 'docedit_app', 'MEMBER') THEN
        GRANT docedit_app TO ${role};
      END IF;
    END $docedit$`);
}
