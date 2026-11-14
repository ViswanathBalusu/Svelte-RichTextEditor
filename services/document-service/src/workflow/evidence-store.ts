/**
 * PostgreSQL adapters for the evidence purge job (FRW-043; lane U-FRW-037-054). The job itself is
 * `runEvidencePurge` in `@docedit/authority`; these classes give it the rows of table
 * `workflow_evidence` (0060_workflow_evidence.sql) and write its audit entry to `audit_events`.
 *
 * Each adapter is bound to one tenant, and every statement runs in a transaction of that tenant
 * (BE-011), so row-level security limits it to the tenant's rows. The audit entry holds counts,
 * the instant and the hold flag only; it names no evidence row and carries no personal data.
 *
 * The purge is not scheduled here: the caller runs it. The retention period and the legal hold
 * are the caller's (FRW-084 is open; the hold is not stored on the document yet).
 */
import { uuid7 } from '@docedit/model';
import type { EvidenceRow, EvidenceRowStore, PurgeAudit, PurgeAuditSink } from '@docedit/authority';
import { insertAuditEvent } from '../data-plane/pg/audit.ts';
import { inTenant, type Pool } from '../storage/db.ts';

const LIST = `
  SELECT id::text AS id,
         floor(extract(epoch FROM collected_at) * 1000)::bigint AS collected_ms
    FROM workflow_evidence
   WHERE tenant_id = $1 AND doc_id = $2
   ORDER BY collected_at, id`;

const DELETE = `
  DELETE FROM workflow_evidence
   WHERE tenant_id = $1 AND doc_id = $2 AND id = ANY($3::uuid[])`;

/** The evidence rows of one tenant, as the purge job reads and deletes them. */
export class PgEvidenceRowStore implements EvidenceRowStore {
  readonly #pool: Pool;
  readonly #tenant: string;

  constructor(pool: Pool, tenant: string) {
    this.#pool = pool;
    this.#tenant = tenant;
  }

  async listRows(documentId: string): Promise<readonly EvidenceRow[]> {
    const r = await inTenant(
      this.#pool,
      this.#tenant,
      (c) => c.query<{ id: string; collected_ms: string }>(LIST, [this.#tenant, documentId]),
      { readOnly: true },
    );
    return r.rows.map((row) => ({ id: row.id, collectedAtMs: Number(row.collected_ms) }));
  }

  async deleteRows(documentId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await inTenant(this.#pool, this.#tenant, (c) =>
      c.query(DELETE, [this.#tenant, documentId, [...ids]]),
    );
  }
}

/** Writes each purge's audit entry to `audit_events` in its own transaction. */
export class PgPurgeAuditSink implements PurgeAuditSink {
  readonly #pool: Pool;
  readonly #tenant: string;

  constructor(pool: Pool, tenant: string) {
    this.#pool = pool;
    this.#tenant = tenant;
  }

  async record(documentId: string, audit: PurgeAudit): Promise<void> {
    await inTenant(this.#pool, this.#tenant, (c) =>
      insertAuditEvent(c, {
        id: uuid7(),
        tenant: this.#tenant,
        doc: documentId,
        actor: 'system',
        kind: audit.kind,
        data: {
          removedCount: audit.removedCount,
          keptCount: audit.keptCount,
          legalHold: audit.legalHold,
        },
        at: audit.atMs,
      }),
    );
  }
}
