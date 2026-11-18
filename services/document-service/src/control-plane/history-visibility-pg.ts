/**
 * The PostgreSQL store of the history visibility settings (HIS-025 criteria 5 and 6, durable
 * half; 08 section 9; 13 section 10).
 *
 * It holds the same rows as `MemoryVisibilityStore` in history-visibility.ts, in the table
 * `history_visibility_settings` of migration 0094. A row is one scope: the tenant (`doc_id` null)
 * or one document. Every query runs under the tenant's row-level security (BE-011). The version is
 * checked in the write itself, so two writers that read the same version cannot both succeed.
 * `pgParts` in server.ts composes this store.
 */
import type { HistoryVisibility } from '@docedit/authority';
import { inTenant, type Pool } from '../storage/db.ts';
import {
  VisibilityConflict,
  type VisibilityRow,
  type VisibilityStore,
} from './history-visibility.ts';

export const HISTORY_VISIBILITY_TABLE = 'history_visibility_settings';

export class PgVisibilityStore implements VisibilityStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  read(tenant: string, document: string | null): Promise<VisibilityRow | null> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ setting: string; version: number }>(
          `select setting, version from ${HISTORY_VISIBILITY_TABLE}
            where tenant_id = $1 and doc_id is not distinct from $2`,
          [tenant, document],
        );
        const row = r.rows[0];
        return row
          ? { setting: row.setting as HistoryVisibility, version: Number(row.version) }
          : null;
      },
      { readOnly: true },
    );
  }

  write(
    tenant: string,
    document: string | null,
    setting: HistoryVisibility,
    expected: number,
  ): Promise<number> {
    return inTenant(this.#pool, tenant, async (c) => {
      if (expected === 0) {
        const r = await c.query<{ version: number }>(
          `insert into ${HISTORY_VISIBILITY_TABLE} (tenant_id, doc_id, setting, version, updated_at)
           values ($1, $2, $3, 1, now())
           on conflict do nothing
           returning version`,
          [tenant, document, setting],
        );
        if (r.rows.length === 0)
          throw new VisibilityConflict('the setting changed since it was read');
        return 1;
      }
      const r = await c.query<{ version: number }>(
        `update ${HISTORY_VISIBILITY_TABLE}
            set setting = $3, version = version + 1, updated_at = now()
          where tenant_id = $1 and doc_id is not distinct from $2 and version = $4
          returning version`,
        [tenant, document, setting, expected],
      );
      if (r.rows.length === 0)
        throw new VisibilityConflict('the setting changed since it was read');
      return Number(r.rows[0]!.version);
    });
  }

  effective(
    tenant: string,
    documents: readonly string[],
  ): Promise<Map<string, { setting: HistoryVisibility; source: 'document' | 'tenant' }>> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ doc_id: string | null; setting: string }>(
          `select doc_id::text as doc_id, setting from ${HISTORY_VISIBILITY_TABLE}
            where tenant_id = $1 and (doc_id is null or doc_id::text = any($2::text[]))`,
          [tenant, [...documents]],
        );
        const own = new Map<string, HistoryVisibility>();
        let tenantSetting: HistoryVisibility | null = null;
        for (const row of r.rows) {
          if (row.doc_id === null) tenantSetting = row.setting as HistoryVisibility;
          else own.set(row.doc_id, row.setting as HistoryVisibility);
        }
        const out = new Map<
          string,
          { setting: HistoryVisibility; source: 'document' | 'tenant' }
        >();
        for (const doc of documents) {
          const o = own.get(doc);
          if (o) out.set(doc, { setting: o, source: 'document' });
          else if (tenantSetting) out.set(doc, { setting: tenantSetting, source: 'tenant' });
        }
        return out;
      },
      { readOnly: true },
    );
  }
}
