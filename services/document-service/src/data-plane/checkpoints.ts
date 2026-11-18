/**
 * Checkpoints from the durable state (06 §2.2 step 3, §4.1, §4.2; 08 §3; BE-020, BE-019). A room
 * writes one after 2,000 commits or ten minutes of activity since the last, but not more often
 * than every two minutes; around a snapshot commit; and when it closes with changes (BE-021,
 * BE-022). The content is replayed and serialised in a worker thread from the last checkpoint and
 * the steps stored since (SYN-039), never from the tentative state; the main thread passes plain
 * data and stores the bytes the worker returns.
 *
 * A checkpoint is the canonical JSON text of the envelope (03 §2), compressed with Zstandard; its
 * SHA-256 is the hash `sync.check` carries (04 §13). With an index (`doc_checkpoints`) every
 * checkpoint is recorded with its object key, size and hash, and a room opens only from a
 * recorded one (or from the content at sequence number 0, D67): an object written for a snapshot
 * whose commit was never stored is not used.
 */
import type { StepJson, ThreadAnchor } from '@docedit/authority';
import type { AttributionJson } from '@docedit/history';
import type { JsonEnvelope } from '@docedit/model';
import { objectKeys } from '../objects/store.ts';
import { decodeContent, decodeSide, encodeSide } from '../storage/codec.ts';
import type { CheckpointIndex, CheckpointStore, DocRef } from '../storage/types.ts';
import type { Base, Encoded } from './tasks.ts';
import type { Workers } from './workers.ts';

export interface LoadedCheckpoint {
  seq: number;
  envelope: JsonEnvelope;
  /** What a worker replays from: the stored bytes when the store gives them. */
  base: Base;
  /** The hash of the canonical text, when the index or the bytes give it. */
  hash: string | null;
  /** The comment ranges saved with the checkpoint, each at `seq` (SYN-032); none when there is no side object. */
  threads: ThreadAnchor[];
}

/** A checkpoint left as stored bytes, for a worker to parse (BE-019 criterion 5). */
export interface EncodedCheckpoint {
  seq: number;
  encoded: Uint8Array;
  hash: string | null;
  /** The comment ranges saved with the checkpoint, each at `seq` (SYN-032). */
  threads: ThreadAnchor[];
}

export interface Written extends Encoded {
  seq: number;
  key: string;
}

/** The object key of a checkpoint (06 §4.2), or a plain label for a document id that is not a UUID. */
function keyOf(ref: DocRef, seq: number): string {
  try {
    return objectKeys.checkpoint(ref.tenant, ref.doc, seq);
  } catch {
    return `tenants/${ref.tenant}/docs/${ref.doc}/checkpoints/${seq}.cdm.json.zst`;
  }
}

export class Checkpointer {
  readonly #store: CheckpointStore | undefined;
  readonly #index: CheckpointIndex | undefined;
  readonly #workers: Workers;
  readonly #onSaved: ((ref: DocRef, seq: number) => void | Promise<void>) | undefined;
  readonly #onSavedError: ((e: unknown) => void) | undefined;

  constructor(deps: {
    store: CheckpointStore | undefined;
    index: CheckpointIndex | undefined;
    workers: Workers;
    /** Called after each stored checkpoint (BE-054); a failure goes to `onSavedError`. */
    onSaved?: (ref: DocRef, seq: number) => void | Promise<void>;
    onSavedError?: (e: unknown) => void;
  }) {
    this.#store = deps.store;
    this.#index = deps.index;
    this.#workers = deps.workers;
    this.#onSaved = deps.onSaved;
    this.#onSavedError = deps.onSavedError;
  }

  /** Whether a checkpoint store is configured. */
  get enabled(): boolean {
    return this.#store !== undefined;
  }

  get indexed(): boolean {
    return this.#index !== undefined;
  }

  /**
   * The newest usable checkpoint at or before `head` (BE-019): with an index, the newest recorded
   * one whose object can be read, else the content at 0; without one, the store's newest.
   */
  async load(ref: DocRef, head: number): Promise<LoadedCheckpoint | null> {
    const store = this.#store;
    if (!store) return null;
    if (this.#index) {
      const rows = (await this.#index.list(ref)).filter((r) => r.seq <= head && r.seq > 0);
      for (const row of rows.reverse()) {
        const got = await this.#read(ref, row.seq);
        if (got) return { ...got, hash: row.hash, threads: await this.#readThreads(ref, row.seq) };
      }
      const zero = await this.#read(ref, 0);
      return zero ? { ...zero, hash: null, threads: [] } : null;
    }
    const latest = await store.latest(ref, head);
    if (!latest) return null;
    const encoded = store.getEncoded ? await store.getEncoded(ref, latest.seq) : null;
    return {
      seq: latest.seq,
      envelope: latest.content,
      base: encoded ? { encoded } : { doc: latest.content.doc },
      hash: null,
      threads: await this.#readThreads(ref, latest.seq),
    };
  }

  /** The comment ranges saved with the checkpoint at `seq` (none: no side object, or none readable). */
  async #readThreads(ref: DocRef, seq: number): Promise<ThreadAnchor[]> {
    const store = this.#store;
    if (!store?.getSide) return [];
    const bytes = await store.getSide(ref, seq);
    if (!bytes) return [];
    try {
      const side = decodeSide(bytes);
      // Anchors that refer to another `seq` than the checkpoint's would be mapped over the wrong steps.
      return side.seq === seq ? side.threads : [];
    } catch (e) {
      // An unreadable side object is as good as none.
      this.#onSavedError?.(e);
      return [];
    }
  }

  /**
   * `load` for a room that opens: a checkpoint of `rawAtOrAbove` stored bytes or more comes back as
   * its bytes alone, so that nothing of it is decoded on this thread. Smaller ones come back as
   * `load` gives them. Needs a store that gives bytes and an index; otherwise it is `load`.
   */
  async loadForOpen(
    ref: DocRef,
    head: number,
    rawAtOrAbove: number,
  ): Promise<LoadedCheckpoint | EncodedCheckpoint | null> {
    const store = this.#store;
    const index = this.#index;
    if (!store?.getEncoded || !index) return this.load(ref, head);
    const pick = async (
      seq: number,
      encoded: Uint8Array,
      hash: string | null,
    ): Promise<LoadedCheckpoint | EncodedCheckpoint> => {
      const threads = await this.#readThreads(ref, seq);
      return encoded.byteLength >= rawAtOrAbove
        ? { seq, encoded, hash, threads }
        : { seq, envelope: decodeContent<JsonEnvelope>(encoded), base: { encoded }, hash, threads };
    };
    const rows = (await index.list(ref)).filter((r) => r.seq <= head && r.seq > 0);
    for (const row of rows.reverse()) {
      const encoded = await store.getEncoded(ref, row.seq);
      if (encoded) return await pick(row.seq, encoded, row.hash);
    }
    const zero = await store.getEncoded(ref, 0);
    return zero ? await pick(0, zero, null) : null;
  }

  async #read(
    ref: DocRef,
    seq: number,
  ): Promise<Omit<LoadedCheckpoint, 'hash' | 'threads'> | null> {
    const store = this.#store!;
    if (store.getEncoded) {
      const encoded = await store.getEncoded(ref, seq);
      if (!encoded) return null;
      return { seq, envelope: decodeContent<JsonEnvelope>(encoded), base: { encoded } };
    }
    const envelope = await store.get(ref, seq);
    return envelope ? { seq, envelope, base: { doc: envelope.doc } } : null;
  }

  /** Encodes content in a worker: for imported content and the snapshot's checkpoint. */
  encode(envelope: JsonEnvelope): Promise<Encoded> {
    return this.#workers.run('encode', { envelope });
  }

  /** Replays `commits` on `base` in a worker and encodes the result. */
  replay(input: {
    base: Base;
    cdm: number;
    requires: readonly string[];
    commits: ReadonlyArray<readonly StepJson[]>;
  }): Promise<Encoded> {
    return this.#workers.run('checkpoint', input);
  }

  /** Whether the store keeps a side object (the attribution map) with each checkpoint. */
  get sides(): boolean {
    return this.#store?.putSide !== undefined && this.#store.getSide !== undefined;
  }

  /** The attribution map saved with the checkpoint at exactly `seq`, or null (ADR 0377). */
  async loadSide(ref: DocRef, seq: number): Promise<AttributionJson | null> {
    const store = this.#store;
    if (!store?.getSide) return null;
    const bytes = await store.getSide(ref, seq);
    if (!bytes) return null;
    try {
      const side = decodeContent<{ v?: number; attribution?: AttributionJson }>(bytes);
      return side.v === 1 && side.attribution ? side.attribution : null;
    } catch (e) {
      // An unreadable side object is as good as none: the map is rebuilt by a replay.
      this.#onSavedError?.(e);
      return null;
    }
  }

  /**
   * Stores an encoded checkpoint at `seq`; with `index`, records it too. One side object holds
   * what is saved with the checkpoint: the attribution map (`side`; ADR 0377) and the comment
   * ranges at `seq` (`threads`; SYN-032 criterion 6). It is written first: a side object without
   * its checkpoint is never read, a checkpoint without one only costs a replay. A failure to
   * write it is reported and does not fail the checkpoint.
   */
  async save(
    ref: DocRef,
    seq: number,
    e: Encoded,
    index = true,
    side?: AttributionJson,
    threads?: readonly ThreadAnchor[],
  ): Promise<Written> {
    const store = this.#store;
    if (!store) throw new Error('no checkpoint store is configured');
    if ((side || threads?.length) && store.putSide) {
      try {
        await store.putSide(
          ref,
          seq,
          encodeSide({
            v: 1,
            seq,
            threads: threads ? [...threads] : [],
            ...(side ? { attribution: side } : {}),
          }),
        );
      } catch (err) {
        this.#onSavedError?.(err);
      }
    }
    if (store.putEncoded) await store.putEncoded(ref, seq, e.encoded);
    // A store without encoded writes gets the envelope: decoded here (once the control plane's
    // store offers putEncoded, nothing heavy is left on the main thread).
    else await store.put(ref, seq, decodeContent<JsonEnvelope>(e.encoded));
    const key = keyOf(ref, seq);
    if (index && this.#index)
      await this.#index.record(ref, { seq, key, bytes: e.encoded.byteLength, hash: e.hash });
    if (this.#onSaved) {
      // A failure of the listener never fails the checkpoint: it is written (BE-054).
      try {
        void Promise.resolve(this.#onSaved(ref, seq)).catch((err: unknown) =>
          this.#onSavedError?.(err),
        );
      } catch (err) {
        this.#onSavedError?.(err);
      }
    }
    return { ...e, seq, key };
  }

  /** The object key the store uses for a checkpoint. */
  keyOf(ref: DocRef, seq: number): string {
    return keyOf(ref, seq);
  }
}
