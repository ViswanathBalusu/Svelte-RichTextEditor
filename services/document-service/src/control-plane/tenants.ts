/**
 * Tenant registrations (BE-012; 05 §3.1, §3.2; 10 §3.2, §3.7): the keys that verify user tokens,
 * the separate keys and API keys of service credentials, and the allowed origins. Every read goes
 * to storage, so an operator's change applies to the next connection or request without a restart.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { assertUuid, inTenant, millis, type Pool, type PoolClient } from '../storage/db.ts';
import {
  type Algorithm,
  type PublicJwk,
  canonicalJwk,
  importPublicJwk,
  thumbprint,
} from './jwt.ts';

/** A key set: `user` keys verify user tokens, `service` keys verify `dep-svc+jwt` (05 §3.2). */
export type KeyUse = 'user' | 'service';

export interface TenantKey {
  kid: string;
  use: KeyUse;
  alg: Algorithm;
  jwk: PublicJwk;
  thumbprint: string;
  /** The `iss` tokens verified by this key must carry, when set. */
  issuer: string | null;
}

export interface ApiKeyRecord {
  id: string;
  /** SHA-256 of the secret. */
  secretHash: Buffer;
  label: string | null;
  createdAt: number;
  /** After this time the key no longer authenticates (the end of a rotation overlap), or null. */
  expiresAt: number | null;
}

export interface NewKey {
  kid: string;
  use: KeyUse;
  alg: Algorithm;
  jwk: unknown;
  issuer?: string;
}

/** The registration refused a key: it is malformed, or registered for the other use (BE-012). */
export class KeyRegistrationError extends Error {
  override name = 'KeyRegistrationError';
}

export interface TenantRegistry {
  exists(tenant: string): Promise<boolean>;
  keys(tenant: string, use: KeyUse): Promise<TenantKey[]>;
  apiKey(tenant: string, id: string): Promise<ApiKeyRecord | null>;
  origins(tenant: string): Promise<string[]>;
  /** Whether any tenant allows `origin`: the preflight's question (decision D66). */
  originRegistered(origin: string): Promise<boolean>;
  /** The identifiers of every tenant, for the scheduler (BE-052; `docedit_tenant_ids()`). */
  list(): Promise<string[]>;

  // Operator writes (phase 1a: configuration and the command line; administration is UX-076).
  putTenant(tenant: string, name: string): Promise<void>;
  addKey(tenant: string, key: NewKey): Promise<TenantKey>;
  removeKey(tenant: string, kid: string): Promise<boolean>;
  addApiKey(
    tenant: string,
    key: { id: string; secretHash: Buffer; label?: string; expiresAt?: number | null },
  ): Promise<void>;
  /** Sets or clears the expiry of an API key (rotation overlap, 10 §3.7). */
  expireApiKey(tenant: string, id: string, at: number | null): Promise<boolean>;
  removeApiKey(tenant: string, id: string): Promise<boolean>;
  addOrigin(tenant: string, origin: string): Promise<void>;
  removeOrigin(tenant: string, origin: string): Promise<boolean>;
}

const KID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * An origin as the browser sends it (RFC 6454; the WHATWG URL standard's serialisation): the
 * scheme `http` or `https`, the host (an IPv6 address in brackets) and a port other than the
 * scheme's default, lower case, without a path, a query, a fragment or credentials. Parsed with
 * the platform's URL parser, so `http://[::1]:56490` is an origin and `https://a.example:443`
 * becomes `https://a.example`.
 */
export function normaliseOrigin(origin: string): string | null {
  const text = origin.trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== ''))
    return null;
  // Nothing after the authority but an optional slash: an origin has no path.
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(text)) return null;
  return u.origin.toLowerCase();
}

export function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Compares a presented secret with a stored hash in constant time. */
export function secretMatches(secret: string, hash: Buffer): boolean {
  const h = hashSecret(secret);
  return h.length === hash.length && timingSafeEqual(h, hash);
}

function checkedKey(key: NewKey): TenantKey {
  if (!KID.test(key.kid)) throw new KeyRegistrationError('a key identifier is 1 to 128 characters');
  let jwk: PublicJwk;
  try {
    importPublicJwk(key.jwk, key.alg);
    jwk = canonicalJwk(key.jwk as Record<string, unknown>);
  } catch (e) {
    throw new KeyRegistrationError(e instanceof Error ? e.message : 'the key is not valid');
  }
  return {
    kid: key.kid,
    use: key.use,
    alg: key.alg,
    jwk,
    thumbprint: thumbprint(jwk),
    issuer: key.issuer ?? null,
  };
}

// ---------------------------------------------------------------------------------------------

interface MemoryTenant {
  name: string;
  keys: Map<string, TenantKey>;
  apiKeys: Map<string, ApiKeyRecord>;
  origins: Set<string>;
}

export class MemoryTenantRegistry implements TenantRegistry {
  readonly #tenants = new Map<string, MemoryTenant>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  #get(tenant: string): MemoryTenant {
    const t = this.#tenants.get(tenant);
    if (!t) throw new KeyRegistrationError(`no tenant ${tenant}`);
    return t;
  }

  async exists(tenant: string): Promise<boolean> {
    return this.#tenants.has(tenant);
  }

  async keys(tenant: string, use: KeyUse): Promise<TenantKey[]> {
    const t = this.#tenants.get(tenant);
    return t ? [...t.keys.values()].filter((k) => k.use === use).map((k) => ({ ...k })) : [];
  }

  async apiKey(tenant: string, id: string): Promise<ApiKeyRecord | null> {
    const k = this.#tenants.get(tenant)?.apiKeys.get(id);
    return k ? { ...k } : null;
  }

  async origins(tenant: string): Promise<string[]> {
    return [...(this.#tenants.get(tenant)?.origins ?? [])].sort();
  }

  async originRegistered(origin: string): Promise<boolean> {
    for (const t of this.#tenants.values()) if (t.origins.has(origin)) return true;
    return false;
  }

  async list(): Promise<string[]> {
    return [...this.#tenants.keys()].sort();
  }

  async putTenant(tenant: string, name: string): Promise<void> {
    assertUuid(tenant, 'tenant');
    const t = this.#tenants.get(tenant);
    if (t) t.name = name;
    else
      this.#tenants.set(tenant, { name, keys: new Map(), apiKeys: new Map(), origins: new Set() });
  }

  async addKey(tenant: string, key: NewKey): Promise<TenantKey> {
    const t = this.#get(tenant);
    const k = checkedKey(key);
    for (const other of t.keys.values())
      if (other.thumbprint === k.thumbprint && other.kid !== k.kid)
        throw new KeyRegistrationError(
          `the key is already registered as ${other.kid} for ${other.use} tokens`,
        );
    const prior = t.keys.get(k.kid);
    if (prior && prior.use !== k.use)
      throw new KeyRegistrationError(`key ${k.kid} is registered for ${prior.use} tokens`);
    t.keys.set(k.kid, k);
    return { ...k };
  }

  async removeKey(tenant: string, kid: string): Promise<boolean> {
    return this.#tenants.get(tenant)?.keys.delete(kid) ?? false;
  }

  async addApiKey(
    tenant: string,
    key: { id: string; secretHash: Buffer; label?: string; expiresAt?: number | null },
  ): Promise<void> {
    assertUuid(key.id, 'API key');
    this.#get(tenant).apiKeys.set(key.id, {
      id: key.id,
      secretHash: Buffer.from(key.secretHash),
      label: key.label ?? null,
      createdAt: this.#now(),
      expiresAt: key.expiresAt ?? null,
    });
  }

  async expireApiKey(tenant: string, id: string, at: number | null): Promise<boolean> {
    const k = this.#tenants.get(tenant)?.apiKeys.get(id);
    if (!k) return false;
    k.expiresAt = at;
    return true;
  }

  async removeApiKey(tenant: string, id: string): Promise<boolean> {
    return this.#tenants.get(tenant)?.apiKeys.delete(id) ?? false;
  }

  async addOrigin(tenant: string, origin: string): Promise<void> {
    const o = normaliseOrigin(origin);
    if (!o) throw new KeyRegistrationError('an origin is a scheme, a host and an optional port');
    this.#get(tenant).origins.add(o);
  }

  async removeOrigin(tenant: string, origin: string): Promise<boolean> {
    const o = normaliseOrigin(origin);
    return o ? (this.#tenants.get(tenant)?.origins.delete(o) ?? false) : false;
  }
}

// ---------------------------------------------------------------------------------------------

interface KeyRow {
  kid: string;
  use: KeyUse;
  alg: Algorithm;
  jwk: PublicJwk;
  thumbprint: string;
  issuer: string | null;
}

/** The registrations in PostgreSQL (migration 0004), each read under its tenant (BE-011). */
export class PgTenantRegistry implements TenantRegistry {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  #read<T>(tenant: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return inTenant(this.#pool, tenant, fn, { readOnly: true });
  }

  async exists(tenant: string): Promise<boolean> {
    return this.#read(tenant, async (c) => {
      const r = await c.query('SELECT 1 FROM tenants WHERE id = $1', [tenant]);
      return r.rowCount === 1;
    });
  }

  keys(tenant: string, use: KeyUse): Promise<TenantKey[]> {
    return this.#read(tenant, async (c) => {
      const r = await c.query<KeyRow>(
        `SELECT kid, use, alg, jwk, thumbprint, issuer FROM tenant_keys
          WHERE tenant_id = $1 AND use = $2 ORDER BY kid COLLATE "C"`,
        [tenant, use],
      );
      return r.rows.map((k) => ({ ...k }));
    });
  }

  apiKey(tenant: string, id: string): Promise<ApiKeyRecord | null> {
    assertUuid(id, 'API key');
    return this.#read(tenant, async (c) => {
      const r = await c.query<{
        id: string;
        secret_hash: Buffer;
        label: string | null;
        created_at: Date;
        expires_at: Date | null;
      }>(
        'SELECT id, secret_hash, label, created_at, expires_at FROM tenant_api_keys WHERE tenant_id = $1 AND id = $2',
        [tenant, id],
      );
      const row = r.rows[0];
      return row
        ? {
            id: row.id,
            secretHash: row.secret_hash,
            label: row.label,
            createdAt: millis(row.created_at)!,
            expiresAt: millis(row.expires_at),
          }
        : null;
    });
  }

  origins(tenant: string): Promise<string[]> {
    return this.#read(tenant, async (c) => {
      const r = await c.query<{ origin: string }>(
        'SELECT origin FROM tenant_origins WHERE tenant_id = $1 ORDER BY origin COLLATE "C"',
        [tenant],
      );
      return r.rows.map((x) => x.origin);
    });
  }

  async originRegistered(origin: string): Promise<boolean> {
    const r = await this.#pool.query<{ ok: boolean }>(
      'SELECT docedit_origin_registered($1) AS ok',
      [origin],
    );
    return r.rows[0]?.ok === true;
  }

  async list(): Promise<string[]> {
    const r = await this.#pool.query<{ id: string }>('SELECT docedit_tenant_ids() AS id');
    return r.rows.map((x) => x.id);
  }

  putTenant(tenant: string, name: string): Promise<void> {
    assertUuid(tenant, 'tenant');
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(
        `INSERT INTO tenants (id, tenant_id, name, created_at) VALUES ($1, $1, $2, now())
         ON CONFLICT (id) DO UPDATE SET name = excluded.name`,
        [tenant, name],
      );
    });
  }

  async addKey(tenant: string, key: NewKey): Promise<TenantKey> {
    const k = checkedKey(key);
    return inTenant(this.#pool, tenant, async (c) => {
      const same = await c.query<{ kid: string; use: KeyUse }>(
        'SELECT kid, use FROM tenant_keys WHERE tenant_id = $1 AND (thumbprint = $2 OR kid = $3)',
        [tenant, k.thumbprint, k.kid],
      );
      for (const row of same.rows) {
        if (row.kid !== k.kid)
          throw new KeyRegistrationError(
            `the key is already registered as ${row.kid} for ${row.use} tokens`,
          );
        if (row.use !== k.use)
          throw new KeyRegistrationError(`key ${k.kid} is registered for ${row.use} tokens`);
      }
      await c.query(
        `INSERT INTO tenant_keys (tenant_id, kid, use, alg, jwk, thumbprint, issuer, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
         ON CONFLICT (tenant_id, kid) DO UPDATE
            SET alg = excluded.alg, jwk = excluded.jwk, thumbprint = excluded.thumbprint,
                issuer = excluded.issuer`,
        [tenant, k.kid, k.use, k.alg, JSON.stringify(k.jwk), k.thumbprint, k.issuer],
      );
      return k;
    });
  }

  removeKey(tenant: string, kid: string): Promise<boolean> {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query('DELETE FROM tenant_keys WHERE tenant_id = $1 AND kid = $2', [
        tenant,
        kid,
      ]);
      return r.rowCount === 1;
    });
  }

  addApiKey(
    tenant: string,
    key: { id: string; secretHash: Buffer; label?: string; expiresAt?: number | null },
  ): Promise<void> {
    assertUuid(key.id, 'API key');
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(
        `INSERT INTO tenant_api_keys (tenant_id, id, secret_hash, label, created_at, expires_at)
         VALUES ($1, $2, $3, $4, now(), $5)`,
        [
          tenant,
          key.id,
          key.secretHash,
          key.label ?? null,
          key.expiresAt === null || key.expiresAt === undefined
            ? null
            : new Date(key.expiresAt).toISOString(),
        ],
      );
    });
  }

  expireApiKey(tenant: string, id: string, at: number | null): Promise<boolean> {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query(
        'UPDATE tenant_api_keys SET expires_at = $3 WHERE tenant_id = $1 AND id = $2',
        [tenant, id, at === null ? null : new Date(at).toISOString()],
      );
      return r.rowCount === 1;
    });
  }

  removeApiKey(tenant: string, id: string): Promise<boolean> {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query('DELETE FROM tenant_api_keys WHERE tenant_id = $1 AND id = $2', [
        tenant,
        id,
      ]);
      return r.rowCount === 1;
    });
  }

  addOrigin(tenant: string, origin: string): Promise<void> {
    const o = normaliseOrigin(origin);
    if (!o)
      return Promise.reject(
        new KeyRegistrationError('an origin is a scheme, a host and an optional port'),
      );
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(
        `INSERT INTO tenant_origins (tenant_id, origin, created_at) VALUES ($1, $2, now())
         ON CONFLICT DO NOTHING`,
        [tenant, o],
      );
    });
  }

  removeOrigin(tenant: string, origin: string): Promise<boolean> {
    const o = normaliseOrigin(origin);
    if (!o) return Promise.resolve(false);
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query('DELETE FROM tenant_origins WHERE tenant_id = $1 AND origin = $2', [
        tenant,
        o,
      ]);
      return r.rowCount === 1;
    });
  }
}
