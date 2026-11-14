/**
 * PostgreSQL record of a sealed final PDF (FRW-054 criterion 1; lane V-FRW-037-054). The sealed
 * bytes are in write-once object storage (`src/objects/sealed-pdf.ts`); this row keeps the hash of
 * those bytes, the object key and the retention end in table `workflow_sealed_pdf`
 * (0061_workflow_sealed_pdf.sql). The statement runs in a transaction of the tenant (BE-011), so
 * row-level security limits it to the tenant's rows.
 *
 * A second record for the same workflow is refused: the primary key is (tenant, document, workflow).
 */
import type { Pool } from '../storage/db.ts';
import { inTenant } from '../storage/db.ts';

export interface SealedPdfRecord {
  readonly docId: string;
  readonly workflowId: string;
  readonly sealedHash: string;
  readonly storedHash: string;
  readonly objectKey: string;
  /** Unix ms of the end of the retention. */
  readonly retainUntilMs: number;
}

const INSERT = `
  INSERT INTO workflow_sealed_pdf
    (tenant_id, doc_id, workflow_id, sealed_hash, stored_hash, object_key, retain_until)
  VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::bigint / 1000.0))`;

const SELECT = `
  SELECT doc_id::text AS doc_id,
         workflow_id,
         sealed_hash,
         stored_hash,
         object_key,
         floor(extract(epoch FROM retain_until) * 1000)::bigint AS retain_ms
    FROM workflow_sealed_pdf
   WHERE tenant_id = $1 AND doc_id = $2 AND workflow_id = $3`;

/**
 * Records the sealed PDF of one workflow for the tenant. Throws on a second record for the same
 * workflow (unique violation, SQLSTATE 23505) and on any row the table's checks refuse.
 */
export async function recordSealedPdf(
  pool: Pool,
  tenant: string,
  record: SealedPdfRecord,
): Promise<void> {
  if (!Number.isSafeInteger(record.retainUntilMs) || record.retainUntilMs <= 0)
    throw new RangeError('recordSealedPdf: retainUntilMs is not a positive safe integer');
  await inTenant(pool, tenant, (c) =>
    c.query(INSERT, [
      tenant,
      record.docId,
      record.workflowId,
      record.sealedHash,
      record.storedHash,
      record.objectKey,
      record.retainUntilMs,
    ]),
  );
}

/** The recorded sealed PDF of one workflow, or null when none is recorded. */
export async function readSealedPdfRecord(
  pool: Pool,
  tenant: string,
  docId: string,
  workflowId: string,
): Promise<SealedPdfRecord | null> {
  const r = await inTenant(
    pool,
    tenant,
    (c) =>
      c.query<{
        doc_id: string;
        workflow_id: string;
        sealed_hash: string;
        stored_hash: string;
        object_key: string;
        retain_ms: string;
      }>(SELECT, [tenant, docId, workflowId]),
    { readOnly: true },
  );
  const row = r.rows[0];
  if (row === undefined) return null;
  return {
    docId: row.doc_id,
    workflowId: row.workflow_id,
    sealedHash: row.sealed_hash,
    storedHash: row.stored_hash,
    objectKey: row.object_key,
    retainUntilMs: Number(row.retain_ms),
  };
}
