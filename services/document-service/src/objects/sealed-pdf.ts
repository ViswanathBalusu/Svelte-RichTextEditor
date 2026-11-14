/**
 * Write-once storage of a sealed PDF (FRW-054 criterion 1; 12 §8.2 step 4; HIS-036 criterion 4).
 *
 * The sealed bytes go under the tenant's key for the workflow (`objectKeys.final`), written with S3
 * Object Lock in COMPLIANCE mode: until `retainUntil` no credential, the operator's included, can
 * overwrite or delete them. The result has the shape of the `StoreResult` that `finaliseWorkflow`
 * (@docedit/authority) takes, so the gate decides the workflow state from it: a failed write leaves
 * the workflow at `completed` (FRW-054 criterion 2).
 *
 * The bucket must have Object Lock enabled. An operator creates it so; the tests create their own.
 * Universal logic is not needed here: this file is service code and uses the S3 adapter directly.
 */
import { createHash } from 'node:crypto';
import type { S3ObjectStore } from './s3.ts';
import { objectKeys, ObjectStoreError } from './store.ts';

/** The result of one store attempt, in the shape `finaliseWorkflow` takes. */
export type SealedStoreResult =
  | { readonly ok: true; readonly storedHash: string }
  | { readonly ok: false; readonly reason: 'store_failed' };

/** Lower-case hexadecimal SHA-256 of the bytes. */
export function sealedHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Stores the sealed bytes of one workflow under the tenant, write-once until `retainUntil` (Unix
 * ms). Returns the hash of the stored bytes, read back from the bytes written, or `store_failed`
 * when the store refuses or cannot be reached. It never throws for a store failure.
 */
export async function storeSealedPdf(
  store: S3ObjectStore,
  tenant: string,
  doc: string,
  workflow: string,
  bytes: Uint8Array,
  retainUntil: number,
): Promise<SealedStoreResult> {
  if (!Number.isSafeInteger(retainUntil) || retainUntil <= 0)
    throw new RangeError('storeSealedPdf: retainUntil is not a positive safe integer');
  const key = objectKeys.final(tenant, doc, workflow);
  try {
    await store.putRetained(key, bytes, retainUntil);
  } catch (e) {
    if (e instanceof ObjectStoreError) return { ok: false, reason: 'store_failed' };
    throw e;
  }
  return { ok: true, storedHash: sealedHash(bytes) };
}

/** Reads the sealed bytes back, or null when no object has the key. */
export async function readSealedPdf(
  store: S3ObjectStore,
  tenant: string,
  doc: string,
  workflow: string,
): Promise<Uint8Array | null> {
  return store.get(objectKeys.final(tenant, doc, workflow));
}

/** The key a sealed PDF is stored under (the tenant's prefix first). */
export function sealedPdfKey(tenant: string, doc: string, workflow: string): string {
  return objectKeys.final(tenant, doc, workflow);
}
