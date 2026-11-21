/**
 * Write-once storage of the signed, time-stamped chain head of a completed workflow (12 §8.2 step 4;
 * 08 §12; FRW-054 criterion 3).
 *
 * The file holds the signed record (identifiers and the head), its SHA-256, a detached CAdES-B-T
 * signature over that hash with an RFC 3161 token inside, and the time of the token. A relying
 * party checks the record's hash, the signature and the token with the evidence bundle's chain
 * (FRW-055). It is stored once for a workflow: a second store of the same record is a no-op, and
 * a different record for the same workflow is refused.
 *
 * - `MemoryAnchorStore` keeps files in the process (the memory composition and tests).
 * - `ObjectAnchorStore` writes them to the tenant's write-once bucket (S3 Object Lock, COMPLIANCE).
 */
import type { S3ObjectStore } from '../objects/s3.ts';
import { objectKeys, ObjectStoreError } from '../objects/store.ts';

export const ANCHOR_FILE_FORMAT = 'docedit-chain-head-anchor-file/1';

/** The stored file, as JSON. */
export interface AnchorFile {
  readonly format: typeof ANCHOR_FILE_FORMAT;
  /** The signed record, canonical text. */
  readonly record: string;
  /** SHA-256 of `record` (UTF-8), lower-case hexadecimal. */
  readonly recordSha256: string;
  /** Detached CAdES-B-T over `recordSha256`, base64 of the DER. */
  readonly cms: string;
  /** `genTime` of the signature time-stamp token, ISO 8601. */
  readonly timestampTime: string;
  /** The key that signed, by identifier. */
  readonly keyId: string;
}

export interface AnchorStoreInput {
  readonly tenant: string;
  readonly doc: string;
  readonly workflow: string;
  readonly file: AnchorFile;
  /** Unix ms of the end of the retention. */
  readonly retainUntilMs: number;
}

export type AnchorStoreOutcome =
  | { readonly ok: true; readonly existing: boolean }
  | { readonly ok: false; readonly reason: 'store_failed' | 'different_record' };

export interface AnchorStore {
  store(input: AnchorStoreInput): Promise<AnchorStoreOutcome>;
  read(tenant: string, doc: string, workflow: string): Promise<AnchorFile | null>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function anchorFileBytes(file: AnchorFile): Uint8Array {
  return enc.encode(`${JSON.stringify(file)}\n`);
}

function parseFile(bytes: Uint8Array): AnchorFile | null {
  try {
    const f = JSON.parse(dec.decode(bytes)) as Partial<AnchorFile>;
    return f.format === ANCHOR_FILE_FORMAT &&
      typeof f.record === 'string' &&
      typeof f.recordSha256 === 'string' &&
      typeof f.cms === 'string' &&
      typeof f.timestampTime === 'string' &&
      typeof f.keyId === 'string'
      ? (f as AnchorFile)
      : null;
  } catch {
    return null;
  }
}

export class MemoryAnchorStore implements AnchorStore {
  readonly #files = new Map<string, AnchorFile>();

  store(input: AnchorStoreInput): Promise<AnchorStoreOutcome> {
    const key = `${input.tenant}/${input.doc}/${input.workflow}`;
    const had = this.#files.get(key);
    if (had !== undefined)
      return Promise.resolve(
        had.record === input.file.record
          ? { ok: true, existing: true }
          : { ok: false, reason: 'different_record' },
      );
    this.#files.set(key, structuredClone(input.file));
    return Promise.resolve({ ok: true, existing: false });
  }

  read(tenant: string, doc: string, workflow: string): Promise<AnchorFile | null> {
    const f = this.#files.get(`${tenant}/${doc}/${workflow}`);
    return Promise.resolve(f === undefined ? null : structuredClone(f));
  }
}

/** The write-once object store: Object Lock, COMPLIANCE mode, until the retention ends. */
export class ObjectAnchorStore implements AnchorStore {
  readonly #objects: S3ObjectStore;
  constructor(objects: S3ObjectStore) {
    this.#objects = objects;
  }

  async store(input: AnchorStoreInput): Promise<AnchorStoreOutcome> {
    const key = objectKeys.anchor(input.tenant, input.doc, input.workflow);
    try {
      const had = await this.#objects.get(key);
      if (had !== null) {
        const f = parseFile(had);
        return f !== null && f.record === input.file.record
          ? { ok: true, existing: true }
          : { ok: false, reason: 'different_record' };
      }
      await this.#objects.putRetained(key, anchorFileBytes(input.file), input.retainUntilMs);
    } catch (e) {
      if (e instanceof ObjectStoreError) return { ok: false, reason: 'store_failed' };
      throw e;
    }
    return { ok: true, existing: false };
  }

  async read(tenant: string, doc: string, workflow: string): Promise<AnchorFile | null> {
    const bytes = await this.#objects.get(objectKeys.anchor(tenant, doc, workflow));
    return bytes === null ? null : parseFile(bytes);
  }
}
