/**
 * The rows of the document purge on PostgreSQL (HIS-039; document-purge.ts). The pool must connect
 * as a login that is a member of `docedit_purge` (migration 0073), not as the service role: the
 * service role may not delete from the log. Every transaction sets the tenant, so row-level
 * security limits the purge to that tenant's rows.
 */
import { inTenant, type Pool } from '../storage/db.ts';
import type { DeletedDocument, PurgeAssetRow, PurgeStore, SealedRow } from './document-purge.ts';

/** The tables whose rows are keyed by `doc_id`, in the order they are deleted (children first). */
export const PURGE_TABLES: readonly string[] = [
  // The outbox names the head row (`outbox_doc_id_fkey`), so it goes before it (BE-054 found it).
  'outbox',
  'commit_tombstones',
  'commit_scopes',
  'doc_commit_payloads',
  'doc_snapshots',
  'doc_checkpoints',
  'doc_commits',
  'doc_heads',
  'doc_assets',
  'versions',
  'read_markers',
  'region_grants',
  'region_states',
  'region_leases',
  'retired_regions',
  'grant_history',
  'grant_revisions',
  'suggestion_introductions',
  'workflow_evidence',
  'workflow_sealed_pdf',
  'workflow_renewal_state',
  'workflow_reminders',
  'workflow_access_codes',
  'workflow_resource',
  'document_revocations',
  'tenant_retention',
  'document_keys',
  'home_regions',
  'jobs',
];

export class PgPurgeStore implements PurgeStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  deleted(tenant: string, limit: number): Promise<DeletedDocument[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ id: string; deleted_at: Date }>(
          `SELECT id, deleted_at FROM documents
            WHERE tenant_id = $1 AND deleted_at IS NOT NULL ORDER BY deleted_at, id LIMIT $2`,
          [tenant, limit],
        );
        return r.rows.map((x) => ({ doc: x.id, deletedAt: x.deleted_at.getTime() }));
      },
      { readOnly: true },
    );
  }

  assets(tenant: string, doc: string): Promise<PurgeAssetRow[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{
          id: string;
          own: boolean;
          sha: string | null;
          shared: boolean;
        }>(
          `SELECT a.id, (a.doc_id = $2) AS own, encode(a.sha256, 'hex') AS sha,
                  EXISTS (SELECT 1 FROM doc_assets o
                           WHERE o.tenant_id = a.tenant_id AND o.asset_id = a.id AND o.doc_id <> $2)
                  AS shared
             FROM assets a
            WHERE a.tenant_id = $1
              AND (a.doc_id = $2
                   OR a.id IN (SELECT asset_id FROM doc_assets WHERE tenant_id = $1 AND doc_id = $2))
            ORDER BY a.id`,
          [tenant, doc],
        );
        // The assets this purge deletes: uploaded for the document and referenced by no other.
        const deleting = new Set(r.rows.filter((y) => y.own && !y.shared).map((y) => y.id));
        const out: PurgeAssetRow[] = [];
        for (const x of r.rows) {
          // Content is shared when an asset row this purge keeps has the same hash (assets are
          // stored by hash), so the object stays.
          let contentShared = false;
          if (x.sha !== null) {
            const same = await c.query<{ id: string }>(
              `SELECT id FROM assets
                WHERE tenant_id = $1 AND sha256 = decode($2, 'hex') AND id <> $3`,
              [tenant, x.sha, x.id],
            );
            contentShared = same.rows.some((y) => !deleting.has(y.id));
          }
          out.push({ id: x.id, shared: x.shared, own: x.own, sha256: x.sha, contentShared });
        }
        return out;
      },
      { readOnly: true },
    );
  }

  jobs(tenant: string, doc: string): Promise<string[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ id: string }>(
          'SELECT id FROM jobs WHERE tenant_id = $1 AND doc_id = $2',
          [tenant, doc],
        );
        return r.rows.map((x) => x.id);
      },
      { readOnly: true },
    );
  }

  sealed(tenant: string, doc: string): Promise<SealedRow[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ object_key: string; retain_until: Date }>(
          'SELECT object_key, retain_until FROM workflow_sealed_pdf WHERE tenant_id = $1 AND doc_id = $2',
          [tenant, doc],
        );
        return r.rows.map((x) => ({
          objectKey: x.object_key,
          retainUntil: x.retain_until.getTime(),
        }));
      },
      { readOnly: true },
    );
  }

  remove(tenant: string, doc: string, assets: readonly string[]): Promise<void> {
    return inTenant(this.#pool, tenant, async (c) => {
      // The comments of the document's threads first: they point at the threads, not the document.
      await c.query(
        `DELETE FROM comments WHERE tenant_id = $1
            AND thread_id IN (SELECT id FROM threads WHERE tenant_id = $1 AND doc_id = $2)`,
        [tenant, doc],
      );
      await c.query('DELETE FROM threads WHERE tenant_id = $1 AND doc_id = $2', [tenant, doc]);
      for (const table of PURGE_TABLES)
        await c.query(`DELETE FROM ${table} WHERE tenant_id = $1 AND doc_id = $2`, [tenant, doc]);
      if (assets.length > 0)
        await c.query('DELETE FROM assets WHERE tenant_id = $1 AND id = ANY ($2::uuid[])', [
          tenant,
          [...assets],
        ]);
      await c.query('DELETE FROM documents WHERE tenant_id = $1 AND id = $2', [tenant, doc]);
    });
  }
}
