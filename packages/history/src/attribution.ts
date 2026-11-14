/**
 * The attribution map (08 §7; HIS-014): an ordered list of runs that covers every position of the
 * document exactly once, each naming the user and the `seq` that inserted that content.
 *
 * Each step updates it: existing runs are mapped through the step's position map and inserted
 * content gets a new run. Formatting (mark and attribute steps, and a wrapper re-typed in place)
 * changes no attribution in version 1, and an attribute change such as a field value creates no run
 * ("who filled this field" comes from the `field:<id>` scopes, HIS-016). Pasted or moved content is
 * inserted content, so it names the person who pasted or moved it. Content brought back by a
 * restore keeps its original authors and is marked as restored by the restoring user (the hint of
 * `applyStep`, computed by the restore plan).
 *
 * Runs are kept by length, not by position, in chunks of at most `CHUNK` runs, so that a step costs
 * a walk over the chunk sizes and the runs of the chunks it touches, not over the whole map. The
 * room host keeps one map next to the room and saves `toJSON()` with every checkpoint (06 §4.2,
 * `{seq}.side.json.zst`); `attributionAt` rebuilds the map at any `seq` from the nearest one.
 */
import type { Node, Schema } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  DocAttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  Step,
} from 'prosemirror-transform';
import type { LogCommit, Span as HiddenSpan, SnapshotCommit } from '@docedit/authority';
import type { Author } from './types.ts';

/** A stretch of `len` positions inserted by one author. */
export interface Run extends Author {
  len: number;
}

/** The author of a placeholder in a projection: nobody the reader may learn about. */
export const HIDDEN_AUTHOR: Readonly<Author> = Object.freeze({ user: '', seq: -1 });

/** Runs per chunk. */
export const CHUNK = 128;

interface Chunk {
  runs: Run[];
  size: number;
}

export function sameAuthor(a: Author, b: Author): boolean {
  return (
    a.user === b.user &&
    a.seq === b.seq &&
    a.agent === b.agent &&
    a.restoredBy === b.restoredBy &&
    a.restoredSeq === b.restoredSeq
  );
}

/** An author without the length of a run, with absent fields left out (exactOptionalPropertyTypes). */
export function authorOf(r: Author): Author {
  const a: Author = { user: r.user, seq: r.seq };
  if (r.agent !== undefined) a.agent = r.agent;
  if (r.restoredBy !== undefined) a.restoredBy = r.restoredBy;
  if (r.restoredSeq !== undefined) a.restoredSeq = r.restoredSeq;
  return a;
}

const run = (len: number, a: Author): Run => ({ ...authorOf(a), len });

/** The serialised form saved with a checkpoint (version 1). */
export interface AttributionJson {
  v: 1;
  /** Authors in order of first use: user, seq, agent, restored by, restored seq. */
  authors: Array<[string, number, string | null, string | null, number | null]>;
  /** Pairs of run length and author index. */
  runs: number[];
}

export class AttributionMap {
  private chunks: Chunk[];

  private constructor(chunks: Chunk[]) {
    this.chunks = chunks;
  }

  /** A map for a document of `size` positions written by one author (seq 0: the created content). */
  static create(size: number, author: Author): AttributionMap {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new RangeError(`a document has a size, not ${size}`);
    return new AttributionMap(size ? [{ runs: [run(size, author)], size }] : []);
  }

  static fromRuns(runs: readonly Run[]): AttributionMap {
    return new AttributionMap(chunked(mergeRuns(runs.filter((r) => r.len > 0))));
  }

  static fromJSON(json: AttributionJson): AttributionMap {
    if (json?.v !== 1 || !Array.isArray(json.authors) || !Array.isArray(json.runs))
      throw new TypeError('not an attribution map of version 1');
    const authors = json.authors.map(([user, seq, agent, restoredBy, restoredSeq]) => {
      const a: Author = { user, seq };
      if (agent !== null) a.agent = agent;
      if (restoredBy !== null) a.restoredBy = restoredBy;
      if (restoredSeq !== null) a.restoredSeq = restoredSeq;
      return a;
    });
    const runs: Run[] = [];
    for (let i = 0; i + 1 < json.runs.length; i += 2) {
      const a = authors[json.runs[i + 1]!];
      const len = json.runs[i]!;
      if (!a || !Number.isSafeInteger(len) || len <= 0)
        throw new TypeError(`attribution run ${i / 2} is not valid`);
      runs.push(run(len, a));
    }
    return AttributionMap.fromRuns(runs);
  }

  toJSON(): AttributionJson {
    const authors: AttributionJson['authors'] = [];
    const index = new Map<string, number>();
    const out: number[] = [];
    for (const r of this.runs()) {
      const key = authorKey(r);
      let i = index.get(key);
      if (i === undefined) {
        i = authors.length;
        index.set(key, i);
        authors.push([r.user, r.seq, r.agent ?? null, r.restoredBy ?? null, r.restoredSeq ?? null]);
      }
      out.push(r.len, i);
    }
    return { v: 1, authors, runs: out };
  }

  clone(): AttributionMap {
    return new AttributionMap(
      this.chunks.map((c) => ({ runs: c.runs.map((r) => ({ ...r })), size: c.size })),
    );
  }

  /** The number of positions covered: the content size of the document. */
  get size(): number {
    let s = 0;
    for (const c of this.chunks) s += c.size;
    return s;
  }

  /** The number of runs, adjacent runs of the same author counted once. */
  get runCount(): number {
    return this.runs().length;
  }

  /** All runs in order, adjacent runs of the same author merged. */
  runs(): Run[] {
    const flat: Run[] = [];
    for (const c of this.chunks) for (const r of c.runs) flat.push(r);
    return mergeRuns(flat);
  }

  equals(other: AttributionMap): boolean {
    const a = this.runs();
    const b = other.runs();
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++)
      if (a[i]!.len !== b[i]!.len || !sameAuthor(a[i]!, b[i]!)) return false;
    return true;
  }

  /** The author of the position `pos` (the content from `pos` to `pos + 1`), if any. */
  at(pos: number): Author | undefined {
    if (pos < 0) return undefined;
    let start = 0;
    for (const c of this.chunks) {
      if (pos >= start + c.size) {
        start += c.size;
        continue;
      }
      for (const r of c.runs) {
        if (pos < start + r.len) return r.user === '' ? undefined : authorOf(r);
        start += r.len;
      }
    }
    return undefined;
  }

  /** The runs that cover `from` to `to`, clipped to it, with their start positions. */
  slice(from: number, to: number): Array<Run & { from: number }> {
    const out: Array<Run & { from: number }> = [];
    if (to <= from) return out;
    let start = 0;
    for (const c of this.chunks) {
      if (start + c.size <= from) {
        start += c.size;
        continue;
      }
      if (start >= to) break;
      for (const r of c.runs) {
        const end = start + r.len;
        if (end > from && start < to) {
          const a = Math.max(start, from);
          const b = Math.min(end, to);
          const prev = out[out.length - 1];
          if (prev && sameAuthor(prev, r) && prev.from + prev.len === a) prev.len += b - a;
          else out.push({ ...authorOf(r), len: b - a, from: a });
        }
        start = end;
        if (start >= to) break;
      }
    }
    return out;
  }

  /** Replaces the positions from `from` to `to` with `runs` (an insertion when they are equal). */
  replace(from: number, to: number, runs: readonly Run[]): void {
    const total = this.size;
    if (from < 0 || to < from || to > total)
      throw new RangeError(`cannot replace ${from} to ${to} in a map of ${total}`);
    const inserted = runs.filter((r) => r.len > 0);
    if (from === to && inserted.length === 0) return;
    // The chunks that hold `from` and `to`.
    let ci = 0;
    let start = 0;
    while (ci < this.chunks.length - 1 && start + this.chunks[ci]!.size <= from) {
      start += this.chunks[ci]!.size;
      ci++;
    }
    let cj = ci;
    let endStart = start;
    while (cj < this.chunks.length - 1 && endStart + this.chunks[cj]!.size < to) {
      endStart += this.chunks[cj]!.size;
      cj++;
    }
    // Take the previous and next chunks too, so that runs merge across chunk edges.
    if (ci > 0) {
      ci--;
      start -= this.chunks[ci]!.size;
    }
    if (cj < this.chunks.length - 1) cj++;
    const seg: Run[] = [];
    for (let k = ci; k <= cj && k < this.chunks.length; k++) seg.push(...this.chunks[k]!.runs);
    const edited = editRuns(seg, from - start, to - start, inserted);
    this.chunks.splice(
      ci,
      Math.max(0, Math.min(cj, this.chunks.length - 1) - ci + 1),
      ...chunked(edited),
    );
  }

  /**
   * Applies one step (see the module comment). `hint`, from a restore, gives the original authors
   * of the inserted content; they are kept and marked as restored by `author` (08 §7).
   */
  applyStep(step: Step, author: Author, hint?: readonly Run[]): void {
    if (isFormatting(step)) return;
    const ranges: Array<[number, number, number, number]> = [];
    step.getMap().forEach((os, oe, ns, ne) => {
      ranges.push([os, oe, ns, ne]);
    });
    const structural = isStructural(step);
    const hinted =
      hint &&
      ranges.length === 1 &&
      hint.reduce((s, r) => s + r.len, 0) === ranges[0]![3] - ranges[0]![2]
        ? hint.map((r) => ({ ...r, restoredBy: author.user, restoredSeq: author.seq }))
        : null;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [os, oe, ns, ne] = ranges[i]!;
      const len = ne - ns;
      // A wrapper whose tokens are replaced by tokens of the same size is re-typed in place
      // (setBlockType, setNodeMarkup): formatting, so its runs stay.
      if (structural && oe - os === len) continue;
      this.replace(os, oe, len ? (hinted ?? [run(len, author)]) : []);
    }
  }
}

/**
 * Whether a step is a structural replace-around step (wrapping, lifting, re-typing a wrapper). The
 * flag is part of the step's JSON (`structure`) but not of the published type, so it is read here.
 */
export function isStructural(step: Step): boolean {
  return (
    step instanceof ReplaceAroundStep &&
    (step as unknown as { structure?: unknown }).structure === true
  );
}

/** Steps whose position map is empty and which change formatting or attributes only. */
export function isFormatting(step: Step): boolean {
  return (
    step instanceof AddMarkStep ||
    step instanceof RemoveMarkStep ||
    step instanceof AttrStep ||
    step instanceof DocAttrStep ||
    step instanceof AddNodeMarkStep ||
    step instanceof RemoveNodeMarkStep
  );
}

function authorKey(a: Author): string {
  return `${a.user}\u0000${a.seq}\u0000${a.agent ?? ''}\u0000${a.restoredBy ?? ''}\u0000${a.restoredSeq ?? ''}`;
}

function mergeRuns(runs: readonly Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r.len <= 0) continue;
    const last = out[out.length - 1];
    if (last && sameAuthor(last, r)) last.len += r.len;
    else out.push({ ...r });
  }
  return out;
}

function chunked(runs: readonly Run[]): Chunk[] {
  const out: Chunk[] = [];
  for (let i = 0; i < runs.length; i += CHUNK) {
    const part = runs.slice(i, i + CHUNK);
    out.push({ runs: part, size: part.reduce((s, r) => s + r.len, 0) });
  }
  return out;
}

/** Cuts `from` to `to` out of a list of runs and puts `inserted` in its place. */
function editRuns(runs: readonly Run[], from: number, to: number, inserted: readonly Run[]): Run[] {
  const before: Run[] = [];
  const after: Run[] = [];
  let pos = 0;
  for (const r of runs) {
    const end = pos + r.len;
    if (end <= from) before.push(r);
    else if (pos >= to) after.push(r);
    else {
      if (pos < from) before.push({ ...r, len: from - pos });
      if (end > to) after.push({ ...r, len: end - to });
    }
    pos = end;
  }
  return mergeRuns([...before, ...inserted.map((r) => ({ ...r })), ...after]);
}

// -----------------------------------------------------------------------------------------------
// Commits, replay and projection.

/**
 * How an author is labelled (13 §6.2; HIS-017): content an assistant wrote names the person and the
 * agent; content without an agent is the person's own, whatever origin its commit claimed. The
 * shell turns the label into text and an icon from its own strings.
 */
export interface AuthorLabel {
  kind: 'person' | 'assistant';
  user: string;
  agent?: string;
}

export function authorLabel(a: { user: string; agent?: string | undefined }): AuthorLabel {
  return a.agent !== undefined && a.agent !== ''
    ? { kind: 'assistant', user: a.user, agent: a.agent }
    : { kind: 'person', user: a.user };
}

/** The author a step commit stamps on what it inserts: its user, `seq` and agent (never its origin). */
export function commitAuthor(c: Pick<LogCommit, 'user' | 'seq' | 'agent'>): Author {
  const a: Author = { user: c.user, seq: c.seq };
  if (c.agent !== undefined) a.agent = c.agent;
  return a;
}

/** Runs for each step of a restore commit, by step index (08 §7: restored runs keep their authors). */
export type RestoreHint = ReadonlyArray<readonly Run[] | undefined>;

/** Applies a stored step or control commit to a map. Snapshot commits replace the map instead. */
export function applyCommit(
  map: AttributionMap,
  commit: LogCommit,
  schema: Schema,
  hint?: RestoreHint,
): void {
  if (commit.kind !== 'steps') return;
  const author = commitAuthor(commit);
  commit.steps.forEach((json, i) => {
    map.applyStep(Step.fromJSON(schema, json), author, hint?.[i]);
  });
}

export interface AttributionSource {
  schema: Schema;
  /** Maps saved with checkpoints, seq 0 among them (the created content). */
  checkpoints: ReadonlyArray<{ seq: number; map: AttributionMap }>;
  /** The commits after a `seq` up to another, in order. */
  commits: (afterSeq: number, toSeq: number) => readonly LogCommit[];
  /** The map saved with a snapshot commit's checkpoint. */
  snapshot?: (c: SnapshotCommit) => AttributionMap | undefined;
  /** The hint of a restore commit, when a replay crosses one (ADR 0051). */
  restoreHint?: (seq: number) => RestoreHint | undefined;
}

export type AttributionResult =
  | { ok: true; seq: number; map: AttributionMap; from: number; replayed: number }
  | { ok: false; code: 'not_found' | 'internal'; reason: string };

/** The attribution map at `seq`: the nearest saved map at or before it plus a replay. */
export function attributionAt(seq: number, source: AttributionSource): AttributionResult {
  let start: { seq: number; map: AttributionMap } | undefined;
  for (const c of source.checkpoints) if (c.seq <= seq && (!start || c.seq > start.seq)) start = c;
  if (!start) return { ok: false, code: 'not_found', reason: `no saved map at or before ${seq}` };
  const commits = source.commits(start.seq, seq);
  let map = start.map.clone();
  let expected = start.seq + 1;
  let replayed = 0;
  for (const c of commits) {
    if (c.seq !== expected)
      return { ok: false, code: 'internal', reason: `the log has a gap at ${expected}` };
    expected++;
    if (c.kind === 'snapshot') {
      const m = source.snapshot?.(c);
      if (!m)
        return { ok: false, code: 'internal', reason: `no saved map for snapshot commit ${c.seq}` };
      map = m.clone();
      continue;
    }
    try {
      applyCommit(map, c, source.schema, source.restoreHint?.(c.seq));
    } catch (e) {
      return { ok: false, code: 'internal', reason: `commit ${c.seq}: ${(e as Error).message}` };
    }
    replayed++;
  }
  if (expected !== seq + 1)
    return { ok: false, code: 'internal', reason: `the log ends at ${expected - 1}, not ${seq}` };
  return { ok: true, seq, map, from: start.seq, replayed };
}

/**
 * The map of a projection (ADR 0019): every hidden region becomes one position of no author, so
 * that a reader learns neither who wrote hidden content nor how much of it there is.
 */
export function projectAttribution(
  map: AttributionMap,
  spans: readonly HiddenSpan[],
): AttributionMap {
  const out = map.clone();
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]!;
    out.replace(s.fullStart, s.fullStart + s.fullSize, [run(1, HIDDEN_AUTHOR)]);
  }
  return out;
}

/** Checks that a map covers a document exactly: one run per position, no gap and no overlap. */
export function coversExactly(map: AttributionMap, doc: Node): boolean {
  const runs = map.runs();
  return runs.every((r) => r.len > 0) && runs.reduce((s, r) => s + r.len, 0) === doc.content.size;
}
