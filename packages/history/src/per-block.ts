/**
 * The attribution map stored per block (08 §15, third bullet; HIS-044), for comparison with the
 * one map per document of `attribution.ts`. The document is cut into segments: everything before
 * the body's content (definitions, stories and the body's opening token), each child of the body,
 * and the body's closing token. Each segment holds the runs that cover it, so "who wrote this" for
 * a region is one lookup by identifier, and a step rewrites only the segments it touches.
 *
 * It is a measurement prototype: the room host keeps `AttributionMap`, unless HIS-044's figures
 * argue otherwise (ADR 0051).
 */
import type { Node } from 'prosemirror-model';
import type { Step } from 'prosemirror-transform';
import {
  AttributionMap,
  type Run,
  authorOf,
  isFormatting,
  isStructural,
  sameAuthor,
} from './attribution.ts';
import type { Author } from './types.ts';

interface Segment {
  key: string;
  size: number;
}

const HEAD = '#head';
const TAIL = '#tail';

function bodyOf(doc: Node): { body: Node; start: number } {
  const body = doc.child(doc.childCount - 1);
  return { body, start: doc.content.size - body.nodeSize + 1 };
}

function keyOf(n: Node, i: number): string {
  const id = n.attrs['id'];
  return typeof id === 'string' && id ? id : `#${i}`;
}

function layout(doc: Node): Segment[] {
  const { body, start } = bodyOf(doc);
  const out: Segment[] = [{ key: HEAD, size: start }];
  body.forEach((c, _, i) => out.push({ key: keyOf(c, i), size: c.nodeSize }));
  out.push({ key: TAIL, size: 1 });
  return out;
}

function splitRuns(runs: readonly Run[], sizes: readonly number[]): Run[][] {
  const out: Run[][] = [];
  let k = 0;
  let left = runs[0] ? { ...runs[0] } : null;
  for (const size of sizes) {
    const seg: Run[] = [];
    let need = size;
    while (need > 0 && left) {
      const take = Math.min(need, left.len);
      seg.push({ ...left, len: take });
      need -= take;
      left.len -= take;
      if (left.len === 0) {
        k++;
        left = runs[k] ? { ...runs[k]! } : null;
      }
    }
    out.push(seg);
  }
  return out;
}

export class BlockAttribution {
  private keys: string[];
  private sizes: number[];
  private segs: Run[][];
  private index: Map<string, number> | null = null;

  private constructor(keys: string[], sizes: number[], segs: Run[][]) {
    this.keys = keys;
    this.sizes = sizes;
    this.segs = segs;
  }

  /** Cuts a document map into segments of `doc`. */
  static fromMap(map: AttributionMap, doc: Node): BlockAttribution {
    const l = layout(doc);
    return new BlockAttribution(
      l.map((s) => s.key),
      l.map((s) => s.size),
      splitRuns(
        map.runs(),
        l.map((s) => s.size),
      ),
    );
  }

  get runCount(): number {
    let n = 0;
    for (const s of this.segs) n += s.length;
    return n;
  }

  get segmentCount(): number {
    return this.segs.length;
  }

  /** The runs of one body child (a region, a paragraph, a table) by identifier. */
  runsOf(id: string): Run[] | undefined {
    if (!this.index) this.index = new Map(this.keys.map((k, i) => [k, i]));
    const i = this.index.get(id);
    return i === undefined ? undefined : this.segs[i]!.map((r) => ({ ...r }));
  }

  /** The whole map again, for checks. */
  toMap(): AttributionMap {
    return AttributionMap.fromRuns(this.segs.flat());
  }

  /** The serialised form: the shared author table and each segment's runs. */
  toJSON(): {
    v: 1;
    authors: Array<[string, number, string | null, string | null, number | null]>;
    blocks: Array<[string, number[]]>;
  } {
    const authors: Array<[string, number, string | null, string | null, number | null]> = [];
    const index = new Map<string, number>();
    const blocks: Array<[string, number[]]> = [];
    this.segs.forEach((seg, i) => {
      const pairs: number[] = [];
      for (const r of seg) {
        const key = `${r.user}\u0000${r.seq}\u0000${r.agent ?? ''}\u0000${r.restoredBy ?? ''}\u0000${r.restoredSeq ?? ''}`;
        let a = index.get(key);
        if (a === undefined) {
          a = authors.length;
          index.set(key, a);
          authors.push([
            r.user,
            r.seq,
            r.agent ?? null,
            r.restoredBy ?? null,
            r.restoredSeq ?? null,
          ]);
        }
        pairs.push(r.len, a);
      }
      blocks.push([this.keys[i]!, pairs]);
    });
    return { v: 1, authors, blocks };
  }

  /**
   * Applies one step; `after` is the document after it (for the new segment boundaries). `hint`
   * has the meaning of `AttributionMap.applyStep`'s.
   */
  applyStep(step: Step, author: Author, after: Node, hint?: readonly Run[]): void {
    if (isFormatting(step)) return;
    const ranges: Array<[number, number, number, number]> = [];
    step.getMap().forEach((os, oe, ns, ne) => {
      ranges.push([os, oe, ns, ne]);
    });
    const structural = isStructural(step);
    const edits = ranges.filter(([os, oe, ns, ne]) => !(structural && oe - os === ne - ns));
    const hinted =
      hint &&
      ranges.length === 1 &&
      hint.reduce((s, r) => s + r.len, 0) === ranges[0]![3] - ranges[0]![2]
        ? hint.map((r) => ({ ...r, restoredBy: author.user, restoredSeq: author.seq }))
        : null;
    if (!edits.length) return;
    const lo = Math.min(...edits.map((r) => r[0]));
    const hi = Math.max(...edits.map((r) => r[1]));
    // The segments the edit touches, by a walk over the segment sizes.
    let i = 0;
    let start = 0;
    while (i < this.sizes.length - 1 && start + this.sizes[i]! < lo) {
      start += this.sizes[i]!;
      i++;
    }
    let j = i;
    let end = start + this.sizes[i]!;
    while (j < this.sizes.length - 1 && end <= hi) {
      j++;
      end += this.sizes[j]!;
    }
    const flat = AttributionMap.fromRuns(this.segs.slice(i, j + 1).flat());
    for (let r = edits.length - 1; r >= 0; r--) {
      const [os, oe, ns, ne] = edits[r]!;
      flat.replace(
        os - start,
        oe - start,
        ne > ns ? (hinted ?? [{ ...authorOf(author), len: ne - ns }]) : [],
      );
    }
    const total = flat.size;
    // The new segments over the same stretch: from segment i on, in the document after.
    const l: Segment[] = [];
    const { body, start: bodyStart } = bodyOf(after);
    let covered = 0;
    let k = i;
    if (k === 0) {
      l.push({ key: HEAD, size: bodyStart });
      covered += bodyStart;
      k = 1;
    }
    let child = k - 1;
    while (covered < total) {
      if (child < body.childCount) {
        const c = body.child(child);
        l.push({ key: keyOf(c, child), size: c.nodeSize });
        covered += c.nodeSize;
        child++;
      } else {
        l.push({ key: TAIL, size: 1 });
        covered += 1;
      }
    }
    if (covered !== total) {
      // The edit did not end on a segment boundary of the new document: lay everything out again.
      const whole = AttributionMap.fromRuns([
        ...this.segs.slice(0, i).flat(),
        ...flat.runs(),
        ...this.segs.slice(j + 1).flat(),
      ]);
      const again = BlockAttribution.fromMap(whole, after);
      this.keys = again.keys;
      this.sizes = again.sizes;
      this.segs = again.segs;
      this.index = null;
      return;
    }
    const parts = splitRuns(
      flat.runs(),
      l.map((s) => s.size),
    );
    this.keys.splice(i, j - i + 1, ...l.map((s) => s.key));
    this.sizes.splice(i, j - i + 1, ...l.map((s) => s.size));
    this.segs.splice(i, j - i + 1, ...parts.map((p) => mergeAdjacent(p)));
    this.index = null;
  }
}

function mergeAdjacent(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && sameAuthor(last, r)) last.len += r.len;
    else out.push(r);
  }
  return out;
}
