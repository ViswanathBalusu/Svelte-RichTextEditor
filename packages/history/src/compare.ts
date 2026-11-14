/**
 * Comparing two versions (08 §6; HIS-011, HIS-012; ADR 0051, proposed).
 *
 * Both methods compare the requester's projections of the two versions (ADR 0019), so that hidden
 * regions are placeholders and hidden values are redaction markers before anything is compared,
 * and they share one classification of blocks by identifier:
 *
 * - `added` and `removed`: the outermost identified block present on one side only;
 * - `moved`: present on both sides, but in another container or out of order among the blocks the
 *   two sides share (the longest common subsequence keeps the rest in place);
 * - `modified`: a leaf block whose inline content differs, with insert and delete spans from a
 *   word-level (or character-level) diff of its tokens, at offsets in the newer version;
 * - `formatted`: block attributes, block marks or the marks of unchanged text differ, with the
 *   attribute and mark names;
 * - `field`: a form field present on both sides whose value differs;
 * - `definition`: a style, numbering or other definition added, removed or changed (ADR 0051:
 *   not in 08 §6's list, proposed with the HIS-043 recommendation).
 *
 * The methods differ in where authorship comes from:
 *
 * - from the recorded steps (`compareSteps`), for versions at most 2,000 commits apart with no
 *   snapshot commit between them: `prosemirror-changeset` over the projected steps of every commit
 *   gives, for each position, the commit that inserted it and the commit that deleted it, so both
 *   insert and delete spans carry a user and a `seq`, and formatting carries the commit that
 *   changed it last;
 * - by aligning blocks (`compareStates`), otherwise: insert spans, added and moved blocks name the
 *   author from the attribution map at the later version; deletions and formatting name nobody,
 *   because the map records neither (HIS-012 Notes). A named version's comparison always uses this
 *   method, so that no intermediate commit appears (ADR 0034).
 *
 * Field and definition changes name the latest commit in the range whose scopes include
 * `field:<id>` or `defs:<type>/<id>` (the per-scope table, 06 §4.1). Placeholders of hidden regions
 * never name anybody.
 */
import {
  type HiddenSet,
  type LogCommit,
  NOTHING_HIDDEN,
  project,
  projectCommit,
  projectionSchema,
  rangeVisible,
  stateVisible,
  visibilityKey,
} from '@docedit/authority';
import { ChangeSet, type Change as PmChange } from 'prosemirror-changeset';
import type { Node, Schema } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  Step,
} from 'prosemirror-transform';
import {
  type AttributionMap,
  commitAuthor,
  isStructural,
  projectAttribution,
  sameAuthor,
} from './attribution.ts';
import {
  type BlockEntry,
  type DocIndex,
  type Granularity,
  PLACEHOLDER,
  type Token,
  changedAttrs,
  changedNodeMarks,
  indexDocument,
  stableJson,
  tokenize,
} from './blocks.ts';
import { DEFAULT_MAX_COST, diffTokens } from './diff.ts';
import { type Author, type HistoryGate, type HistoryResult, refuse } from './types.ts';

export type ChangeKind =
  'modified' | 'added' | 'removed' | 'moved' | 'formatted' | 'field' | 'definition';

/** One insertion or deletion inside a block (08 §6). */
export interface DiffSpan {
  op: 'insert' | 'delete';
  /** Offset in the block's content in the newer version (ProseMirror positions). */
  at: number;
  text: string;
  /** Who made it, when known: the commit for the step method, the inserting author otherwise. */
  user?: string;
  seq?: number;
  agent?: string;
  /** For inserted text that a restore brought back (08 §7). */
  restoredBy?: string;
}

export interface Change {
  kind: ChangeKind;
  blockId?: string;
  fieldId?: string;
  /** `<type>/<id>` of a definition, or `settings`. */
  defId?: string;
  /** For `definition`: what happened to it. */
  change?: 'added' | 'removed' | 'changed';
  /** The node type of the block. */
  type?: string;
  /** Identifiers of the identified ancestors, outermost first (tables: table, row, cell). */
  path?: string[];
  /** The region the block or field is in. */
  region?: string;
  spans?: DiffSpan[];
  attrs?: string[];
  marks?: string[];
  user?: string;
  seq?: number;
  agent?: string;
  /** The placeholder of a region the requester may not read. */
  hidden?: true;
}

export type ComparisonMethod = 'steps' | 'aligned';

export interface Comparison {
  fromSeq: number;
  toSeq: number;
  method: ComparisonMethod;
  granularity: Granularity;
  region?: string;
  changes: Change[];
}

/** Versions at most this many commits apart are compared from their steps (08 §6). */
export const STEP_LIMIT = 2000;

// -----------------------------------------------------------------------------------------------
// Where authorship comes from.

interface Range {
  from: number;
  to: number;
  data: Author;
}

interface Oracle {
  /** The author of the content at a position of the newer version. */
  inserted(pos: number): Author | undefined;
  /** Who deleted the content at a position of the older version. */
  deleted(pos: number): Author | undefined;
  /** For text that moved into a block without being written there: the change nearest to it. */
  near(block: BlockEntry, pos: number): Author | undefined;
  /** Who last changed a block's formatting. */
  formatted(blockId: string): Author | undefined;
  /** The latest commit in the range with a scope. */
  scope(scope: string): Author | undefined;
}

function findRange(ranges: readonly Range[], pos: number): Author | undefined {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const r = ranges[mid]!;
    if (pos < r.from) hi = mid - 1;
    else if (pos >= r.to) lo = mid + 1;
    else return r.data;
  }
  return undefined;
}

function spanRanges(start: number, spans: PmChange<Author>['inserted']): Range[] {
  const out: Range[] = [];
  let p = start;
  for (const s of spans) {
    if (s.length > 0 && s.data) out.push({ from: p, to: p + s.length, data: s.data });
    p += s.length;
  }
  return out;
}

const noAuthor = (): undefined => undefined;

// -----------------------------------------------------------------------------------------------
// The shared classification.

const KIND_RANK: Record<ChangeKind, number> = {
  definition: 0,
  removed: 1,
  added: 2,
  moved: 3,
  modified: 4,
  formatted: 5,
  field: 6,
};

function withAuthor<T extends object>(target: T, a: Author | undefined): T {
  if (!a) return target;
  const t = target as T & { user?: string; seq?: number; agent?: string };
  t.user = a.user;
  t.seq = a.seq;
  if (a.agent !== undefined) t.agent = a.agent;
  return target;
}

function blockChange(kind: ChangeKind, e: BlockEntry): Change {
  const c: Change = { kind, blockId: e.id, type: e.type };
  if (e.path.length) c.path = [...e.path];
  if (e.region !== null && e.region !== e.id) c.region = e.region;
  if (e.type === PLACEHOLDER) c.hidden = true;
  return c;
}

/** Indices of the longest increasing subsequence (patience sorting). */
function longestIncreasing(xs: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prev = new Array<number>(xs.length).fill(-1);
  for (let i = 0; i < xs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (xs[tails[mid]!]! < xs[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length ? tails[tails.length - 1]! : -1;
  while (k >= 0) {
    keep.add(k);
    k = prev[k]!;
  }
  return keep;
}

/** Blocks present on both sides that changed container or order. */
function movedBlocks(A: DocIndex, B: DocIndex): Set<string> {
  const moved = new Set<string>();
  for (const [parent, idsB] of B.children) {
    const idsA = A.children.get(parent) ?? [];
    const posA = new Map(idsA.map((id, i) => [id, i]));
    const common = idsB.filter((id) => posA.has(id));
    const seq = common.map((id) => posA.get(id)!);
    const keep = longestIncreasing(seq);
    common.forEach((id, i) => {
      if (!keep.has(i)) moved.add(id);
    });
    for (const id of idsB) {
      const a = A.blocks.get(id);
      if (a && a.parent !== parent) moved.add(id);
    }
  }
  return moved;
}

function markChange(ta: Token, tb: Token): string[] {
  const sa = new Set(ta.markNames);
  const sb = new Set(tb.markNames);
  const out = new Set<string>();
  for (const n of sa) if (!sb.has(n)) out.add(n);
  for (const n of sb) if (!sa.has(n)) out.add(n);
  if (out.size === 0) for (const n of [...sa, ...sb]) out.add(n);
  return [...out];
}

/** Splits a run of tokens into spans, one per author. */
function piecesOf(
  tokens: readonly Token[],
  base: number,
  authorAt: (pos: number) => Author | undefined,
): Array<{ off: number; text: string; author: Author | undefined }> {
  const out: Array<{ off: number; text: string; author: Author | undefined }> = [];
  const push = (off: number, text: string, author: Author | undefined) => {
    const last = out[out.length - 1];
    const same =
      last &&
      (last.author === author || (last.author && author && sameAuthor(last.author, author)));
    if (last && same) last.text += text;
    else out.push({ off, text, author });
  };
  for (const t of tokens) {
    if (t.key !== t.text || t.size !== t.text.length) {
      // An inline node: one piece, authored at its position.
      push(t.off, t.text, authorAt(base + t.off));
      continue;
    }
    for (let i = 0; i < t.text.length; i++) push(t.off + i, t.text[i]!, authorAt(base + t.off + i));
  }
  return out;
}

function toSpan(
  op: 'insert' | 'delete',
  at: number,
  text: string,
  a: Author | undefined,
): DiffSpan {
  const s: DiffSpan = { op, at, text };
  if (a) {
    s.user = a.user;
    s.seq = a.seq;
    if (a.agent !== undefined) s.agent = a.agent;
    if (a.restoredBy !== undefined) s.restoredBy = a.restoredBy;
  }
  return s;
}

function leafChanges(
  a: BlockEntry,
  b: BlockEntry,
  oracle: Oracle,
  granularity: Granularity,
  maxCost: number,
): { spans: DiffSpan[]; marks: string[] } {
  const ta = tokenize(a.node, granularity);
  const tb = tokenize(b.node, granularity);
  const edits = diffTokens(
    ta.map((t) => t.key),
    tb.map((t) => t.key),
    maxCost,
  );
  const spans: DiffSpan[] = [];
  const marks = new Set<string>();
  const baseA = a.pos + 1;
  const baseB = b.pos + 1;
  const endB = tb.length ? tb[tb.length - 1]!.off + tb[tb.length - 1]!.size : 0;
  for (const e of edits) {
    if (e.op === 'equal') {
      for (let j = 0; j < e.n; j++) {
        const x = ta[e.a + j]!;
        const y = tb[e.b + j]!;
        if (x.marks !== y.marks) for (const n of markChange(x, y)) marks.add(n);
      }
      continue;
    }
    // Text that was not written or deleted in the range itself (a word only partly typed, text a
    // split or a join moved) is attributed to the nearest change, so that one word is one span.
    if (e.op === 'delete') {
      const at = e.b < tb.length ? tb[e.b]!.off : endB;
      const pieces = piecesOf(
        ta.slice(e.a, e.a + e.n),
        baseA,
        (p) => oracle.deleted(p) ?? oracle.near(b, baseB + at),
      );
      for (const p of pieces) spans.push(toSpan('delete', at, p.text, p.author));
    } else {
      const pieces = piecesOf(
        tb.slice(e.b, e.b + e.n),
        baseB,
        (p) => oracle.inserted(p) ?? oracle.near(b, p),
      );
      for (const p of pieces) spans.push(toSpan('insert', p.off, p.text, p.author));
    }
  }
  return { spans, marks: [...marks].sort() };
}

interface Sorted {
  key: [number, number, number, number];
  change: Change;
}

/** The changes between two indexed documents (both projections for the same hidden set). */
function classify(
  A: DocIndex,
  B: DocIndex,
  oracle: Oracle,
  granularity: Granularity,
  maxCost: number,
): Change[] {
  const out: Sorted[] = [];
  // Definitions first, in key order.
  const defKeys = [...new Set([...A.definitions.keys(), ...B.definitions.keys()])].sort();
  defKeys.forEach((key, i) => {
    const a = A.definitions.get(key);
    const b = B.definitions.get(key);
    let change: Change | null = null;
    if (a && !b) change = { kind: 'definition', defId: key, change: 'removed', type: a.type };
    else if (!a && b) change = { kind: 'definition', defId: key, change: 'added', type: b.type };
    else if (a && b && a.node !== b.node) {
      const attrs = changedAttrs(a.node, b.node, []);
      if (attrs.length)
        change = { kind: 'definition', defId: key, change: 'changed', type: b.type, attrs };
    }
    if (change)
      out.push({ key: [-1, i, 0, 0], change: withAuthor(change, oracle.scope(`defs:${key}`)) });
  });

  const moved = movedBlocks(A, B);
  const added = new Set<string>();
  const indexB = new Map<string, number>();
  B.order.forEach((b, i) => indexB.set(b.id, i));
  B.order.forEach((b, i) => {
    const a = A.blocks.get(b.id);
    const hidden = b.type === PLACEHOLDER;
    if (!a || a.type !== b.type) {
      if (b.path.some((id) => added.has(id))) {
        added.add(b.id);
        return;
      }
      added.add(b.id);
      const c = blockChange('added', b);
      out.push({
        key: [2 * i, 0, KIND_RANK.added, 0],
        change: hidden ? c : withAuthor(c, oracle.inserted(b.pos)),
      });
      return;
    }
    if (moved.has(b.id)) {
      const c = blockChange('moved', b);
      out.push({
        key: [2 * i, 0, KIND_RANK.moved, 0],
        change: hidden ? c : withAuthor(c, oracle.inserted(b.pos)),
      });
    }
    if (a.node === b.node) return;
    const attrs = changedAttrs(a.node, b.node);
    const nodeMarks = changedNodeMarks(a.node, b.node);
    let marks: string[] = [];
    if (b.leaf && !hidden) {
      const r = leafChanges(a, b, oracle, granularity, maxCost);
      marks = r.marks;
      if (r.spans.length) {
        const c = blockChange('modified', b);
        c.spans = r.spans;
        out.push({ key: [2 * i, 0, KIND_RANK.modified, 0], change: c });
      }
    }
    const allMarks = [...new Set([...nodeMarks, ...marks])].sort();
    if (attrs.length || allMarks.length) {
      const c = blockChange('formatted', b);
      if (attrs.length) c.attrs = attrs;
      if (allMarks.length) c.marks = allMarks;
      out.push({
        key: [2 * i, 0, KIND_RANK.formatted, 0],
        change: hidden ? c : withAuthor(c, oracle.formatted(b.id)),
      });
    }
  });

  // Removed blocks, placed after the block of the older version before them that survives (its
  // container, or the last block before them), so that a block replaced in place reads as removed
  // and then added.
  const prevSurviving = new Array<number>(A.order.length);
  let prev = -1;
  for (let i = 0; i < A.order.length; i++) {
    prevSurviving[i] = prev;
    const at = indexB.get(A.order[i]!.id);
    if (at !== undefined && B.blocks.get(A.order[i]!.id)!.type === A.order[i]!.type) prev = at;
  }
  const removed = new Set<string>();
  A.order.forEach((a, i) => {
    const b = B.blocks.get(a.id);
    if (b && b.type === a.type) return;
    if (a.path.some((id) => removed.has(id))) {
      removed.add(a.id);
      return;
    }
    removed.add(a.id);
    const c = blockChange('removed', a);
    out.push({
      key: [2 * prevSurviving[i]! + 1, i, KIND_RANK.removed, 0],
      change: a.type === PLACEHOLDER ? c : withAuthor(c, oracle.deleted(a.pos)),
    });
  });

  // Field values, after the changes of the block that holds them.
  for (const [id, fb] of B.fields) {
    const fa = A.fields.get(id);
    if (!fa) continue;
    if (stableJson(fa.node.attrs['value']) === stableJson(fb.node.attrs['value'])) continue;
    const c: Change = { kind: 'field', fieldId: id, blockId: fb.block };
    if (fb.region !== null) c.region = fb.region;
    out.push({
      key: [2 * (indexB.get(fb.block) ?? B.order.length), 0, KIND_RANK.field, fb.pos],
      change: withAuthor(c, oracle.scope(`field:${id}`)),
    });
  }

  out.sort((x, y) => {
    for (let k = 0; k < 4; k++) if (x.key[k] !== y.key[k]) return x.key[k]! - y.key[k]!;
    return 0;
  });
  return out.map((s) => s.change);
}

function regionFilter(changes: Change[], region: string): Change[] {
  return changes.filter(
    (c) => c.kind !== 'definition' && (c.region === region || c.blockId === region),
  );
}

function regionExists(index: DocIndex, region: string): boolean {
  const e = index.blocks.get(region);
  return !!e && (e.type === 'region' || e.type === PLACEHOLDER);
}

/** The hidden set applied to scopes: a reader never learns about a hidden region or value. */
function visibleScope(scope: string, hidden: HiddenSet): boolean {
  if (scope.startsWith('region:')) return !hidden.regions.has(scope.slice(7));
  if (scope.startsWith('field:')) return !hidden.values.has(scope.slice(6));
  return true;
}

// -----------------------------------------------------------------------------------------------
// From the recorded steps (HIS-011).

export interface StepsComparisonInput {
  /** The CDM schema the stored steps are in. */
  schema: Schema;
  /** The full document at `fromSeq`. */
  from: { seq: number; doc: Node };
  /** The stored commits from `fromSeq + 1` to `toSeq`, in order; no snapshot commit among them. */
  commits: readonly LogCommit[];
  /** The requester's hidden set (ADR 0019); nothing hidden when absent. */
  hidden?: HiddenSet;
  granularity?: Granularity;
  region?: string;
  maxCost?: number;
}

export function compareSteps(
  input: StepsComparisonInput,
): HistoryResult<{ comparison: Comparison }> {
  const hidden = input.hidden ?? NOTHING_HIDDEN;
  const granularity = input.granularity ?? 'word';
  const fromSeq = input.from.seq;
  const toSeq = fromSeq + input.commits.length;
  for (let i = 0; i < input.commits.length; i++) {
    const c = input.commits[i]!;
    if (c.seq !== fromSeq + 1 + i)
      return refuse('internal', `the commits are not contiguous at ${fromSeq + 1 + i}`);
    if (c.kind === 'snapshot')
      return refuse('validation_failed', `snapshot commit ${c.seq} lies between the versions`);
  }
  if (input.region !== undefined && hidden.regions.has(input.region))
    return refuse('not_found', `no region ${input.region}`);
  const pschema = projectionSchema();
  let full = input.from.doc;
  let view = project(full, hidden, pschema);
  const startView = view.doc;
  let cs = ChangeSet.create<Author>(
    view.doc,
    (a, b) => (a === b || (a && b && sameAuthor(a, b)) ? a : null) as Author,
  );
  const formatted = new Map<string, Author>();
  const scopes = new Map<string, Author>();
  for (const c of input.commits) {
    const author = commitAuthor(c);
    for (const s of c.scopes) if (visibleScope(s, hidden)) scopes.set(s, author);
    // A steps commit with no steps is one whose payload was removed (HIS-040, HIS-032): its changes
    // are unknown, so the comparison refuses rather than leave them out.
    if (c.kind === 'steps' && c.steps.length === 0)
      return refuse(
        'not_found',
        `the detail of commit ${c.seq} was removed, so the comparison cannot be built`,
      );
    if (c.kind !== 'steps') continue;
    let steps: Step[];
    try {
      steps = c.steps.map((s) => Step.fromJSON(input.schema, s));
    } catch (e) {
      return refuse(
        'internal',
        `commit ${c.seq} has a step that does not parse: ${(e as Error).message}`,
      );
    }
    const projected = projectCommit(view, full, steps, hidden, pschema);
    let pdoc = view.doc;
    for (const s of projected.steps) {
      const r = s.apply(pdoc);
      if (!r.doc) return refuse('internal', `commit ${c.seq}: a projected step does not apply`);
      noteFormatting(s, pdoc, r.doc, author, formatted);
      pdoc = r.doc;
    }
    if (projected.steps.length)
      cs = cs.addSteps(
        projected.view.doc,
        projected.steps.map((s) => s.getMap()),
        author,
      );
    for (const s of steps) {
      const r = s.apply(full);
      if (!r.doc) return refuse('internal', `commit ${c.seq} does not replay: ${r.failed}`);
      full = r.doc;
    }
    view = projected.view;
  }
  const A = indexDocument(startView);
  const B = indexDocument(view.doc);
  if (
    input.region !== undefined &&
    !regionExists(A, input.region) &&
    !regionExists(B, input.region)
  )
    return refuse('not_found', `no region ${input.region}`);

  const inserted: Range[] = [];
  const deleted: Range[] = [];
  const points: Range[] = [];
  for (const ch of cs.changes) {
    inserted.push(...spanRanges(ch.fromB, ch.inserted));
    deleted.push(...spanRanges(ch.fromA, ch.deleted));
    const data = ch.deleted.find((s) => s.data)?.data ?? ch.inserted.find((s) => s.data)?.data;
    if (data) points.push({ from: ch.fromB, to: ch.toB, data });
  }
  const oracle: Oracle = {
    inserted: (p) => findRange(inserted, p),
    deleted: (p) => findRange(deleted, p),
    near: (block, pos) => {
      const lo = block.pos;
      const hi = block.pos + block.node.nodeSize;
      let best: Range | undefined;
      let dist = Infinity;
      for (const r of points) {
        if (r.to < lo || r.from > hi) continue;
        const d = pos < r.from ? r.from - pos : pos > r.to ? pos - r.to : 0;
        if (d < dist) {
          dist = d;
          best = r;
        }
      }
      return best?.data ?? formatted.get(block.id);
    },
    formatted: (id) => formatted.get(id),
    scope: (s) => scopes.get(s),
  };
  let changes = classify(A, B, oracle, granularity, input.maxCost ?? DEFAULT_MAX_COST);
  if (input.region !== undefined) changes = regionFilter(changes, input.region);
  const comparison: Comparison = { fromSeq, toSeq, method: 'steps', granularity, changes };
  if (input.region !== undefined) comparison.region = input.region;
  return { ok: true, comparison };
}

/** The identified block that holds a position, or the node there when it is one. */
function blockIdAt(doc: Node, pos: number): string | null {
  const node = doc.nodeAt(pos);
  if (node && typeof node.attrs['id'] === 'string' && node.isBlock) return node.attrs['id'];
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.isBlock && typeof n.attrs['id'] === 'string') return n.attrs['id'];
  }
  return null;
}

/** Records who changed the formatting of which block (attribute, mark and re-typing steps). */
function noteFormatting(
  step: Step,
  before: Node,
  after: Node,
  author: Author,
  out: Map<string, Author>,
): void {
  try {
    if (
      step instanceof AttrStep ||
      step instanceof AddNodeMarkStep ||
      step instanceof RemoveNodeMarkStep
    ) {
      const id = blockIdAt(before, step.pos);
      if (id) out.set(id, author);
    } else if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      after.nodesBetween(step.from, step.to, (n) => {
        if (n.isTextblock && typeof n.attrs['id'] === 'string') out.set(n.attrs['id'], author);
        return !n.isTextblock;
      });
    } else if (step instanceof ReplaceAroundStep && isStructural(step)) {
      const id = blockIdAt(after, step.from);
      if (id) out.set(id, author);
    }
  } catch {
    // A position the projection cannot resolve: formatting stays unattributed.
  }
}

// -----------------------------------------------------------------------------------------------
// By aligning blocks (HIS-012).

export interface StatesComparisonInput {
  from: { seq: number; doc: Node };
  /** The later version, with the attribution map at it (full positions) when authorship is wanted. */
  to: { seq: number; doc: Node; attribution?: AttributionMap };
  hidden?: HiddenSet;
  granularity?: Granularity;
  region?: string;
  maxCost?: number;
  /**
   * The latest commit after `from.seq` and up to `to.seq` whose scopes include `scope`: the
   * per-scope table (06 §4.1). Only asked for scopes the requester may see.
   */
  scopeIndex?: (scope: string) => Author | undefined;
}

export function compareStates(
  input: StatesComparisonInput,
): HistoryResult<{ comparison: Comparison }> {
  const hidden = input.hidden ?? NOTHING_HIDDEN;
  const granularity = input.granularity ?? 'word';
  if (input.region !== undefined && hidden.regions.has(input.region))
    return refuse('not_found', `no region ${input.region}`);
  const pschema = projectionSchema();
  const pa = project(input.from.doc, hidden, pschema);
  const pb = project(input.to.doc, hidden, pschema);
  const A = indexDocument(pa.doc);
  const B = indexDocument(pb.doc);
  if (
    input.region !== undefined &&
    !regionExists(A, input.region) &&
    !regionExists(B, input.region)
  )
    return refuse('not_found', `no region ${input.region}`);
  const map = input.to.attribution ? projectAttribution(input.to.attribution, pb.spans) : undefined;
  const oracle: Oracle = {
    inserted: (p) => map?.at(p),
    deleted: noAuthor,
    near: noAuthor,
    formatted: noAuthor,
    scope: (s) => (visibleScope(s, hidden) ? input.scopeIndex?.(s) : undefined),
  };
  let changes = classify(A, B, oracle, granularity, input.maxCost ?? DEFAULT_MAX_COST);
  if (input.region !== undefined) changes = regionFilter(changes, input.region);
  const comparison: Comparison = {
    fromSeq: input.from.seq,
    toSeq: input.to.seq,
    method: 'aligned',
    granularity,
    changes,
  };
  if (input.region !== undefined) comparison.region = input.region;
  return { ok: true, comparison };
}

// -----------------------------------------------------------------------------------------------
// The entry point: the gate, the method and the cache.

export interface CompareRequest {
  fromSeq: number;
  toSeq: number;
  region?: string;
  granularity?: Granularity;
}

export interface CompareSource {
  schema: Schema;
  incarnation: string;
  /** The full content at a `seq` (HIS-005, `contentAt`). */
  content: (seq: number) => Node | undefined;
  /** The stored commits after a `seq` up to another, in order. */
  commits: (afterSeq: number, toSeq: number) => readonly LogCommit[];
  /** The attribution map at a `seq`, for the aligned method. */
  attribution?: (seq: number) => AttributionMap | undefined;
  /** The latest commit in `(afterSeq, toSeq]` whose scopes include `scope` (06 §4.1). */
  scopeIndex?: (scope: string, afterSeq: number, toSeq: number) => Author | undefined;
  /** Commits apart up to which the steps are used; default 2,000 (08 §6). */
  stepLimit?: number;
}

export interface CompareContext {
  gate: HistoryGate;
  /** The requester's hidden set (ADR 0019). */
  hidden: HiddenSet;
  cache?: ComparisonCache;
}

/**
 * A comparison as a requester may see it (08 §6, §9; 07 §8): both versions must pass the gate as
 * single states; the steps are used only when the requester may also see the commits between them
 * (a run from `fromSeq`), they are at most `stepLimit` apart and no snapshot commit lies between.
 * Every refusal happens before any rebuild work.
 */
export function compare(
  req: CompareRequest,
  source: CompareSource,
  ctx: CompareContext,
): HistoryResult<{ comparison: Comparison; cached: boolean }> {
  const { fromSeq, toSeq } = req;
  const { gate, hidden } = ctx;
  if (
    !Number.isSafeInteger(fromSeq) ||
    !Number.isSafeInteger(toSeq) ||
    fromSeq < 0 ||
    toSeq < fromSeq
  )
    return refuse('validation_failed', `fromSeq ${fromSeq} and toSeq ${toSeq} are not a range`);
  if (toSeq > gate.head)
    return refuse('not_found', `no version at seq ${toSeq} (head ${gate.head})`);
  if (
    !stateVisible(gate.min, fromSeq, gate.head, gate.named) ||
    !stateVisible(gate.min, toSeq, gate.head, gate.named)
  )
    return refuse('forbidden', 'a version is below your visibility gate');
  if (req.region !== undefined && hidden.regions.has(req.region))
    return refuse('not_found', `no region ${req.region}`);
  const granularity = req.granularity ?? 'word';
  const limit = source.stepLimit ?? STEP_LIMIT;
  let method: ComparisonMethod = 'aligned';
  let commits: readonly LogCommit[] | null = null;
  if (rangeVisible(gate.min, fromSeq) && toSeq - fromSeq <= limit) {
    commits = source.commits(fromSeq, toSeq);
    if (!commits.some((c) => c.kind === 'snapshot')) method = 'steps';
  }
  const key = ComparisonCache.key(source.incarnation, req, granularity, method, hidden);
  const hit = ctx.cache?.get(key);
  if (hit) return { ok: true, comparison: hit, cached: true };
  const from = source.content(fromSeq);
  if (!from) return refuse('internal', `no content at seq ${fromSeq}`);
  let r: HistoryResult<{ comparison: Comparison }>;
  const common = {
    hidden,
    granularity,
    ...(req.region !== undefined ? { region: req.region } : {}),
  };
  if (method === 'steps')
    r = compareSteps({
      schema: source.schema,
      from: { seq: fromSeq, doc: from },
      commits: commits!,
      ...common,
    });
  else {
    const to = source.content(toSeq);
    if (!to) return refuse('internal', `no content at seq ${toSeq}`);
    const attribution = source.attribution?.(toSeq);
    r = compareStates({
      from: { seq: fromSeq, doc: from },
      to: { seq: toSeq, doc: to, ...(attribution ? { attribution } : {}) },
      ...common,
      ...(source.scopeIndex
        ? { scopeIndex: (s: string) => source.scopeIndex!(s, fromSeq, toSeq) }
        : {}),
    });
  }
  if (!r.ok) return r;
  ctx.cache?.set(key, r.comparison);
  return { ok: true, comparison: r.comparison, cached: false };
}

export interface RegionSummary {
  /** The region, or null for changes outside regions (definitions included). */
  region: string | null;
  changes: number;
  kinds: Partial<Record<ChangeKind, number>>;
  /** Distinct users named by the changes, in order of first appearance. */
  users: string[];
}

/**
 * The summary of a comparison grouped by region (08 §6, last paragraph; 08 §10), in the order the
 * regions first appear in the changes. A change to a region itself counts for that region.
 */
export function summarise(c: Comparison): RegionSummary[] {
  const out = new Map<string | null, RegionSummary>();
  for (const ch of c.changes) {
    const region =
      ch.region ?? (ch.type === 'region' || ch.type === PLACEHOLDER ? ch.blockId! : null);
    let s = out.get(region);
    if (!s) {
      s = { region, changes: 0, kinds: {}, users: [] };
      out.set(region, s);
    }
    s.changes++;
    s.kinds[ch.kind] = (s.kinds[ch.kind] ?? 0) + 1;
    const users = [ch.user, ...(ch.spans ?? []).map((sp) => sp.user)];
    for (const u of users) if (u !== undefined && !s.users.includes(u)) s.users.push(u);
  }
  return [...out.values()];
}

/**
 * Comparisons cached by the pair of sequence numbers (08 §6), and by everything else that changes
 * the answer: the log incarnation, the region, the granularity, the method the requester's gate
 * allows and the requester's visibility class, so that one class is never served another's result.
 */
export class ComparisonCache {
  private readonly entries = new Map<string, Comparison>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!(capacity > 0)) throw new RangeError('a cache needs room for one entry');
    this.capacity = capacity;
  }

  static key(
    incarnation: string,
    req: CompareRequest,
    granularity: Granularity,
    method: ComparisonMethod,
    hidden: HiddenSet,
  ): string {
    return [
      incarnation,
      req.fromSeq,
      req.toSeq,
      req.region ?? '',
      granularity,
      method,
      visibilityKey(hidden),
    ].join('\u0000');
  }

  get(key: string): Comparison | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: Comparison): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity)
      this.entries.delete(this.entries.keys().next().value!);
  }

  get size(): number {
    return this.entries.size;
  }
}
