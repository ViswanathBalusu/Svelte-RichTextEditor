/**
 * The PostgreSQL store of the fonts tenants add (BE-048), in the table `tenant_fonts` of migration
 * 0099. Every query runs under the tenant's row-level security (BE-011), so one tenant never reads,
 * adds or removes another tenant's fonts. `pgParts` in server.ts composes this store.
 */
import { inTenant, type Pool } from '../storage/db.ts';
import type { TenantFontRow, TenantFontStore } from './tenant-fonts.ts';

export const TENANT_FONTS_TABLE = 'tenant_fonts';

interface Row {
  sha256: string;
  family: string;
  style: TenantFontRow['style'];
  weight: number;
  italic: boolean;
  format: TenantFontRow['format'];
  bytes: string;
  licence: string;
  server_use: boolean;
  added_by: string;
  added_at_ms: string;
}

const COLUMNS = `sha256, family, style, weight, italic, format, bytes::text as bytes, licence,
                 server_use, added_by, (extract(epoch from added_at) * 1000)::text as added_at_ms`;

const rowOf = (tenant: string, r: Row): TenantFontRow => ({
  tenant,
  sha256: r.sha256,
  family: r.family,
  style: r.style,
  weight: r.weight === 700 ? 700 : 400,
  italic: r.italic,
  format: r.format,
  bytes: Number(r.bytes),
  licence: r.licence,
  serverUse: r.server_use,
  addedBy: r.added_by,
  addedAt: Math.round(Number(r.added_at_ms)),
});

export class PgTenantFontStore implements TenantFontStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  add(row: TenantFontRow): Promise<'added' | 'same_file' | 'same_face'> {
    return inTenant(this.#pool, row.tenant, async (c) => {
      // The two uniqueness rules are checked first so that the answer says which one applies; a
      // concurrent add of the same face is stopped by the indexes and surfaces as an error.
      const same = await c.query<{ sha256: string }>(
        `select sha256 from ${TENANT_FONTS_TABLE}
          where tenant_id = $1 and (sha256 = $2 or (lower(family) = lower($3) and style = $4))`,
        [row.tenant, row.sha256, row.family, row.style],
      );
      if (same.rows.some((r) => r.sha256 === row.sha256)) return 'same_file';
      if (same.rows.length > 0) return 'same_face';
      await c.query(
        `insert into ${TENANT_FONTS_TABLE}
           (tenant_id, sha256, family, style, weight, italic, format, bytes, licence, server_use,
            added_by, added_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 to_timestamp($12::double precision / 1000))`,
        [
          row.tenant,
          row.sha256,
          row.family,
          row.style,
          row.weight,
          row.italic,
          row.format,
          row.bytes,
          row.licence,
          row.serverUse,
          row.addedBy,
          row.addedAt,
        ],
      );
      return 'added';
    });
  }

  list(tenant: string): Promise<TenantFontRow[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<Row>(
          `select ${COLUMNS} from ${TENANT_FONTS_TABLE}
            where tenant_id = $1 order by lower(family), style`,
          [tenant],
        );
        return r.rows.map((x) => rowOf(tenant, x));
      },
      { readOnly: true },
    );
  }

  remove(tenant: string, sha256: string): Promise<TenantFontRow | null> {
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query<Row>(
        `delete from ${TENANT_FONTS_TABLE} where tenant_id = $1 and sha256 = $2 returning ${COLUMNS}`,
        [tenant, sha256],
      );
      const row = r.rows[0];
      return row ? rowOf(tenant, row) : null;
    });
  }
}
