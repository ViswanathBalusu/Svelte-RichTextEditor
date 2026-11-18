/**
 * The sealed PDF of a workflow, as the workflow service sees its store (FRW-054; 12 §8.2 step 4).
 *
 * `SealedPdfStore` is the port: `store` writes the sealed bytes once and records their hash, `read`
 * gives them back with the recorded hash. There is no way to replace or remove what was stored: the
 * port has no such method, and both implementations refuse a second store for the same workflow.
 *
 * - `MemorySealedPdfStore` keeps the bytes in the process, for the memory composition and for tests.
 * - `ObjectSealedPdfStore` is the write-once object store (S3 Object Lock) and the PostgreSQL record
 *   of FRW-054 criterion 1 (`storeAndRecordSealedPdf`, `readSealedPdfRecord`).
 */
import type { S3ObjectStore } from '../objects/s3.ts';
import { readSealedPdf, sealedHash, sealedPdfKey } from '../objects/sealed-pdf.ts';
import type { Pool } from '../storage/db.ts';
import { readSealedPdfRecord, type SealedPdfRecord } from './sealed-pdf-pg.ts';
import {
  storeAndRecordSealedPdf,
  type SealedPdfStoreInput,
  type SealedPdfStoreOutcome,
} from './sealed-pdf-finalise.ts';

/** A stored sealed PDF with the record of it. */
export interface StoredSealedPdf {
  readonly bytes: Uint8Array;
  readonly record: SealedPdfRecord;
}

export interface SealedPdfStore {
  /** Stores the bytes write-once and records their hash; see `storeAndRecordSealedPdf`. */
  store(input: SealedPdfStoreInput): Promise<SealedPdfStoreOutcome>;
  /** The sealed PDF of one workflow, or null when none is stored. */
  read(tenant: string, docId: string, workflowId: string): Promise<StoredSealedPdf | null>;
}

/** In memory: a second store for the same workflow is refused, and nothing is removed. */
export class MemorySealedPdfStore implements SealedPdfStore {
  readonly #items = new Map<string, StoredSealedPdf>();

  store(input: SealedPdfStoreInput): Promise<SealedPdfStoreOutcome> {
    const key = sealedPdfKey(input.tenant, input.docId, input.workflowId);
    if (this.#items.has(key)) return Promise.resolve({ store: FAILED, record: null });
    const bytes = new Uint8Array(input.bytes);
    const storedHash = sealedHash(bytes);
    if (storedHash !== input.sealedHash)
      return Promise.resolve({ store: { ok: true, storedHash }, record: null });
    const record: SealedPdfRecord = {
      docId: input.docId,
      workflowId: input.workflowId,
      sealedHash: input.sealedHash,
      storedHash,
      objectKey: key,
      retainUntilMs: input.retainUntilMs,
    };
    this.#items.set(key, { bytes, record });
    return Promise.resolve({ store: { ok: true, storedHash }, record });
  }

  read(tenant: string, docId: string, workflowId: string): Promise<StoredSealedPdf | null> {
    const found = this.#items.get(sealedPdfKey(tenant, docId, workflowId));
    return Promise.resolve(
      found === undefined ? null : { bytes: new Uint8Array(found.bytes), record: found.record },
    );
  }
}

const FAILED = { ok: false, reason: 'store_failed' } as const;

/** The write-once object store and the PostgreSQL record. */
export class ObjectSealedPdfStore implements SealedPdfStore {
  readonly #pool: Pool;
  readonly #objects: S3ObjectStore;

  constructor(pool: Pool, objects: S3ObjectStore) {
    this.#pool = pool;
    this.#objects = objects;
  }

  store(input: SealedPdfStoreInput): Promise<SealedPdfStoreOutcome> {
    return storeAndRecordSealedPdf(this.#pool, this.#objects, input);
  }

  async read(tenant: string, docId: string, workflowId: string): Promise<StoredSealedPdf | null> {
    const record = await readSealedPdfRecord(this.#pool, tenant, docId, workflowId);
    if (record === null) return null;
    const bytes = await readSealedPdf(this.#objects, tenant, docId, workflowId);
    return bytes === null ? null : { bytes, record };
  }
}
