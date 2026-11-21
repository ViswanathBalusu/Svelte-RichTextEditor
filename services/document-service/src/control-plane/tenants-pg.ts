/**
 * The tenant registrations in PostgreSQL (migration 0004; BE-012), each read under its tenant
 * (BE-011). The port, its record types, the checks of a key, an origin and the rate limits, and
 * the in-memory registry are in `tenants.ts`; this adapter is in a file of its own so that the
 * handlers and the request pipeline, which import that module, load no database client (BE-002
 * criterion 1).
 */
import { assertUuid, inTenant, millis, type Pool, type PoolClient } from '../storage/db.ts';
import type { Algorithm, PublicJwk } from './jwt.ts';
import {
  checkedKey,
  checkTenantRateLimits,
  KeyRegistrationError,
  normaliseOrigin,
  type ApiKeyRecord,
  type KeyUse,
  type NewKey,
  type TenantKey,
  type TenantRateLimits,
  type TenantRegistry,
} from './tenants.ts';

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

  rateLimits(tenant: string): Promise<TenantRateLimits | null> {
    return this.#read(tenant, async (c) => {
      const r = await c.query<{ rate_limits: unknown }>(
        'SELECT rate_limits FROM tenants WHERE id = $1',
        [tenant],
      );
      const v = r.rows[0]?.rate_limits;
      return v === null || v === undefined ? null : checkTenantRateLimits(v);
    });
  }

  async setRateLimits(tenant: string, limits: TenantRateLimits | null): Promise<void> {
    const checked = limits === null ? null : checkTenantRateLimits(limits);
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query('UPDATE tenants SET rate_limits = $2::jsonb WHERE id = $1', [
        tenant,
        checked === null ? null : JSON.stringify(checked),
      ]);
      if (r.rowCount !== 1) throw new KeyRegistrationError(`no tenant ${tenant}`);
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
