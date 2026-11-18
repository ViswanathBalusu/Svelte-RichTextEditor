/**
 * Checkpoints and assets over object storage (06 §4.2, §4.4, §14; BE-003). Checkpoints are
 * Zstandard-compressed canonical JSON (FND-005), like log payloads. Assets are content-addressed:
 * the store computes the hash itself. Sealed PDFs are written once.
 */
import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { canonicalize, type JsonEnvelope } from '@docedit/model';
import type { AssetStore, CheckpointStore, DocRef } from '../storage/types.ts';
import { objectKeys, TenantObjects, type ObjectStore } from './store.ts';

/** A checkpoint as stored: canonical JSON (RFC 8785) compressed with Zstandard (FND-005). */
export function encodeCheckpoint(content: JsonEnvelope): Uint8Array {
  return zstdCompressSync(Buffer.from(canonicalize(content), 'utf8'));
}

export function decodeCheckpoint(bytes: Uint8Array): JsonEnvelope {
  return JSON.parse(zstdDecompressSync(bytes).toString('utf8')) as JsonEnvelope;
}

export class ObjectCheckpointStore implements CheckpointStore {
  readonly #store: ObjectStore;

  constructor(store: ObjectStore) {
    this.#store = store;
  }

  async put(ref: DocRef, seq: number, content: JsonEnvelope): Promise<void> {
    await this.putEncoded(ref, seq, encodeCheckpoint(content));
  }

  /** The bytes `put` would store, encoded elsewhere (a worker thread of the data plane; SYN-039). */
  async putEncoded(ref: DocRef, seq: number, bytes: Uint8Array): Promise<void> {
    await new TenantObjects(this.#store, ref.tenant).put(
      objectKeys.checkpoint(ref.tenant, ref.doc, seq),
      bytes,
      { contentType: 'application/zstd' },
    );
  }

  async getEncoded(ref: DocRef, seq: number): Promise<Uint8Array | null> {
    return new TenantObjects(this.#store, ref.tenant).get(
      objectKeys.checkpoint(ref.tenant, ref.doc, seq),
    );
  }

  /** The side object of a checkpoint (comment ranges; 06 §8 `checkpoints/{seq}.side.json.zst`). */
  async putSide(ref: DocRef, seq: number, bytes: Uint8Array): Promise<void> {
    await new TenantObjects(this.#store, ref.tenant).put(
      objectKeys.checkpointSide(ref.tenant, ref.doc, seq),
      bytes,
      { contentType: 'application/zstd' },
    );
  }

  async getSide(ref: DocRef, seq: number): Promise<Uint8Array | null> {
    return new TenantObjects(this.#store, ref.tenant).get(
      objectKeys.checkpointSide(ref.tenant, ref.doc, seq),
    );
  }

  async get(ref: DocRef, seq: number): Promise<JsonEnvelope | null> {
    const bytes = await this.getEncoded(ref, seq);
    return bytes ? decodeCheckpoint(bytes) : null;
  }

  /** The sequence numbers of the stored checkpoints of a document, ascending. */
  async #seqs(ref: DocRef): Promise<number[]> {
    const keys = await new TenantObjects(this.#store, ref.tenant).list(
      objectKeys.checkpoints(ref.tenant, ref.doc),
    );
    const out: number[] = [];
    for (const k of keys) {
      const m = /\/(\d+)\.cdm\.json\.zst$/.exec(k);
      if (m) out.push(Number(m[1]));
    }
    return out.sort((a, b) => a - b);
  }

  async latest(
    ref: DocRef,
    atOrBefore: number,
  ): Promise<{ seq: number; content: JsonEnvelope } | null> {
    let best = -1;
    for (const seq of await this.#seqs(ref)) if (seq <= atOrBefore && seq > best) best = seq;
    if (best < 0) return null;
    const content = await this.get(ref, best);
    return content ? { seq: best, content } : null;
  }

  /**
   * Moves every checkpoint above `aboveSeq` out of the checkpoints prefix (BE-078): after a
   * database recovery rewound the log, content beyond the restored head must never be read again.
   * The objects are kept under `docs/{doc}/aside/{tag}/` for the investigation. Returns the
   * sequence numbers set aside.
   */
  async setAside(ref: DocRef, aboveSeq: number): Promise<number[]> {
    const objects = new TenantObjects(this.#store, ref.tenant);
    const tag = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const moved: number[] = [];
    for (const seq of await this.#seqs(ref)) {
      if (seq <= aboveSeq) continue;
      const key = objectKeys.checkpoint(ref.tenant, ref.doc, seq);
      const bytes = await objects.get(key);
      if (bytes)
        await objects.put(objectKeys.checkpointAside(ref.tenant, ref.doc, seq, tag), bytes, {
          contentType: 'application/zstd',
        });
      await objects.delete(key);
      // The side object goes with its checkpoint: it describes content that no longer counts.
      const side = objectKeys.checkpointSide(ref.tenant, ref.doc, seq);
      const sideBytes = await objects.get(side);
      if (sideBytes) {
        await objects.put(
          objectKeys
            .checkpointAside(ref.tenant, ref.doc, seq, tag)
            .replace(/.cdm.json.zst$/, '.side.json.zst'),
          sideBytes,
          { contentType: 'application/zstd' },
        );
        await objects.delete(side);
      }
      moved.push(seq);
    }
    return moved;
  }
}

/** Assets, exports and sealed PDFs of one tenant (06 §4.2, §4.4; BE-003). */
export class ObjectAssetStore implements AssetStore {
  readonly #store: ObjectStore;
  readonly #stored: ((tenant: string, bytes: number, kind: string) => void) | undefined;

  /**
   * `stored` is told the bytes of each export output and sealed PDF written, with its kind (the
   * per-tenant meter of BE-085); a failed write is not told.
   */
  constructor(store: ObjectStore, stored?: (tenant: string, bytes: number, kind: string) => void) {
    this.#store = store;
    this.#stored = stored;
  }

  /** An upload before validation (06 §4.4). */
  putQuarantined(tenant: string, asset: string, bytes: Uint8Array): Promise<void> {
    return new TenantObjects(this.#store, tenant).put(objectKeys.quarantine(tenant, asset), bytes);
  }

  getQuarantined(tenant: string, asset: string): Promise<Uint8Array | null> {
    return new TenantObjects(this.#store, tenant).get(objectKeys.quarantine(tenant, asset));
  }

  /** A final asset: the store computes the hash and writes the content-addressed object. */
  async putFinal(tenant: string, bytes: Uint8Array, contentType: string): Promise<string> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const objects = new TenantObjects(this.#store, tenant);
    const key = objectKeys.asset(tenant, sha256);
    if (!(await objects.exists(key))) await objects.put(key, bytes, { contentType });
    return sha256;
  }

  getFinal(tenant: string, sha256: string): Promise<Uint8Array | null> {
    return new TenantObjects(this.#store, tenant).get(objectKeys.asset(tenant, sha256));
  }

  /** An output of an export job, under the job's prefix. */
  putExport(
    tenant: string,
    job: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    return new TenantObjects(this.#store, tenant)
      .put(objectKeys.exportFile(tenant, job, name), bytes, { contentType })
      .then(() => this.#stored?.(tenant, bytes.length, 'export'));
  }

  /** A sealed PDF: written once; a second write is refused with ObjectExistsError. */
  putSealed(tenant: string, doc: string, workflow: string, bytes: Uint8Array): Promise<void> {
    return new TenantObjects(this.#store, tenant)
      .put(objectKeys.final(tenant, doc, workflow), bytes, {
        contentType: 'application/pdf',
        ifAbsent: true,
      })
      .then(() => this.#stored?.(tenant, bytes.length, 'sealed'));
  }

  getSealed(tenant: string, doc: string, workflow: string): Promise<Uint8Array | null> {
    return new TenantObjects(this.#store, tenant).get(objectKeys.final(tenant, doc, workflow));
  }

  /** A short-lived URL of an object of `tenant`, after the caller's permission check (10 §3.7). */
  signedUrl(tenant: string, key: string, expiresAt: number): string {
    return new TenantObjects(this.#store, tenant).signedUrl(key, expiresAt);
  }
}
