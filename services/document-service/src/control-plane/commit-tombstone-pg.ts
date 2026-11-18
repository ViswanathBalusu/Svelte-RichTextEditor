/**
 * The rows of a tombstone on PostgreSQL (HIS-040; commit-tombstone.ts). The pool must connect as a
 * member of `docedit_purge` (migrations 0073 and 0074), as for the document purge.
 */
import { inTenant, type Pool } from '../storage/db.ts';
import type { PayloadState, TombstoneStore } from './commit-tombstone.ts';

export class PgTombstoneStore implements TombstoneStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  state(tenant: string, doc: string, seq: number): Promise<PayloadState> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ has_payload: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM doc_commit_payloads p
                           WHERE p.tenant_id = c.tenant_id AND p.doc_id = c.doc_id AND p.seq = c.seq)
                  AS has_payload
             FROM doc_commits c WHERE c.tenant_id = $1 AND c.doc_id = $2 AND c.seq = $3`,
          [tenant, doc, seq],
        );
        const row = r.rows[0];
        if (row === undefined) return 'absent';
        return row.has_payload ? 'present' : 'removed';
      },
      { readOnly: true },
    );
  }

  remove(
    tenant: string,
    doc: string,
    seq: number,
    actor: string,
    reason: string,
    at: number,
  ): Promise<void> {
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query(
        `INSERT INTO commit_tombstones (tenant_id, doc_id, seq, actor, reason, removed_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenant, doc, seq, actor, reason, new Date(at).toISOString()],
      );
      const r = await c.query(
        'DELETE FROM doc_commit_payloads WHERE tenant_id = $1 AND doc_id = $2 AND seq = $3',
        [tenant, doc, seq],
      );
      if (r.rowCount !== 1) throw new Error('the payload row vanished during the tombstone');
    });
  }
}
