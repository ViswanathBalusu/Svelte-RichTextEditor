/**
 * The rows of the payload thinning on PostgreSQL (HIS-032; payload-thinning.ts). The pool must
 * connect as a login that is a member of `docedit_purge` (migration 0073), as for the document
 * purge and the tombstone: the service role may not delete from the log. Every transaction sets
 * the tenant, so row-level security limits the work to that tenant's rows.
 */
import type { PayloadRecord, PinnedVersion } from '@docedit/history';
import { inTenant, type Pool } from '../storage/db.ts';
import type { ThinningFacts, ThinningStore } from './payload-thinning.ts';

export class PgThinningStore implements ThinningStore {
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

  facts(tenant: string, doc: string, before: number): Promise<ThinningFacts> {
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const commits = await c.query<{ seq: string; server_ts: Date; kind: string }>(
          `SELECT c.seq, c.server_ts, c.kind
             FROM doc_commits c
             JOIN doc_commit_payloads p ON p.doc_id = c.doc_id AND p.seq = c.seq
            WHERE c.tenant_id = $1 AND c.doc_id = $2 AND c.server_ts < $3
            ORDER BY c.seq`,
          [tenant, doc, new Date(before).toISOString()],
        );
        const checkpoints = await c.query<{ seq: string }>(
          `SELECT seq FROM doc_checkpoints
            WHERE tenant_id = $1 AND doc_id = $2 AND set_aside_at IS NULL ORDER BY seq`,
          [tenant, doc],
        );
        const versions = await c.query<{ seq: string; kind: string }>(
          'SELECT seq, kind FROM versions WHERE tenant_id = $1 AND doc_id = $2 ORDER BY seq',
          [tenant, doc],
        );
        return {
          commits: commits.rows.map((x): PayloadRecord => ({
            seq: Number(x.seq),
            time: x.server_ts.getTime(),
            kind: x.kind,
          })),
          checkpoints: checkpoints.rows.map((x) => Number(x.seq)),
          versions: versions.rows.map((x): PinnedVersion => ({
            seq: Number(x.seq),
            kind: x.kind as PinnedVersion['kind'],
          })),
        };
      },
      { readOnly: true },
    );
  }

  remove(tenant: string, doc: string, seqs: readonly number[]): Promise<number> {
    if (seqs.length === 0) return Promise.resolve(0);
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query(
        `DELETE FROM doc_commit_payloads
          WHERE tenant_id = $1 AND doc_id = $2 AND seq = ANY($3::bigint[])`,
        [tenant, doc, seqs],
      );
      return r.rowCount ?? 0;
    });
  }
}
