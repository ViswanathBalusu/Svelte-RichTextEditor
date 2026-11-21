/**
 * Anchoring signed, time-stamped chain heads in write-once storage (HIS-036; 08 section 12; ADR
 * 0409; owner decision 56 in docs/owner-decisions-2026-11-15.md: one signed batch root per tenant,
 * every hour).
 *
 * A scheduled run (`heads.anchor`, hourly, one per tenant) does this for a tenant:
 *
 * 1. finishes what an earlier run left: a record that was signed and not yet written to write-once
 *    storage is written first, so that the records of a tenant form one line;
 * 2. reads the heads that changed: every document whose head (incarnation, `seq`, chain head)
 *    differs from the head its newest record covers. No change, no record;
 * 3. builds the Merkle tree over them (`anchorTree` of `@docedit/history`) and writes the leaf list
 *    to write-once storage, so that an inclusion path can be given later;
 * 4. has the record signed and time-stamped by the signing service. The record names the tenant,
 *    the time the heads were read (`to`), the `to` of the record before (`from`), the root, the
 *    number of leaves and the hash of the record before (`previous`). This process holds no key: it
 *    sends the root, and gets back a signature with an RFC 3161 token inside;
 * 5. stores the record and the heads it covers in one transaction, then writes the record to
 *    write-once storage and marks it stored.
 *
 * A run that fails changes nothing that says "anchored", so the next run that works covers every
 * head the failed ones missed (criterion 5). The failure is told to the operator (`onFailure`: an
 * error line, a counter and an audit entry in the composed service). Nothing here is on the path of
 * a commit: rooms neither wait for a run nor read its tables.
 *
 * What each record, with its leaf list, lets a relying party check is in ADR 0409: the head, its
 * inclusion path, the signature and the time-stamp, and the comparison with the log
 * (services/signing-service/scripts/verify-anchor.ts).
 */
import {
  anchorTree,
  headAnchorRecordText,
  leafListText,
  type AnchoredHead,
} from '@docedit/history';
import { uuid7 } from '@docedit/model';
import type { S3ObjectStore } from '../objects/s3.ts';
import { objectKeys, ObjectStoreError } from '../objects/store.ts';
import type { AuditStore } from '../storage/types.ts';
import type { BatchAnchorClient } from '../workflow/signing-client.ts';
import type { ScheduledTask } from './scheduler.ts';

/** The period of ADR 0409: one hour. */
export const ANCHOR_PERIOD_MS = 60 * 60 * 1000;

export const HEAD_ANCHOR_FILE_FORMAT = 'docedit-anchor-file/1';

/** The stored record file, as JSON. */
export interface HeadAnchorFile {
  readonly format: typeof HEAD_ANCHOR_FILE_FORMAT;
  /** The signed record, canonical text (`docedit-anchor/1`). */
  readonly record: string;
  /** SHA-256 of `record` (UTF-8), lower-case hexadecimal. */
  readonly recordSha256: string;
  /** Detached CAdES-B-T over `recordSha256`, base64 of the DER: the signature and its RFC 3161 token. */
  readonly cms: string;
  /** `genTime` of the token, RFC 3339. */
  readonly timestampTime: string;
  /** The key that signed, by identifier. */
  readonly keyId: string;
}

export function headAnchorFileBytes(file: HeadAnchorFile): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(file)}\n`);
}

/** Write-once storage for the records and their leaf lists. */
export interface HeadAnchorFiles {
  /**
   * Writes the object once, retained until `retainUntilMs`. `existing` when an object with the same
   * bytes is there already (a run that is repeated). Rejects when other bytes are there, or when
   * the store fails.
   */
  put(key: string, bytes: Uint8Array, retainUntilMs: number): Promise<'stored' | 'existing'>;
  get(key: string): Promise<Uint8Array | null>;
}

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** Another object is stored under the key of a record: nothing is overwritten. */
export class AnchorFileConflictError extends Error {
  override name = 'AnchorFileConflictError';
}

/** Files in the process, for the memory composition and tests. Nothing is ever overwritten. */
export class MemoryHeadAnchorFiles implements HeadAnchorFiles {
  readonly #files = new Map<string, { bytes: Uint8Array; retainUntilMs: number }>();

  async put(key: string, bytes: Uint8Array, retainUntilMs: number): Promise<'stored' | 'existing'> {
    const had = this.#files.get(key);
    if (had) {
      if (same(had.bytes, bytes)) return 'existing';
      throw new AnchorFileConflictError(`another object is stored at ${key}`);
    }
    this.#files.set(key, { bytes: Uint8Array.from(bytes), retainUntilMs });
    return 'stored';
  }

  async get(key: string): Promise<Uint8Array | null> {
    const f = this.#files.get(key);
    return f ? Uint8Array.from(f.bytes) : null;
  }

  keys(): string[] {
    return [...this.#files.keys()].sort();
  }
}

/** The write-once object store: S3 Object Lock, COMPLIANCE mode, until the retention ends. */
export class ObjectHeadAnchorFiles implements HeadAnchorFiles {
  readonly #objects: S3ObjectStore;

  constructor(objects: S3ObjectStore) {
    this.#objects = objects;
  }

  async put(key: string, bytes: Uint8Array, retainUntilMs: number): Promise<'stored' | 'existing'> {
    const had = await this.#objects.get(key);
    if (had !== null) {
      if (same(had, bytes)) return 'existing';
      throw new AnchorFileConflictError(`another object is stored at ${key}`);
    }
    await this.#objects.putRetained(key, bytes, retainUntilMs);
    return 'stored';
  }

  get(key: string): Promise<Uint8Array | null> {
    return this.#objects.get(key);
  }
}

/** A record as the store holds it. */
export interface StoredHeadAnchor {
  /** The record's `to`, RFC 3339 in UTC with milliseconds. */
  to: string;
  from: string | null;
  root: string;
  leaves: number;
  record: string;
  recordSha256: string;
  previous: string | null;
  cms: Uint8Array;
  /** Unix ms of the token's `genTime`. */
  timestampTime: number;
  keyId: string;
  objectKey: string;
  leavesKey: string;
  state: 'signed' | 'stored';
}

/** The rows of the anchoring. The PostgreSQL implementation uses the service role (migration 0098). */
export interface HeadAnchorStore {
  /**
   * The heads of the tenant's documents that differ from the head their newest record covers, in
   * the order of their document identifiers. A document with no commit has no head.
   */
  changedHeads(tenant: string): Promise<AnchoredHead[]>;
  /** The tenant's newest record, or null. */
  latest(tenant: string): Promise<StoredHeadAnchor | null>;
  /** The records that are signed and not yet in write-once storage, oldest first. */
  unstored(tenant: string): Promise<StoredHeadAnchor[]>;
  /**
   * Stores a signed record and the heads it covers, in one transaction. False, and nothing stored,
   * when the tenant has a record at that time or a later one already (another run was first).
   */
  record(
    tenant: string,
    anchor: StoredHeadAnchor,
    heads: readonly AnchoredHead[],
    at: number,
  ): Promise<boolean>;
  /** Marks a record as written to write-once storage. */
  markStored(tenant: string, to: string, at: number): Promise<void>;
}

export interface HeadAnchoringDeps {
  store: HeadAnchorStore;
  /** The signing service's client. This process has no key. */
  signing: BatchAnchorClient;
  files: HeadAnchorFiles;
  audit: AuditStore;
  /** How long a record and its leaf list are retained in write-once storage, ms from their `to`. */
  retainMs: number;
  now: () => number;
}

export type AnchorRun =
  | { anchored: false; reason: 'no-change'; finished: number }
  | {
      anchored: true;
      to: string;
      leaves: number;
      root: string;
      recordSha256: string;
      /** Records of earlier runs that this run wrote to write-once storage first. */
      finished: number;
    };

/** A run stopped. `stage` says where; `code` is the signing service's code when it has one. */
export class HeadAnchoringError extends Error {
  override name = 'HeadAnchoringError';
  readonly stage: 'store-earlier' | 'tree' | 'leaves' | 'sign' | 'record' | 'store';
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    stage: HeadAnchoringError['stage'],
    code: string,
    retryable: boolean,
    cause?: unknown,
  ) {
    super(`anchoring stopped at ${stage}: ${code}`, cause === undefined ? undefined : { cause });
    this.stage = stage;
    this.code = code;
    this.retryable = retryable;
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

function codeOf(e: unknown): string {
  if (e instanceof AnchorFileConflictError) return 'conflict';
  if (e instanceof ObjectStoreError) return 'object_store';
  return 'failed';
}

export class HeadAnchoring {
  readonly #d: HeadAnchoringDeps;

  constructor(deps: HeadAnchoringDeps) {
    if (!Number.isSafeInteger(deps.retainMs) || deps.retainMs < 1)
      throw new RangeError('head anchoring: retainMs must be a positive whole number');
    this.#d = deps;
  }

  /**
   * One run for a tenant at `now`. Rejects with `HeadAnchoringError` when it stops; what it had
   * stored before stays, and nothing counts as anchored that was not signed and recorded.
   */
  async run(tenant: string, now: number = this.#d.now()): Promise<AnchorRun> {
    const { store, files, signing } = this.#d;

    // 1. A record that was signed and not yet written is written first.
    let finished = 0;
    for (const earlier of await store.unstored(tenant)) {
      try {
        await this.#write(earlier);
        await store.markStored(tenant, earlier.to, now);
      } catch (e) {
        throw new HeadAnchoringError('store-earlier', codeOf(e), true, e);
      }
      finished++;
    }

    // 2. The heads that changed since the record that covers each document.
    const heads = await store.changedHeads(tenant);
    if (heads.length === 0) return { anchored: false, reason: 'no-change', finished };

    // 3. The tree, and the leaf list in write-once storage.
    const tree = await anchorTree(heads);
    if (!tree.ok) throw new HeadAnchoringError('tree', tree.reason, false);
    const previous = await store.latest(tenant);
    const to = iso(now);
    if (previous !== null && previous.to >= to)
      throw new HeadAnchoringError('tree', 'the newest record is not older than this run', true);
    const fields = {
      tenant,
      from: previous?.to ?? null,
      to,
      root: tree.root,
      leaves: tree.leaves.length,
      previous: previous?.recordSha256 ?? null,
    };
    const expected = headAnchorRecordText(fields);
    if (!expected.ok) throw new HeadAnchoringError('tree', expected.reason, false);
    const leavesKey = objectKeys.headAnchorLeaves(tenant, to);
    const objectKey = objectKeys.headAnchor(tenant, to);
    const retainUntil = now + this.#d.retainMs;
    try {
      await files.put(leavesKey, new TextEncoder().encode(`${leafListText(tree)}\n`), retainUntil);
    } catch (e) {
      throw new HeadAnchoringError('leaves', codeOf(e), true, e);
    }

    // 4. The signature and the time-stamp, from the signing service.
    const signed = await signing.anchorBatch(fields).catch((e: unknown) => {
      throw new HeadAnchoringError('sign', 'unreachable', true, e);
    });
    if (!signed.ok) throw new HeadAnchoringError('sign', signed.code, signed.retryable);
    if (signed.record !== expected.text)
      throw new HeadAnchoringError('sign', 'record_differs', false);

    // 5. The record and the heads it covers, then the record in write-once storage.
    const anchor: StoredHeadAnchor = {
      to,
      from: fields.from,
      root: tree.root,
      leaves: tree.leaves.length,
      record: signed.record,
      recordSha256: signed.recordSha256,
      previous: fields.previous,
      cms: signed.cms,
      timestampTime: signed.timestampTime.getTime(),
      keyId: signed.keyId,
      objectKey,
      leavesKey,
      state: 'signed',
    };
    let recorded: boolean;
    try {
      recorded = await store.record(tenant, anchor, heads, now);
    } catch (e) {
      throw new HeadAnchoringError('record', 'failed', true, e);
    }
    // Another run recorded a record for this tenant first: its heads are covered by that one or by
    // the next run. This signature is not used.
    if (!recorded) throw new HeadAnchoringError('record', 'superseded', true);
    try {
      await this.#write(anchor);
      await store.markStored(tenant, to, now);
    } catch (e) {
      // The record is signed and recorded; the next run writes it before it does anything else.
      throw new HeadAnchoringError('store', codeOf(e), true, e);
    }
    await this.#d.audit.record([
      {
        id: uuid7(),
        tenant,
        doc: null,
        actor: 'system',
        kind: 'heads.anchored',
        data: {
          to,
          from: fields.from,
          leaves: tree.leaves.length,
          root: tree.root,
          recordSha256: signed.recordSha256,
          keyId: signed.keyId,
          timestampTime: iso(anchor.timestampTime),
          objectKey,
        },
        at: now,
      },
    ]);
    return {
      anchored: true,
      to,
      leaves: tree.leaves.length,
      root: tree.root,
      recordSha256: signed.recordSha256,
      finished,
    };
  }

  /** Writes the record file of an anchor to write-once storage. */
  async #write(anchor: StoredHeadAnchor): Promise<void> {
    const file: HeadAnchorFile = {
      format: HEAD_ANCHOR_FILE_FORMAT,
      record: anchor.record,
      recordSha256: anchor.recordSha256,
      cms: Buffer.from(anchor.cms).toString('base64'),
      timestampTime: iso(anchor.timestampTime),
      keyId: anchor.keyId,
    };
    await this.#d.files.put(
      anchor.objectKey,
      headAnchorFileBytes(file),
      Date.parse(anchor.to) + this.#d.retainMs,
    );
  }
}

/** What the operator is told when a run stops (criterion 5). */
export interface AnchorFailure {
  tenant: string;
  stage: string;
  code: string;
  retryable: boolean;
}

/**
 * The scheduled task (BE-052): once an hour, per tenant, at the full hour (the scheduler's slots
 * start at multiples of the period). It deletes nothing. Its count is 1 for a tenant that got a
 * record. A run that stops is told to `onFailure` and rejects, so that the scheduler counts it as
 * failed; the next hour's run covers what it missed.
 */
export function headAnchoringTask(
  anchoring: HeadAnchoring,
  onFailure?: (failure: AnchorFailure) => void | Promise<void>,
): ScheduledTask {
  return {
    name: 'heads.anchor',
    everyMs: ANCHOR_PERIOD_MS,
    forTenant: async (tenant: string, at: number) => {
      try {
        return (await anchoring.run(tenant, at)).anchored ? 1 : 0;
      } catch (e) {
        const failure: AnchorFailure =
          e instanceof HeadAnchoringError
            ? { tenant, stage: e.stage, code: e.code, retryable: e.retryable }
            : { tenant, stage: 'run', code: 'failed', retryable: true };
        await Promise.resolve(onFailure?.(failure)).catch(() => undefined);
        throw e;
      }
    },
  };
}
