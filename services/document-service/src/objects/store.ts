/**
 * Object storage (06 §4.2, §14; ADR 0006; BE-003): one bucket, keys under a prefix per tenant.
 * `ObjectStore` is the raw port, implemented for S3-compatible servers (s3.ts) and in memory;
 * `TenantObjects` is the only way the service reaches it, and refuses any key outside the tenant's
 * prefix before a request is sent (BE-003 criterion 2).
 */
import { createHmac } from 'node:crypto';
import { assertUuid } from '../storage/ids.ts';

export interface PutOptions {
  contentType?: string;
  /** Write only if no object has the key (write-once; BE-003 criterion 3). */
  ifAbsent?: boolean;
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Whether an object has the key. */
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** Keys that start with `prefix`, in key order. */
  list(prefix: string): Promise<string[]>;
  /** A URL that reads the object until `expiresAt` (Unix ms), without credentials (10 §3.7). */
  signedUrl(key: string, expiresAt: number): string;
}

/** A write-once object already exists (BE-003 criterion 3). */
export class ObjectExistsError extends Error {
  override name = 'ObjectExistsError';
}

/** A call named a key outside the caller's tenant; nothing was sent (BE-003 criterion 2). */
export class ForeignKeyError extends Error {
  override name = 'ForeignKeyError';
}

export class ObjectStoreError extends Error {
  override name = 'ObjectStoreError';
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The key layout of 06 §4.2. Every key starts with the tenant's prefix. */
export const objectKeys = {
  prefix(tenant: string): string {
    assertUuid(tenant, 'tenant');
    return `tenants/${tenant}/`;
  },
  checkpoints(tenant: string, doc: string): string {
    assertUuid(doc, 'document');
    return `${objectKeys.prefix(tenant)}docs/${doc}/checkpoints/`;
  },
  checkpoint(tenant: string, doc: string, seq: number): string {
    return `${objectKeys.checkpoints(tenant, doc)}${seqText(seq)}.cdm.json.zst`;
  },
  checkpointSide(tenant: string, doc: string, seq: number): string {
    return `${objectKeys.checkpoints(tenant, doc)}${seqText(seq)}.side.json.zst`;
  },
  /**
   * Where a checkpoint goes when it is set aside (BE-078: a log rewound by a database recovery):
   * outside the checkpoints prefix, so that no read finds it, but kept for the investigation.
   */
  checkpointAside(tenant: string, doc: string, seq: number, tag: string): string {
    assertUuid(doc, 'document');
    if (!SAFE_SEGMENT.test(tag)) throw new RangeError('a set-aside tag is one safe segment');
    return `${objectKeys.prefix(tenant)}docs/${doc}/aside/${tag}/${seqText(seq)}.cdm.json.zst`;
  },
  segment(tenant: string, doc: string, fromSeq: number, toSeq: number): string {
    assertUuid(doc, 'document');
    if (toSeq < fromSeq) throw new RangeError('a segment ends at or after its start');
    return `${objectKeys.prefix(tenant)}docs/${doc}/segments/${seqText(fromSeq)}-${seqText(toSeq)}.payloads.zst`;
  },
  quarantine(tenant: string, asset: string): string {
    assertUuid(asset, 'asset');
    return `${objectKeys.prefix(tenant)}quarantine/${asset}`;
  },
  asset(tenant: string, sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new RangeError('an asset key is a SHA-256');
    return `${objectKeys.prefix(tenant)}assets/${sha256}`;
  },
  exports(tenant: string, job: string): string {
    assertUuid(job, 'job');
    return `${objectKeys.prefix(tenant)}exports/${job}/`;
  },
  exportFile(tenant: string, job: string, name: string): string {
    if (!SAFE_SEGMENT.test(name)) throw new RangeError('an export file name is one safe segment');
    return `${objectKeys.exports(tenant, job)}${name}`;
  },
  final(tenant: string, doc: string, workflow: string): string {
    assertUuid(doc, 'document');
    if (!SAFE_SEGMENT.test(workflow)) throw new RangeError('a workflow identifier is one segment');
    return `${objectKeys.prefix(tenant)}final/${doc}/${workflow}.pdf`;
  },
  /** The 
	h update of a sealed PDF: long-term validation data or a renewed time-stamp (FRW-056). */
  finalUpdate(tenant: string, doc: string, workflow: string, n: number): string {
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError('an update number is at least 1');
    return objectKeys.final(tenant, doc, workflow).replace(/\.pdf$/, `.u${n}.pdf`);
  },
  /** The prefix under which the updates of one sealed PDF are listed. */
  finalUpdates(tenant: string, doc: string, workflow: string): string {
    return objectKeys.final(tenant, doc, workflow).replace(/\.pdf$/, '.u');
  },
  /** The signed, time-stamped chain head of a completed workflow (FRW-054 criterion 3). */
  anchor(tenant: string, doc: string, workflow: string): string {
    assertUuid(doc, 'document');
    if (!SAFE_SEGMENT.test(workflow)) throw new RangeError('a workflow identifier is one segment');
    return `${objectKeys.prefix(tenant)}anchors/${doc}/${workflow}.json`;
  },
  /**
   * The signed, time-stamped record of an hourly batch of a tenant's chain heads (HIS-036; ADR
   * 0409), named by the time the heads were read (`to`, RFC 3339 in UTC with milliseconds).
   */
  headAnchor(tenant: string, to: string): string {
    return `${objectKeys.prefix(tenant)}anchors/heads/${anchorTime(to)}.json`;
  },
  /** The leaf list stored next to that record, from which an inclusion path is given later. */
  headAnchorLeaves(tenant: string, to: string): string {
    return `${objectKeys.prefix(tenant)}anchors/heads/${anchorTime(to)}.leaves.json`;
  },
};

/** A record's `to` as one safe key segment: `2026-11-21T01:00:00.000Z` is `20261121T010000.000Z`. */
function anchorTime(to: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(to))
    throw new RangeError('an anchor time is RFC 3339 in UTC with milliseconds');
  return to.replaceAll('-', '').replaceAll(':', '');
}

function seqText(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError('a sequence number');
  return String(seq);
}

/** The store as one tenant may use it: keys outside its prefix are refused before any request. */
export class TenantObjects {
  readonly tenant: string;
  readonly #store: ObjectStore;
  readonly #prefix: string;

  constructor(store: ObjectStore, tenant: string) {
    this.#store = store;
    this.tenant = tenant;
    this.#prefix = objectKeys.prefix(tenant);
  }

  #guard(key: string): string {
    if (!key.startsWith(this.#prefix) || key.includes('..') || key.includes('//'))
      throw new ForeignKeyError(`key outside the prefix of tenant ${this.tenant}`);
    return key;
  }

  put(key: string, body: Uint8Array, opts?: PutOptions): Promise<void> {
    try {
      return this.#store.put(this.#guard(key), body, opts);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  get(key: string): Promise<Uint8Array | null> {
    try {
      return this.#store.get(this.#guard(key));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  exists(key: string): Promise<boolean> {
    try {
      return this.#store.exists(this.#guard(key));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  delete(key: string): Promise<void> {
    try {
      return this.#store.delete(this.#guard(key));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  list(prefix: string): Promise<string[]> {
    try {
      return this.#store.list(this.#guard(prefix));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  signedUrl(key: string, expiresAt: number): string {
    return this.#store.signedUrl(this.#guard(key), expiresAt);
  }
}

/** Objects in process, for tests and the memory deployment. Data does not outlive the process. */
export class MemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, { body: Uint8Array; contentType: string }>();
  readonly #secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  /** Every call, for the tests that prove a refused key sends nothing. */
  readonly calls: string[] = [];

  async put(key: string, body: Uint8Array, opts: PutOptions = {}): Promise<void> {
    this.calls.push(`PUT ${key}`);
    if (opts.ifAbsent && this.#objects.has(key)) throw new ObjectExistsError(`${key} exists`);
    this.#objects.set(key, {
      body: Uint8Array.from(body),
      contentType: opts.contentType ?? 'application/octet-stream',
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.calls.push(`GET ${key}`);
    const o = this.#objects.get(key);
    return o ? Uint8Array.from(o.body) : null;
  }

  async exists(key: string): Promise<boolean> {
    this.calls.push(`HEAD ${key}`);
    return this.#objects.has(key);
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`DELETE ${key}`);
    this.#objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    this.calls.push(`LIST ${prefix}`);
    return [...this.#objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  signedUrl(key: string, expiresAt: number): string {
    const sig = createHmac('sha256', this.#secret).update(`${key}\n${expiresAt}`).digest('hex');
    return `memory://objects/${key.split('/').map(encodeURIComponent).join('/')}?expires=${expiresAt}&signature=${sig}`;
  }
}
