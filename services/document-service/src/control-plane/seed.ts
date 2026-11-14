/**
 * Seeding tenant registrations from configuration (BE-012 criterion 1: "configuration or command
 * line in phase 1a"). A seed file names tenants with their key sets, API keys (as SHA-256 hashes of
 * their secrets; a seed never holds a secret) and allowed origins. Applying a seed is idempotent.
 */
import { isAlgorithm } from './jwt.ts';
import { KeyRegistrationError, type KeyUse, type TenantRegistry } from './tenants.ts';

export interface TenantSeed {
  id: string;
  name: string;
  keys?: Array<{ kid: string; use: KeyUse; alg: string; jwk: unknown; issuer?: string }>;
  apiKeys?: Array<{ id: string; secretSha256: string; label?: string; expiresAt?: string }>;
  origins?: string[];
}

export interface SeedFile {
  tenants: TenantSeed[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the shape of a seed file; throws with the JSON Pointer of the first problem. */
export function parseSeed(value: unknown): SeedFile {
  const fail = (path: string, rule: string) => {
    throw new Error(`seed ${path}: ${rule}`);
  };
  if (!isObject(value) || !Array.isArray(value['tenants'])) fail('', 'an object with tenants[]');
  const tenants = (value as { tenants: unknown[] }).tenants;
  tenants.forEach((t, i) => {
    if (!isObject(t)) return fail(`/tenants/${i}`, 'an object');
    if (typeof t['id'] !== 'string') fail(`/tenants/${i}/id`, 'a tenant UUID');
    if (typeof t['name'] !== 'string') fail(`/tenants/${i}/name`, 'a name');
    for (const [j, k] of ((t['keys'] as unknown[]) ?? []).entries()) {
      if (!isObject(k) || typeof k['kid'] !== 'string' || !isAlgorithm(k['alg']))
        fail(`/tenants/${i}/keys/${j}`, 'kid, alg (ES256, EdDSA or RS256) and jwk');
      if (
        (k as Record<string, unknown>)['use'] !== 'user' &&
        (k as Record<string, unknown>)['use'] !== 'service'
      )
        fail(`/tenants/${i}/keys/${j}/use`, 'user or service');
    }
    for (const [j, k] of ((t['apiKeys'] as unknown[]) ?? []).entries())
      if (
        !isObject(k) ||
        typeof k['id'] !== 'string' ||
        typeof k['secretSha256'] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(k['secretSha256'])
      )
        fail(`/tenants/${i}/apiKeys/${j}`, 'id and secretSha256 (lower-case hexadecimal)');
  });
  return value as unknown as SeedFile;
}

/** An entry of a seed that was not applied: where it is and why (identifiers and rules only). */
export interface SkippedEntry {
  path: string;
  reason: string;
}

/**
 * Applies a seed. An entry the registry refuses (a malformed key, an origin that is not one) is
 * skipped and reported, so that one bad entry of a tenants file does not stop the service (ADR
 * 0054); a tenant that cannot be stored skips its whole entry.
 */
export async function applySeed(registry: TenantRegistry, seed: SeedFile): Promise<SkippedEntry[]> {
  const skipped: SkippedEntry[] = [];
  const attempt = async (path: string, fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      if (!(e instanceof KeyRegistrationError) && !(e instanceof TypeError)) throw e;
      skipped.push({ path, reason: e.message });
      return false;
    }
  };
  for (const [i, t] of seed.tenants.entries()) {
    const at = `/tenants/${i}`;
    if (!(await attempt(at, () => registry.putTenant(t.id, t.name)))) continue;
    for (const [j, k] of (t.keys ?? []).entries())
      await attempt(`${at}/keys/${j}`, () =>
        registry.addKey(t.id, {
          kid: k.kid,
          use: k.use,
          alg: k.alg as never,
          jwk: k.jwk,
          ...(k.issuer !== undefined ? { issuer: k.issuer } : {}),
        }),
      );
    for (const [j, k] of (t.apiKeys ?? []).entries()) {
      if (await registry.apiKey(t.id, k.id).catch(() => null)) continue;
      await attempt(`${at}/apiKeys/${j}`, () =>
        registry.addApiKey(t.id, {
          id: k.id,
          secretHash: Buffer.from(k.secretSha256, 'hex'),
          ...(k.label !== undefined ? { label: k.label } : {}),
          expiresAt: k.expiresAt === undefined ? null : Date.parse(k.expiresAt),
        }),
      );
    }
    for (const [j, o] of (t.origins ?? []).entries())
      await attempt(`${at}/origins/${j}`, () => registry.addOrigin(t.id, o));
  }
  return skipped;
}
