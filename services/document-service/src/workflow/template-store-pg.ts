/**
 * The templates of a tenant in PostgreSQL (migration 0093 `document_templates`; FRW-062). Each
 * statement runs in a transaction of the tenant (BE-011).
 */
import { inTenant, type Pool } from '../storage/db.ts';
import type { TemplateRecord, TemplateStore } from './template-store.ts';

export const DOCUMENT_TEMPLATES_TABLE = 'document_templates';

interface Row {
  id: string;
  doc_id: string;
  name: string;
  created_by: string;
  created_at_ms: string | number;
}

const recordOf = (r: Row): TemplateRecord => ({
  id: r.id,
  doc: r.doc_id,
  name: r.name,
  createdBy: r.created_by,
  createdAtMs: Number(r.created_at_ms),
});

const COLUMNS = 'id, doc_id, name, created_by, created_at_ms';

export class PgTemplateStore implements TemplateStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(tenant: string, record: TemplateRecord): Promise<'created' | 'exists'> {
    const r = await inTenant(this.#pool, tenant, (c) =>
      c.query(
        `INSERT INTO ${DOCUMENT_TEMPLATES_TABLE}
           (tenant_id, id, doc_id, name, created_by, created_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING`,
        [tenant, record.id, record.doc, record.name, record.createdBy, record.createdAtMs],
      ),
    );
    return (r.rowCount ?? 0) === 1 ? 'created' : 'exists';
  }

  async list(tenant: string): Promise<readonly TemplateRecord[]> {
    const r = await inTenant(
      this.#pool,
      tenant,
      (c) =>
        c.query<Row>(
          `SELECT ${COLUMNS} FROM ${DOCUMENT_TEMPLATES_TABLE}
            WHERE tenant_id = $1 ORDER BY created_at_ms, id`,
          [tenant],
        ),
      { readOnly: true },
    );
    return r.rows.map(recordOf);
  }

  async get(tenant: string, id: string): Promise<TemplateRecord | null> {
    const r = await inTenant(
      this.#pool,
      tenant,
      (c) =>
        c.query<Row>(
          `SELECT ${COLUMNS} FROM ${DOCUMENT_TEMPLATES_TABLE} WHERE tenant_id = $1 AND id = $2`,
          [tenant, id],
        ),
      { readOnly: true },
    );
    return r.rows[0] === undefined ? null : recordOf(r.rows[0]);
  }
}
