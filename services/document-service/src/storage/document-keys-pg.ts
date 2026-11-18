/**
 * The rows of per-document keys on PostgreSQL (HIS-041; document-keys.ts; migration 0075). Every
 * query runs under the tenant's row-level security. The service role writes these rows: it is the
 * one that gives and destroys keys, and the purge role deletes them with the document.
 */
import { inTenant, type Pool } from './db.ts';
import type { DocumentKeyRow, DocumentKeyStore } from './document-keys.ts';
import type { DocRef } from './types.ts';

interface Row {
  key_id: string;
  wrapped_dek: Buffer | null;
  state: 'active' | 'destroyed';
  created_at: Date;
  destroyed_at: Date | null;
}

export class PgDocumentKeyStore implements DocumentKeyStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  tenantEnabled(tenant: string): Promise<boolean> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ enabled: boolean }>(
          'SELECT enabled FROM tenant_document_keys WHERE tenant_id = $1',
          [tenant],
        );
        return r.rows[0]?.enabled ?? false;
      },
      { readOnly: true },
    );
  }

  setTenantEnabled(tenant: string, enabled: boolean): Promise<void> {
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(
        `INSERT INTO tenant_document_keys (tenant_id, enabled, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (tenant_id) DO UPDATE SET enabled = $2, updated_at = now()`,
        [tenant, enabled],
      );
    });
  }

  get(ref: DocRef): Promise<DocumentKeyRow | null> {
    return inTenant(
      this.#pool,
      ref.tenant,
      async (c) => {
        const r = await c.query<Row>(
          `SELECT key_id, wrapped_dek, state, created_at, destroyed_at
             FROM document_keys WHERE tenant_id = $1 AND doc_id = $2`,
          [ref.tenant, ref.doc],
        );
        const row = r.rows[0];
        if (!row) return null;
        return {
          keyId: row.key_id,
          wrappedDek: row.wrapped_dek === null ? null : new Uint8Array(row.wrapped_dek),
          state: row.state,
          createdAt: row.created_at.getTime(),
          destroyedAt: row.destroyed_at === null ? null : row.destroyed_at.getTime(),
        };
      },
      { readOnly: true },
    );
  }

  insert(ref: DocRef, row: DocumentKeyRow): Promise<boolean> {
    return inTenant(this.#pool, ref.tenant, async (c) => {
      if (row.wrappedDek === null)
        throw new TypeError('a new key row carries its wrapped data key');
      const r = await c.query(
        `INSERT INTO document_keys (tenant_id, doc_id, key_id, wrapped_dek, state, created_at)
         VALUES ($1, $2, $3, $4, 'active', $5) ON CONFLICT (doc_id) DO NOTHING`,
        [ref.tenant, ref.doc, row.keyId, Buffer.from(row.wrappedDek), new Date(row.createdAt)],
      );
      return r.rowCount === 1;
    });
  }

  markDestroyed(ref: DocRef, at: number): Promise<void> {
    return inTenant(this.#pool, ref.tenant, async (c) => {
      await c.query(
        `UPDATE document_keys SET state = 'destroyed', wrapped_dek = NULL, destroyed_at = $3
          WHERE tenant_id = $1 AND doc_id = $2 AND state = 'active'`,
        [ref.tenant, ref.doc, new Date(at)],
      );
    });
  }
}
