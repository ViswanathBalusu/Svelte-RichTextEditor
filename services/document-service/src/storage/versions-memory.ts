/**
 * Stored versions in memory, and the port the control plane uses for them (HIS-006; PRO-054; lane
 * U-PRO-052-068). `PgVersionStore` (versions-store.ts) and this class answer the same way: the
 * refusals of `create` are the ones `versions-store.ts` documents, and a second creation for the
 * same document, `seq` and kind returns the stored version (HIS-007 criterion 5).
 *
 * The memory store has no row lock, so it takes the head from a reader of the log instead of
 * reading it under a lock as the PostgreSQL store does. Nothing outlives the process.
 */
import {
  STORED_VERSION_KINDS,
  type StoredVersionKind,
  type StoredVersionRow,
  type VersionInput,
  type VersionOutcome,
} from './versions-store.ts';
import type { DocRef } from './types.ts';

/** What the control plane needs of a version store; `PgVersionStore` has this shape. */
export interface VersionStorePort {
  /** Stores a version at `input.seq` (or the head), or returns the stored one with that seq and kind. */
  create(ref: DocRef, input: VersionInput, options?: { minSeq?: number }): Promise<VersionOutcome>;
  /** The stored versions, oldest `seq` first; `minSeq` and `kind` filter as in `PgVersionStore`. */
  list(
    ref: DocRef,
    options?: { minSeq?: number; kind?: StoredVersionKind },
  ): Promise<StoredVersionRow[]>;
}

export class MemoryVersionStore implements VersionStorePort {
  readonly #head: (ref: DocRef) => Promise<number>;
  readonly #rows = new Map<string, StoredVersionRow[]>();

  /** `head` gives the head `seq` of a document, and throws when the document does not exist. */
  constructor(head: (ref: DocRef) => Promise<number>) {
    this.#head = head;
  }

  static #key(ref: DocRef): string {
    return JSON.stringify([ref.tenant, ref.doc]);
  }

  async create(
    ref: DocRef,
    input: VersionInput,
    options: { minSeq?: number } = {},
  ): Promise<VersionOutcome> {
    let head: number;
    try {
      head = await this.#head(ref);
    } catch {
      return { ok: false, code: 'not_found', message: `no document ${ref.doc}` };
    }
    if (!(STORED_VERSION_KINDS as readonly string[]).includes(input.kind))
      return {
        ok: false,
        code: 'validation_failed',
        message: `kind ${input.kind} is not a version kind`,
      };
    const seq = input.seq ?? head;
    if (!Number.isSafeInteger(seq) || seq < 0)
      return {
        ok: false,
        code: 'validation_failed',
        message: `seq ${seq} is not a sequence number`,
      };
    if (seq > head)
      return {
        ok: false,
        code: 'validation_failed',
        message: `seq ${seq} is above the head ${head}`,
      };
    const min = options.minSeq ?? 0;
    if (seq < min)
      return { ok: false, code: 'forbidden', message: `seq ${seq} is below your visibility gate` };
    const key = MemoryVersionStore.#key(ref);
    const rows = this.#rows.get(key) ?? [];
    const kind = input.kind as StoredVersionKind;
    const found = rows.find((r) => r.seq === seq && r.kind === kind);
    if (found) return { ok: true, version: { ...found }, created: false };
    const row: StoredVersionRow = {
      seq,
      kind,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
    };
    if (input.name !== undefined) row.name = input.name;
    if (input.note !== undefined) row.note = input.note;
    rows.push(row);
    this.#rows.set(key, rows);
    return { ok: true, version: { ...row }, created: true };
  }

  async list(
    ref: DocRef,
    options: { minSeq?: number; kind?: StoredVersionKind } = {},
  ): Promise<StoredVersionRow[]> {
    const min = options.minSeq ?? 0;
    return (this.#rows.get(MemoryVersionStore.#key(ref)) ?? [])
      .filter((r) => r.seq >= min && (options.kind === undefined || r.kind === options.kind))
      .sort((a, b) => a.seq - b.seq || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
      .map((r) => ({ ...r }));
  }
}
