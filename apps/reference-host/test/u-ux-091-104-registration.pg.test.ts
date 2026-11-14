// UX-091 criterion 3 against PostgreSQL (lane U-UX-091-104). The stack's document service applies
// the tenant registration file with `parseSeed` and `applySeed` at start (BE-012). This file runs
// the same two calls on a PgTenantRegistry, in a database of its own that carries the lane tag, and
// reads the seeded tenant back through the service role. The database is dropped afterwards.
// The file skips, with the reason, when PostgreSQL is not up:
//   pwsh -NoProfile -File infra/test-env.ps1 up
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applySeed,
  createPool,
  ensureServiceRole,
  hashSecret,
  migrate,
  parseSeed,
  PgTenantRegistry,
} from '@docedit/document-service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  ensureSecrets,
  HOST_ISSUER,
  seedTenant,
  tenantRegistration,
  type Secrets,
  type Settings,
} from '../scripts/lib/stack.ts';

const CONTAINERS = resolve(fileURLToPath(new URL('../../../infra/containers/', import.meta.url)));

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

const S: Record<string, string> = {
  ...readEnvFile(join(CONTAINERS, '.env.example')),
  ...readEnvFile(join(CONTAINERS, '.env')),
};
for (const k of Object.keys(S)) {
  const v = process.env[k];
  if (v) S[k] = v;
}

const ADMIN = {
  host: S['DOCEDIT_PG_HOST'] ?? '127.0.0.1',
  port: Number(S['DOCEDIT_PG_PORT'] ?? '55432'),
  user: S['DOCEDIT_PG_ADMIN_USER'] ?? 'postgres',
  password: S['DOCEDIT_PG_ADMIN_PASSWORD'] ?? '',
  connectionTimeoutMillis: 3000,
};
const SERVICE_USER = S['DOCEDIT_PG_SERVICE_USER'] ?? 'docedit_service';
const SERVICE_PASSWORD = S['DOCEDIT_PG_SERVICE_PASSWORD'] ?? '';

const SETTINGS: Settings = { DOCEDIT_DEMO_HOST_PORT: '56490' };
const DB = `docedit_u_ux_091_104_${randomBytes(4).toString('hex')}`;

type Pool = ReturnType<typeof createPool>;
let admin: Pool | undefined;
let root: Pool | undefined;
let service: Pool | undefined;
let skipReason: string | null = null;
let dir = '';
let secrets: Secrets;
let tenantId = '';
let fileText = '';

beforeAll(async () => {
  try {
    root = createPool({ ...ADMIN, database: 'postgres', max: 1 });
    const v = await root.query<{ v: string }>("SELECT current_setting('server_version_num') AS v");
    if (Number(v.rows[0]?.v ?? 0) < 160000) {
      skipReason = 'PostgreSQL is older than 16';
      return;
    }
  } catch (e) {
    skipReason = `PostgreSQL is not reachable (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
    return;
  }

  const c = await root.connect();
  try {
    await ensureServiceRole(c, SERVICE_USER, SERVICE_PASSWORD);
    await c.query(`CREATE DATABASE ${DB}`);
  } finally {
    c.release();
  }
  admin = createPool({ ...ADMIN, database: DB, max: 2 });
  const a = await admin.connect();
  try {
    await migrate(a);
  } finally {
    a.release();
  }
  service = createPool({
    host: ADMIN.host,
    port: ADMIN.port,
    user: SERVICE_USER,
    password: SERVICE_PASSWORD,
    database: DB,
    max: 4,
  });

  const tenant = seedTenant();
  tenantId = tenant.id;
  dir = await mkdtemp(join(tmpdir(), 'docedit-u-ux-091-104-'));
  secrets = await ensureSecrets(tenant.id, dir);
  fileText = `${JSON.stringify(tenantRegistration(tenant, secrets, allowedOrigins(SETTINGS)), null, 2)}\n`;
});

afterAll(async () => {
  await service?.end().catch(() => {});
  await admin?.end().catch(() => {});
  if (root && skipReason === null) {
    const c = await root.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    } finally {
      c.release();
    }
  }
  await root?.end().catch(() => {});
  if (dir) await rm(dir, { recursive: true, force: true });
});

const run = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (skipReason !== null) {
      console.warn(`skipped: ${skipReason}`);
      return;
    }
    await fn();
  });

describe('the tenant registration applied to PostgreSQL (UX-091 criterion 3; BE-005 criterion 2)', () => {
  run('seeds the tenant, its host key, its origins and its API key into the database', async () => {
    const registry = new PgTenantRegistry(service!);
    const skipped = await applySeed(registry, parseSeed(JSON.parse(fileText)));
    expect(skipped).toEqual([]);

    expect(await registry.exists(tenantId)).toBe(true);
    const keys = await registry.keys(tenantId, 'user');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      kid: secrets.hostSigning.kid,
      use: 'user',
      alg: 'ES256',
      issuer: HOST_ISSUER,
    });
    expect(keys[0]!.thumbprint).toMatch(/\S/);

    expect(await registry.origins(tenantId)).toEqual(allowedOrigins(SETTINGS));
    expect(await registry.originRegistered('http://localhost:56490')).toBe(true);
    expect(await registry.originRegistered('http://127.0.0.1:56490')).toBe(true);
    expect(await registry.originRegistered('http://evil.example')).toBe(false);

    const stored = await registry.apiKey(tenantId, secrets.apiKey.id);
    expect(stored).not.toBeNull();
    expect(stored!.secretHash.equals(hashSecret(secrets.apiKey.secret))).toBe(true);
  });

  run('applying the same file again changes nothing (setup.ts can be repeated)', async () => {
    const registry = new PgTenantRegistry(service!);
    await applySeed(registry, parseSeed(JSON.parse(fileText)));
    expect(await registry.keys(tenantId, 'user')).toHaveLength(1);
    expect(await registry.origins(tenantId)).toEqual(allowedOrigins(SETTINGS));
  });

  run('the file holds the API key as a hash only', async () => {
    expect(fileText).not.toContain(secrets.apiKey.secret);
  });
});
