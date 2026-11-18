/**
 * Home regions in memory and in PostgreSQL (migration 0092; 06 §7; BE-074 criterion 1).
 *
 * A region is a name of 1 to 100 characters with no control characters. It is compared as written:
 * the nodes announce the same names on their lease rows (`NodeTraits.region`).
 */
import { assertUuid, inTenant, type Pool } from './db.ts';
import type { DocRef, HomeRegionRow, HomeRegionStore } from './types.ts';

export function assertRegion(region: string): void {
  const hasControl = [...region].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (region.length < 1 || region.length > 100 || hasControl)
    throw new RangeError('a region is 1 to 100 characters with no control characters');
}

export class MemoryHomeRegions implements HomeRegionStore {
  readonly #tenant = new Map<string, string>();
  readonly #doc = new Map<string, string>();

  async resolve(ref: DocRef): Promise<string | null> {
    return this.#doc.get(`${ref.tenant}/${ref.doc}`) ?? this.#tenant.get(ref.tenant) ?? null;
  }

  async assign(tenant: string, region: string, _by: string, doc?: string): Promise<void> {
    assertRegion(region);
    if (doc === undefined) this.#tenant.set(tenant, region);
    else this.#doc.set(`${tenant}/${doc}`, region);
  }

  async clear(tenant: string, doc?: string): Promise<boolean> {
    return doc === undefined ? this.#tenant.delete(tenant) : this.#doc.delete(`${tenant}/${doc}`);
  }

  async list(tenant: string): Promise<HomeRegionRow[]> {
    const own = this.#tenant.get(tenant);
    const docs = [...this.#doc.entries()]
      .filter(([k]) => k.startsWith(`${tenant}/`))
      .map(([k, region]) => ({ doc: k.slice(tenant.length + 1), region }))
      .sort((a, b) => (a.doc < b.doc ? -1 : a.doc > b.doc ? 1 : 0));
    return [...(own === undefined ? [] : [{ doc: null, region: own }]), ...docs];
  }
}

export class PgHomeRegions implements HomeRegionStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async resolve(ref: DocRef): Promise<string | null> {
    assertUuid(ref.doc, 'document');
    return inTenant(
      this.#pool,
      ref.tenant,
      async (c) => {
        const r = await c.query<{ region: string }>(
          `SELECT region FROM home_regions
            WHERE tenant_id = $1 AND (doc_id = $2 OR doc_id IS NULL)
            ORDER BY doc_id IS NULL LIMIT 1`,
          [ref.tenant, ref.doc],
        );
        return r.rows[0]?.region ?? null;
      },
      { readOnly: true },
    );
  }

  async assign(tenant: string, region: string, by: string, doc?: string): Promise<void> {
    assertRegion(region);
    if (doc !== undefined) assertUuid(doc, 'document');
    return inTenant(this.#pool, tenant, async (c) => {
      // Two partial unique indexes (migration 0092), so the conflict target names the right one.
      if (doc === undefined)
        await c.query(
          `INSERT INTO home_regions (tenant_id, doc_id, region, assigned_by)
           VALUES ($1, NULL, $2, $3)
           ON CONFLICT (tenant_id) WHERE doc_id IS NULL
           DO UPDATE SET region = excluded.region, assigned_by = excluded.assigned_by,
                         assigned_at = now()`,
          [tenant, region, by],
        );
      else
        await c.query(
          `INSERT INTO home_regions (tenant_id, doc_id, region, assigned_by)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, doc_id) WHERE doc_id IS NOT NULL
           DO UPDATE SET region = excluded.region, assigned_by = excluded.assigned_by,
                         assigned_at = now()`,
          [tenant, doc, region, by],
        );
    });
  }

  async clear(tenant: string, doc?: string): Promise<boolean> {
    if (doc !== undefined) assertUuid(doc, 'document');
    return inTenant(this.#pool, tenant, async (c) => {
      const r =
        doc === undefined
          ? await c.query('DELETE FROM home_regions WHERE tenant_id = $1 AND doc_id IS NULL', [
              tenant,
            ])
          : await c.query('DELETE FROM home_regions WHERE tenant_id = $1 AND doc_id = $2', [
              tenant,
              doc,
            ]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  list(tenant: string): Promise<HomeRegionRow[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ doc_id: string | null; region: string }>(
          'SELECT doc_id, region FROM home_regions WHERE tenant_id = $1 ORDER BY doc_id NULLS FIRST',
          [tenant],
        );
        return r.rows.map((x) => ({ doc: x.doc_id, region: x.region }));
      },
      { readOnly: true },
    );
  }
}
