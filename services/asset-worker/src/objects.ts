/**
 * The object store as the asset worker and the asset origin use it. Production uses the S3 client
 * of s3.ts; tests and development use the in-memory store. The document service's own S3 adapter
 * (services/document-service/src/objects) has the same shape for `get`, `put`, `delete` and
 * `exists`, and can be wrapped if one client is preferred.
 */

export interface PutOptions {
  contentType: string;
  /** Stored with the object and sent back on reads. */
  cacheControl?: string;
  /** Write only if no object has the key (`If-None-Match: *`). */
  ifAbsent?: boolean;
}

export interface AssetObjects {
  /** The object's bytes, or null if there is none; refuses objects larger than `maxBytes`. */
  get(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** `exists` when `ifAbsent` was asked for and an object has the key. */
  put(key: string, body: Uint8Array, opts: PutOptions): Promise<'written' | 'exists'>;
  /** The object's size, or null if there is none. */
  head(key: string): Promise<{ bytes: number } | null>;
  delete(key: string): Promise<void>;
}

/** The object store failed or could not be reached; the job can be tried again. */
export class ObjectStoreUnavailable extends Error {
  override name = 'ObjectStoreUnavailable';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** An object is larger than the reader accepts. */
export class ObjectTooLarge extends Error {
  override name = 'ObjectTooLarge';
}

export interface StoredObject {
  body: Uint8Array;
  contentType: string;
  cacheControl: string | null;
}

/** Objects in process memory, for tests and development. */
export class MemoryAssetObjects implements AssetObjects {
  readonly objects = new Map<string, StoredObject>();
  /** Every call, in order. */
  readonly calls: string[] = [];

  async get(key: string, maxBytes: number): Promise<Uint8Array | null> {
    this.calls.push(`GET ${key}`);
    const o = this.objects.get(key);
    if (!o) return null;
    if (o.body.length > maxBytes)
      throw new ObjectTooLarge(`${key} is larger than ${maxBytes} bytes`);
    return Uint8Array.from(o.body);
  }

  async put(key: string, body: Uint8Array, opts: PutOptions): Promise<'written' | 'exists'> {
    this.calls.push(`PUT ${key}`);
    if (opts.ifAbsent && this.objects.has(key)) return 'exists';
    this.objects.set(key, {
      body: Uint8Array.from(body),
      contentType: opts.contentType,
      cacheControl: opts.cacheControl ?? null,
    });
    return 'written';
  }

  async head(key: string): Promise<{ bytes: number } | null> {
    this.calls.push(`HEAD ${key}`);
    const o = this.objects.get(key);
    return o ? { bytes: o.body.length } : null;
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`DELETE ${key}`);
    this.objects.delete(key);
  }
}
