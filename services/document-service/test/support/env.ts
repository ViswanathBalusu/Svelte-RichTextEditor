/**
 * The integration-test environment as the tests see it (FND-010). Settings come from
 * infra/containers/.env.example, then infra/containers/.env, then the process environment, which
 * is what infra/test-env.ps1 uses too. Tests that need PostgreSQL call `postgresUnavailable()` and
 * skip, with the reason, when it is not up. Each test file gets a database of its own, migrated
 * by the admin role, which the service role then uses.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createPool,
  ensureServiceRole,
  migrate,
  PgDocumentStore,
  PgGrantStore,
  PgLogStore,
} from '../../src/index.ts';

const CONTAINERS = fileURLToPath(new URL('../../../../infra/containers/', import.meta.url));

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

export function settings(): Record<string, string> {
  const s = { ...readEnvFile(CONTAINERS + '.env.example'), ...readEnvFile(CONTAINERS + '.env') };
  for (const k of Object.keys(s)) {
    const v = process.env[k];
    if (v) s[k] = v;
  }
  return s;
}

const S = settings();
const need = (k: string) => {
  const v = S[k];
  if (!v) throw new Error(`${k} is not set (infra/containers/.env.example)`);
  return v;
};

export const ADMIN: pg.ClientConfig = {
  host: need('DOCEDIT_PG_HOST'),
  port: Number(need('DOCEDIT_PG_PORT')),
  user: need('DOCEDIT_PG_ADMIN_USER'),
  password: need('DOCEDIT_PG_ADMIN_PASSWORD'),
  database: 'postgres',
  connectionTimeoutMillis: 3000,
};

export const SERVICE_USER = need('DOCEDIT_PG_SERVICE_USER');
const SERVICE_PASSWORD = need('DOCEDIT_PG_SERVICE_PASSWORD');

let probed: Promise<string | null> | undefined;

/** Null when PostgreSQL answers; otherwise why the integration tests skip. */
export function postgresUnavailable(): Promise<string | null> {
  probed ??= (async () => {
    const c = new pg.Client({ ...ADMIN, connectionTimeoutMillis: 1500 });
    try {
      await c.connect();
      const r = await c.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
      const v = Number(r.rows[0]?.v ?? 0);
      if (v < 160000) return `PostgreSQL ${v} is older than 16`;
      return null;
    } catch (e) {
      return `PostgreSQL is not reachable at ${ADMIN.host}:${ADMIN.port} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
    } finally {
      await c.end().catch(() => {});
    }
  })();
  return probed;
}

export interface TestDatabase {
  name: string;
  /** The schema owner: migrations, and tests that inspect or tamper with storage. */
  admin: pg.Pool;
  /** The document service's role: no superuser, no BYPASSRLS. */
  service: pg.Pool;
  serviceConfig: pg.PoolConfig;
  drop(): Promise<void>;
}

/** A new database, migrated, with the service role able to use it. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `docedit_t_${randomBytes(6).toString('hex')}`;
  const root = new pg.Client(ADMIN);
  await root.connect();
  try {
    // Roles are cluster-wide and test files run in parallel: serialise on one database's lock.
    await root.query("SELECT pg_advisory_lock(hashtext('docedit.test-roles'))");
    try {
      await ensureServiceRole(root, SERVICE_USER, SERVICE_PASSWORD);
    } finally {
      await root.query("SELECT pg_advisory_unlock(hashtext('docedit.test-roles'))");
    }
    await root.query(`CREATE DATABASE ${name}`);
  } finally {
    await root.end();
  }
  const admin = new pg.Pool({ ...ADMIN, database: name, max: 4 });
  admin.on('error', () => {});
  const c = await admin.connect();
  try {
    await migrate(c);
  } finally {
    c.release();
  }
  const serviceConfig: pg.PoolConfig = {
    host: ADMIN.host,
    port: ADMIN.port,
    user: SERVICE_USER,
    password: SERVICE_PASSWORD,
    database: name,
    max: 12,
  };
  const service = createPool(serviceConfig);
  return {
    name,
    admin,
    service,
    serviceConfig,
    async drop() {
      await service.end().catch(() => {});
      await admin.end().catch(() => {});
      const r = new pg.Client(ADMIN);
      await r.connect();
      try {
        await r.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await r.end();
      }
    },
  };
}

/** The PostgreSQL stores over the service role's pool. */
export function pgStores(pool: pg.Pool) {
  const grants = new PgGrantStore(pool);
  const logs = new PgLogStore(pool, { permissions: (ref) => grants.current(ref) });
  const docs = new PgDocumentStore(pool);
  return { grants, logs, docs };
}

export function newTenant(): string {
  return randomUUID();
}

/**
 * The Podman machine for the asset worker's sandbox (DOCEDIT_PODMAN_MACHINE), as an environment
 * fragment. The setting wins; otherwise the default machine name on Windows and macOS, where Podman runs in
 * a machine whose cgroup manager cannot apply the sandbox's limits (services/asset-worker/src/container.ts).
 * Elsewhere (Linux, hosted CI) there is none: a name would send every sandbox call through
 * `podman machine ssh`, which fails where no machine exists.
 */
export function machineEnv(s: Record<string, string>): Record<string, string> {
  const name =
    s['DOCEDIT_PODMAN_MACHINE'] ?? (process.platform !== 'linux' ? 'podman-machine-default' : '');
  return name ? { DOCEDIT_PODMAN_MACHINE: name } : {};
}
