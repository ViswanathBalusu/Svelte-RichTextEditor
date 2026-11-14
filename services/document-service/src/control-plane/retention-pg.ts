/**
 * The PostgreSQL retention store (UX-080 criterion 1, durable half; 08 section 11; 13 section 10).
 *
 * It holds the same rows as `MemoryRetentionStore` in retention.ts, in the table `tenant_retention`
 * of migration 0065. A row is one scope: the tenant (`doc_id` null) or one document. Every query
 * runs under the tenant's row-level security (BE-011), so one tenant never reads or writes another
 * tenant's rows. The version is checked in the write itself, so two writers that read the same
 * version cannot both succeed. `pgParts` in server.ts composes this store.
 */
import { inTenant, type Pool } from '../storage/db.ts';
import {
  RetentionConflict,
  type RetentionPolicy,
  type RetentionRow,
  type RetentionStore,
} from './retention.ts';

export const TENANT_RETENTION_TABLE = 'tenant_retention';

interface Row {
  mode: string;
  after_days: number | null;
  version: number;
}

export class PgRetentionStore implements RetentionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  read(tenant: string, document: string | null): Promise<RetentionRow | null> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `select mode, after_days, version from ${TENANT_RETENTION_TABLE}
            where tenant_id = $1 and doc_id is not distinct from $2`,
          [tenant, document],
        );
        const row = r.rows[0];
        if (!row) return null;
        const policy: RetentionPolicy =
          row.mode === 'keep_all'
            ? { mode: 'keep_all' }
            : { mode: 'thin_payloads', afterDays: Number(row.after_days) };
        return { policy, version: Number(row.version) };
      },
      { readOnly: true },
    );
  }

  write(
    tenant: string,
    document: string | null,
    policy: RetentionPolicy,
    expected: number,
  ): Promise<number> {
    const days = policy.afterDays ?? null;
    return inTenant(this.#pool, tenant, async (c) => {
      if (expected === 0) {
        // A row of the same scope already there (either unique index) means another writer won.
        const r = await c.query<{ version: number }>(
          `insert into ${TENANT_RETENTION_TABLE} (tenant_id, doc_id, mode, after_days, version, updated_at)
           values ($1, $2, $3, $4, 1, now())
           on conflict do nothing
           returning version`,
          [tenant, document, policy.mode, days],
        );
        if (r.rows.length === 0)
          throw new RetentionConflict('the policy changed since it was read');
        return 1;
      }
      const r = await c.query<{ version: number }>(
        `update ${TENANT_RETENTION_TABLE}
            set mode = $3, after_days = $4, version = version + 1, updated_at = now()
          where tenant_id = $1 and doc_id is not distinct from $2 and version = $5
          returning version`,
        [tenant, document, policy.mode, days, expected],
      );
      if (r.rows.length === 0) throw new RetentionConflict('the policy changed since it was read');
      return Number(r.rows[0]!.version);
    });
  }
}
