/**
 * Per-reader projections (ADR 0019, proposed; spike S12, SPK-029; SYN-050 to SYN-052).
 *
 * A projection replaces every hidden region with a `hidden_region` atom and every hidden field
 * value with a redaction marker. Readers with the same hidden set share a projection (a visibility
 * class). Outgoing commits are sent to a class step by step (`projectCommit`): a step that does not
 * touch hidden content goes as itself, mapped to projected positions; a step inside a hidden region
 * sends nothing; a change of a hidden value sends the redacted change; any other step that touches
 * hidden content sends one diff step covering that step's effect only. Incoming steps made on a
 * projection are mapped back to full positions (`toFullSteps`).
 *
 * A class keeps, with each projected document, the spans of its hidden regions in both documents.
 * The spans are mapped through every step, so that neither direction needs to scan the body.
 */
import {
  REDACTED_FIELD_ATTRIBUTES,
  REDACTION_MARKER,
  isRedactionMarker,
} from '@docedit/model/definition';
import { projectionSchema as modelProjectionSchema } from '@docedit/model/prosemirror';
import type { Fragment, Node, Schema, Slice } from 'prosemirror-model';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
  Step,
  type StepMap,
} from 'prosemirror-transform';
import { type Result, fail, ok } from '../codes.ts';

/** What one reader may not see. */
export interface HiddenSet {
  /** Region identifiers whose content (and, unless `titles`, title) is hidden. */
  regions: ReadonlySet<string>;
  /** Form-field identifiers whose value is hidden. */
  values: ReadonlySet<string>;
  /** Whether the titles of hidden regions are shown on the placeholder. */
  titles: boolean;
}

export const NOTHING_HIDDEN: HiddenSet = { regions: new Set(), values: new Set(), titles: false };

/** The redaction marker that replaces a hidden value (ADR 0019; the model's `REDACTION_MARKER`). */
export const REDACTED: Readonly<{ redacted: true }> = REDACTION_MARKER;

export function visibilityKey(h: HiddenSet): string {
  return `${[...h.regions].sort().join(',')}|${[...h.values].sort().join(',')}|${h.titles ? 't' : ''}`;
}

/** Whether a hidden set hides nothing: its readers share the full document. */
export function hidesNothing(h: HiddenSet): boolean {
  return h.regions.size === 0 && h.values.size === 0;
}

/**
 * A short identifier per visibility class, for the per-node caches. Class keys list every hidden
 * scope and can run to kilobytes; comparing them on every cache hit cost more than the projection.
 */
const classIds = new Map<string, string>();
const classIdOf = new WeakMap<HiddenSet, string>();
function classId(h: HiddenSet): string {
  let id = classIdOf.get(h);
  if (id !== undefined) return id;
  const key = visibilityKey(h);
  id = classIds.get(key);
  if (id === undefined) {
    id = `c${classIds.size}`;
    classIds.set(key, id);
  }
  classIdOf.set(h, id);
  return id;
}

/**
 * The CDM schema plus the nodes only projections contain, such as the `hidden_region`
 * placeholder: the model's projection schema (CDM-053; spec/cdm/cdm-1.projection.json).
 */
export function projectionSchema(): Schema {
  return modelProjectionSchema();
}

/** One hidden region's span in the full document and the projection. */
export interface Span {
  id: string;
  /** Position of the region in the full document. */
  fullStart: number;
  /** The region's node size in the full document. */
  fullSize: number;
  /** Position of its placeholder (size 1) in the projection. */
  projStart: number;
}

/** A projected document with the spans of its hidden regions, in document order. */
export interface Projection {
  doc: Node;
  spans: readonly Span[];
}

function bodyStart(doc: Node): number {
  const body = doc.child(doc.childCount - 1);
  return doc.content.size - body.nodeSize + 1;
}

/** The attributes a field has in a projection that hides its value (its value and default). */
function redactedAttrs(attrs: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...attrs };
  for (const a of REDACTED_FIELD_ATTRIBUTES) if (a in attrs) next[a] = redactedValue(attrs[a]);
  return next;
}

/** What a hidden value or default looks like in a projection: null stays null. */
function redactedValue(v: unknown): unknown {
  return v === null || v === undefined ? null : { ...REDACTION_MARKER };
}

const isRedactedAttr = (attr: string): boolean => REDACTED_FIELD_ATTRIBUTES.includes(attr);

/**
 * Caches by projection schema, full node and visibility key. ProseMirror shares every unchanged
 * node between the versions of a document, so a commit converts only the nodes on the path from
 * the root to what it changed, plus one lookup per child of each node on that path. The cost of a
 * projection then scales with the change and the fan-out along its path, not with the size of the
 * document (measured in the S12 report).
 */
type Cache<T> = WeakMap<Schema, WeakMap<Node, Map<string, T>>>;
const converted: Cache<Node> = new WeakMap();
const projections: Cache<Projection> = new WeakMap();

function entry<T>(cache: Cache<T>, pschema: Schema, n: Node): Map<string, T> {
  let bySchema = cache.get(pschema);
  if (!bySchema) {
    bySchema = new WeakMap();
    cache.set(pschema, bySchema);
  }
  let byKey = bySchema.get(n);
  if (!byKey) {
    byKey = new Map();
    bySchema.set(n, byKey);
  }
  return byKey;
}

function marksIn(pschema: Schema, node: Node) {
  return node.marks.length
    ? node.marks.map((m) => pschema.marks[m.type.name]!.create(m.attrs))
    : [];
}

/** The projection of one node that is not a hidden region (hidden values redacted). */
function convert(n: Node, hidden: HiddenSet, key: string, pschema: Schema): Node {
  const byKey = entry(converted, pschema, n);
  let out = byKey.get(key);
  if (out) return out;
  if (n.isText) out = pschema.text(n.text ?? '', marksIn(pschema, n));
  else {
    const attrs =
      n.type.name === 'form_field' && hidden.values.has(String(n.attrs['id']))
        ? redactedAttrs(n.attrs)
        : n.attrs;
    const children: Node[] = [];
    n.forEach((c) => children.push(convert(c, hidden, key, pschema)));
    out = pschema.nodes[n.type.name]!.create(attrs, children, marksIn(pschema, n));
  }
  byKey.set(key, out);
  return out;
}

function placeholder(region: Node, hidden: HiddenSet, key: string, pschema: Schema): Node {
  const byKey = entry(converted, pschema, region);
  const k = `${key}#placeholder`;
  let out = byKey.get(k);
  if (!out) {
    out = pschema.nodes['hidden_region']!.create({
      id: region.attrs['id'],
      title: hidden.titles ? region.attrs['title'] : null,
    });
    byKey.set(k, out);
  }
  return out;
}

/** Projects a full document for a hidden set. */
export function project(
  full: Node,
  hidden: HiddenSet,
  pschema: Schema = projectionSchema(),
): Projection {
  const key = classId(hidden);
  const cached = entry(projections, pschema, full);
  const known = cached.get(key);
  if (known) return known;
  const spans: Span[] = [];
  const body = full.child(full.childCount - 1);
  let fullPos = bodyStart(full);
  let shift = 0;
  const children: Node[] = [];
  body.forEach((child) => {
    if (child.type.name === 'region' && hidden.regions.has(String(child.attrs['id']))) {
      spans.push({
        id: String(child.attrs['id']),
        fullStart: fullPos,
        fullSize: child.nodeSize,
        projStart: fullPos - shift,
      });
      shift += child.nodeSize - 1;
      children.push(placeholder(child, hidden, key, pschema));
    } else children.push(convert(child, hidden, key, pschema));
    fullPos += child.nodeSize;
  });
  const top: Node[] = [];
  for (let i = 0; i < full.childCount - 1; i++)
    top.push(convert(full.child(i), hidden, key, pschema));
  const pbody = pschema.nodes[body.type.name]!.create(body.attrs, children, marksIn(pschema, body));
  const result: Projection = {
    doc: pschema.nodes[full.type.name]!.create(full.attrs, [...top, pbody], marksIn(pschema, full)),
    spans,
  };
  cached.set(key, result);
  return result;
}

// -----------------------------------------------------------------------------------------------
// Positions.

/** The span whose region strictly contains a full position, if any. */
function spanAround(spans: readonly Span[], pos: number): Span | undefined {
  for (const s of spans) {
    if (pos <= s.fullStart) return undefined;
    if (pos < s.fullStart + s.fullSize) return s;
  }
  return undefined;
}

function f2p(spans: readonly Span[], pos: number): number | null {
  let shift = 0;
  for (const s of spans) {
    if (pos <= s.fullStart) break;
    if (pos < s.fullStart + s.fullSize) return null;
    shift += s.fullSize - 1;
  }
  return pos - shift;
}

function p2f(spans: readonly Span[], pos: number): number {
  let shift = 0;
  for (const s of spans) {
    if (pos <= s.projStart) break;
    shift += s.fullSize - 1;
  }
  return pos + shift;
}

/** Full position → projected position; null when it lies strictly inside a hidden region. */
export function fullToProj(p: Projection, pos: number): number | null {
  return f2p(p.spans, pos);
}

/** Projected position → full position. A position after a placeholder maps after the region. */
export function projToFull(p: Projection, pos: number): number {
  return p2f(p.spans, pos);
}

/**
 * Maps spans through a full step that leaves every hidden region whole (moved, or removed
 * entirely, never cut) and through the matching projected step (null when the projection did not
 * change). Removed regions drop out.
 */
function mapSpans(spans: readonly Span[], full: StepMap, proj: StepMap | null): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const start = full.mapResult(s.fullStart, 1);
    if (start.deletedAfter) continue;
    const end = full.map(s.fullStart + s.fullSize, -1);
    out.push({
      id: s.id,
      fullStart: start.pos,
      fullSize: end - start.pos,
      projStart: proj ? proj.map(s.projStart, 1) : s.projStart,
    });
  }
  return out;
}

/** Whether a projected range [from, to] touches a placeholder (or has one strictly inside). */
function touchesPlaceholder(spans: readonly Span[], from: number, to: number): boolean {
  for (const s of spans) {
    const a = s.projStart;
    const b = s.projStart + 1;
    if (from < b && to > a) return true;
  }
  return false;
}

/** Whether a full range [from, to] overlaps a hidden region (touching its edges does not count). */
function overlapsSpan(spans: readonly Span[], from: number, to: number): boolean {
  for (const s of spans) if (from < s.fullStart + s.fullSize && to > s.fullStart) return true;
  return false;
}

const isRedacted = (v: unknown): boolean =>
  isRedactionMarker(v as Parameters<typeof isRedactionMarker>[0]);

/**
 * Whether a slice carries a placeholder or a redacted value. A reader cannot move or copy what they
 * cannot see: pasting a copy of a field whose value is redacted would otherwise write the marker
 * into the full document.
 */
function sliceCarriesHidden(step: ReplaceStep | ReplaceAroundStep): boolean {
  let found = false;
  step.slice.content.descendants((n) => {
    if (n.type.name === 'hidden_region') found = true;
    else if (
      n.type.name === 'form_field' &&
      (isRedacted(n.attrs['value']) || isRedacted(n.attrs['default']))
    )
      found = true;
    return !found;
  });
  return found;
}

/**
 * Whether a full slice may hold what the class may not see: a field whose value is hidden, or any
 * region. A region in a slice means the step restructures regions, and can carry a hidden region's
 * content into another; such a step goes to the class as the diff of its effect, never as itself.
 */
function sliceHoldsHidden(slice: Slice, hidden: HiddenSet): boolean {
  let found = false;
  slice.content.descendants((n) => {
    if (n.type.name === 'region') found = true;
    else if (n.type.name === 'form_field' && hidden.values.has(String(n.attrs['id']))) found = true;
    return !found;
  });
  return found;
}

/**
 * Whether a step left the full document as it was, judged where the step acts. A step's JSON can
 * carry data that never becomes content (an attribute the node does not have, a mark on a range
 * that holds no text): such a step is never forwarded, so its payload cannot reach a reader.
 */
function changedNothing(step: Step, before: Node, after: Node): boolean {
  try {
    if (
      step instanceof AttrStep ||
      step instanceof AddNodeMarkStep ||
      step instanceof RemoveNodeMarkStep
    ) {
      const a = before.nodeAt(step.pos);
      const b = after.nodeAt(step.pos);
      return !!a && !!b && a.eq(b);
    }
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep)
      return before.slice(step.from, step.to).eq(after.slice(step.from, step.to));
    if (step instanceof ReplaceStep) return step.from === step.to && step.slice.size === 0;
  } catch {
    return false;
  }
  return false;
}

/**
 * One step that turns the projection before a commit into the projection after it, or null when
 * they are equal (the commit changed only hidden content).
 */
export function diffStep(before: Node, after: Node): ReplaceStep | null {
  const start = before.content.findDiffStart(after.content);
  if (start === null || start === undefined) return null;
  const end = before.content.findDiffEnd(after.content);
  if (!end) return null;
  let endA = end.a;
  let endB = end.b;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return new ReplaceStep(start, endA, after.slice(start, endB));
}

/**
 * The steps that turn projection `a` into projection `b`: one replace step for each changed range
 * of body children, narrowed to the first and last differing positions inside it, and one for
 * the definitions and stories before the body when they differ (second review SR-M1: one step per
 * changed range, never one step from the first change to the last). Both projections come from
 * the node cache, so unchanged children are the same objects and are matched by identity. The
 * steps are in descending position order, so each applies to the document the previous ones left.
 */
export function rangeSteps(a: Node, b: Node): ReplaceStep[] {
  const out: ReplaceStep[] = [];
  const bodyA = a.lastChild!;
  const bodyB = b.lastChild!;
  const bodyStartA = a.content.size - bodyA.nodeSize + 1;
  const bodyStartB = b.content.size - bodyB.nodeSize + 1;
  const offsets = (n: Node): number[] => {
    const at = [0];
    n.forEach((c) => at.push(at[at.length - 1]! + c.nodeSize));
    return at;
  };
  const offA = offsets(bodyA);
  const offB = offsets(bodyB);
  // Anchors: children present in both, in the same order.
  const indexB = new Map<Node, number>();
  bodyB.forEach((c, _, i) => {
    if (!indexB.has(c)) indexB.set(c, i);
  });
  const anchors: Array<[number, number]> = [];
  let last = -1;
  bodyA.forEach((c, _, i) => {
    const j = indexB.get(c);
    if (j !== undefined && j > last) {
      anchors.push([i, j]);
      last = j;
    }
  });
  anchors.push([bodyA.childCount, bodyB.childCount]);
  const gaps: Array<[number, number, number, number]> = [];
  let pa = 0;
  let pb = 0;
  for (const [ia, ib] of anchors) {
    if (ia > pa || ib > pb) gaps.push([pa, ia, pb, ib]);
    pa = ia + 1;
    pb = ib + 1;
  }
  const narrowed = (
    fa: Fragment,
    fb: Fragment,
    atA: number,
    atB: number,
    docB: Node,
  ): ReplaceStep | null => {
    const start = fa.findDiffStart(fb);
    if (start === null || start === undefined) return null;
    const end = fa.findDiffEnd(fb);
    if (!end) return null;
    let endA = end.a;
    let endB = end.b;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }
    return new ReplaceStep(atA + start, atA + endA, docB.slice(atB + start, atB + endB));
  };
  for (let g = gaps.length - 1; g >= 0; g--) {
    const [fromA, toA, fromB, toB] = gaps[g]!;
    const step = narrowed(
      bodyA.content.cut(offA[fromA]!, offA[toA]!),
      bodyB.content.cut(offB[fromB]!, offB[toB]!),
      bodyStartA + offA[fromA]!,
      bodyStartB + offB[fromB]!,
      b,
    );
    if (step) out.push(step);
  }
  const before = narrowed(
    a.content.cut(0, bodyStartA - 1),
    b.content.cut(0, bodyStartB - 1),
    0,
    0,
    b,
  );
  if (before) out.push(before);
  return out;
}

// -----------------------------------------------------------------------------------------------
// Outgoing: a stored commit for one class (SYN-051; ADR 0019 change 4; second review SR-M1).

/** How one full step reaches a class. */
export type StepRoute =
  /** It does not touch hidden content: sent as itself at projected positions. */
  | 'mapped'
  /** It changed nothing in the full document: nothing is sent, so its payload goes nowhere. */
  | 'noop'
  /** It changes only the content of one hidden region: nothing is sent. */
  | 'inside'
  /** It sets a hidden value or default: the redacted change is sent, if the projection changes. */
  | 'value'
  /** It touches hidden content otherwise: one diff step covering this step's effect is sent. */
  | 'diff';

function routeOf(step: Step, before: Node, spans: readonly Span[], hidden: HiddenSet): StepRoute {
  const inOne = (...ps: number[]) => {
    const s = spanAround(spans, ps[0]!);
    return s !== undefined && ps.every((p) => spanAround(spans, p) === s);
  };
  const anyInside = (...ps: number[]) => ps.some((p) => spanAround(spans, p) !== undefined);
  if (step instanceof ReplaceStep) {
    if (inOne(step.from, step.to)) return 'inside';
    if (anyInside(step.from, step.to) || sliceHoldsHidden(step.slice, hidden)) return 'diff';
    return 'mapped';
  }
  if (step instanceof ReplaceAroundStep) {
    if (inOne(step.from, step.to, step.gapFrom, step.gapTo)) return 'inside';
    if (overlapsSpan(spans, step.from, step.to) || sliceHoldsHidden(step.slice, hidden))
      return 'diff';
    return 'mapped';
  }
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    if (inOne(step.from, step.to)) return 'inside';
    // A range over a placeholder would mark the atom itself where the schema allows the mark on
    // body children (the suggestion marks), which the full region never gets: diff instead.
    if (overlapsSpan(spans, step.from, step.to)) return 'diff';
    return 'mapped';
  }
  if (
    step instanceof AddNodeMarkStep ||
    step instanceof RemoveNodeMarkStep ||
    step instanceof AttrStep
  ) {
    if (inOne(step.pos)) return 'inside';
    // The region node itself: its placeholder carries the id and possibly the title, no marks.
    if (spans.some((s) => s.fullStart === step.pos)) return 'diff';
    if (step instanceof AttrStep && isRedactedAttr(step.attr)) {
      const target = before.nodeAt(step.pos);
      if (target?.type.name === 'form_field' && hidden.values.has(String(target.attrs['id'])))
        return 'value';
    }
    return 'mapped';
  }
  return 'diff';
}

/** The JSON of a full step with its positions moved to the projection. */
function mapStepJson(step: Step, spans: readonly Span[]): Record<string, unknown> | null {
  const json = step.toJSON() as Record<string, unknown>;
  const at = (k: string): boolean => {
    const v = json[k];
    if (typeof v !== 'number') return true;
    const p = f2p(spans, v);
    if (p === null) return false;
    json[k] = p;
    return true;
  };
  for (const k of ['from', 'to', 'gapFrom', 'gapTo', 'pos']) if (!at(k)) return null;
  return json;
}

export interface ProjectedCommit {
  /** The steps the class receives, in order; empty when its projection did not change. */
  steps: Step[];
  /** The projection after the commit. */
  view: Projection;
  /** How each full step was routed, for diagnostics and the cost report. */
  routes: StepRoute[];
}

/**
 * The steps that turn a class's projection before a commit into its projection after it, one
 * full step at a time (ADR 0019 change 4; SR-M1). Steps that do not touch hidden content keep their
 * type, so selections, comment anchors and readers' concurrent typing map exactly; a diff step
 * covers only the effect of the one step that needs it, never the span between two changes.
 *
 * @param before the class's projection of `fullBefore`
 * @param fullBefore the full document before the commit
 * @param steps the commit's steps as stored (on the full document)
 */
export function projectCommit(
  before: Projection,
  fullBefore: Node,
  steps: readonly Step[],
  hidden: HiddenSet,
  pschema: Schema = projectionSchema(),
): ProjectedCommit {
  let view = before;
  let full = fullBefore;
  const out: Step[] = [];
  const routes: StepRoute[] = [];
  for (const step of steps) {
    const r = step.apply(full);
    if (!r.doc) throw new Error(`projectCommit: a stored step does not apply: ${r.failed}`);
    const next = r.doc;
    let route: StepRoute = changedNothing(step, full, next)
      ? 'noop'
      : routeOf(step, full, view.spans, hidden);
    if (route === 'noop') {
      // The projection is unchanged and so are the spans; only the full document object is new.
    } else if (route === 'mapped') {
      const json = mapStepJson(step, view.spans);
      let done = false;
      if (json) {
        try {
          const m = Step.fromJSON(pschema, json);
          const applied = m.apply(view.doc);
          if (applied.doc) {
            out.push(m);
            view = { doc: applied.doc, spans: mapSpans(view.spans, step.getMap(), m.getMap()) };
            done = true;
          }
        } catch {
          // Fall through to the diff of this step.
        }
      }
      if (!done) route = 'diff';
    } else if (route === 'inside') {
      // The region must stay one body child with its identity: a slice could split it.
      const span = spanAround(view.spans, stepPos(step))!;
      const spansAfter = mapSpans(view.spans, step.getMap(), null);
      const moved = spansAfter.find((s) => s.id === span.id);
      const node = moved ? next.nodeAt(moved.fullStart) : null;
      if (
        moved &&
        node?.type.name === 'region' &&
        String(node.attrs['id']) === span.id &&
        node.nodeSize === moved.fullSize &&
        next.child(next.childCount - 1).childCount === full.child(full.childCount - 1).childCount
      )
        view = { doc: view.doc, spans: spansAfter };
      else route = 'diff';
    } else if (route === 'value') {
      const s = step as AttrStep;
      const target = view.doc.nodeAt(f2p(view.spans, s.pos)!);
      const value = redactedValue(s.value);
      if (target && JSON.stringify(target.attrs[s.attr] ?? null) !== JSON.stringify(value)) {
        const m = new AttrStep(f2p(view.spans, s.pos)!, s.attr, value);
        const applied = m.apply(view.doc);
        if (applied.doc) {
          out.push(m);
          view = { doc: applied.doc, spans: view.spans };
        } else route = 'diff';
      }
    }
    if (route === 'diff') {
      // From this step on, the class receives the ranges that differ between its projection now
      // and its projection of the commit's result, one replace step per changed range. A commit is
      // atomic (07 §5.1 compares only before and after it), so no projection of a state inside the
      // commit reached through a step that touches hidden content is ever sent: such a step can,
      // for example, move hidden text out of its region and a later step delete it again.
      let end = next;
      for (const later of steps.slice(routes.length + 1)) {
        const lr = later.apply(end);
        if (!lr.doc) throw new Error(`projectCommit: a stored step does not apply: ${lr.failed}`);
        end = lr.doc;
      }
      // Both from the node cache, so that unchanged children are shared and matched by identity.
      const a = project(full, hidden, pschema);
      const b = project(end, hidden, pschema);
      out.push(...rangeSteps(a.doc, b.doc));
      while (routes.length < steps.length) routes.push('diff');
      return { steps: out, view: b, routes };
    }
    routes.push(route);
    full = next;
  }
  return { steps: out, view, routes };
}

function stepPos(step: Step): number {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) return step.from;
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) return step.from;
  if (
    step instanceof AddNodeMarkStep ||
    step instanceof RemoveNodeMarkStep ||
    step instanceof AttrStep
  )
    return step.pos;
  return 0;
}

// -----------------------------------------------------------------------------------------------
// Incoming: a reader's steps (SYN-052; ADR 0019 decision item 4, change 5).

/**
 * Maps steps made on a projection to the full document, applying them as it goes. A step that
 * touches a placeholder, or whose slice carries one, is refused: a reader cannot change, move or
 * copy what they cannot see. Field values that are hidden cannot be set either.
 *
 * @param start the projection of `full` for this hidden set, when the caller holds it; otherwise
 * it is computed. The spans are then mapped through every step, so later steps need no scan.
 */
export function toFullSteps(
  projected: readonly Step[],
  full: Node,
  hidden: HiddenSet,
  pschema: Schema,
  fschema: Schema,
  start?: Projection,
): Result<{ steps: Step[]; doc: Node }> {
  let doc = full;
  let view = start ?? project(full, hidden, pschema);
  const out: Step[] = [];
  for (let i = 0; i < projected.length; i++) {
    const s = projected[i]!;
    const json = s.toJSON() as Record<string, unknown>;
    let mapped: Record<string, unknown>;
    const deny = (why: string) =>
      fail<{ steps: Step[]; doc: Node }>('permission_denied', `step ${i} ${why}`);
    const sp = view.spans;
    if (s instanceof ReplaceStep) {
      if (touchesPlaceholder(sp, s.from, s.to) || sliceCarriesHidden(s))
        return deny('touches content you cannot see');
      mapped = { ...json, from: p2f(sp, s.from), to: p2f(sp, s.to) };
    } else if (s instanceof ReplaceAroundStep) {
      if (touchesPlaceholder(sp, s.from, s.to) || sliceCarriesHidden(s))
        return deny('touches content you cannot see');
      mapped = {
        ...json,
        from: p2f(sp, s.from),
        to: p2f(sp, s.to),
        gapFrom: p2f(sp, s.gapFrom),
        gapTo: p2f(sp, s.gapTo),
      };
    } else if (s instanceof AddMarkStep || s instanceof RemoveMarkStep) {
      if (touchesPlaceholder(sp, s.from, s.to)) return deny('touches content you cannot see');
      mapped = { ...json, from: p2f(sp, s.from), to: p2f(sp, s.to) };
    } else if (
      s instanceof AddNodeMarkStep ||
      s instanceof RemoveNodeMarkStep ||
      s instanceof AttrStep
    ) {
      if (touchesPlaceholder(sp, s.pos, s.pos + 1)) return deny('touches content you cannot see');
      let target: Node | null;
      try {
        target = view.doc.nodeAt(s.pos);
      } catch {
        target = null;
      }
      if (
        s instanceof AttrStep &&
        target?.type.name === 'form_field' &&
        hidden.values.has(String(target.attrs['id'])) &&
        isRedactedAttr(s.attr)
      ) {
        return deny('sets a value you cannot read');
      }
      mapped = { ...json, pos: p2f(sp, s.pos) };
    } else return deny('is not a step type a reader may send');
    let fullStep: Step;
    try {
      fullStep = Step.fromJSON(fschema, mapped);
    } catch (e) {
      return fail('invalid_op', `step ${i} could not be mapped: ${(e as Error).message}`);
    }
    let r: ReturnType<Step['apply']>;
    let pr: ReturnType<Step['apply']>;
    try {
      r = fullStep.apply(doc);
      pr = s.apply(view.doc);
    } catch {
      // A crafted step can map outside the document; ProseMirror throws rather than failing. Its
      // message can quote the full document's content, so the reader is not given it (ADR 0019).
      return fail('invalid_op', `step ${i} does not fit the document`);
    }
    if (r.failed || !r.doc)
      return fail('invalid_op', `step ${i} failed on the full document: ${r.failed}`);
    if (pr.failed || !pr.doc)
      return fail('invalid_op', `step ${i} failed on your projection: ${pr.failed}`);
    out.push(fullStep);
    view = { doc: pr.doc, spans: mapSpans(sp, fullStep.getMap(), s.getMap()) };
    doc = r.doc;
  }
  return ok({ steps: out, doc });
}
