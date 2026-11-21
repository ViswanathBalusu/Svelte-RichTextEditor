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
import { objectKeys, ObjectStoreError } from '../objects/store.ts';
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

/** The newest stored bytes of a sealed PDF: the sealed object (`n` 0) or its latest update. */
export interface LatestSealedPdf {
  readonly bytes: Uint8Array;
  /** SHA-256 of `bytes`, lower-case hexadecimal. */
  readonly hash: string;
  /** 0 for the sealed object, then 1, 2, ... for each update. */
  readonly n: number;
}

export interface SealedUpdateInput {
  readonly tenant: string;
  readonly docId: string;
  readonly workflowId: string;
  /** The newer file: the latest stored bytes, then the update. */
  readonly bytes: Uint8Array;
  /** SHA-256 of the bytes the update was made from; it must be the latest stored. */
  readonly basedOnHash: string;
  readonly retainUntilMs: number;
}

export type SealedUpdateOutcome =
  | { readonly ok: true; readonly n: number; readonly hash: string; readonly existing: boolean }
  | {
      readonly ok: false;
      readonly reason: 'not_sealed' | 'stale' | 'not_an_append' | 'store_failed';
    };

export interface SealedPdfStore {
  /** Stores the bytes write-once and records their hash; see `storeAndRecordSealedPdf`. */
  store(input: SealedPdfStoreInput): Promise<SealedPdfStoreOutcome>;
  /** The sealed PDF of one workflow, as it was sealed (never an update), or null. */
  read(tenant: string, docId: string, workflowId: string): Promise<StoredSealedPdf | null>;
  /**
   * Stores a further object that begins with the latest stored bytes (FRW-056 criterion 3). The
   * sealed object and every earlier update stay as they were. The same update again is a no-op.
   */
  storeUpdate(input: SealedUpdateInput): Promise<SealedUpdateOutcome>;
  /** The newest bytes: the sealed object or the latest update; null when nothing is stored. */
  readLatest(tenant: string, docId: string, workflowId: string): Promise<LatestSealedPdf | null>;
}

/** The rules of an update, over the latest bytes: the same for every store. */
function planUpdate(
  latest: LatestSealedPdf | null,
  input: SealedUpdateInput,
): SealedUpdateOutcome | { readonly ok: 'write'; readonly n: number; readonly hash: string } {
  if (latest === null) return { ok: false, reason: 'not_sealed' };
  const hash = sealedHash(input.bytes);
  if (hash === latest.hash) return { ok: true, n: latest.n, hash, existing: true };
  if (latest.hash !== input.basedOnHash) return { ok: false, reason: 'stale' };
  if (
    input.bytes.length <= latest.bytes.length ||
    Buffer.compare(
      Buffer.from(input.bytes.subarray(0, latest.bytes.length)),
      Buffer.from(latest.bytes),
    ) !== 0
  )
    return { ok: false, reason: 'not_an_append' };
  return { ok: 'write', n: latest.n + 1, hash };
}

/** In memory: a second store for the same workflow is refused, and nothing is removed. */
export class MemorySealedPdfStore implements SealedPdfStore {
  readonly #items = new Map<string, StoredSealedPdf>();
  readonly #updates = new Map<string, Uint8Array[]>();

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

  async readLatest(
    tenant: string,
    docId: string,
    workflowId: string,
  ): Promise<LatestSealedPdf | null> {
    const key = sealedPdfKey(tenant, docId, workflowId);
    const base = this.#items.get(key);
    if (base === undefined) return null;
    const ups = this.#updates.get(key) ?? [];
    const bytes = new Uint8Array(ups[ups.length - 1] ?? base.bytes);
    return { bytes, hash: sealedHash(bytes), n: ups.length };
  }

  async storeUpdate(input: SealedUpdateInput): Promise<SealedUpdateOutcome> {
    const key = sealedPdfKey(input.tenant, input.docId, input.workflowId);
    const plan = planUpdate(
      await this.readLatest(input.tenant, input.docId, input.workflowId),
      input,
    );
    if (plan.ok !== 'write') return plan;
    const ups = this.#updates.get(key) ?? [];
    ups.push(new Uint8Array(input.bytes));
    this.#updates.set(key, ups);
    return { ok: true, n: plan.n, hash: plan.hash, existing: false };
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

  async readLatest(
    tenant: string,
    docId: string,
    workflowId: string,
  ): Promise<LatestSealedPdf | null> {
    const prefix = objectKeys.finalUpdates(tenant, docId, workflowId);
    let n = 0;
    for (const key of await this.#objects.list(prefix)) {
      const m = /\.u(\d+)\.pdf$/.exec(key);
      if (m) n = Math.max(n, Number(m[1]));
    }
    const bytes =
      n === 0
        ? await readSealedPdf(this.#objects, tenant, docId, workflowId)
        : await this.#objects.get(objectKeys.finalUpdate(tenant, docId, workflowId, n));
    return bytes === null ? null : { bytes, hash: sealedHash(bytes), n };
  }

  async storeUpdate(input: SealedUpdateInput): Promise<SealedUpdateOutcome> {
    const plan = planUpdate(
      await this.readLatest(input.tenant, input.docId, input.workflowId),
      input,
    );
    if (plan.ok !== 'write') return plan;
    try {
      await this.#objects.putRetained(
        objectKeys.finalUpdate(input.tenant, input.docId, input.workflowId, plan.n),
        input.bytes,
        input.retainUntilMs,
      );
    } catch (e) {
      if (e instanceof ObjectStoreError) return { ok: false, reason: 'store_failed' };
      throw e;
    }
    return { ok: true, n: plan.n, hash: plan.hash, existing: false };
  }
}
