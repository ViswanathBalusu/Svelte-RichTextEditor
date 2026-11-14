// The tenant registration that scripts/setup.ts writes (UX-091 criterion 3; BE-005 criterion 2). The
// stack's service applies the file at start with `parseSeed` and `applySeed` (server.ts, BE-012).
// These tests run the same two calls on an in-memory registry, so the seeded keys, API key and
// origins are checked as the service reads them. The containers and PostgreSQL are not started here.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySeed, hashSecret, MemoryTenantRegistry, parseSeed } from '@docedit/document-service';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowedOrigins,
  ensureSecrets,
  HOST_ISSUER,
  seedTenant,
  tenantRegistration,
  type Secrets,
  type Settings,
} from '../scripts/lib/stack.ts';

const SETTINGS: Settings = { DOCEDIT_DEMO_HOST_PORT: '56490' };
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function secretsAndRegistration(): Promise<{
  secrets: Secrets;
  file: string;
  tenant: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'docedit-registration-test-'));
  dirs.push(dir);
  const tenant = seedTenant();
  const secrets = await ensureSecrets(tenant.id, dir);
  const registration = tenantRegistration(tenant, secrets, allowedOrigins(SETTINGS));
  // The text as setup.ts writes it to tenants.json.
  return { secrets, file: `${JSON.stringify(registration, null, 2)}\n`, tenant: tenant.id };
}

describe('the tenant registration file (UX-091 criterion 3; BE-005 criterion 2)', () => {
  it('seeds the tenant, its host key and its allowed origins into the service registry', async () => {
    const { secrets, file, tenant } = await secretsAndRegistration();
    const registry = new MemoryTenantRegistry();
    const skipped = await applySeed(registry, parseSeed(JSON.parse(file)));
    expect(skipped).toEqual([]);

    expect(await registry.exists(tenant)).toBe(true);
    const keys = await registry.keys(tenant, 'user');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      kid: secrets.hostSigning.kid,
      use: 'user',
      alg: 'ES256',
      issuer: HOST_ISSUER,
    });
    expect(keys[0]!.thumbprint).toMatch(/\S/);

    expect(await registry.origins(tenant)).toEqual(allowedOrigins(SETTINGS));
    expect(await registry.originRegistered('http://localhost:56490')).toBe(true);
    expect(await registry.originRegistered('http://127.0.0.1:56490')).toBe(true);
    expect(await registry.originRegistered('http://evil.example')).toBe(false);
  });

  it('stores the host API key as the hash of its secret, and the secret itself nowhere', async () => {
    const { secrets, file, tenant } = await secretsAndRegistration();
    const registry = new MemoryTenantRegistry();
    await applySeed(registry, parseSeed(JSON.parse(file)));

    const stored = await registry.apiKey(tenant, secrets.apiKey.id);
    expect(stored).not.toBeNull();
    expect(stored!.secretHash.equals(hashSecret(secrets.apiKey.secret))).toBe(true);
    expect(stored!.expiresAt).toBeNull();
    // The file holds a hash only: neither the secret nor the host's private key appears in it.
    expect(file).not.toContain(secrets.apiKey.secret);
    expect(file).not.toContain(secrets.apiKey.credential);
    expect(secrets.hostSigning.d).toBeDefined();
    expect(file).not.toContain(secrets.hostSigning.d!);
  });

  it('registers the host public key without its private part', async () => {
    const { secrets, file, tenant } = await secretsAndRegistration();
    const registry = new MemoryTenantRegistry();
    await applySeed(registry, parseSeed(JSON.parse(file)));
    const [key] = await registry.keys(tenant, 'user');
    expect(key!.jwk).not.toHaveProperty('d');
    expect(key!.jwk).toMatchObject({ kty: 'EC', crv: 'P-256', x: secrets.hostPublic.x });
  });

  it('applies again without changing the registry (a restart re-reads the same file)', async () => {
    const { file, tenant } = await secretsAndRegistration();
    const registry = new MemoryTenantRegistry();
    const seed = parseSeed(JSON.parse(file));
    await applySeed(registry, seed);
    const skipped = await applySeed(registry, seed);
    expect(skipped).toEqual([]);
    expect(await registry.origins(tenant)).toHaveLength(2);
    expect(await registry.keys(tenant, 'user')).toHaveLength(1);
  });

  it('refuses a registration whose API key hash is not hexadecimal SHA-256', async () => {
    const { file } = await secretsAndRegistration();
    const broken = JSON.parse(file) as {
      tenants: Array<{ apiKeys: Array<{ secretSha256: string }> }>;
    };
    broken.tenants[0]!.apiKeys[0]!.secretSha256 = 'not-a-hash';
    expect(() => parseSeed(broken)).toThrow(/secretSha256/);
  });
});
