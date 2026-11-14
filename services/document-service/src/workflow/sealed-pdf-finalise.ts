/**
 * The store step of finalisation (FRW-054 criterion 1; 12 §8.2 step 4). It writes the sealed bytes
 * to write-once storage under the tenant (`storeSealedPdf`), reads them back, hashes what was read,
 * and records that hash in table `workflow_sealed_pdf` (`recordSealedPdf`). The result's `store`
 * has the shape `finaliseWorkflow` (@docedit/authority) takes, so the gate decides the workflow
 * state from it.
 *
 * - The write fails: `store` is `store_failed` and nothing is recorded.
 * - The bytes read back differ from the sealed hash: `store` carries the hash read back, so the
 *   gate stops with `stored_hash_differs`, and nothing is recorded (the table refuses such a row).
 * - The record cannot be written: `store` is `store_failed`, so the workflow stays `completed`.
 *   The bytes stay in storage under their retention; they cannot be removed.
 *
 * The record is written on its own, not in the same transaction as the control commit of FRW-054
 * criterion 2: the control commit is the workflow service's and is not built (ADR 0341, Open).
 */
import type { S3ObjectStore } from '../objects/s3.ts';
import {
  readSealedPdf,
  sealedHash,
  sealedPdfKey,
  storeSealedPdf,
  type SealedStoreResult,
} from '../objects/sealed-pdf.ts';
import type { Pool } from '../storage/db.ts';
import { recordSealedPdf, type SealedPdfRecord } from './sealed-pdf-pg.ts';

export interface SealedPdfStoreInput {
  readonly tenant: string;
  readonly docId: string;
  readonly workflowId: string;
  /** The sealed bytes from the signing service. */
  readonly bytes: Uint8Array;
  /** The hash the signing service gave for the sealed bytes (`SealResult.sealedHash`). */
  readonly sealedHash: string;
  /** Unix ms of the end of the retention. */
  readonly retainUntilMs: number;
}

export interface SealedPdfStoreOutcome {
  /** The input to `finaliseWorkflow`'s `store`. */
  readonly store: SealedStoreResult;
  /** The record written, or null when none was written. */
  readonly record: SealedPdfRecord | null;
}

const FAILED: SealedStoreResult = { ok: false, reason: 'store_failed' };

/** Stores the sealed bytes write-once and records the hash of the bytes stored. */
export async function storeAndRecordSealedPdf(
  pool: Pool,
  objects: S3ObjectStore,
  input: SealedPdfStoreInput,
): Promise<SealedPdfStoreOutcome> {
  const { tenant, docId, workflowId } = input;
  const written = await storeSealedPdf(
    objects,
    tenant,
    docId,
    workflowId,
    input.bytes,
    input.retainUntilMs,
  );
  if (!written.ok) return { store: written, record: null };

  let back: Uint8Array | null;
  try {
    back = await readSealedPdf(objects, tenant, docId, workflowId);
  } catch {
    return { store: FAILED, record: null };
  }
  if (back === null) return { store: FAILED, record: null };
  const storedHash = sealedHash(back);
  if (storedHash !== input.sealedHash) return { store: { ok: true, storedHash }, record: null };

  const record: SealedPdfRecord = {
    docId,
    workflowId,
    sealedHash: input.sealedHash,
    storedHash,
    objectKey: sealedPdfKey(tenant, docId, workflowId),
    retainUntilMs: input.retainUntilMs,
  };
  try {
    await recordSealedPdf(pool, tenant, record);
  } catch {
    return { store: FAILED, record: null };
  }
  return { store: { ok: true, storedHash }, record };
}
