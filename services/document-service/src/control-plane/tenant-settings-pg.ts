/**
 * The PostgreSQL store of tenant settings (BE-051), in the table `tenant_settings` of migration 0100.
 * Every query runs under the tenant's row-level security (BE-011). A tenant with no row has the
 * defaults. `pgParts` in server.ts composes this store.
 */
import { inTenant, type Pool } from '../storage/db.ts';
import {
  TENANT_SETTING_DEFAULTS,
  type TenantSettingStore,
  type TenantSettingValues,
} from './tenant-settings.ts';

export const TENANT_SETTINGS_TABLE = 'tenant_settings';

export class PgTenantSettingStore implements TenantSettingStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  get(tenant: string): Promise<TenantSettingValues> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ page_break_reconciliation: boolean }>(
          `select page_break_reconciliation from ${TENANT_SETTINGS_TABLE} where tenant_id = $1`,
          [tenant],
        );
        const row = r.rows[0];
        return row
          ? { pageBreakReconciliation: row.page_break_reconciliation }
          : { ...TENANT_SETTING_DEFAULTS };
      },
      { readOnly: true },
    );
  }

  set(tenant: string, values: TenantSettingValues, actor: string, at: number): Promise<void> {
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(
        `insert into ${TENANT_SETTINGS_TABLE}
           (tenant_id, page_break_reconciliation, updated_by, updated_at)
         values ($1, $2, $3, to_timestamp($4::double precision / 1000))
         on conflict (tenant_id) do update
           set page_break_reconciliation = excluded.page_break_reconciliation,
               updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [tenant, values.pageBreakReconciliation, actor, at],
      );
    });
  }
}
