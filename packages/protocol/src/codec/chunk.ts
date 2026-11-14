/**
 * Chunking (05 §4; PRO-018 groundwork). A message whose UTF-8 size exceeds `maxMessageBytes` is
 * sent as `chunk` messages: `of` a fresh identifier, `i` and `n` the index and count, `part` a
 * substring of the serialised message split only between Unicode code points. Decision D04: `i`
 * counts from 0, `chunk` is session-level, and every chunk frame, envelope included, fits within
 * `maxMessageBytes`.
 */
import { utf8Length } from './frame.ts';

/** Bytes a code point takes inside a JSON string literal, encoded as UTF-8. */
function escapedBytes(cp: number, lone: boolean): number {
  if (lone) return 6; // a lone surrogate is written as \uXXXX
  if (cp === 0x22 || cp === 0x5c) return 2;
  if (cp < 0x20)
    return cp === 0x08 || cp === 0x09 || cp === 0x0a || cp === 0x0c || cp === 0x0d ? 2 : 6;
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3;
  return 4;
}

interface CodePoint {
  /** UTF-16 index where the code point starts. */
  at: number;
  /** UTF-16 length: 1 or 2. */
  units: number;
  bytes: number;
}

function* codePoints(text: string): Generator<CodePoint> {
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        yield { at: i, units: 2, bytes: 4 };
        i += 2;
        continue;
      }
    }
    const lone = c >= 0xd800 && c <= 0xdfff;
    yield { at: i, units: 1, bytes: escapedBytes(c, lone) };
    i += 1;
  }
}

function chunkFrame(of: string, i: number, n: number, part: string): string {
  return JSON.stringify({ t: 'chunk', d: { of, i, n, part } });
}

/** Whether a serialised message must be chunked. */
export function needsChunking(serialised: string, maxMessageBytes: number): boolean {
  return utf8Length(serialised) > maxMessageBytes;
}

/**
 * Splits a serialised message into chunk frames of at most `maxMessageBytes` each. Throws a
 * RangeError when the limit cannot hold even one code point with the envelope.
 */
export function chunkMessage(serialised: string, maxMessageBytes: number, of: string): string[] {
  // The overhead depends on the number of digits of n; retry with more digits if the count grows.
  for (let digits = 1; digits <= 16; digits++) {
    const big = 10 ** digits - 1;
    const overhead = utf8Length(chunkFrame(of, big, big, ''));
    const budget = maxMessageBytes - overhead;
    if (budget < 6) throw new RangeError(`maxMessageBytes ${maxMessageBytes} cannot hold a chunk`);
    const parts: string[] = [];
    let start = 0;
    let used = 0;
    for (const cp of codePoints(serialised)) {
      if (used + cp.bytes > budget) {
        parts.push(serialised.slice(start, cp.at));
        start = cp.at;
        used = 0;
      }
      used += cp.bytes;
    }
    parts.push(serialised.slice(start));
    if (parts.length > big) continue;
    if (parts.length < 2) return [chunkFrame(of, 0, 2, serialised), chunkFrame(of, 1, 2, '')];
    return parts.map((p, i) => chunkFrame(of, i, parts.length, p));
  }
  throw new RangeError('too many chunks');
}

export interface ChunkPayload {
  of: string;
  i: number;
  n: number;
  part: string;
}

export type ReassemblyResult =
  | { status: 'partial' }
  | { status: 'complete'; text: string }
  | { status: 'error'; reason: string };

/**
 * Reassembles chunks received on one connection. Chunks of one message arrive consecutively
 * (05 §4); a reassembly not completed within `timeoutMs` (10 seconds) is abandoned. What happens
 * next is not stated (G14): the caller decides.
 */
export class Reassembler {
  private current: {
    of: string;
    n: number;
    next: number;
    parts: string[];
    startedAt: number;
  } | null = null;
  readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  get pending(): boolean {
    return this.current !== null;
  }

  /** Drops a reassembly older than the timeout; returns its `of` when one was dropped. */
  expire(nowMs: number): string | null {
    if (this.current && nowMs - this.current.startedAt >= this.timeoutMs) {
      const of = this.current.of;
      this.current = null;
      return of;
    }
    return null;
  }

  push(chunk: ChunkPayload, nowMs: number): ReassemblyResult {
    this.expire(nowMs);
    if (!this.current) {
      if (chunk.i !== 0)
        return { status: 'error', reason: `chunk ${chunk.i} of ${chunk.of} without its start` };
      this.current = { of: chunk.of, n: chunk.n, next: 0, parts: [], startedAt: nowMs };
    }
    const c = this.current;
    if (chunk.of !== c.of) {
      this.current = null;
      return { status: 'error', reason: `chunks of ${chunk.of} interleave with ${c.of}` };
    }
    if (chunk.n !== c.n || chunk.i !== c.next) {
      this.current = null;
      return { status: 'error', reason: `chunk ${chunk.i}/${chunk.n} out of order` };
    }
    c.parts.push(chunk.part);
    c.next++;
    if (c.next < c.n) return { status: 'partial' };
    this.current = null;
    return { status: 'complete', text: c.parts.join('') };
  }
}
