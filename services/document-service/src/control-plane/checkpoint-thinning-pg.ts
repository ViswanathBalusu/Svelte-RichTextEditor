/**
 * The rows of the checkpoint thinning on PostgreSQL (HIS-030; checkpoint-thinning.ts). The pool
 * must connect as a login that is a member of `docedit_purge` (migration 0073), as for the document
 * purge and the payload thinning: the service role may not delete from `doc_checkpoints`. Every
 * transaction sets the tenant, so row-level security limits the work to that tenant's rows.
 */
import { inTenant, type Pool } from '../storage/db.ts';
import type { CheckpointFacts, CheckpointThinningStore } from './checkpoint-thinning.ts';

export class PgCheckpointThinningStore implements CheckpointThinningStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  documents(tenant: string): Promise<string[]> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ id: string }>(
          'SELECT id FROM documents WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY id',
          [tenant],
        );
        return r.rows.map((x) => x.id);
      },
      { readOnly: true },
    );
  }

  facts(tenant: string, doc: string): Promise<CheckpointFacts> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const checkpoints = await c.query<{ seq: string; created_at: Date }>(
          `SELECT seq, created_at FROM doc_checkpoints
            WHERE tenant_id = $1 AND doc_id = $2 AND set_aside_at IS NULL ORDER BY seq`,
          [tenant, doc],
        );
        const versions = await c.query<{ seq: string }>(
          'SELECT seq FROM versions WHERE tenant_id = $1 AND doc_id = $2 ORDER BY seq',
          [tenant, doc],
        );
        const snapshots = await c.query<{ seq: string }>(
          'SELECT seq FROM doc_snapshots WHERE tenant_id = $1 AND doc_id = $2 ORDER BY seq',
          [tenant, doc],
        );
        return {
          checkpoints: checkpoints.rows.map((x) => ({
            seq: Number(x.seq),
            time: x.created_at.getTime(),
          })),
          versions: versions.rows.map((x) => Number(x.seq)),
          snapshots: snapshots.rows.map((x) => Number(x.seq)),
        };
      },
      { readOnly: true },
    );
  }

  remove(tenant: string, doc: string, seqs: readonly number[]): Promise<number> {
    if (seqs.length === 0) return Promise.resolve(0);
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query(
        `DELETE FROM doc_checkpoints
          WHERE tenant_id = $1 AND doc_id = $2 AND seq = ANY($3::bigint[])
            AND set_aside_at IS NULL`,
        [tenant, doc, [...seqs]],
      );
      return r.rowCount ?? 0;
    });
  }
}
