/**
 * The validation of a commit's result from what the commit changed (CDM-013 criterion 7; 04 §12;
 * ADR 0422).
 *
 * `validate()` reads the whole document, so its cost grows with the document, and a room validates
 * the result of every commit. Nearly every commit changes one paragraph, and ProseMirror documents
 * are persistent: the result of a commit shares every node the commit did not touch with the
 * document before it. A CommitValidator uses that. It keeps indexes of one document (identifiers,
 * definitions, bookmark names, reference targets and their uses, regions, formulas, a bound of the
 * canonical size). For a commit it finds the nodes the commit removed and added by comparing the
 * two documents by identity, runs the checks of one node (node-checks.ts) on the added ones, and
 * decides the document-wide checks from the indexes and the two sets of nodes.
 *
 * It never reports a violation of its own. Whenever it cannot say "valid" from the changed nodes
 * (a violation, a changed definition, a registered check that reads a changed node type, a
 * document near the size limit, a document before that it never saw pass), it runs `validateDoc()`
 * on the result and returns that. So `validate()` here returns what `validateDoc()` returns for
 * the document after the commit, with the document before as `previous`. Only the cost differs.
 */
import {
  Mark,
  type ContentMatch,
  type Node as PMNode,
  type NodeType,
  type Schema,
} from 'prosemirror-model';
import { canonicalShellText, type JsonNode } from '../canonical/canonical-form.ts';
import { CanonicalizationError, canonicalize } from '../canonical/jcs.ts';
import { CDM1 } from '../definition/cdm1.ts';
import type { CdmDefinition, JsonValue } from '../definition/grammar.ts';
import { indexDefinition, type DefinitionIndex } from '../definition/index.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import {
  LIMITS,
  afterChildren,
  checkContent,
  readsChildren,
  visitNode,
  walkNode,
  type NumberingUse,
  type ParagraphInfo,
  type Recorder,
  type RefUse,
  type StyleInfo,
  type Visit,
} from './node-checks.ts';
import {
  levelProblem,
  refProblem,
  targetProblem,
  type Definitions,
  type Targets,
} from './references.ts';
import type { InvariantCheck, ValidationContext, ValidationResult } from './types.ts';
import { checksOf, validateDoc } from './validate.ts';

/** The context of a commit: the document before it is the `previous` of the validation. */
export type CommitContext = Omit<ValidationContext, 'previous'>;

export interface CommitValidation extends ValidationResult {
  /** From the changed nodes and the indexes, or by validating the whole document. */
  how: 'incremental' | 'full';
  /** Why the whole document was validated; absent when it was not. */
  why?: string;
}

// -------------------------------------------------------------------------------------------------
// Indexes: what the document-wide checks need to know of the nodes a commit left alone.

interface Index extends Definitions, Targets {
  /** Every node identifier (I2). */
  ids: Set<string>;
  /** The user of each suggestion identifier and how many marks and block suggestions carry it. */
  suggestions: Map<string, { user: string; n: number }>;
  anchors: Set<string>;
  eqLabels: Set<string>;
  /** The identifiers of the regions (I3, I7). */
  regions: Set<string>;
  /** `display:latex` of every formula, with how often it occurs (I8). */
  formulas: Map<string, number>;
  /** The assets referred to, with how often (I4). */
  assets: Map<string, number>;
  /** The `field.target` values in use, with how often (I4). */
  targets: Map<string, number>;
  paragraphs: Map<string, ParagraphInfo>;
  styles: Map<string, StyleInfo>;
  numberingLevels: Map<string, number>;
  pageSetups: Set<string>;
  stories: Map<string, string>;
  sources: Set<string>;
  preservedDefs: Set<string>;
  /** The bound of the canonical size of the `doc` node (see `Sizes`). */
  bytes: number;
}

function emptyIndex(): Index {
  return {
    ids: new Set(),
    suggestions: new Map(),
    anchors: new Set(),
    eqLabels: new Set(),
    regions: new Set(),
    formulas: new Map(),
    assets: new Map(),
    targets: new Map(),
    paragraphs: new Map(),
    styles: new Map(),
    defaultStyle: null,
    numberingLevels: new Map(),
    pageSetups: new Set(),
    stories: new Map(),
    sources: new Set(),
    preservedDefs: new Set(),
    bytes: 0,
  };
}

const NONE: readonly never[] = [];

function bump(counts: Map<string, number>, key: string, by: number): void {
  const n = (counts.get(key) ?? 0) + by;
  if (n > 0) counts.set(key, n);
  else counts.delete(key);
}

/** What judging the added nodes needs: the context of the commit and the document before it. */
interface Judge {
  requires: ReadonlySet<string>;
  ctx: CommitContext;
  /** The formulas of the document before the commit: they are not gated again (09 §6.3). */
  formulas: ReadonlyMap<string, number>;
}

/** A definition among the nodes of a side: what it sets in the indexes. */
type DefinitionEntry =
  | { kind: 'settings'; defaultStyle: string | null }
  | { kind: 'style'; id: string; info: StyleInfo }
  | { kind: 'numbering'; id: string; levels: number }
  | { kind: 'story'; id: string; storyKind: string }
  | { kind: 'pageSetup' | 'source' | 'preservedDef'; id: string };

/**
 * One side of a commit: what the nodes it removed gave the indexes, or what the nodes it added
 * give. It is the recorder of the node checks. The added side of a commit also judges: the first
 * violation of a node, or of the added nodes among themselves, is kept in `why` and stops the walk.
 * A side that only collects (the removed nodes, and both sides when the indexes move between two
 * documents known to be valid) ignores violations.
 */
class Side implements Recorder {
  readonly ids = new Set<string>();
  readonly suggestions = new Map<string, { user: string; n: number }>();
  readonly anchors = new Set<string>();
  readonly eqLabels = new Set<string>();
  readonly regions = new Set<string>();
  readonly formulas = new Map<string, number>();
  readonly assets = new Map<string, number>();
  readonly targets = new Map<string, number>();
  readonly refs: RefUse[] = [];
  readonly numberingUses: NumberingUse[] = [];
  readonly paragraphs = new Map<string, ParagraphInfo>();
  /** The definitions among the nodes of this side, in document order. */
  readonly definitions: DefinitionEntry[] = [];
  /** The types of the nodes of this side (text is not listed). */
  readonly types = new Set<string>();
  /** The first violation found, as its code; empty while there is none. */
  why = '';
  private readonly judge: Judge | null;

  constructor(judge: Judge | null) {
    this.judge = judge;
  }

  get judging(): boolean {
    return this.judge !== null;
  }

  fail(code: string): void {
    if (this.judge && !this.why) this.why = code;
  }

  add(code: string): void {
    this.fail(code);
  }
  missing(feature: string): boolean {
    return this.judge !== null && !this.judge.requires.has(feature);
  }
  feature(): void {
    this.fail('feature_missing');
  }
  deep(): void {
    this.fail('nesting_too_deep');
  }
  oversize(): void {
    this.fail('canonical_too_large');
  }
  stopped(): boolean {
    return this.why !== '';
  }
  id(id: string): void {
    if (this.ids.has(id)) this.fail('duplicate_id');
    this.ids.add(id);
  }
  suggestion(sid: string, user: string): void {
    const s = this.suggestions.get(sid);
    if (!s) this.suggestions.set(sid, { user, n: 1 });
    else {
      if (s.user !== user) this.fail('suggestion_user');
      s.n++;
    }
  }
  name(kind: 'anchor' | 'eq', name: string): void {
    const names = kind === 'anchor' ? this.anchors : this.eqLabels;
    if (names.has(name)) this.fail('duplicate_target_name');
    names.add(name);
  }
  region(id: JsonValue | undefined): void {
    // A region without an identifier is `missing_id` already.
    if (typeof id !== 'string') return;
    this.regions.add(id);
    if (this.judge?.ctx.retiredRegionIds?.has(id)) this.fail('region_id_reused');
  }
  math(latex: string, display: boolean): void {
    const key = `${display}:${latex}`;
    const seen = this.formulas.has(key);
    bump(this.formulas, key, 1);
    const gate = this.judge?.ctx.mathGate;
    // A formula the document before already held passed the gate when it was set (09 §6.3).
    if (!gate || seen || this.judge!.formulas.has(key)) return;
    if (gate(latex, display)) this.fail('math_refused');
  }
  ref(use: RefUse): void {
    this.refs.push(use);
    if (use.to === 'asset') bump(this.assets, use.value, 1);
  }
  target(use: { value: string }): void {
    bump(this.targets, use.value, 1);
  }
  numbering(use: NumberingUse): void {
    this.numberingUses.push(use);
  }
  settings(defaultStyle: string | null): void {
    this.definitions.push({ kind: 'settings', defaultStyle });
  }
  style(id: string, info: StyleInfo): void {
    this.definitions.push({ kind: 'style', id, info });
  }
  numberingDef(id: string, levels: number): void {
    this.definitions.push({ kind: 'numbering', id, levels });
  }
  pageSetup(id: string): void {
    this.definitions.push({ kind: 'pageSetup', id });
  }
  preservedDef(id: string): void {
    this.definitions.push({ kind: 'preservedDef', id });
  }
  source(id: string): void {
    this.definitions.push({ kind: 'source', id });
  }
  story(id: string, kind: string): void {
    this.definitions.push({ kind: 'story', id, storyKind: kind });
  }
  paragraph(id: string, style: string | null, numbered: boolean): void {
    this.paragraphs.set(id, { style, numbered, caption: false });
  }
  caption(id: string, caption: boolean): void {
    const info = this.paragraphs.get(id);
    if (info) info.caption = caption;
  }
  node(entry: { type: string }): void {
    this.types.add(entry.type);
  }
}

// -------------------------------------------------------------------------------------------------
// The size bound.

/** The UTF-8 length of a string without lone surrogates (the canonical form has none). */
function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // A surrogate pair: four bytes for its two code units.
      n += 2;
      i++;
    } else n += 2;
  }
  return n;
}

/**
 * The UTF-8 length of a string as RFC 8785 writes it, quotes included, without writing it: `"` and
 * `\` take two bytes, the control characters below U+0020 two (`\b`, `\t`, `\n`, `\f`, `\r`) or six
 * (`\u00XX`), everything else its UTF-8 length. A lone surrogate is refused, as `canonicalize` does.
 */
export function quotedBytes(s: string): number {
  let n = 2;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      if (c >= 0x20) n += c === 0x22 || c === 0x5c ? 2 : 1;
      else n += c === 8 || c === 9 || c === 10 || c === 12 || c === 13 ? 2 : 6;
    } else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdfff) {
      const d = c <= 0xdbff ? s.charCodeAt(i + 1) : 0;
      if (!(d >= 0xdc00 && d <= 0xdfff))
        throw new CanonicalizationError('lone surrogate in string', '');
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** A node as JSON without its content: what the checks of the node itself read. */
function shell(node: PMNode): Record<string, unknown> {
  const out: Record<string, unknown> = { type: node.type.name };
  // As Node.toJSON() writes it: `attrs` only when the type has attributes.
  if (Object.keys(node.attrs).length) out['attrs'] = node.attrs;
  if (node.marks.length) out['marks'] = node.marks.map((m) => m.toJSON() as unknown);
  return out;
}

/** What a content array adds around its items: `"content":[`, `],` and the commas between them. */
const around = (children: number): number => (children > 0 ? 12 + children : 0);

/**
 * The bytes of nodes: the sum of the canonical bytes of each node on its own. For a document it is
 * the size of the canonical form (03 §2) except that it never merges two adjacent text nodes, which
 * the canonical form does when their marks are equal after sorting. ProseMirror keeps such
 * neighbours merged, so the two sizes differ only where text nodes carry the same suggestion marks
 * in another order, and then this one is the larger. It is therefore an upper bound of the
 * canonical size, and it is a sum over nodes: a commit changes it by what its removed nodes took
 * away and its added nodes brought, which is what the indexes keep.
 */
class Sizes {
  private readonly def: CdmDefinition;
  /** What a text node costs besides its text, per mark set (ProseMirror shares the arrays). */
  private readonly text = new WeakMap<readonly Mark[], number>();

  constructor(def: CdmDefinition) {
    this.def = def;
  }

  /** The canonical bytes of a node as JSON without content: braces, type, attributes, marks. */
  json(node: Record<string, unknown>): number {
    return utf8Length(canonicalShellText(node as unknown as JsonNode, this.def));
  }

  /** The canonical bytes of a node without its content. */
  shell(node: PMNode): number {
    if (!node.isText) return this.json(shell(node));
    let base = this.text.get(node.marks);
    if (base === undefined) {
      const empty: Record<string, unknown> = { type: 'text', text: '' };
      if (node.marks.length) empty['marks'] = node.marks.map((m) => m.toJSON() as unknown);
      // `{"marks":[…],"text":"","type":"text"}` without the two quotes of the empty text.
      base = this.json(empty) - 2;
      this.text.set(node.marks, base);
    }
    return base + quotedBytes(node.text ?? '');
  }

  /** The bytes of a node and everything below it. */
  tree(node: PMNode): number {
    let n = this.shell(node);
    const children = node.content.content;
    if (children.length) {
      n += around(children.length);
      for (const child of children) n += this.tree(child);
    }
    return n;
  }

  /** The bytes of the envelope around the `doc` node: `cdm`, `requires` and the member name. */
  envelope(requires: readonly string[]): number {
    // `0` stands where the document goes.
    const text = canonicalize({
      cdm: this.def.cdm,
      requires: [...new Set(requires)].sort(),
      doc: 0,
    });
    return utf8Length(text) - 1;
  }
}

// -------------------------------------------------------------------------------------------------
// What a commit removed and added.

interface Delta {
  removed: Side;
  added: Side;
  /** The change of the size bound. */
  bytes: number;
}

/**
 * The children of a node as JSON, two levels deep, with their types and attributes: what the
 * checks after a node's children read (`afterChildren` in node-checks.ts).
 */
function skeleton(node: PMNode): unknown[] {
  return node.content.content.map((c) => ({
    type: c.type.name,
    attrs: c.attrs,
    content: c.content.content.map((g) => ({ type: g.type.name, attrs: g.attrs })),
  }));
}

/**
 * Whether two nodes have the same skeleton: the same types and attributes in the two levels below
 * them. Attributes are compared by identity, which ProseMirror keeps when it copies a node with
 * other content; equal attributes in another object count as different, which only costs a check.
 */
function sameSkeleton(a: PMNode, b: PMNode): boolean {
  const xs = a.content.content;
  const ys = b.content.content;
  if (xs.length !== ys.length) return false;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (x === y) continue;
    if (x.type !== y.type || x.attrs !== y.attrs) return false;
    const gx = x.content.content;
    const gy = y.content.content;
    if (gx.length !== gy.length) return false;
    for (let j = 0; j < gx.length; j++) {
      const p = gx[j]!;
      const q = gy[j]!;
      if (p !== q && (p.type !== q.type || p.attrs !== q.attrs)) return false;
    }
  }
  return true;
}

function paragraphsIn(node: PMNode): number {
  let n = 0;
  for (const c of node.content.content) if (c.type.name === 'paragraph') n++;
  return n;
}

/** Whether a paragraph holds a `seq` field, which makes it a caption (a target of references). */
function isCaption(node: PMNode): boolean {
  for (const c of node.content.content)
    if (c.type.name === 'field' && c.attrs['kind'] === 'seq') return true;
  return false;
}

/** Whether the marks of a node are a set as ProseMirror builds one (`Node.check()`). */
function validMarks(node: PMNode): boolean {
  let copy: readonly Mark[] = Mark.none;
  for (const m of node.marks) copy = m.addToSet(copy);
  return Mark.sameSet(copy, node.marks);
}

/** A content expression that is any number of nodes of a set of types, such as `block+`. */
interface AnyOf {
  types: ReadonlySet<NodeType>;
  /** Whether it needs at least one node. */
  atLeastOne: boolean;
}

const anyOfCache = new WeakMap<NodeType, AnyOf | null>();

/**
 * The content expression of a node type as "any number of these types", or null when it is another
 * kind (a sequence such as `defs story* body`). It is that kind when every state its automaton
 * reaches accepts the same types as the start and every state but the start is a valid end. Then a
 * content is valid exactly when each child is of an accepted type and, where one is needed, there is
 * one; so for a node whose content was valid, only its new children need a look, not all of them.
 */
function anyOf(type: NodeType): AnyOf | null {
  const known = anyOfCache.get(type);
  if (known !== undefined) return known;
  const start = type.contentMatch;
  const types = new Set<NodeType>();
  for (let i = 0; i < start.edgeCount; i++) types.add(start.edge(i).type);
  let rule: AnyOf | null = { types, atLeastOne: !start.validEnd };
  const seen = new Set<ContentMatch>([start]);
  const todo = [start];
  while (rule && todo.length) {
    const m = todo.pop()!;
    if ((m !== start && !m.validEnd) || m.edgeCount !== types.size) rule = null;
    for (let i = 0; rule && i < m.edgeCount; i++) {
      const edge = m.edge(i);
      if (!types.has(edge.type)) rule = null;
      else if (!seen.has(edge.next)) {
        seen.add(edge.next);
        todo.push(edge.next);
      }
    }
  }
  anyOfCache.set(type, rule);
  return rule;
}

/**
 * The path given to the node checks. A side never reports where a violation is (the full
 * validation does that), so no path is built.
 */
const NOWHERE = '';

/**
 * Walks two documents together and records, on two sides, the nodes that are in one and not in the
 * other. Children that are the same object in both are skipped with everything below them: they
 * are in the same place under nodes of the same types, so their checks and what they give the
 * indexes are unchanged.
 */
class Differ {
  bytes = 0;
  /** A node could not be read or measured: the delta is not to be applied. */
  broken = false;
  private readonly ix: DefinitionIndex;
  private readonly sizes: Sizes;
  private readonly removed: Side;
  private readonly added: Side;

  constructor(ix: DefinitionIndex, sizes: Sizes, removed: Side, added: Side) {
    this.ix = ix;
    this.sizes = sizes;
    this.removed = removed;
    this.added = added;
  }

  /** The whole of `after` when `before` is null. */
  run(before: PMNode | null, after: PMNode): void {
    if (before === after) return;
    if (before === null) this.add(after, [], 1);
    else this.each(before, after, [], 1);
  }

  /** A node whose subtree was not read: the added side fails, and the delta is not to be applied. */
  private lost(code: string): void {
    this.broken = true;
    this.added.fail(code);
  }

  private measure(sign: 1 | -1, size: () => number): void {
    try {
      this.bytes += sign * size();
    } catch {
      // Not canonicalisable (a lone surrogate, a number that is not finite).
      this.lost('not_canonicalisable');
    }
  }

  /** A node of the document after with everything below it: all of it is new. */
  private add(node: PMNode, ancestors: readonly string[], depth: number): void {
    const side = this.added;
    if (side.stopped()) return;
    const json = node.toJSON() as Record<string, unknown>;
    walkNode(this.ix, side, json, NOWHERE, ancestors, depth, null);
    if (side.stopped()) return;
    if (side.judging) {
      // I1: content expressions, attribute types and mark sets, as ProseMirror checks them.
      try {
        node.check();
      } catch {
        return side.fail('schema_content');
      }
    }
    this.measure(1, () => this.sizes.tree(node));
  }

  /** A node of the document before with everything below it: all of it is gone. */
  private remove(node: PMNode, ancestors: readonly string[], depth: number): void {
    const json = node.toJSON() as Record<string, unknown>;
    walkNode(this.ix, this.removed, json, NOWHERE, ancestors, depth, null);
    this.measure(-1, () => this.sizes.tree(node));
  }

  /** Two nodes in the same place that are not the same object. */
  private each(a: PMNode, b: PMNode, ancestors: readonly string[], depth: number): void {
    if (a.type === b.type && !a.isText) this.pair(a, b, ancestors, depth);
    else {
      this.remove(a, ancestors, depth);
      this.add(b, ancestors, depth);
    }
  }

  /** One node before and after: the same type in the same place, with other content or markup. */
  private pair(a: PMNode, b: PMNode, ancestors: readonly string[], depth: number): void {
    const { ix, removed, added } = this;
    if (added.stopped()) return;
    const type = b.type.name;
    const nd = ix.nodes.get(type);
    if (!nd) return this.lost('unknown_node_type');
    // A caption is a paragraph that holds a `seq` field: its content decides what it gives the
    // indexes, so a paragraph that became or stopped being one counts as changed.
    const same =
      ((a.attrs === b.attrs && a.marks === b.marks) || a.sameMarkup(b)) &&
      (type !== 'paragraph' || isCaption(a) === isCaption(b));
    let v: Visit | null = null;
    if (!same) {
      const sa = shell(a);
      const sb = shell(b);
      const va = visitNode(ix, removed, sa, NOWHERE, ancestors, depth, null);
      if (va && a.childCount) afterChildren(removed, va, NOWHERE, () => skeleton(a));
      v = visitNode(ix, added, sb, NOWHERE, ancestors, depth, null);
      // A node the checks do not enter (nested too deep) has reported it; its children are not read.
      if (!v) return this.lost('nesting_too_deep');
      if (added.stopped()) return;
      if (added.judging && !validMarks(b)) return added.fail('schema_content');
      this.measure(-1, () => this.sizes.json(sa));
      this.measure(1, () => this.sizes.json(sb));
    }
    // The checks that read a node's children (the geometry of a table, the paragraphs of a
    // footnote) read two levels. When those are as they were, the answer is as it was.
    if (b.childCount && readsChildren(type) && (!same || !sameSkeleton(a, b))) {
      if (!v) {
        const own =
          ix.idNodes.has(type) && typeof b.attrs['id'] === 'string' ? b.attrs['id'] : null;
        v = { type, nd, attrs: b.attrs as Record<string, JsonValue>, own, nodeId: own };
      }
      checkContent(added, v, NOWHERE, true, () => paragraphsIn(b));
      afterChildren(added, v, NOWHERE, () => skeleton(b));
      if (added.stopped()) return;
    }
    // I1: the content against the content expression, and the marks the children may carry. For
    // "any number of these types" only the new children are looked at, as they are met below.
    let rule: AnyOf | null = null;
    if (added.judging) {
      rule = anyOf(b.type);
      if (rule ? rule.atLeastOne && b.childCount === 0 : !b.type.validContent(b.content))
        return added.fail('schema_content');
    }
    this.bytes += around(b.childCount) - around(a.childCount);
    this.children(a, b, [...ancestors, type], depth + 1, rule);
  }

  /** Whether a new child fits a parent whose content is "any number of these types" (`pair`). */
  private fits(parent: PMNode, child: PMNode, rule: AnyOf | null): boolean {
    if (!rule || (rule.types.has(child.type) && parent.type.allowsMarks(child.marks))) return true;
    this.added.fail('schema_content');
    return false;
  }

  /**
   * The children of a pair. The children that are the same objects at the start and at the end
   * are skipped. Between them, a child on each side that the other side does not have is taken as
   * one node before and after; a child only one side has is removed or added whole; a child both
   * sides have in another place has moved, and is removed where it was and added where it is.
   *
   * However the children are matched, every child is counted once on its side: left alone with
   * the same object, taken as a pair, removed, or added. So the two sides are right for any
   * match, also when one object is a child more than once; a better match only records fewer
   * nodes.
   */
  private children(
    a: PMNode,
    b: PMNode,
    ancestors: readonly string[],
    depth: number,
    rule: AnyOf | null,
  ): void {
    const xs = a.content.content;
    const ys = b.content.content;
    let start = 0;
    const least = Math.min(xs.length, ys.length);
    while (start < least && xs[start] === ys[start]) start++;
    let endA = xs.length;
    let endB = ys.length;
    while (endA > start && endB > start && xs[endA - 1] === ys[endB - 1]) {
      endA--;
      endB--;
    }
    let i = start;
    let j = start;
    if (endA - start === 1 && endB - start === 1) {
      // The usual case: one child changed.
      if (this.fits(b, ys[j]!, rule)) this.each(xs[i]!, ys[j]!, ancestors, depth);
      return;
    }
    if (endA > start && endB > start) {
      // Where each child stands on the other side, for the children both sides have.
      const before = new Map<PMNode, number>();
      const after = new Map<PMNode, number>();
      for (let k = start; k < endA; k++) before.set(xs[k]!, k);
      for (let k = start; k < endB; k++) after.set(ys[k]!, k);
      // Children that moved: removed ahead of their place after, or added ahead of their place
      // before. When the other side reaches them they are added, or removed.
      const gone = new Set<PMNode>();
      const come = new Set<PMNode>();
      while (i < endA && j < endB) {
        const x = xs[i]!;
        const y = ys[j]!;
        if (x === y) {
          i++;
          j++;
          continue;
        }
        const xThere = come.has(x) ? undefined : after.get(x);
        const yThere = gone.has(y) ? undefined : before.get(y);
        if (xThere === undefined && yThere === undefined) {
          // Neither is waited for on the other side: one node before and after, unless one of
          // them moved and was counted where it went.
          if (come.has(x)) {
            this.remove(x, ancestors, depth);
            i++;
          } else if (gone.has(y)) {
            if (this.fits(b, y, rule)) this.add(y, ancestors, depth);
            j++;
          } else {
            if (this.fits(b, y, rule)) this.each(x, y, ancestors, depth);
            i++;
            j++;
          }
        } else if (xThere === undefined) {
          this.remove(x, ancestors, depth);
          i++;
        } else if (yThere === undefined) {
          if (this.fits(b, y, rule)) this.add(y, ancestors, depth);
          j++;
        } else if (xThere - j >= yThere - i) {
          // Both are on the other side, elsewhere: the one that is further from its place moved.
          this.remove(x, ancestors, depth);
          gone.add(x);
          i++;
        } else {
          if (this.fits(b, y, rule)) this.add(y, ancestors, depth);
          come.add(y);
          j++;
        }
      }
    }
    for (; i < endA; i++) this.remove(xs[i]!, ancestors, depth);
    for (; j < endB; j++) if (this.fits(b, ys[j]!, rule)) this.add(ys[j]!, ancestors, depth);
  }
}

/** Moves the indexes over a delta: first what the removed nodes gave, then what the added give. */
function apply(index: Index, d: Delta): void {
  const { removed: r, added: a } = d;
  for (const id of r.ids) index.ids.delete(id);
  for (const [sid, s] of r.suggestions) {
    const held = index.suggestions.get(sid);
    if (held && (held.n -= s.n) <= 0) index.suggestions.delete(sid);
  }
  for (const n of r.anchors) index.anchors.delete(n);
  for (const n of r.eqLabels) index.eqLabels.delete(n);
  for (const id of r.regions) index.regions.delete(id);
  for (const [k, n] of r.formulas) bump(index.formulas, k, -n);
  for (const [k, n] of r.assets) bump(index.assets, k, -n);
  for (const [k, n] of r.targets) bump(index.targets, k, -n);
  for (const id of r.paragraphs.keys()) index.paragraphs.delete(id);
  for (const e of r.definitions) {
    if (e.kind === 'settings') index.defaultStyle = null;
    else if (e.kind === 'style') index.styles.delete(e.id);
    else if (e.kind === 'numbering') index.numberingLevels.delete(e.id);
    else if (e.kind === 'story') index.stories.delete(e.id);
    else if (e.kind === 'pageSetup') index.pageSetups.delete(e.id);
    else if (e.kind === 'source') index.sources.delete(e.id);
    else index.preservedDefs.delete(e.id);
  }

  for (const id of a.ids) index.ids.add(id);
  for (const [sid, s] of a.suggestions) {
    const held = index.suggestions.get(sid);
    if (held) held.n += s.n;
    else index.suggestions.set(sid, { user: s.user, n: s.n });
  }
  for (const n of a.anchors) index.anchors.add(n);
  for (const n of a.eqLabels) index.eqLabels.add(n);
  for (const id of a.regions) index.regions.add(id);
  for (const [k, n] of a.formulas) bump(index.formulas, k, n);
  for (const [k, n] of a.assets) bump(index.assets, k, n);
  for (const [k, n] of a.targets) bump(index.targets, k, n);
  for (const [id, info] of a.paragraphs) index.paragraphs.set(id, info);
  for (const e of a.definitions) {
    if (e.kind === 'settings') index.defaultStyle = e.defaultStyle;
    else if (e.kind === 'style') index.styles.set(e.id, e.info);
    else if (e.kind === 'numbering') index.numberingLevels.set(e.id, e.levels);
    else if (e.kind === 'story') index.stories.set(e.id, e.storyKind);
    else if (e.kind === 'pageSetup') index.pageSetups.add(e.id);
    else if (e.kind === 'source') index.sources.add(e.id);
    else index.preservedDefs.add(e.id);
  }
  index.bytes += d.bytes;
}

/**
 * Whether the result of a commit is valid, from the indexes of the document before it and the two
 * sides of the commit. Returns null for "valid", or why this cannot be said without reading the
 * whole document. It changes nothing.
 */
function decide(
  index: Index,
  d: Delta,
  ctx: CommitContext,
  checks: readonly InvariantCheck[],
  envelope: number,
): string | null {
  const { removed: r, added: a } = d;
  if (a.why) return `a changed node is not valid (${a.why})`;
  // A definition that is removed, added or changed can break or mend any reference to it, a chain
  // of styles (I5) or a heading that a field names.
  if (r.definitions.length || a.definitions.length) return 'a definition changed';
  for (const c of checks)
    for (const t of c.reads?.nodes ?? NONE)
      if (r.types.has(t) || a.types.has(t)) return `the check "${c.name}" reads a changed ${t}`;
  for (const c of ctx.identifierChanges ?? [])
    if (c.from !== null && c.from !== c.to && c.copy !== true) return 'an identifier changed (I2)';

  // I2: identifiers stay unique, and a suggestion identifier keeps its one user.
  for (const id of a.ids)
    if (index.ids.has(id) && !r.ids.has(id)) return 'an identifier is used twice (I2)';
  for (const [sid, s] of a.suggestions) {
    const held = index.suggestions.get(sid);
    if (held && held.user !== s.user && held.n > (r.suggestions.get(sid)?.n ?? 0))
      return 'a suggestion identifier has two users (I2)';
  }
  // I4: bookmark names and equation labels stay unique.
  for (const n of a.anchors)
    if (index.anchors.has(n) && !r.anchors.has(n)) return 'a bookmark name is used twice (I4)';
  for (const n of a.eqLabels)
    if (index.eqLabels.has(n) && !r.eqLabels.has(n)) return 'an equation label is used twice (I4)';

  // I7 and I3: the number of regions, and the regions the commit left alone against the
  // identifiers retired by now (the added ones were judged as they were recorded).
  if (index.regions.size - r.regions.size + a.regions.size > LIMITS.regions)
    return 'too many regions (I7)';
  const retired = ctx.retiredRegionIds;
  if (retired && retired.size <= index.regions.size) {
    for (const id of retired)
      if (index.regions.has(id) && !r.regions.has(id)) return 'a region identifier is retired (I3)';
  } else if (retired) {
    for (const id of index.regions)
      if (retired.has(id) && !r.regions.has(id)) return 'a region identifier is retired (I3)';
  }

  // I4: the references and numbering levels of the added nodes. The definitions did not change.
  for (const use of a.refs)
    if (refProblem(index, use, ctx.attachedAssets)) return 'a reference does not resolve (I4)';
  for (const use of a.numberingUses)
    if (levelProblem(index, use)) return 'a numbering level does not exist (I4)';
  // I4: the assets of the nodes the commit left alone, against what is attached now.
  const attached = ctx.attachedAssets;
  if (attached)
    for (const [asset, n] of index.assets)
      if (n > (r.assets.get(asset) ?? 0) && !attached.has(asset))
        return 'an asset is not attached (I4)';

  // I4: field targets, where the commit added one or removed or changed what one can name.
  if (a.targets.size || r.anchors.size || r.eqLabels.size || r.paragraphs.size) {
    // What a target can name in the document after the commit.
    const names: Definitions & Targets = {
      styles: index.styles,
      defaultStyle: index.defaultStyle,
      numberingLevels: index.numberingLevels,
      pageSetups: index.pageSetups,
      stories: index.stories,
      sources: index.sources,
      preservedDefs: index.preservedDefs,
      anchors: { has: (n) => a.anchors.has(n) || (index.anchors.has(n) && !r.anchors.has(n)) },
      eqLabels: {
        has: (n) => a.eqLabels.has(n) || (index.eqLabels.has(n) && !r.eqLabels.has(n)),
      },
      paragraphs: {
        has: (id) => a.paragraphs.has(id) || (index.paragraphs.has(id) && !r.paragraphs.has(id)),
        get: (id) =>
          a.paragraphs.get(id) ?? (r.paragraphs.has(id) ? undefined : index.paragraphs.get(id)),
      },
    };
    for (const value of a.targets.keys())
      if (targetProblem(names, value)) return 'a field target does not resolve (I4)';
    // The targets of the nodes the commit left alone: a bookmark or an equation label that is
    // gone, a paragraph that is gone or no longer a heading, numbered or a caption.
    const left = (target: string) =>
      (index.targets.get(target) ?? 0) > (r.targets.get(target) ?? 0);
    for (const n of r.anchors)
      if (!a.anchors.has(n) && left(`bookmark:${n}`)) return 'a field target does not resolve (I4)';
    for (const n of r.eqLabels)
      if (!a.eqLabels.has(n) && left(`eq:${n}`)) return 'a field target does not resolve (I4)';
    for (const id of r.paragraphs.keys())
      if (left(`node:${id}`) && targetProblem(names, `node:${id}`))
        return 'a field target does not resolve (I4)';
  }

  // I7: the canonical size, by its bound. Near the limit the exact size is measured in full.
  if (index.bytes + d.bytes + envelope > LIMITS.canonicalBytes)
    return 'the canonical size is near its limit (I7)';
  return null;
}

// -------------------------------------------------------------------------------------------------

/** What a document was found valid under; another key means another validation. */
interface Key {
  def: CdmDefinition;
  schema: Schema;
  /** `requires` as given, and as a set. */
  requires: readonly string[];
  features: ReadonlySet<string>;
  checks: readonly InvariantCheck[];
  /** Which members of the context were given: they decide `notChecked`. */
  given: number;
  /** The members of the context that the checks read, and the sizes of the sets among them. */
  read: readonly unknown[];
  sizes: Sizes;
  /** The bytes of the envelope around the document. */
  envelope: number;
}

const givenOf = (ctx: CommitContext): number =>
  (ctx.attachedAssets ? 1 : 0) |
  (ctx.mathGate ? 2 : 0) |
  (ctx.retiredRegionIds ? 4 : 0) |
  (ctx.identifierChanges ? 8 : 0);

function readOf(checks: readonly InvariantCheck[], ctx: CommitContext): unknown[] {
  const read: unknown[] = [];
  for (const c of checks)
    for (const member of c.reads?.context ?? NONE) {
      const value: unknown = ctx[member];
      read.push(value, value instanceof Set ? value.size : 0);
    }
  return read;
}

/** Whether `readOf` would give `read` again, without building it. */
function sameRead(
  read: readonly unknown[],
  checks: readonly InvariantCheck[],
  ctx: CommitContext,
): boolean {
  let i = 0;
  for (const c of checks)
    for (const member of c.reads?.context ?? NONE) {
      const value: unknown = ctx[member];
      if (read[i++] !== value || read[i++] !== (value instanceof Set ? value.size : 0))
        return false;
    }
  return i === read.length;
}

const sameItems = (a: readonly unknown[], b: readonly unknown[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * The formulas of a document in the JSON shape `validate()` reads `previous` in: only the
 * `equation` and `equation_block` nodes with their `latex`, so the document is not serialised whole.
 */
function formulasOf(doc: PMNode): { content: { type: string; attrs: { latex: unknown } }[] } {
  const content: { type: string; attrs: { latex: unknown } }[] = [];
  doc.descendants((n) => {
    const t = n.type.name;
    if (t === 'equation' || t === 'equation_block')
      content.push({ type: t, attrs: { latex: n.attrs['latex'] } });
    return true;
  });
  return { content };
}

/**
 * Validates the results of commits to one document, one after another (04 §5 step 6). A room keeps
 * one for its document.
 *
 * `validate(before, after, …)` returns what `validateDoc(after, …)` returns with the document
 * before as `previous`. The answer comes from the changed nodes when two things hold: `before` is a
 * document this validator found valid under the same `requires`, definition, schema and checks, and
 * the commit changed nothing that needs the whole document. Otherwise it comes from a full
 * validation.
 *
 * The validator remembers two documents and no more: the one its indexes describe and the last one
 * it found valid. That is what a room needs: the result of a commit that the room then refuses for
 * another reason (permissions, 04 §5 step 7) is forgotten with the next call, and the document
 * before it is still known. A room that goes back to an older document (after a failed write)
 * pays one full validation.
 *
 * The sets of the context are read afresh on every call, so a caller may pass new sets or change
 * them in place. Only a check that declares it reads a member of the context
 * (`InvariantCheck.reads.context`) needs a new set object when that set changes without changing
 * its size.
 */
export class CommitValidator {
  /** How many results came from the changed nodes and how many from a full validation. */
  readonly stats = { incremental: 0, full: 0 };
  #key: Key | null = null;
  /**
   * The document the indexes describe. `notChecked` is that of its validation under the key, or
   * null when it is not known to be valid under the key.
   */
  #base: { doc: PMNode; index: Index; notChecked: readonly string[] | null } | null = null;
  /**
   * The last document found valid under the key, with the `notChecked` of its result, and the
   * delta that leads to it from the base when that was read to its end.
   */
  #last: { doc: PMNode; notChecked: readonly string[]; delta: Delta | null } | null = null;

  validate(
    before: PMNode,
    after: PMNode,
    requires: readonly string[],
    ctx: CommitContext = {},
  ): CommitValidation {
    const key = this.#keyFor(requires, ctx);
    let found: { why: string | null; notChecked: readonly string[]; delta: Delta | null };
    try {
      found = this.#fromChanges(before, after, ctx, key);
    } catch (e) {
      // Whatever went wrong, the full validation below answers; the indexes are built afresh.
      this.#base = null;
      this.#last = null;
      found = {
        why: `the changed nodes could not be read (${(e as Error).message})`,
        notChecked: NONE,
        delta: null,
      };
    }
    if (found.why === null) {
      this.#last = { doc: after, notChecked: found.notChecked, delta: found.delta };
      this.stats.incremental++;
      return { valid: true, violations: [], notChecked: [...found.notChecked], how: 'incremental' };
    }
    const full = validateDoc(
      after,
      requires,
      ctx.mathGate ? { ...ctx, previous: formulasOf(before) } : ctx,
    );
    this.stats.full++;
    // The delta, when the changed nodes were read to their end, leads to `after` all the same.
    if (full.valid) this.#last = { doc: after, notChecked: full.notChecked, delta: found.delta };
    return { ...full, how: 'full', why: found.why };
  }

  /** The key of this call: the one in force when nothing it is made of changed, or a new one. */
  #keyFor(requires: readonly string[], ctx: CommitContext): Key {
    const def = ctx.def ?? CDM1;
    const schema = ctx.schema ?? cdmSchema();
    const checks = checksOf(ctx);
    const old = this.#key;
    if (
      old &&
      old.def === def &&
      old.schema === schema &&
      old.given === givenOf(ctx) &&
      sameItems(old.requires, requires) &&
      sameItems(old.checks, checks) &&
      sameRead(old.read, checks, ctx)
    )
      return old;
    // Under a new key no document is known to be valid yet. Another definition or schema also
    // makes the indexes wrong.
    this.#last = null;
    if (this.#base) this.#base.notChecked = null;
    if (old && (old.def !== def || old.schema !== schema)) this.#base = null;
    const sizes = old && old.def === def ? old.sizes : new Sizes(def);
    return (this.#key = {
      def,
      schema,
      requires: [...requires],
      features: new Set(requires),
      checks,
      given: givenOf(ctx),
      read: readOf(checks, ctx),
      sizes,
      envelope: sizes.envelope(requires),
    });
  }

  /**
   * `why` is null when the result is valid by the changed nodes, and otherwise says why a full
   * validation is needed. `delta` leads from `before` to `after` when the changed nodes were read to
   * their end.
   */
  #fromChanges(
    before: PMNode,
    after: PMNode,
    ctx: CommitContext,
    key: Key,
  ): { why: string | null; notChecked: readonly string[]; delta: Delta | null } {
    const no = (why: string) => ({ why, notChecked: NONE, delta: null });
    for (const c of key.checks)
      if (!c.reads) return no(`the check "${c.name}" does not say what it reads`);
    if (before.type.schema !== key.schema || after.type.schema !== key.schema)
      return no('the documents are not of the schema of the validation');
    const notChecked =
      (this.#base?.doc === before ? this.#base.notChecked : null) ??
      (this.#last?.doc === before ? this.#last.notChecked : null);
    if (!notChecked) return no('the document before the commit is not known to be valid');
    const ix = indexDefinition(key.def);
    const index = this.#moveTo(ix, key.sizes, before);
    if (!index) return no('the document before the commit could not be indexed');
    this.#base!.notChecked = notChecked;
    const added = new Side({ requires: key.features, ctx, formulas: index.formulas });
    const delta: Delta = { removed: new Side(null), added, bytes: 0 };
    const differ = new Differ(ix, key.sizes, delta.removed, added);
    differ.run(before, after);
    delta.bytes = differ.bytes;
    return {
      why: decide(index, delta, ctx, key.checks, key.envelope),
      notChecked,
      delta: added.why === '' && !differ.broken ? delta : null,
    };
  }

  /**
   * Brings the indexes to `doc`, a document known to be valid; null when it cannot be indexed.
   * The delta kept with the last valid document is used when `doc` is that document; any other
   * move makes that delta stale.
   */
  #moveTo(ix: DefinitionIndex, sizes: Sizes, doc: PMNode): Index | null {
    const base = this.#base;
    if (base?.doc === doc) return base.index;
    const last = this.#last;
    let delta = base && last?.doc === doc ? last.delta : null;
    if (last) last.delta = null;
    if (!delta) {
      delta = { removed: new Side(null), added: new Side(null), bytes: 0 };
      const differ = new Differ(ix, sizes, delta.removed, delta.added);
      differ.run(base?.doc ?? null, doc);
      if (differ.broken) {
        this.#base = null;
        return null;
      }
      delta.bytes = differ.bytes;
    }
    const index = base?.index ?? emptyIndex();
    apply(index, delta);
    this.#base = { doc, index, notChecked: null };
    return index;
  }

  /**
   * The indexes for `doc`, a valid document, brought there from wherever they stand, as plain
   * sorted data. For tests and diagnostics: indexes moved over many commits must equal those built
   * from the document.
   */
  describe(doc: PMNode, def: CdmDefinition = CDM1): Record<string, unknown> {
    const sizes = this.#key && this.#key.def === def ? this.#key.sizes : new Sizes(def);
    const known = this.#base?.doc === doc ? this.#base.notChecked : null;
    const index = this.#moveTo(indexDefinition(def), sizes, doc);
    if (!index) return {};
    if (this.#base) this.#base.notChecked = known;
    const list = (items: Iterable<string>): string[] => [...items].sort();
    const pairs = <V>(m: Map<string, V>): [string, V][] =>
      [...m].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return {
      ids: list(index.ids),
      suggestions: pairs(index.suggestions),
      anchors: list(index.anchors),
      eqLabels: list(index.eqLabels),
      regions: list(index.regions),
      formulas: pairs(index.formulas),
      assets: pairs(index.assets),
      targets: pairs(index.targets),
      paragraphs: pairs(index.paragraphs),
      // The path of a style is where a full validation reports it; the indexes do not keep it up.
      styles: pairs(index.styles).map(([id, s]) => [id, { ...s, path: '' }]),
      defaultStyle: index.defaultStyle,
      numberingLevels: pairs(index.numberingLevels),
      pageSetups: list(index.pageSetups),
      stories: pairs(index.stories),
      sources: list(index.sources),
      preservedDefs: list(index.preservedDefs),
      bytes: index.bytes,
    };
  }
}
