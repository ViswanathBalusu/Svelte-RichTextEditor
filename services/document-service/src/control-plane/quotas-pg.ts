/**
 * The PostgreSQL quota store (UX-078 criterion 1, durable half; 13 section 10; 06 section 12).
 *
 * It keeps the same rules as `MemoryQuotaStore` in quotas.ts: a value is a finite number of zero
 * or more, a dimension is one of the seven 06 section 12 names, a tenant must be known, and an
 * unset dimension reads as `null`. The values survive a restart of the service because they are
 * rows, not process memory.
 *
 * The rows are in `tenant_quotas` (migration 0069), a tenant table under row-level security
 * (BE-011). Every query runs inside `inTenant`, so the database itself keeps one tenant from
 * reading or writing another tenant's quotas; the `tenant_id = $1` clauses only repeat it. A tenant
 * identifier that is not a UUID cannot be registered, so it reads as all `null` and is refused on
 * write. `pgParts` in server.ts composes this store.
 *
 * Reads are asynchronous, so this store cannot be the synchronous `QuotaSource` that the live
 * quota gate (live-quotas.ts) reads at each decision. A caller that needs both must cache the
 * values; that is not built here.
 */
import { inTenant, isUuid, sqlState, type Pool } from '../storage/db.ts';
import {
  checkQuotaValue,
  isQuotaDimension,
  QUOTA_DIMENSIONS,
  QuotaError,
  type QuotaDimension,
  type QuotaSettings,
} from './quotas.ts';

export const TENANT_QUOTAS_TABLE = 'tenant_quotas';

/** Answers whether a tenant is registered. Asynchronous, as the tenant table is in PostgreSQL. */
export type KnownTenant = (tenant: string) => Promise<boolean>;

function empty(): Record<QuotaDimension, number | null> {
  const out = {} as Record<QuotaDimension, number | null>;
  for (const d of QUOTA_DIMENSIONS) out[d] = null;
  return out;
}

export class PgQuotaStore {
  readonly #pool: Pool;
  readonly #known: KnownTenant;

  constructor(pool: Pool, known: KnownTenant) {
    this.#pool = pool;
    this.#known = known;
  }

  /** Sets one dimension of a tenant's quotas. Returns the value stored. Refused values write nothing. */
  async set(tenant: string, dimension: unknown, value: unknown): Promise<number> {
    if (!isUuid(tenant) || !(await this.#known(tenant))) throw new QuotaError('no such tenant');
    if (!isQuotaDimension(dimension)) throw new QuotaError('the quota dimension is not known');
    const v = checkQuotaValue(value);
    try {
      await inTenant(this.#pool, tenant, (c) =>
        c.query(
          `INSERT INTO ${TENANT_QUOTAS_TABLE} (tenant_id, dimension, value, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (tenant_id, dimension) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [tenant, dimension, v],
        ),
      );
    } catch (e) {
      // The foreign key to `tenants`: the tenant went away between the check and the write.
      if (sqlState(e) === '23503') throw new QuotaError('no such tenant');
      throw e;
    }
    return v;
  }

  /** The quotas of a tenant; every dimension is present and `null` when no value is set. */
  async get(tenant: string): Promise<QuotaSettings> {
    const out = empty();
    if (!isUuid(tenant)) return out;
    const rows = await inTenant(
      this.#pool,
      tenant,
      async (c) =>
        (
          await c.query<{ dimension: string; value: number | string }>(
            `SELECT dimension, value FROM ${TENANT_QUOTAS_TABLE} WHERE tenant_id = $1`,
            [tenant],
          )
        ).rows,
      { readOnly: true },
    );
    for (const row of rows) {
      if (isQuotaDimension(row.dimension)) out[row.dimension] = Number(row.value);
    }
    return out;
  }
}
