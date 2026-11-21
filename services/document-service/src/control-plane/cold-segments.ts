/**
 * Moving old commit payloads to cold segments, and removing payloads from them afterwards
 * (HIS-029; 08 section 11; 06 sections 4.1, 4.2 and 10; ADR 0006).
 *
 * A scheduled run (`payloads.cold`, daily, one per tenant) takes each live document and asks
 * `coldMovePlan` of `@docedit/history` which payloads move: those older than 30 days, in runs of
 * consecutive sequence numbers. `moveSegment` of the same package writes each run as one object,
 * `tenants/{tenant}/docs/{doc}/segments/{fromSeq}-{toSeq}.payloads.zst`, reads it back, checks every
 * payload against the hash in its commit, and only then lets the payload rows go. The commit rows,
 * their payload hashes and the hash chain stay in PostgreSQL. The service adds what the plan cannot
 * know:
 *
 * - a payload above the newest checkpoint stays in PostgreSQL. A room loads from the newest
 *   checkpoint and replays what follows it, so live editing never needs a cold segment (criterion
 *   5); a document without a checkpoint above 0 moves nothing. This is the rule of the payload
 *   thinning (HIS-032) and of the tombstone (HIS-040);
 * - a segment holds at most `maxPayloads` payloads and `maxBytes` bytes of canonical payload, so
 *   that a read of one old commit loads a bounded object;
 * - a document under a legal hold is moved like any other: moving is not thinning (criterion 6).
 *   The audit event says that the hold was seen;
 * - a document whose own key was destroyed (HIS-041) is skipped: its payloads cannot be opened.
 *
 * How a move stays safe (criterion 3). Every change to a document's segment objects is made while
 * holding that document's lock (`ColdSegmentStore.locked`), and the index row tells what state the
 * object is in:
 *
 * 1. a `pending` row is written and committed. From now on the object the move may write is on
 *    record;
 * 2. under the lock: the payload rows are read, the object is written and read back, the payload
 *    rows are deleted and the row becomes `moved`, in one transaction. Nothing is deleted unless
 *    the object read back with every hash matching;
 * 3. if step 2 fails, the object is deleted and the `pending` row with it, under the lock.
 *
 * A process that dies during step 2 leaves the payload rows where they were (the transaction never
 * committed), a `pending` row and perhaps an object. A read never looks at a `pending` row. The
 * next run starts by removing such objects and rows (`pending`), and then moves the payloads again.
 *
 * Thinning and a tombstone remove payloads that have already moved (`remove`): the segment object
 * is written again without them, under the same lock. A segment that would hold nothing goes back
 * to `pending`, and its object and row are then deleted.
 *
 * Each document that had payloads moved gets one audit event, `history.moved`, with counts and
 * never content.
 */
import { zstdDecompressSync } from 'node:zlib';
import {
  COLD_AFTER_MS,
  coldMovePlan,
  dropFromSegment,
  moveSegment,
  type ColdCandidate,
  type ColdStatus,
} from '@docedit/history';
import { uuid7 } from '@docedit/model';
import { objectKeys, TenantObjects, type ObjectStore } from '../objects/store.ts';
import { ColdSegmentUnavailableError, SEGMENT_CODEC } from '../storage/cold-payloads.ts';
import {
  DocumentKeyDestroyedError,
  isSealed,
  type DocumentKeys,
  type DocumentSealer,
} from '../storage/document-keys.ts';
import type { AuditStore, DocRef } from '../storage/types.ts';
import { DAY_MS } from './document-purge.ts';
import type { ScheduledTask } from './scheduler.ts';

/**
 * The most payloads one segment holds: the number of commits between two checkpoints (08 §3), so
 * that a rebuild between two checkpoints reads a few segments at most. A proposed default.
 */
export const SEGMENT_MAX_PAYLOADS = 2000;
/**
 * The most bytes of canonical payload one segment holds: the catch-up limit of 04 (5 MiB), which
 * already bounds what one read of the log may carry. A proposed default.
 */
export const SEGMENT_MAX_BYTES = 5 * 1024 * 1024;

export type ColdSegmentState = 'pending' | 'moved';

/** One row of `commit_cold_segments`. */
export interface ColdSegmentRow {
  fromSeq: number;
  toSeq: number;
  objectKey: string;
  state: ColdSegmentState;
  /** The payloads the object holds. */
  payloads: number;
}

/** A commit whose payload may move, with the bytes of its canonical payload. */
export interface ColdCandidateRow extends ColdCandidate {
  size: number;
}

export interface ColdFacts {
  /** The newest checkpoint above 0 that is not set aside, or null when there is none. */
  newestCheckpoint: number | null;
  /**
   * The commits that still have a payload row, are older than the cut and lie at or below the
   * newest checkpoint; the lowest sequence numbers first, at most the limit asked for.
   */
  candidates: ColdCandidateRow[];
}

/**
 * What a holder of the document's lock may do, all in one transaction: it commits when the callback
 * of `locked` resolves and rolls back when it rejects.
 */
export interface ColdTx {
  /** The row that starts at `fromSeq`, or null. */
  row(fromSeq: number): Promise<ColdSegmentRow | null>;
  /** The `moved` rows whose range overlaps `fromSeq` to `toSeq`, in order. */
  moved(fromSeq: number, toSeq: number): Promise<ColdSegmentRow[]>;
  /**
   * Writes a `pending` row. False, and nothing written, when a row of the document starts at the
   * same sequence number or overlaps the range.
   */
  insertPending(
    segment: { fromSeq: number; toSeq: number; objectKey: string },
    at: number,
  ): Promise<boolean>;
  /** The payloads of these commits as the table stores them. A commit without a row is left out. */
  payloads(seqs: readonly number[]): Promise<Map<number, Uint8Array>>;
  /** Deletes the payload rows of these commits. Rejects unless every one of them was there. */
  deletePayloads(seqs: readonly number[]): Promise<void>;
  /** Makes the row `moved`, with the number of payloads its object holds. */
  setMoved(fromSeq: number, payloads: number, at: number): Promise<void>;
  /** Makes the row `pending` again: its object is no longer to be read. */
  setPending(fromSeq: number): Promise<void>;
  setPayloads(fromSeq: number, payloads: number): Promise<void>;
  deleteRow(fromSeq: number): Promise<void>;
}

/** The rows of the cold segments. The PostgreSQL implementation runs under the purge role (0073). */
export interface ColdSegmentStore {
  /** The tenant's documents that are not deleted. */
  documents(tenant: string): Promise<string[]>;
  /** The `pending` rows of the tenant: moves and removals that did not finish. */
  pending(tenant: string): Promise<Array<{ doc: string; fromSeq: number }>>;
  /** The facts for one document: commits with a payload row and a time before `before` (Unix ms). */
  facts(tenant: string, doc: string, before: number, limit: number): Promise<ColdFacts>;
  /**
   * Runs `fn` in one transaction while holding the document's lock. No two callbacks run at the
   * same time for one document, on any node.
   */
  locked<T>(tenant: string, doc: string, fn: (tx: ColdTx) => Promise<T>): Promise<T>;
}

export interface ColdSegmentsDeps {
  store: ColdSegmentStore;
  objects: ObjectStore;
  audit: AuditStore;
  now: () => number;
  /** Per-document keys (HIS-041): a sealed payload row is opened with the document's key. */
  documentKeys?: Pick<DocumentKeys, 'sealerFor'>;
  /** The documents of a tenant under a legal hold. They are moved all the same; the audit says so. */
  held?: (tenant: string) => Promise<ReadonlySet<string>>;
  /** The age after which a payload moves; 30 days when omitted (08 §11). */
  afterMs?: number;
  maxPayloads?: number;
  maxBytes?: number;
  /** The candidates read per pass over a document; default eight segments' worth. */
  batch?: number;
}

export type ColdSkip = 'key-destroyed';

export interface ColdRunResult {
  /** Documents that had payloads moved, with the counts. */
  moved: Array<{ doc: string; segments: number; payloads: number; bytes: number; held: boolean }>;
  /** Documents left alone, with the reason. */
  skipped: Array<{ doc: string; reason: ColdSkip }>;
  /** Documents whose move stopped, with the reason. Their payloads are where they were. */
  failed: Array<{ doc: string; reason: string }>;
  /** Half-done moves and removals of earlier runs that this run cleared. */
  cleared: number;
}

export interface ColdRemoval {
  /** The payloads that were in a segment and are no longer, in `seq` order. */
  removed: number[];
  /** The keys of the segment objects that were written again or deleted. */
  objects: string[];
}

/** A move that did not finish. The transaction it ran in is rolled back by throwing this. */
class MoveStopped extends Error {
  readonly status: ColdStatus;
  constructor(status: ColdStatus, reason: string) {
    super(reason);
    this.status = status;
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ColdSegments {
  readonly #d: ColdSegmentsDeps;
  readonly #afterMs: number;
  readonly #maxPayloads: number;
  readonly #maxBytes: number;
  readonly #batch: number;

  constructor(deps: ColdSegmentsDeps) {
    this.#d = deps;
    this.#afterMs = deps.afterMs ?? COLD_AFTER_MS;
    this.#maxPayloads = deps.maxPayloads ?? SEGMENT_MAX_PAYLOADS;
    this.#maxBytes = deps.maxBytes ?? SEGMENT_MAX_BYTES;
    this.#batch = deps.batch ?? this.#maxPayloads * 8;
    for (const [name, n] of [
      ['afterMs', this.#afterMs],
      ['maxPayloads', this.#maxPayloads],
      ['maxBytes', this.#maxBytes],
      ['batch', this.#batch],
    ] as const)
      if (!Number.isSafeInteger(n) || n < (name === 'afterMs' ? 0 : 1))
        throw new RangeError(`cold segments: ${name} must be a whole number`);
  }

  /** The age after which a payload moves, in milliseconds. */
  get afterMs(): number {
    return this.#afterMs;
  }

  /**
   * Moves the old payloads of the tenant's live documents. A document under a legal hold is moved
   * like any other. A failure on one document is recorded in `failed` and the run goes on with the
   * next: the payloads of the failed document are where they were.
   */
  async run(tenant: string, now: number = this.#d.now()): Promise<ColdRunResult> {
    const out: ColdRunResult = { moved: [], skipped: [], failed: [], cleared: 0 };
    // What an earlier run left half done goes first, so that its payloads can move again below.
    for (const p of await this.#d.store.pending(tenant)) {
      try {
        if (await this.#discard(tenant, p.doc, p.fromSeq)) out.cleared++;
      } catch (e) {
        out.failed.push({ doc: p.doc, reason: `clearing a half-done move: ${message(e)}` });
      }
    }
    const blocked = new Set(out.failed.map((f) => f.doc));
    const held = this.#d.held ? await this.#d.held(tenant) : new Set<string>();
    for (const doc of await this.#d.store.documents(tenant)) {
      // A document whose half-done move could not be cleared is left for the next run.
      if (blocked.has(doc)) continue;
      try {
        await this.#moveDocument({ tenant, doc }, now, held.has(doc), out);
      } catch (e) {
        if (e instanceof DocumentKeyDestroyedError)
          out.skipped.push({ doc, reason: 'key-destroyed' });
        else out.failed.push({ doc, reason: message(e) });
      }
    }
    return out;
  }

  async #moveDocument(ref: DocRef, now: number, held: boolean, out: ColdRunResult): Promise<void> {
    const { tenant, doc } = ref;
    let segments = 0;
    let payloads = 0;
    let bytes = 0;
    let failure: string | null = null;
    const sealer = this.#d.documentKeys ? await this.#d.documentKeys.sealerFor(ref) : null;
    while (failure === null) {
      const facts = await this.#d.store.facts(tenant, doc, now - this.#afterMs, this.#batch);
      if (facts.newestCheckpoint === null || facts.candidates.length === 0) break;
      const plan = coldMovePlan(facts.candidates, {
        now,
        afterMs: this.#afterMs,
        hold: held,
        maxPayloads: this.#maxPayloads,
        maxBytes: this.#maxBytes,
      });
      if (!plan.ok) throw new Error(`the cold plan of ${doc} was refused: ${plan.reason}`);
      if (plan.segments.length === 0) break;
      let progressed = false;
      for (const segment of plan.segments) {
        const key = objectKeys.segment(tenant, doc, segment.fromSeq, segment.toSeq);
        const r = await this.#moveOne(ref, { ...segment, path: key }, sealer, now);
        if (!r.ok) {
          failure = `segment ${segment.fromSeq}-${segment.toSeq}: ${r.reason}`;
          break;
        }
        progressed = true;
        segments++;
        payloads += segment.entries.length;
        bytes += r.bytes;
      }
      if (!progressed) break;
    }
    if (payloads > 0) {
      out.moved.push({ doc, segments, payloads, bytes, held });
      await this.#d.audit.record([
        {
          id: uuid7(),
          tenant,
          doc,
          actor: 'system',
          kind: 'history.moved',
          data: { segments, payloads, bytes, held, afterDays: this.#afterMs / DAY_MS },
          at: now,
        },
      ]);
    }
    if (failure !== null) out.failed.push({ doc, reason: failure });
  }

  /** Moves one segment (see the three steps in the module comment). */
  async #moveOne(
    ref: DocRef,
    segment: {
      fromSeq: number;
      toSeq: number;
      path: string;
      entries: Array<{ seq: number; payloadHash: string }>;
    },
    sealer: DocumentSealer | null,
    now: number,
  ): Promise<{ ok: true; bytes: number } | { ok: false; reason: string }> {
    const { tenant, doc } = ref;
    const store = this.#d.store;
    const objects = new TenantObjects(this.#d.objects, tenant);
    const seqs = segment.entries.map((e) => e.seq);
    const begun = await store.locked(tenant, doc, (tx) =>
      tx.insertPending(
        { fromSeq: segment.fromSeq, toSeq: segment.toSeq, objectKey: segment.path },
        now,
      ),
    );
    if (!begun)
      return { ok: false, reason: 'a segment row of the document covers that range already' };
    try {
      const bytes = await store.locked(tenant, doc, async (tx) => {
        const row = await tx.row(segment.fromSeq);
        if (!row || row.state !== 'pending' || row.objectKey !== segment.path)
          throw new MoveStopped('missing', 'the record of this move is gone');
        const stored = await tx.payloads(seqs);
        let written = 0;
        // `moveSegment` turns a failure of the stores into a status; the cause is kept here, so
        // that a destroyed key stays what it is and a refused delete says why.
        let cause: unknown;
        const result = await moveSegment(segment, {
          hot: {
            get: async (seq) => {
              const row = stored.get(seq);
              if (row === undefined) return undefined;
              try {
                return await openPayload(ref, seq, row, sealer);
              } catch (e) {
                cause = e;
                throw e;
              }
            },
            delete: async (gone) => {
              try {
                await tx.deletePayloads(gone);
                await tx.setMoved(segment.fromSeq, gone.length, now);
              } catch (e) {
                cause = e;
                throw e;
              }
            },
          },
          objects: {
            put: async (key, body) => {
              await objects.put(key, body, { contentType: 'application/zstd' });
              written = body.byteLength;
            },
            get: async (key) => (await objects.get(key)) ?? undefined,
          },
          codec: SEGMENT_CODEC,
        });
        // A failure rolls the transaction back, whatever it had done.
        if (!result.ok) {
          if (cause instanceof DocumentKeyDestroyedError) throw cause;
          throw new MoveStopped(
            result.status,
            cause === undefined ? result.reason : `${result.reason} (${message(cause)})`,
          );
        }
        return written;
      });
      return { ok: true, bytes };
    } catch (e) {
      // The object, if it was written, and the record of the move go: the payloads are in the
      // table still. If the transaction did commit and only its answer was lost, the row is
      // `moved` and nothing is touched.
      let cleared = '';
      try {
        await this.#discard(tenant, doc, segment.fromSeq);
      } catch (ce) {
        cleared = `; the half-done move could not be cleared yet (${message(ce)})`;
      }
      if (e instanceof DocumentKeyDestroyedError) throw e;
      return { ok: false, reason: `${message(e)}${cleared}` };
    }
  }

  /**
   * Under the document's lock: if the row at `fromSeq` is `pending`, deletes its object and then
   * the row. False when the row is not there or is `moved`. A failure to delete the object leaves
   * the row, so that the next run tries again.
   */
  async #discard(tenant: string, doc: string, fromSeq: number): Promise<boolean> {
    const objects = new TenantObjects(this.#d.objects, tenant);
    return this.#d.store.locked(tenant, doc, async (tx) => {
      const row = await tx.row(fromSeq);
      if (!row || row.state !== 'pending') return false;
      await objects.delete(row.objectKey);
      await tx.deleteRow(fromSeq);
      return true;
    });
  }

  /**
   * Removes the payloads of `seqs` from the cold segments of a document (thinning, HIS-032; a
   * tombstone, HIS-040). Each segment that holds one is written again without it, under the
   * document's lock; a segment left with nothing is deleted, object and row. A commit that no
   * segment holds is not in the answer. A segment that cannot be read rejects with
   * `ColdSegmentUnavailableError`, and what was removed before it stays removed.
   */
  async remove(tenant: string, doc: string, seqs: readonly number[]): Promise<ColdRemoval> {
    const out: ColdRemoval = { removed: [], objects: [] };
    if (seqs.length === 0) return out;
    const sorted = [...new Set(seqs)].sort((a, b) => a - b);
    const store = this.#d.store;
    const objects = new TenantObjects(this.#d.objects, tenant);
    const rows = await store.locked(tenant, doc, (tx) =>
      tx.moved(sorted[0]!, sorted[sorted.length - 1]!),
    );
    for (const listed of rows) {
      const mine = sorted.filter((s) => listed.fromSeq <= s && s <= listed.toSeq);
      if (mine.length === 0) continue;
      const emptied = await store.locked(tenant, doc, async (tx) => {
        const row = await tx.row(listed.fromSeq);
        if (!row || row.state !== 'moved') return false;
        const r = await dropFromSegment(row.objectKey, mine, {
          objects: {
            put: (key, body) => objects.put(key, body, { contentType: 'application/zstd' }),
            get: async (key) => (await objects.get(key)) ?? undefined,
          },
          codec: SEGMENT_CODEC,
        });
        if (!r.ok)
          throw new ColdSegmentUnavailableError(
            r.status === 'mismatch' ? 'mismatch' : 'unavailable',
            r.reason,
            mine[0],
          );
        out.removed.push(...r.removed);
        if (r.removed.length > 0) out.objects.push(row.objectKey);
        if (r.remaining === 0) {
          await tx.setPending(row.fromSeq);
          return true;
        }
        if (r.remaining !== row.payloads) await tx.setPayloads(row.fromSeq, r.remaining);
        return false;
      });
      // The row is `pending` now, so no read uses the object; a failure here is cleared by the
      // next run of the mover.
      if (emptied) await this.#discard(tenant, doc, listed.fromSeq);
    }
    return out;
  }
}

/** The canonical payload of a stored payload row: opened if the document has a key, then decoded. */
async function openPayload(
  ref: DocRef,
  seq: number,
  stored: Uint8Array,
  sealer: DocumentSealer | null,
): Promise<unknown> {
  let bytes = stored;
  if (isSealed(stored)) {
    // A sealed payload with no key to open it is never moved as it is.
    if (!sealer) throw new DocumentKeyDestroyedError(ref.doc);
    bytes = await sealer.open(`${ref.doc}/${seq}`, stored);
  }
  return JSON.parse(zstdDecompressSync(bytes).toString('utf8')) as unknown;
}

/**
 * The scheduled task (BE-052): once a day, per tenant. It is not a task that deletes: no payload is
 * lost by it, so a legal hold does not stop it (HIS-029 criterion 6). Its count is the number of
 * payloads moved. A run in which a document failed rejects after the other documents were done, so
 * that the scheduler counts the run as failed.
 */
export function coldSegmentsTask(
  cold: ColdSegments,
  onFailure?: (tenant: string, failed: ColdRunResult['failed']) => void,
): ScheduledTask {
  return {
    name: 'payloads.cold',
    everyMs: DAY_MS,
    forTenant: async (tenant: string, at: number) => {
      const r = await cold.run(tenant, at);
      if (r.failed.length > 0) {
        onFailure?.(tenant, r.failed);
        throw new Error(
          `payloads.cold: ${r.failed.length} document(s) of ${tenant} could not be moved; the first: ${r.failed[0]!.doc}: ${r.failed[0]!.reason}`,
        );
      }
      return r.moved.reduce((n, m) => n + m.payloads, 0);
    },
  };
}
