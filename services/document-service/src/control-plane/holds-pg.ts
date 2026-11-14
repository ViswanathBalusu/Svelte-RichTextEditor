/**
 * The PostgreSQL hold store (UX-080 criteria 2 and 3, durable half; 08 section 11; 13 section 10).
 *
 * It holds the same rows as `MemoryHoldStore` in holds.ts, in the table `document_holds` of
 * migration 0066. Every query runs under the tenant's row-level security (BE-011), so one tenant
 * never reads or writes another tenant's holds. `pgParts` in server.ts composes this store.
 */
import { inTenant, type Pool } from '../storage/db.ts';
import type { HoldRow, HoldStore } from './holds.ts';

export const DOCUMENT_HOLDS_TABLE = 'document_holds';

interface Row {
  id: string;
  doc_id: string;
  reason: string;
  placed_by: string;
  placed_at_ms: string;
}

export class PgHoldStore implements HoldStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async add(row: HoldRow): Promise<void> {
    await inTenant(this.#pool, row.tenant, async (c) => {
      await c.query(
        `insert into ${DOCUMENT_HOLDS_TABLE} (tenant_id, id, doc_id, reason, placed_by, placed_at)
         values ($1, $2, $3, $4, $5, to_timestamp($6::double precision / 1000))`,
        [row.tenant, row.id, row.document, row.reason, row.placedBy, row.placedAt],
      );
    });
  }

  held(tenant: string, document: string): Promise<boolean> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query(
          `select 1 from ${DOCUMENT_HOLDS_TABLE}
            where tenant_id = $1 and doc_id = $2::uuid
            limit 1`,
          [tenant, document],
        );
        return r.rowCount !== null && r.rowCount > 0;
      },
      { readOnly: true },
    );
  }

  list(tenant: string, after: string | null, limit: number): Promise<HoldRow[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `select id::text as id, doc_id::text as doc_id, reason, placed_by,
                  (extract(epoch from placed_at) * 1000)::text as placed_at_ms
             from ${DOCUMENT_HOLDS_TABLE}
            where tenant_id = $1 and ($2::uuid is null or id > $2::uuid)
            order by id
            limit $3`,
          [tenant, after, limit],
        );
        return r.rows.map((row) => ({
          id: row.id,
          tenant,
          document: row.doc_id,
          reason: row.reason,
          placedBy: row.placed_by,
          placedAt: Math.round(Number(row.placed_at_ms)),
        }));
      },
      { readOnly: true },
    );
  }
}
