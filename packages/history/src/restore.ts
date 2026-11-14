/**
 * Restore plans and their dry runs (08 §8; 07 §12, §13; HIS-018 to HIS-021; ADR 0051, proposed).
 *
 * `planRestore` checks a restore request (the gate, the capability, the region's state and lease,
 * an active workflow) before any work, and computes what the control plane hands to the room:
 *
 * - **one region**: steps from the current region to its content at `toSeq`. Blocks are aligned by
 *   identifier; the unchanged blocks that keep their order are left alone, and each stretch between
 *   them is replaced by one step, so changed blocks are replaced, missing blocks inserted and extra
 *   blocks removed. Comment ranges and attribution in the blocks left alone survive. The region's
 *   own attributes (title, policy) are not restored: they are structure and permission state, not
 *   content. When the steps would be too large for one commit, the plan falls back to a snapshot
 *   commit of the current document with only that region restored (08 §8; review SR-M29 asks for
 *   another answer, ADR 0051);
 * - **the whole document**: a snapshot commit with reason `restore` and the content at `toSeq`.
 *
 * A restored block gets a new identifier when its old one is in use elsewhere in the current
 * document, and a region whose identifier was retired gets a new one (I3). A definition the
 * restored content needs and the current document lacks is recreated when the user holds
 * `structure`; otherwise paragraphs and tables fall back to the default style, character styles
 * and numbering are dropped, and the plan says which (07 §13). The plan carries the preconditions
 * the room checks again when it applies the commit (04 §5; HIS-020), and the attribution hint that
 * keeps the original authors of restored content (08 §7).
 *
 * A dry run is the same plan with the comparison it would produce (HIS-021), computed on the
 * requester's projection. Planning has no effects: no commit, version or event exists until the
 * control plane applies the plan.
 */
import {
  type Access,
  DEFAULT_LIMITS,
  type HiddenSet,
  type Preconditions,
  type RegionState,
  type StepJson,
  authorise,
  commitBytes,
  stateVisible,
  stepsToJson,
} from '@docedit/authority';
import { Fragment, type Mark, type Node, type Schema, Slice } from 'prosemirror-model';
import { ReplaceStep, type Step, Transform } from 'prosemirror-transform';
import { AttributionMap, type RestoreHint, type Run, authorOf } from './attribution.ts';
import { type Comparison, compareStates } from './compare.ts';
import { definitionKey } from './blocks.ts';
import { type HistoryGate, type HistoryResult, refuse } from './types.ts';

export interface RestoreRequest {
  toSeq: number;
  /** A region identifier; absent for the whole document. */
  region?: string;
  dryRun?: boolean;
}

export interface RestoreContext {
  schema: Schema;
  /** The current head: its `seq`, full content and attribution map. */
  head: { seq: number; doc: Node; attribution?: AttributionMap };
  /** The full content at `toSeq` and its attribution map. Fetched only after the checks pass. */
  target: (seq: number) => { doc: Node; attribution?: AttributionMap } | undefined;
  gate: HistoryGate;
  /** The requester's hidden set, for the dry-run comparison (ADR 0019). */
  hidden: HiddenSet;
  /** The requester's effective access (07 §4) and surrogate identifier. */
  access: Access;
  user: string;
  regionStates?: ReadonlyMap<string, RegionState>;
  /** Whether a region is leased to someone other than the requester (07 §10). */
  leasedToSomeoneElse?: (region: string) => boolean;
  workflowActive?: boolean;
  /** Region identifiers retired for good (I3). */
  retired?: ReadonlySet<string>;
  maxCommitBytes?: number;
  maxSteps?: number;
  /** Makes new identifiers deterministic for one request (a dry run and its restore agree). */
  idSalt?: string;
}

export interface RestoreNotes {
  /** Old identifier to new, for restored blocks whose identifier was in use (HIS-020). */
  reidentified: Record<string, string>;
  /** Definitions recreated because the restored content needs them (`<type>/<id>`). */
  recreated: string[];
  /** Definitions the user may not recreate, replaced by the default (07 §13). */
  replaced: string[];
}

export type RestorePlan = (
  | {
      kind: 'steps';
      region: string;
      steps: Step[];
      stepsJson: StepJson[];
      /** Original authors of the restored content, by step (`applyStep`'s hint). */
      hint: RestoreHint;
    }
  | {
      kind: 'snapshot';
      reason: 'restore';
      region?: string;
      /** Set when a region restore fell back because its steps were too large. */
      fallback?: 'too_large';
    }
) &
  RestoreNotes & {
    /** The document after the restore. */
    result: Node;
    /** Its attribution map, when the maps were given: original authors, marked as restored. */
    resultAttribution?: AttributionMap;
    /** What the room checks again when it applies the commit (04 §5; HIS-020). */
    preconditions: Preconditions;
    /** Nothing differs: the control plane need not commit anything. */
    unchanged: boolean;
    /** With `dryRun`: the comparison between the current content and the result (HIS-021). */
    dryRun?: Comparison;
  };

/** Body children of a document, with their positions. */
function bodyOf(doc: Node): { node: Node; start: number } {
  const body = doc.child(doc.childCount - 1);
  return { node: body, start: doc.content.size - body.nodeSize + 1 };
}

function regionAt(doc: Node, id: string): { node: Node; pos: number } | null {
  const { node: body, start } = bodyOf(doc);
  let found: { node: Node; pos: number } | null = null;
  body.forEach((c, o) => {
    if (!found && c.type.name === 'region' && c.attrs['id'] === id)
      found = { node: c, pos: start + o };
  });
  return found;
}

/** Every identifier used by a node or its descendants. */
function idsIn(node: Node, out: Set<string>): Set<string> {
  const own = node.attrs['id'];
  if (typeof own === 'string' && own) out.add(own);
  node.descendants((n) => {
    const id = n.attrs['id'];
    if (typeof id === 'string' && id) out.add(id);
    return true;
  });
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function fnv(s: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A node identifier of 16 URL-safe Base64 characters derived from a salt (03 §9 format). */
export function derivedId(salt: string, old: string, attempt: number): string {
  const text = `${salt}\u0000${old}\u0000${attempt}`;
  let out = '';
  for (let i = 0; out.length < 16; i++) {
    let h = fnv(text, 0x811c9dc5 ^ Math.imul(i + 1, 0x9e3779b1));
    for (let k = 0; k < 5 && out.length < 16; k++) {
      out += B64[h & 63]!;
      h >>>= 6;
    }
  }
  return out;
}

/** Gives every identifier of `node` that is in `used` a new one; records the renames. */
function reidentify(
  node: Node,
  used: Set<string>,
  salt: string,
  renames: Record<string, string>,
): Node {
  const fresh = (old: string): string => {
    for (let attempt = 0; ; attempt++) {
      const id = derivedId(salt, old, attempt);
      if (!used.has(id)) {
        used.add(id);
        return id;
      }
    }
  };
  const visit = (n: Node): Node => {
    let attrs = n.attrs;
    const id = n.attrs['id'];
    if (typeof id === 'string' && id && used.has(id)) {
      const next = renames[id] ?? fresh(id);
      renames[id] = next;
      attrs = { ...n.attrs, id: next };
    } else if (typeof id === 'string' && id) used.add(id);
    if (n.isText) return n;
    const children: Node[] = [];
    n.forEach((c) => children.push(visit(c)));
    return attrs === n.attrs && children.every((c, i) => c === n.child(i))
      ? n
      : n.type.create(attrs, children, n.marks);
  };
  return visit(node);
}

/** The definitions a stretch of content refers to, as `<type>/<id>` keys. */
function referencedDefinitions(nodes: readonly Node[]): Set<string> {
  const out = new Set<string>();
  const markRefs = (marks: readonly Mark[]) => {
    for (const m of marks)
      if (m.type.name === 'charStyle' && typeof m.attrs['style'] === 'string')
        out.add(`style_def/${m.attrs['style']}`);
  };
  const visit = (n: Node) => {
    markRefs(n.marks);
    const style = n.attrs['style'];
    if ((n.type.name === 'paragraph' || n.type.name === 'table') && typeof style === 'string')
      out.add(`style_def/${style}`);
    const numbering = n.attrs['numbering'] as { numberingId?: unknown } | null | undefined;
    if (n.type.name === 'paragraph' && numbering && typeof numbering.numberingId === 'string')
      out.add(`numbering_def/${numbering.numberingId}`);
    if (n.type.name === 'form_field' && typeof n.attrs['assignee'] === 'string')
      out.add(`role_def/${n.attrs['assignee']}`);
    n.forEach(visit);
  };
  nodes.forEach(visit);
  return out;
}

/** The definitions a definition depends on: styles it is based on or followed by, its numbering. */
function definitionDependencies(def: Node): string[] {
  const out: string[] = [];
  if (def.type.name === 'style_def') {
    for (const k of ['basedOn', 'next'])
      if (typeof def.attrs[k] === 'string') out.push(`style_def/${def.attrs[k]}`);
    const numbering = def.attrs['numbering'] as { numberingId?: unknown } | null | undefined;
    if (numbering && typeof numbering.numberingId === 'string')
      out.push(`numbering_def/${numbering.numberingId}`);
  }
  return out;
}

function definitionsOf(doc: Node): Map<string, { node: Node; pos: number }> {
  const out = new Map<string, { node: Node; pos: number }>();
  const defs = doc.child(0);
  defs.forEach((d, o) => out.set(definitionKey(d), { node: d, pos: 1 + o }));
  return out;
}

/** The order of definition types in `defs` (03; the schema's content expression). */
const DEF_ORDER = [
  'settings',
  'style_def',
  'numbering_def',
  'page_setup',
  'role_def',
  'rule_def',
  'source_def',
  'preserved_def',
];

/** Where a definition of `type` goes in the current `defs`: after the last of its type or earlier. */
function definitionInsertPos(doc: Node, type: string): number {
  const defs = doc.child(0);
  const rank = DEF_ORDER.indexOf(type);
  let pos = 1;
  defs.forEach((d, o) => {
    if (DEF_ORDER.indexOf(d.type.name) <= rank) pos = 1 + o + d.nodeSize;
  });
  return pos;
}

/**
 * Replaces references to definitions the user may not recreate: the default paragraph style
 * (a null style), no table style, no character style, no numbering, no assignee.
 */
function withFallback(node: Node, missing: ReadonlySet<string>): Node {
  const visit = (n: Node): Node => {
    let attrs: Record<string, unknown> = n.attrs;
    const set = (k: string, v: unknown) => {
      if (attrs === n.attrs) attrs = { ...n.attrs };
      attrs[k] = v;
    };
    const style = n.attrs['style'];
    if (
      (n.type.name === 'paragraph' || n.type.name === 'table') &&
      typeof style === 'string' &&
      missing.has(`style_def/${style}`)
    )
      set('style', null);
    const numbering = n.attrs['numbering'] as { numberingId?: unknown } | null | undefined;
    if (
      n.type.name === 'paragraph' &&
      numbering &&
      typeof numbering.numberingId === 'string' &&
      missing.has(`numbering_def/${numbering.numberingId}`)
    )
      set('numbering', null);
    if (
      n.type.name === 'form_field' &&
      typeof n.attrs['assignee'] === 'string' &&
      missing.has(`role_def/${n.attrs['assignee']}`)
    )
      set('assignee', null);
    const marks = n.marks.filter(
      (m) =>
        !(
          m.type.name === 'charStyle' &&
          typeof m.attrs['style'] === 'string' &&
          missing.has(`style_def/${m.attrs['style']}`)
        ),
    );
    if (n.isText) return marks.length === n.marks.length ? n : n.mark(marks);
    const children: Node[] = [];
    n.forEach((c) => children.push(visit(c)));
    const same =
      attrs === n.attrs &&
      marks.length === n.marks.length &&
      children.every((c, i) => c === n.child(i));
    return same ? n : n.type.create(attrs, children, marks);
  };
  return visit(node);
}

/** Indices of the longest increasing subsequence. */
function lis(xs: readonly number[]): Set<number> {
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

function childList(n: Node): Node[] {
  const out: Node[] = [];
  n.forEach((c) => out.push(c));
  return out;
}

function childPositions(n: Node, start: number): number[] {
  const out: number[] = [];
  let p = start;
  n.forEach((c) => {
    out.push(p);
    p += c.nodeSize;
  });
  out.push(p);
  return out;
}

/** The checks shared by a restore and its dry run (HIS-021: the same permission and visibility). */
function check(req: RestoreRequest, ctx: RestoreContext): HistoryResult<object> {
  const { gate } = ctx;
  if (!Number.isSafeInteger(req.toSeq) || req.toSeq < 0)
    return refuse('validation_failed', `toSeq ${req.toSeq} is not a sequence number`);
  if (req.toSeq > ctx.head.seq) return refuse('not_found', `no version at seq ${req.toSeq}`);
  if (!stateVisible(gate.min, req.toSeq, gate.head, gate.named))
    return refuse('forbidden', `seq ${req.toSeq} is below your visibility gate`);
  if (req.region === undefined) {
    const v = authorise('manage', { credential: 'user', access: ctx.access });
    if (!v.ok) return refuse('forbidden', `restoring the document ${v.reason}`);
    if (ctx.workflowActive) return refuse('workflow_active', 'a workflow is active');
    return { ok: true };
  }
  if (ctx.hidden.regions.has(req.region)) return refuse('not_found', `no region ${req.region}`);
  // An approval or another person's lease also takes `edit` away (07 §4); they are named first,
  // so that the answer says what must change before the restore can run.
  const state = ctx.regionStates?.get(req.region);
  const leased = ctx.leasedToSomeoneElse?.(req.region) ?? false;
  if (state === 'approved') return refuse('conflict', `region ${req.region} is approved`);
  if (leased) return refuse('conflict', `region ${req.region} is leased to someone else`);
  const v = authorise('restore.region', {
    credential: 'user',
    access: ctx.access,
    region: req.region,
    ...(state !== undefined ? { regionState: state } : {}),
    leasedToSomeoneElse: leased,
  });
  if (!v.ok) return refuse('forbidden', `restoring region ${req.region} ${v.reason}`);
  return { ok: true };
}

/** Plans a restore, or its dry run (see the module comment). */
export function planRestore(
  req: RestoreRequest,
  ctx: RestoreContext,
): HistoryResult<{ plan: RestorePlan }> {
  const checked = check(req, ctx);
  if (!checked.ok) return checked;
  const target = ctx.target(req.toSeq);
  if (!target) return refuse('internal', `no content at seq ${req.toSeq}`);
  const r =
    req.region === undefined
      ? planDocument(req, ctx, target)
      : planRegion(req, req.region, ctx, target);
  if (!r.ok) return r;
  const plan = r.plan;
  if (req.dryRun) {
    // From the head to the commit the restore would add (the next seq).
    const c = compareStates({
      from: { seq: ctx.head.seq, doc: ctx.head.doc },
      to: {
        seq: ctx.head.seq + 1,
        doc: plan.result,
        ...(plan.resultAttribution ? { attribution: plan.resultAttribution } : {}),
      },
      hidden: ctx.hidden,
    });
    if (!c.ok) return c;
    plan.dryRun = c.comparison;
  }
  return { ok: true, plan };
}

function approvedRegions(ctx: RestoreContext): string[] {
  const out: string[] = [];
  for (const [id, s] of ctx.regionStates ?? []) if (s === 'approved') out.push(id);
  return out.sort();
}

function planRegion(
  req: RestoreRequest,
  region: string,
  ctx: RestoreContext,
  target: { doc: Node; attribution?: AttributionMap },
): HistoryResult<{ plan: RestorePlan }> {
  const cur = regionAt(ctx.head.doc, region);
  if (!cur) return refuse('not_found', `region ${region} does not exist now`);
  const old = regionAt(target.doc, region);
  if (!old) return refuse('not_found', `region ${region} did not exist at seq ${req.toSeq}`);
  const C = childList(cur.node);
  const T = childList(old.node);
  const cPos = childPositions(cur.node, cur.pos + 1);
  const tPos = childPositions(old.node, old.pos + 1);
  // Anchors: unchanged blocks, in the same order on both sides.
  const cIndex = new Map<string, number>();
  C.forEach((c, i) => {
    if (typeof c.attrs['id'] === 'string') cIndex.set(c.attrs['id'], i);
  });
  const pairs: Array<[number, number]> = [];
  T.forEach((t, j) => {
    const i = typeof t.attrs['id'] === 'string' ? cIndex.get(t.attrs['id']) : undefined;
    if (i !== undefined && C[i]!.eq(t)) pairs.push([i, j]);
  });
  const keep = lis(pairs.map(([i]) => i));
  const anchors = pairs.filter((_, k) => keep.has(k));
  anchors.push([C.length, T.length]);
  // Identifiers in use outside the blocks the restore removes.
  const removed = new Set<number>();
  {
    let pc = 0;
    for (const [ai] of anchors) {
      for (let i = pc; i < ai; i++) removed.add(i);
      pc = ai + 1;
    }
  }
  const used = new Set<string>();
  const removedAt = new Set([...removed].map((i) => cPos[i]!));
  ctx.head.doc.descendants((n, pos) => {
    // Skip the removed children of the region: their identifiers are free again.
    if (removedAt.has(pos) && pos > cur.pos && pos < cur.pos + cur.node.nodeSize) return false;
    const id = n.attrs['id'];
    if (typeof id === 'string' && id) used.add(id);
    return true;
  });
  const salt = ctx.idSalt ?? `${region}:${req.toSeq}:${ctx.head.seq}`;
  const notes: RestoreNotes = { reidentified: {}, recreated: [], replaced: [] };
  // Definitions the restored blocks need.
  const gaps: Array<{ c0: number; c1: number; t0: number; t1: number }> = [];
  {
    let pc = 0;
    let pt = 0;
    for (const [ai, aj] of anchors) {
      if (ai > pc || aj > pt) gaps.push({ c0: pc, c1: ai, t0: pt, t1: aj });
      pc = ai + 1;
      pt = aj + 1;
    }
  }
  const inserted = gaps.flatMap((g) => T.slice(g.t0, g.t1));
  const defs = resolveDefinitions(inserted, ctx, target.doc, notes);
  if (!defs.ok) return defs;
  // The transform: definitions first, then each stretch from the last to the first.
  const tr = new Transform(ctx.head.doc);
  const hint: Array<readonly Run[] | undefined> = [];
  for (const d of defs.recreate) {
    const at = definitionInsertPos(tr.doc, d.node.type.name);
    const failed = tr.maybeStep(
      new ReplaceStep(at, at, new Slice(Fragment.from(d.node), 0, 0)),
    ).failed;
    if (failed)
      return refuse(
        'internal',
        `definition ${definitionKey(d.node)} cannot be recreated: ${failed}`,
      );
    hint.push(
      target.attribution ? runsOf(target.attribution, d.pos, d.pos + d.node.nodeSize) : undefined,
    );
  }
  const shift = tr.mapping;
  for (let g = gaps.length - 1; g >= 0; g--) {
    const { c0, c1, t0, t1 } = gaps[g]!;
    const nodes = T.slice(t0, t1).map((t) =>
      reidentify(withFallback(t, defs.missing), used, salt, notes.reidentified),
    );
    const from = shift.map(cPos[c0]!, 1);
    const to = c1 === c0 ? from : shift.map(cPos[c1]!, -1);
    const step = new ReplaceStep(from, to, new Slice(Fragment.from(nodes), 0, 0));
    const failed = tr.maybeStep(step).failed;
    if (failed)
      return refuse('internal', `the restore of region ${region} does not apply: ${failed}`);
    hint.push(
      target.attribution && nodes.length
        ? runsOf(target.attribution, tPos[t0]!, tPos[t1]!)
        : undefined,
    );
  }
  const preconditions: Preconditions = {
    head: ctx.head.seq,
    revision: ctx.access.revision,
    regionStates: { [region]: ctx.regionStates?.get(region) ?? 'draft' },
  };
  const result = tr.doc;
  let resultAttribution: AttributionMap | undefined;
  if (ctx.head.attribution) {
    resultAttribution = ctx.head.attribution.clone();
    const author = { user: ctx.user, seq: ctx.head.seq + 1 };
    tr.steps.forEach((s, i) => resultAttribution!.applyStep(s, author, hint[i]));
  }
  const stepsJson = stepsToJson(tr.steps);
  const tooLarge =
    tr.steps.length > (ctx.maxSteps ?? DEFAULT_LIMITS.maxStepsPerCommit) ||
    commitBytes({ steps: stepsJson }) + 4096 >
      (ctx.maxCommitBytes ?? DEFAULT_LIMITS.maxCommitBytes);
  const base = {
    ...notes,
    result,
    ...(resultAttribution ? { resultAttribution } : {}),
    unchanged: tr.steps.length === 0,
  };
  if (tooLarge)
    return {
      ok: true,
      plan: {
        kind: 'snapshot',
        reason: 'restore',
        region,
        fallback: 'too_large',
        ...base,
        preconditions: { ...preconditions, workflowActive: ctx.workflowActive ?? false },
      },
    };
  return {
    ok: true,
    plan: { kind: 'steps', region, steps: tr.steps, stepsJson, hint, ...base, preconditions },
  };
}

/** Runs of a map between two positions, as hint runs (their restore marking is added on apply). */
function runsOf(map: AttributionMap, from: number, to: number): Run[] {
  return map.slice(from, to).map((r) => ({ ...authorOf(r), len: r.len }));
}

function resolveDefinitions(
  nodes: readonly Node[],
  ctx: RestoreContext,
  targetDoc: Node,
  notes: RestoreNotes,
): HistoryResult<{ recreate: Array<{ node: Node; pos: number }>; missing: Set<string> }> {
  const current = definitionsOf(ctx.head.doc);
  const old = definitionsOf(targetDoc);
  // `structure` as the outcome check reads it (07 §5.3): the role conveys it and the definitions
  // scope is not frozen by the document's state.
  const canStructure =
    ctx.access.docRole.has('structure') && ctx.access.structureScopes.has('edit');
  const recreate: Array<{ node: Node; pos: number }> = [];
  const missing = new Set<string>();
  const seen = new Set<string>();
  const queue = [...referencedDefinitions(nodes)].sort();
  while (queue.length) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    if (current.has(key)) continue;
    const def = old.get(key);
    if (!def) continue; // A dangling reference in the old content itself; the invariant check decides.
    if (canStructure) {
      recreate.push(def);
      notes.recreated.push(key);
      queue.push(...definitionDependencies(def.node));
    } else {
      missing.add(key);
      notes.replaced.push(key);
    }
  }
  notes.recreated.sort();
  notes.replaced.sort();
  // Definitions are inserted in the order of `defs`, so that their positions stay valid.
  recreate.sort(
    (a, b) =>
      DEF_ORDER.indexOf(a.node.type.name) - DEF_ORDER.indexOf(b.node.type.name) || a.pos - b.pos,
  );
  return { ok: true, recreate, missing };
}

function planDocument(
  req: RestoreRequest,
  ctx: RestoreContext,
  target: { doc: Node; attribution?: AttributionMap },
): HistoryResult<{ plan: RestorePlan }> {
  // An approved region the restore would change is refused until its state changes (07 §11).
  for (const id of approvedRegions(ctx)) {
    const now = regionAt(ctx.head.doc, id);
    const then = regionAt(target.doc, id);
    if (now && (!then || !now.node.eq(then.node)))
      return refuse('conflict', `region ${id} is approved and the restore would change it`);
  }
  // A region whose identifier is retired cannot come back with it (I3): it gets a new one.
  const notes: RestoreNotes = { reidentified: {}, recreated: [], replaced: [] };
  const retired = ctx.retired ?? new Set<string>();
  const salt = ctx.idSalt ?? `document:${req.toSeq}:${ctx.head.seq}`;
  const used = idsIn(target.doc, new Set<string>());
  let content = target.doc;
  const { node: body } = bodyOf(target.doc);
  const children: Node[] = [];
  let changed = false;
  body.forEach((c) => {
    const id = c.attrs['id'];
    if (c.type.name === 'region' && typeof id === 'string' && retired.has(id)) {
      // Only the region is renamed: its content keeps the identifiers of its time.
      let attempt = 0;
      let next = derivedId(salt, id, attempt);
      while (used.has(next) || retired.has(next)) next = derivedId(salt, id, ++attempt);
      used.add(next);
      notes.reidentified[id] = next;
      children.push(c.type.create({ ...c.attrs, id: next }, c.content, c.marks));
      changed = true;
    } else children.push(c);
  });
  if (changed) {
    const newBody = body.type.create(body.attrs, children, body.marks);
    const top = childList(target.doc);
    top[top.length - 1] = newBody;
    content = target.doc.type.create(target.doc.attrs, top, target.doc.marks);
  }
  const preconditions: Preconditions = {
    head: ctx.head.seq,
    revision: ctx.access.revision,
    workflowActive: false,
  };
  const states: Record<string, RegionState> = {};
  for (const id of approvedRegions(ctx)) states[id] = 'approved';
  if (Object.keys(states).length) preconditions.regionStates = states;
  // The snapshot commit takes the next seq: the head precondition makes sure of it.
  const resultAttribution = target.attribution
    ? markRestored(target.attribution, ctx.user, ctx.head.seq + 1)
    : undefined;
  return {
    ok: true,
    plan: {
      kind: 'snapshot',
      reason: 'restore',
      ...notes,
      result: content,
      ...(resultAttribution ? { resultAttribution } : {}),
      preconditions,
      unchanged: content.eq(ctx.head.doc),
    },
  };
}

/**
 * The map of content a restore brought back: the original authors, each run marked as restored by
 * `user` with the restore commit's `seq` once it is known (08 §7).
 */
export function markRestored(map: AttributionMap, user: string, seq?: number): AttributionMap {
  return AttributionMap.fromRuns(
    map.runs().map((r) => ({
      ...r,
      restoredBy: user,
      ...(seq !== undefined ? { restoredSeq: seq } : {}),
    })),
  );
}
