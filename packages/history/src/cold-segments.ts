/**
 * Moving old payloads to cold segments (08 §11; HIS-029): the plan, the move and the read that
 * reads both stores. The document service's scheduler runs these against PostgreSQL and object
 * storage; this module holds the rules, behind interfaces the service implements.
 *
 * The rules:
 *
 * - a payload older than `afterMs` (30 days by default, 08 §11) is moved. Consecutive `seq` values
 *   that move together form one segment, named `segments/{fromSeq}-{toSeq}.payloads.zst`;
 * - the metadata rows, the payload hashes and the chain stay where they are, so the chain still
 *   verifies with the stored hashes (chain.ts, `thinBundle` in payload-thinning.ts);
 * - a payload leaves the hot store only after its segment object is written, read back, and its
 *   payload hashes match the hashes recorded in the commit metadata. A failure at any step leaves
 *   the payload where it was (`moveSegment`);
 * - a move is not thinning: a legal hold does not stop it (HIS-031; `ColdPolicy.hold` only marks the
 *   plan, it changes nothing in it);
 * - a range that straddles the boundary is read from both stores and gives the same payloads as
 *   before the move. A segment that cannot be read makes the cold part of the range `unavailable`;
 *   the hot part of a read is not affected (`readPayloads`).
 *
 * Compression is not done here: the codec is an input, and the service supplies zstd (08 §11).
 * Text is passed to the codec as a string, so this module needs no text decoder of its own.
 */
import { canonicalize } from '@docedit/model';
import { payloadDigest } from './chain.ts';
import { DAY_MS } from './thinning.ts';
import { type HistoryResult, refuse } from './types.ts';

/** The age after which a payload moves to a cold segment (08 §11; ADR 0010 says 180 days). */
export const COLD_AFTER_MS = 30 * DAY_MS;

/** The format name written inside each segment object. */
export const PAYLOAD_SEGMENT_FORMAT = 'docedit-payload-segment/1';

/** The path of a segment object (08 §11; HIS-029 criterion 1). */
export function segmentPath(fromSeq: number, toSeq: number): HistoryResult<{ path: string }> {
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq))
    return refuse('validation_failed', 'a segment starts and ends at whole sequence numbers');
  if (fromSeq < 1 || toSeq < fromSeq)
    return refuse('validation_failed', 'a segment starts at 1 or later and ends at or after it');
  return { ok: true, path: `segments/${fromSeq}-${toSeq}.payloads.zst` };
}

/** A segment as the index records it: the range it holds and where its object is. */
export interface SegmentRef {
  fromSeq: number;
  toSeq: number;
  path: string;
}

/** One commit whose payload is in the hot store. */
export interface ColdCandidate {
  seq: number;
  /** Server time of the commit, Unix milliseconds. */
  time: number;
  /** The payload hash recorded in the commit metadata (lower-case hexadecimal SHA-256). */
  payloadHash: string;
}

export interface ColdPolicy {
  /** The time of the run, Unix milliseconds. */
  now: number;
  /** The age after which a payload moves, in milliseconds; `COLD_AFTER_MS` when omitted. */
  afterMs?: number;
  /**
   * A legal hold is in force. Moving is not thinning (08 §11), so the plan is the same with or
   * without it; the flag is returned so that the audit can show that the hold was seen.
   */
  hold?: boolean;
}

export interface ColdPlanSegment extends SegmentRef {
  entries: Array<{ seq: number; payloadHash: string }>;
}

export interface ColdPlan {
  /** Segments to write, in `seq` order. Each holds consecutive `seq` values. */
  segments: ColdPlanSegment[];
  /** Payloads that stay in the hot store, in `seq` order. */
  keep: number[];
  /** Whether a legal hold was in force; it does not change `segments` or `keep`. */
  held: boolean;
}

/**
 * The move plan for the hot payloads of a document at the policy's time. `commits` holds only the
 * payloads still in the hot store: a payload already in a segment is not listed again.
 */
export function coldMovePlan(
  commits: readonly ColdCandidate[],
  policy: ColdPolicy,
): HistoryResult<ColdPlan> {
  if (!Number.isSafeInteger(policy.now)) return refuse('validation_failed', 'now is a whole time');
  const afterMs = policy.afterMs ?? COLD_AFTER_MS;
  if (!Number.isSafeInteger(afterMs) || afterMs < 0)
    return refuse('validation_failed', 'afterMs is a whole number of milliseconds, not negative');
  const all = [...commits].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < all.length; i++)
    if (all[i]!.seq === all[i - 1]!.seq)
      return refuse('validation_failed', 'each seq appears once in the candidates');

  const cut = policy.now - afterMs;
  const segments: ColdPlanSegment[] = [];
  const keep: number[] = [];
  let run: ColdPlanSegment | null = null;
  for (const c of all) {
    if (c.time >= cut) {
      keep.push(c.seq);
      run = null;
      continue;
    }
    if (run !== null && run.toSeq + 1 === c.seq) {
      run.toSeq = c.seq;
      run.path = `segments/${run.fromSeq}-${c.seq}.payloads.zst`;
      run.entries.push({ seq: c.seq, payloadHash: c.payloadHash });
    } else {
      run = {
        fromSeq: c.seq,
        toSeq: c.seq,
        path: `segments/${c.seq}-${c.seq}.payloads.zst`,
        entries: [{ seq: c.seq, payloadHash: c.payloadHash }],
      };
      segments.push(run);
    }
  }
  return { ok: true, segments, keep, held: policy.hold === true };
}

/** The hot store (`doc_commit_payloads` in the service). */
export interface HotPayloads {
  /** The canonical payload of `seq`, or undefined when it is not in the hot store. */
  get(seq: number): Promise<unknown | undefined>;
  /** Removes these payloads from the hot store. Atomic: on a throw, none is removed. */
  delete(seqs: readonly number[]): Promise<void>;
}

/** The object store for segments. A read of a missing object gives undefined. */
export interface SegmentObjects {
  put(path: string, bytes: Uint8Array): Promise<void>;
  get(path: string): Promise<Uint8Array | undefined>;
}

/**
 * The codec of a segment object. The service supplies zstd; `encode` and `decode` are each other's
 * inverse, and `decode` gives back the text `encode` was given.
 */
export interface SegmentCodec {
  encode(text: string): Promise<Uint8Array>;
  decode(bytes: Uint8Array): Promise<string>;
}

export interface ColdIo {
  hot: HotPayloads;
  objects: SegmentObjects;
  codec: SegmentCodec;
}

/** Why a cold move or read did not finish. Nothing is lost in any of these. */
export type ColdStatus = 'unavailable' | 'missing' | 'mismatch';

export type ColdMoveResult =
  | { ok: true; segment: SegmentRef; moved: number[] }
  | { ok: false; status: ColdStatus; reason: string };

/** The text of a segment object, before compression. Keys are sorted, so it is stable. */
export function segmentText(
  entries: ReadonlyArray<{ seq: number; payloadHash: string; payload: unknown }>,
): string {
  return canonicalize({
    format: PAYLOAD_SEGMENT_FORMAT,
    entries: entries.map((e) => ({ seq: e.seq, payloadHash: e.payloadHash, payload: e.payload })),
  });
}

/** Parses a segment object's text, checking its format. Returns null when it is not a segment. */
function parseSegment(
  text: string,
): Array<{ seq: number; payloadHash: string; payload: unknown }> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const v = value as { format?: unknown; entries?: unknown };
  if (v.format !== PAYLOAD_SEGMENT_FORMAT || !Array.isArray(v.entries)) return null;
  const out: Array<{ seq: number; payloadHash: string; payload: unknown }> = [];
  for (const e of v.entries) {
    if (typeof e !== 'object' || e === null) return null;
    const x = e as { seq?: unknown; payloadHash?: unknown; payload?: unknown };
    if (typeof x.seq !== 'number' || typeof x.payloadHash !== 'string') return null;
    out.push({ seq: x.seq, payloadHash: x.payloadHash, payload: x.payload });
  }
  return out;
}

/**
 * Moves one segment's payloads (HIS-029 criterion 3): writes the object, reads it back and checks
 * each payload hash against the metadata, then removes the payloads from the hot store. Any
 * failure before the removal leaves every payload in the hot store. The caller records `segment`
 * in the index in the same transaction as the removal (the service's job); a crash after the
 * object is written and before that leaves an orphan object and the payloads in the hot store, so
 * the next run writes the same path again.
 */
export async function moveSegment(segment: ColdPlanSegment, io: ColdIo): Promise<ColdMoveResult> {
  const seqs = segment.entries.map((e) => e.seq);
  const entries: Array<{ seq: number; payloadHash: string; payload: unknown }> = [];
  for (const e of segment.entries) {
    let payload: unknown;
    try {
      payload = await io.hot.get(e.seq);
    } catch {
      return { ok: false, status: 'unavailable', reason: 'the hot store could not be read' };
    }
    if (payload === undefined)
      return { ok: false, status: 'missing', reason: 'a payload to move is not in the hot store' };
    if ((await payloadDigest(payload)).hash !== e.payloadHash)
      return {
        ok: false,
        status: 'mismatch',
        reason: 'a stored payload does not match its recorded hash; it was not moved',
      };
    entries.push({ seq: e.seq, payloadHash: e.payloadHash, payload });
  }

  let written: Uint8Array;
  try {
    written = await io.codec.encode(segmentText(entries));
    await io.objects.put(segment.path, written);
  } catch {
    return { ok: false, status: 'unavailable', reason: 'the segment object could not be written' };
  }

  // The read-back is what makes the removal safe: the bytes that were written must come back.
  let back: Array<{ seq: number; payloadHash: string; payload: unknown }> | null;
  try {
    const bytes = await io.objects.get(segment.path);
    back = bytes === undefined ? null : parseSegment(await io.codec.decode(bytes));
  } catch {
    back = null;
  }
  if (back === null)
    return {
      ok: false,
      status: 'unavailable',
      reason: 'the segment object could not be read back',
    };
  const byseq = new Map(back.map((e) => [e.seq, e]));
  for (const e of entries) {
    const got = byseq.get(e.seq);
    if (got === undefined || (await payloadDigest(got.payload)).hash !== e.payloadHash)
      return {
        ok: false,
        status: 'mismatch',
        reason: 'the segment did not read back with matching hashes; the payloads were kept',
      };
  }

  try {
    await io.hot.delete(seqs);
  } catch {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'the hot store could not remove the payloads',
    };
  }
  return {
    ok: true,
    segment: { fromSeq: segment.fromSeq, toSeq: segment.toSeq, path: segment.path },
    moved: seqs,
  };
}

/** The index of segments a document has, as the service records them (one per moved run). */
export type SegmentIndex = readonly SegmentRef[];

export type ColdRead =
  | { ok: true; payloads: Array<{ seq: number; payload: unknown }> }
  | { ok: false; status: ColdStatus; reason: string; seq?: number };

export interface ColdReadInput {
  fromSeq: number;
  toSeq: number;
  /** The payload hash of every commit in the range, from the metadata. */
  hashes: ReadonlyMap<number, string>;
  index: SegmentIndex;
}

/**
 * The payloads of `fromSeq` to `toSeq` from both stores (HIS-029 criterion 2). A payload in the
 * hot store is read there; otherwise it is read from the segment that holds it, and the segment
 * is checked against the metadata hashes. A cold part that cannot be read is `unavailable` (criterion
 * 5). A range that lies wholly in the hot store never touches the segments, so it is not affected.
 */
export async function readPayloads(
  input: ColdReadInput,
  io: Pick<ColdIo, 'hot' | 'objects' | 'codec'>,
): Promise<ColdRead> {
  if (
    !Number.isSafeInteger(input.fromSeq) ||
    !Number.isSafeInteger(input.toSeq) ||
    input.fromSeq > input.toSeq
  )
    return {
      ok: false,
      status: 'missing',
      reason: 'the range is a pair of whole sequence numbers',
    };
  const out: Array<{ seq: number; payload: unknown }> = [];
  const loaded = new Map<string, Map<number, unknown>>();
  for (let seq = input.fromSeq; seq <= input.toSeq; seq++) {
    let hot: unknown | undefined;
    try {
      hot = await io.hot.get(seq);
    } catch {
      return { ok: false, status: 'unavailable', reason: 'the hot store could not be read', seq };
    }
    if (hot !== undefined) {
      out.push({ seq, payload: hot });
      continue;
    }
    const seg = input.index.find((s) => s.fromSeq <= seq && seq <= s.toSeq);
    if (seg === undefined)
      return { ok: false, status: 'missing', reason: 'a payload is in neither store', seq };
    let entries = loaded.get(seg.path);
    if (entries === undefined) {
      const got = await readSegment(seg.path, io);
      if (!got.ok) return { ...got, seq };
      entries = got.entries;
      loaded.set(seg.path, entries);
    }
    const payload = entries.get(seq);
    const want = input.hashes.get(seq);
    if (payload === undefined || want === undefined)
      return {
        ok: false,
        status: 'missing',
        reason: 'the segment does not hold that payload',
        seq,
      };
    if ((await payloadDigest(payload)).hash !== want)
      return {
        ok: false,
        status: 'mismatch',
        reason: 'a cold payload does not match its hash',
        seq,
      };
    out.push({ seq, payload });
  }
  return { ok: true, payloads: out };
}

async function readSegment(
  path: string,
  io: Pick<ColdIo, 'objects' | 'codec'>,
): Promise<
  { ok: true; entries: Map<number, unknown> } | { ok: false; status: ColdStatus; reason: string }
> {
  let bytes: Uint8Array | undefined;
  try {
    bytes = await io.objects.get(path);
  } catch {
    return { ok: false, status: 'unavailable', reason: 'the segment object cannot be read' };
  }
  if (bytes === undefined)
    return { ok: false, status: 'unavailable', reason: 'the segment object is missing' };
  let parsed: ReturnType<typeof parseSegment>;
  try {
    parsed = parseSegment(await io.codec.decode(bytes));
  } catch {
    parsed = null;
  }
  if (parsed === null)
    return { ok: false, status: 'unavailable', reason: 'the segment object cannot be decoded' };
  return { ok: true, entries: new Map(parsed.map((e) => [e.seq, e.payload])) };
}
