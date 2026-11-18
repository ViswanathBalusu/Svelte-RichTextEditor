/**
 * The evidence ledger in PostgreSQL (FRW-041; table `workflow_evidence`, migration 0060). One row
 * for each event: the evidence as captured under the tenant's setting, and in the same `data`
 * object the salt and the hash that the chain holds. Each statement runs in a transaction of the
 * tenant (BE-011), so row-level security limits it to the tenant's rows; the service role has no
 * UPDATE, so a stored row is not rewritten. The row is written in the transaction that reads the
 * capture setting, so a change of the setting applies to the events after it commits.
 */
import type { CapturedEvidence } from '@docedit/authority';
import { inTenant, type Pool } from '../storage/db.ts';
import { readCaptureState } from './capture-settings-pg.ts';
import {
  fromHex,
  prepareEvidence,
  toHex,
  type EvidenceLedger,
  type EvidenceRecordEvent,
  type RecordedEvidence,
  type StoredCommit,
  type StoredEvidence,
} from './evidence-ledger.ts';

interface Row {
  id: string;
  participant: string;
  item: string;
  collected_ms: string;
  data: CapturedEvidence & { commit: StoredCommit };
}

export class PgEvidenceLedger implements EvidenceLedger {
  readonly #pool: Pool;
  readonly #now: () => number;

  constructor(pool: Pool, options: { now?: () => number } = {}) {
    this.#pool = pool;
    this.#now = options.now ?? Date.now;
  }

  record(tenant: string, event: EvidenceRecordEvent): Promise<RecordedEvidence> {
    return inTenant(this.#pool, tenant, async (c) => {
      const { settings } = await readCaptureState(c, tenant, false);
      const made = await prepareEvidence(event, settings);
      await c.query(
        `INSERT INTO workflow_evidence (id, tenant_id, doc_id, participant, item, collected_at, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          made.id,
          tenant,
          event.doc,
          event.participant,
          event.item,
          new Date(this.#now()).toISOString(),
          JSON.stringify({
            ...made.evidence,
            commit: { salt: toHex(made.salt), hash: made.hash },
          }),
        ],
      );
      return { id: made.id, evidence: made.evidence, hash: made.hash, commit: made.commit };
    });
  }

  async list(tenant: string, doc: string): Promise<readonly StoredEvidence[]> {
    const r = await inTenant(
      this.#pool,
      tenant,
      (c) =>
        c.query<Row>(
          `SELECT id::text AS id, participant, item,
                  floor(extract(epoch FROM collected_at) * 1000)::bigint::text AS collected_ms,
                  data
             FROM workflow_evidence
            WHERE tenant_id = $1 AND doc_id = $2
            ORDER BY collected_at, id`,
          [tenant, doc],
        ),
      { readOnly: true },
    );
    return r.rows.map((row) => {
      const { commit, ...evidence } = row.data;
      return {
        id: row.id,
        participant: row.participant,
        item: row.item,
        collectedAtMs: Number(row.collected_ms),
        evidence: evidence as CapturedEvidence,
        salt: fromHex(commit.salt),
        hash: commit.hash,
      };
    });
  }
}
