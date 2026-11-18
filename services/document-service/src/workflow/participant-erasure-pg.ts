/**
 * PostgreSQL adapters for the erasure of one participant (FRW-043 criterion 3; participant-erasure.ts).
 *
 * - `PgParticipantEvidence` deletes a participant's rows of `workflow_evidence` (the service role may
 *   delete from it, migration 0060). Each statement runs in a transaction of the tenant (BE-011).
 * - `PgParticipantCommits` finds the commits that hold the person's field values: the commits the
 *   surrogate wrote, with a scope `field:<id>` (`commit_scopes`) and a payload row still present.
 *   The tombstone itself is written by `PgTombstoneStore` under the purge role.
 */
import { inTenant, type Pool } from '../storage/db.ts';
import type { ParticipantCommits, ParticipantEvidenceStore } from './participant-erasure.ts';

export class PgParticipantEvidence implements ParticipantEvidenceStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async deleteParticipant(tenant: string, doc: string, participant: string): Promise<number> {
    const r = await inTenant(this.#pool, tenant, (c) =>
      c.query(
        'DELETE FROM workflow_evidence WHERE tenant_id = $1 AND doc_id = $2 AND participant = $3',
        [tenant, doc, participant],
      ),
    );
    return r.rowCount ?? 0;
  }
}

export class PgParticipantCommits implements ParticipantCommits {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async fieldCommits(tenant: string, doc: string, surrogate: string): Promise<readonly number[]> {
    const r = await inTenant(
      this.#pool,
      tenant,
      (c) =>
        c.query<{ seq: string }>(
          `SELECT c.seq::text AS seq
             FROM doc_commits c
            WHERE c.tenant_id = $1 AND c.doc_id = $2 AND c.user_id = $3
              AND EXISTS (SELECT 1 FROM commit_scopes s
                           WHERE s.tenant_id = c.tenant_id AND s.doc_id = c.doc_id
                             AND s.seq = c.seq AND s.scope LIKE 'field:%')
              AND EXISTS (SELECT 1 FROM doc_commit_payloads p
                           WHERE p.tenant_id = c.tenant_id AND p.doc_id = c.doc_id
                             AND p.seq = c.seq)
            ORDER BY c.seq`,
          [tenant, doc, surrogate],
        ),
      { readOnly: true },
    );
    return r.rows.map((row) => Number(row.seq));
  }
}
