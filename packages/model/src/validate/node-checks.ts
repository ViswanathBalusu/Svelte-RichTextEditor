/**
 * The checks of one node (03 §8), shared by the full validator (validate.ts) and the incremental one
 * (incremental.ts; ADR 0422). A check reports through a Recorder. What depends on the node alone is
 * a violation at once (`add`). What depends on the rest of the document goes to the recorder, which
 * decides when it can: identifiers (I2), suggestion users (I2), bookmark names and equation labels
 * (I4), features against `requires` (I1), retired regions (I3), the math gate (I8), the nesting
 * limit and the size of one attribute value (I7). What the document-wide checks need (references,
 * definitions, numbering uses, field targets) is collected the same way.
 *
 * The full validator's recorder holds the state of the walk and decides in walk order. The
 * incremental one records what the nodes a commit removed and added give and take, and decides from
 * its indexes of the document before the commit. Both run this code, so the two cannot differ in
 * what a node is checked for.
 */
import {
  BLOCK_FORMAT_ATTRIBUTES,
  BUILT_IN_STYLES,
  FIELD_TARGET_PATTERN,
  SUGGESTION_HOSTS,
} from '../definition/cdm1.ts';
import type {
  AttrDef,
  Grammar,
  InvariantId,
  JsonValue,
  MarkDef,
  NodeDef,
  RefTarget,
} from '../definition/grammar.ts';
import type { DefinitionIndex } from '../definition/index.ts';
import type { BuiltInCode } from './codes.ts';
import { grammarProblems, show } from './grammar-check.ts';
import type { IndexedNode } from './types.ts';

export const LIMITS = {
  canonicalBytes: 16 * 1024 * 1024,
  regions: 500,
  tableColumns: 63,
  depth: 12,
  basedOnDepth: 10,
  fields: 2000,
  rules: 500,
  fieldValueBytes: 4096,
  footnoteParagraphs: 1,
} as const;

/** The code a grammar problem of an attribute gets, by the invariant the attribute names. */
const GRAMMAR_CODES: Partial<Record<InvariantId, BuiltInCode>> = {
  I7: 'limit_exceeded',
  I9: 'link_scheme',
  I11: 'attribute_invalid',
  I12: 'extension_envelope',
};

/** A reference to a definition or an asset, resolved by the document-wide checks (I4). */
export interface RefUse {
  to: RefTarget;
  value: string;
  path: string;
  nodeId: string | null;
  /** For style_def.basedOn: the kind of the style that refers. */
  fromStyleKind?: string;
}

/** A `field.target` in the form its kind takes, resolved by the document-wide checks (I4). */
export interface FieldTargetUse {
  value: string;
  kind: string;
  path: string;
  nodeId: string | null;
}

/** A numbering level used by a paragraph or a style (I4). */
export interface NumberingUse {
  numberingId: string;
  level: number;
  path: string;
  nodeId: string | null;
}

export interface StyleInfo {
  kind: string;
  basedOn: string | null;
  builtIn: boolean;
  /** Path of the style's `attrs`. */
  path: string;
  outlineLevel: boolean;
  numbered: boolean;
}

export interface ParagraphInfo {
  style: string | null;
  numbered: boolean;
  caption: boolean;
}

/** Where the checks of one node put what they find. */
export interface Recorder {
  /** A violation that depends on the node alone. */
  add(code: BuiltInCode, path: string, nodeId: string | null, message: string): void;
  /** Whether a use of `feature` is to be passed to `feature`: the full validator asks `requires`. */
  missing(feature: string): boolean;
  /** I1: a node, mark, attribute or value of a feature (reported when `requires` lacks it). */
  feature(feature: string, path: string, nodeId: string | null, message: string): void;
  /** I7: a node nested deeper than the limit; the walk does not enter it. Reported once. */
  deep(path: string, nodeId: string | null): void;
  /**
   * I7: an attribute value that alone is over the canonical size limit. Its grammar is not walked
   * item by item, and the other attributes of its node or mark are not read.
   */
  oversize(path: string, nodeId: string | null): void;
  /** Whether the walk is to stop here: the full validator stops where the size passed its limit. */
  stopped(): boolean;
  /** I2: the identifier of an identified node, at `path` (`…/attrs/id`). */
  id(id: string, path: string): void;
  /** I2: a suggestion identifier and its user, at `path` (`…/attrs/user`). */
  suggestion(sid: string, user: string, path: string, nodeId: string | null): void;
  /** I4: a bookmark name or an equation label, which references need to be unique. */
  name(kind: 'anchor' | 'eq', name: string, path: string, nodeId: string | null): void;
  /** I3 and I7: a region, with its identifier as given, at `path` (`…/attrs/id`). */
  region(id: JsonValue | undefined, path: string, nodeId: string | null): void;
  /** I8: a non-empty formula. */
  math(latex: string, display: boolean, path: string, nodeId: string | null): void;
  ref(use: RefUse): void;
  target(use: FieldTargetUse): void;
  numbering(use: NumberingUse): void;
  settings(defaultStyle: string | null): void;
  style(id: string, info: StyleInfo): void;
  numberingDef(id: string, levels: number): void;
  pageSetup(id: string): void;
  preservedDef(id: string): void;
  source(id: string): void;
  story(id: string, kind: string): void;
  paragraph(id: string, style: string | null, numbered: boolean): void;
  /** Whether the paragraph holds a `seq` field, decided after its children. */
  caption(id: string, caption: boolean): void;
  /** A walked node (text is not listed), for the registered checks. */
  node(entry: IndexedNode): void;
}

/** A node the walk entered: what its children and the checks after them need. */
export interface Visit {
  type: string;
  nd: NodeDef;
  /** Attributes with the defaults filled in. */
  attrs: Record<string, JsonValue>;
  /** The node's own identifier. */
  own: string | null;
  /** The node's own identifier, or the nearest enclosing one. */
  nodeId: string | null;
}

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const ALLOWED_KEYS = new Set(['type', 'attrs', 'content', 'marks']);
const TEXT_KEYS = new Set(['type', 'text', 'marks']);

/**
 * The checks of one node up to its content: type, nesting, members, features, attributes, marks,
 * placement and what it defines or refers to. Returns null when the walk stops at the node (an
 * unknown type, the nesting limit, text).
 */
export function visitNode(
  ix: DefinitionIndex,
  rec: Recorder,
  node: Record<string, unknown>,
  path: string,
  ancestors: readonly string[],
  depth: number,
  nearestId: string | null,
): Visit | null {
  const type = node['type'];
  if (typeof type !== 'string') {
    rec.add('unknown_node_type', path, nearestId, 'node without a type');
    return null;
  }
  const nd = ix.nodes.get(type);
  if (!nd) {
    if (ix.projectionNodes.has(type))
      rec.add(
        'projection_only_node',
        path,
        nearestId,
        `"${type}" exists only in a reader's projection and is never stored (ADR 0019)`,
      );
    else rec.add('unknown_node_type', path, nearestId, `unknown node type "${type}"`);
    return null;
  }
  if (depth > LIMITS.depth) {
    // Reported once and not entered, so that hostile nesting costs no unbounded recursion.
    rec.deep(path, nearestId);
    return null;
  }
  const allowed = type === 'text' ? TEXT_KEYS : ALLOWED_KEYS;
  for (const key of Object.keys(node))
    if (!allowed.has(key))
      rec.add('unknown_member', `${path}/${key}`, nearestId, `unknown member "${key}" on ${type}`);
  if (nd.feature && rec.missing(nd.feature))
    rec.feature(
      nd.feature,
      path,
      nearestId,
      `"${type}" belongs to feature "${nd.feature}", which requires does not list`,
    );

  if (type === 'text') {
    if (typeof node['text'] !== 'string' || node['text'] === '')
      rec.add('empty_text', `${path}/text`, nearestId, 'text nodes need non-empty text');
    checkMarks(ix, rec, node['marks'], `${path}/marks`, nearestId);
    return null;
  }

  const attrs = checkAttrs(ix, rec, nd, node['attrs'], `${path}/attrs`, type, nearestId);
  const own = ix.idNodes.has(type) && typeof attrs['id'] === 'string' ? attrs['id'] : null;
  const nodeId = own ?? nearestId;
  rec.node({ type, attrs, path, ancestors, nodeId, node });

  // I3: regions and section breaks are direct children of the body; regions do not nest.
  if (type === 'region' || type === 'section_break') {
    const parent = ancestors[ancestors.length - 1];
    if (parent !== 'body') {
      if (type === 'region' && ancestors.includes('region'))
        rec.add('nested_region', path, nodeId, 'regions do not nest');
      else
        rec.add(
          'misplaced_container',
          path,
          nodeId,
          `a ${type} must be a direct child of the body, not of ${parent ?? 'nothing'}`,
        );
    }
  }
  // Inline atoms carry marks as text does, formatting and suggestions alike (spike S11, change 1).
  // A block carries no marks: its suggestions are in the `suggest` attribute (03 §5; owner decision 92).
  if (node['marks'] !== undefined) {
    if (nd.inline) checkMarks(ix, rec, node['marks'], `${path}/marks`, nodeId);
    else if (!Array.isArray(node['marks']))
      rec.add('malformed', `${path}/marks`, nodeId, 'marks must be an array');
    else if (node['marks'].length)
      rec.add(
        'node_mark_host',
        `${path}/marks`,
        nodeId,
        `a ${type} carries no marks; block suggestions are in its \`suggest\` attribute`,
      );
  }
  const suggest = attrs['suggest'];
  if (SUGGESTION_HOSTS.includes(type) && Array.isArray(suggest))
    suggest.forEach((e, i) => {
      if (!isObject(e) || typeof e['type'] !== 'string' || !isObject(e['attrs'])) return;
      checkSuggestion(
        ix,
        rec,
        e['type'],
        e['attrs'] as Record<string, JsonValue>,
        `${path}/attrs/suggest/${i}/attrs`,
        type,
        nodeId,
      );
    });
  collect(ix, rec, type, attrs, path, ancestors, nodeId);
  return { type, nd, attrs, own, nodeId };
}

/**
 * The node types whose checks read their children: the paragraphs of a footnote (`checkContent`),
 * the rows and cells of a table and the fields of a paragraph (`afterChildren`). The incremental
 * validator runs these checks again only for these types, and only when the children changed. A
 * check of the children of another type must be added here, or it does not run.
 */
const READS_CHILDREN: ReadonlySet<string> = new Set(['footnote', 'table', 'paragraph']);

/** Whether `checkContent` or `afterChildren` reads the children of a node of this type. */
export function readsChildren(type: string): boolean {
  return READS_CHILDREN.has(type);
}

/**
 * The checks of a node's `content` before its children. `isArray` says whether `content` is an
 * array; `paragraphs` counts the paragraphs among the children (asked only for a footnote).
 * Returns whether the children are to be walked.
 */
export function checkContent(
  rec: Recorder,
  v: Visit,
  path: string,
  isArray: boolean,
  paragraphs: () => number,
): boolean {
  if (!isArray) {
    rec.add('malformed', `${path}/content`, v.nodeId, 'content must be an array');
    return false;
  }
  if (!v.nd.content)
    rec.add('content_on_leaf', `${path}/content`, v.nodeId, `${v.type} has no content`);
  if (!READS_CHILDREN.has(v.type)) return true;
  if (v.type === 'footnote') {
    const count = paragraphs();
    if (count > LIMITS.footnoteParagraphs)
      rec.add(
        'footnote_paragraphs',
        `${path}/content`,
        v.nodeId,
        `a footnote holds one paragraph in version 1, not ${count} (CDM-001)`,
      );
  }
  return true;
}

/**
 * The checks after a node's children: table geometry (I6) and whether a paragraph is a caption.
 * `children` gives the node's `content` as JSON when a check asks for it. A check reads the type
 * and the attributes of the children and of their children, and nothing deeper: the incremental
 * validator hands in exactly that much for a node whose children it did not walk.
 */
export function afterChildren(
  rec: Recorder,
  v: Visit,
  path: string,
  children: () => readonly unknown[],
): void {
  if (!READS_CHILDREN.has(v.type)) return;
  if (v.type === 'table') checkTableGeometry(rec, v.attrs, children(), path, v.nodeId);
  if (v.type === 'paragraph' && typeof v.own === 'string')
    rec.caption(v.own, children().some(isSeqField));
}

/** Whether a child (as JSON) is a `seq` field, which makes its paragraph a caption. */
export function isSeqField(c: unknown): boolean {
  return (
    isObject(c) && c['type'] === 'field' && isObject(c['attrs']) && c['attrs']['kind'] === 'seq'
  );
}

/** Children that are not node objects reported per content array before the walk gives up. */
const MAX_MALFORMED_CHILDREN = 16;

/**
 * Walks a node and its subtree as JSON and runs the checks of every node. The recursion stops at the
 * nesting limit (`visitNode`), so hostile nesting costs no unbounded recursion, and wherever the
 * recorder says the walk has stopped.
 */
export function walkNode(
  ix: DefinitionIndex,
  rec: Recorder,
  node: Record<string, unknown>,
  path: string,
  ancestors: readonly string[],
  depth: number,
  nearestId: string | null,
): void {
  if (rec.stopped()) return;
  const v = visitNode(ix, rec, node, path, ancestors, depth, nearestId);
  if (!v) return;
  const content = node['content'];
  if (content === undefined) return;
  const children: readonly unknown[] = Array.isArray(content) ? content : [];
  const paragraphs = () => children.filter((c) => isObject(c) && c['type'] === 'paragraph').length;
  if (!checkContent(rec, v, path, Array.isArray(content), paragraphs)) return;
  const next = [...ancestors, v.type];
  let malformed = 0;
  for (let i = 0; i < children.length && !rec.stopped(); i++) {
    const child = children[i];
    if (isObject(child))
      walkNode(ix, rec, child, `${path}/content/${i}`, next, depth + 1, v.nodeId);
    else {
      rec.add('malformed', `${path}/content/${i}`, v.nodeId, 'child is not a node object');
      // The array is wrong already (I1); a hostile one is not reported item by item.
      if (++malformed >= MAX_MALFORMED_CHILDREN) break;
    }
  }
  if (rec.stopped()) return;
  afterChildren(rec, v, path, () => children);
}

/**
 * Whether the JSON text of a value is longer than `limit` bytes, without writing it. It counts a
 * lower bound (a number, a boolean or null as one byte, a UTF-16 code unit as one byte) and stops
 * as soon as the bound passes the limit, so the work and the memory are bounded by the limit and
 * not by the input. No recursion.
 */
export function jsonSizeOver(value: unknown, limit: number): boolean {
  if (typeof value !== 'object' || value === null)
    return typeof value === 'string' && value.length + 2 > limit;
  let n = 0;
  const stack: object[] = [value];
  const count = (v: unknown): void => {
    if (typeof v === 'string') n += v.length + 2;
    else if (typeof v === 'object' && v !== null) stack.push(v);
    else if (v !== undefined) n += 1;
  };
  while (stack.length) {
    const v = stack.pop()!;
    if (Array.isArray(v)) {
      // The brackets and the commas between the items, then each item.
      n += v.length ? v.length + 1 : 2;
      if (n > limit) return true;
      for (let i = 0; i < v.length; i++) {
        count(v[i]);
        if (n > limit) return true;
      }
    } else {
      n += 2;
      for (const key of Object.keys(v)) {
        // The quotes and the colon, then the value. (The comma is not counted: one fewer than keys.)
        n += key.length + 3;
        count((v as Record<string, unknown>)[key]);
        if (n > limit) return true;
      }
    }
  }
  return n > limit;
}

/** The problems of one attribute value, each under the invariant its attribute names. */
function grammarViolations(
  rec: Recorder,
  a: AttrDef,
  value: unknown,
  path: string,
  nodeId: string | null,
): void {
  for (const p of grammarProblems(a.grammar, value, path)) {
    const inv = a.reportAs?.[p.kind] ?? a.reportAs?.['*'] ?? 'I11';
    rec.add(GRAMMAR_CODES[inv] ?? 'attribute_invalid', p.path, nodeId, p.message);
  }
}

/** Checks the attributes of a node or mark; returns the effective values (defaults filled in). */
function checkAttrs(
  ix: DefinitionIndex,
  rec: Recorder,
  owner: NodeDef | MarkDef,
  given: unknown,
  path: string,
  ownerName: string,
  nodeId: string | null,
): Record<string, JsonValue> {
  const spec = owner.attrs;
  const out: Record<string, JsonValue> = {};
  if (given !== undefined && !isObject(given)) {
    rec.add('malformed', path, nodeId, 'attrs must be an object');
    given = undefined;
  }
  const r = (given ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(r))
    if (!Object.hasOwn(spec, key))
      rec.add(
        'unknown_attribute',
        `${path}/${key}`,
        nodeId,
        `unknown attribute "${key}" on ${ownerName}`,
      );
  for (const [name, a] of Object.entries(spec)) {
    const present = Object.hasOwn(r, name);
    const value = (present ? r[name] : a.default) as JsonValue;
    out[name] = value;
    // A required attribute must be given: its default only lets ProseMirror create the node.
    if (a.presence === 'required' && (!present || value === null || value === undefined)) {
      const own = name === 'id' && ix.idNodes.has(ownerName);
      if (own) rec.add('missing_id', `${path}/${name}`, nodeId, `${ownerName} has no identifier`);
      else if (a.reportAs?.['*'] === 'I12')
        rec.add(
          'extension_envelope',
          `${path}/${name}`,
          nodeId,
          `${ownerName}.${name} is required`,
        );
      else
        rec.add('attribute_missing', `${path}/${name}`, nodeId, `${ownerName}.${name} is required`);
      continue;
    }
    // A value that alone is over the size limit is I7; its grammar is not walked item by item.
    if (present && jsonSizeOver(value, LIMITS.canonicalBytes)) {
      rec.oversize(`${path}/${name}`, nodeId);
      break;
    }
    // Field values (`reportAs` I15) are checked whole, by kind, by the field invariants.
    if (present && a.reportAs?.['*'] !== 'I15')
      grammarViolations(rec, a, value, `${path}/${name}`, nodeId);
    if (a.feature && value !== null && rec.missing(a.feature))
      rec.feature(
        a.feature,
        `${path}/${name}`,
        nodeId,
        `${ownerName}.${name} belongs to feature "${a.feature}", which requires does not list`,
      );
    if (a.valueFeatures && typeof value === 'string' && Object.hasOwn(a.valueFeatures, value)) {
      const feature = a.valueFeatures[value]!;
      if (rec.missing(feature))
        rec.feature(
          feature,
          `${path}/${name}`,
          nodeId,
          `${ownerName}.${name} "${value}" belongs to feature "${feature}", which requires does not list`,
        );
    }
  }
  return out;
}

const SUGGESTIONS = new Set(['ins', 'del', 'fmt']);

function checkMarks(
  ix: DefinitionIndex,
  rec: Recorder,
  marks: unknown,
  path: string,
  nodeId: string | null,
): void {
  if (marks === undefined) return;
  if (!Array.isArray(marks)) return rec.add('malformed', path, nodeId, 'marks must be an array');
  marks.forEach((m, i) => {
    const p = `${path}/${i}`;
    if (!isObject(m) || typeof m['type'] !== 'string')
      return rec.add('unknown_mark_type', p, nodeId, 'mark without a type');
    for (const key of Object.keys(m))
      if (key !== 'type' && key !== 'attrs')
        rec.add('unknown_member', `${p}/${key}`, nodeId, `unknown member "${key}" on a mark`);
    const md = ix.marks.get(m['type']);
    if (!md) return rec.add('unknown_mark_type', p, nodeId, `unknown mark type "${m['type']}"`);

    if (md.feature && rec.missing(md.feature))
      rec.feature(
        md.feature,
        p,
        nodeId,
        `mark "${md.name}" belongs to feature "${md.feature}", which requires does not list`,
      );
    const attrs = checkAttrs(ix, rec, md, m['attrs'], `${p}/attrs`, md.name, nodeId);
    collectRefs(rec, md.attrs, attrs, `${p}/attrs`, nodeId);
    if (SUGGESTIONS.has(md.name))
      checkSuggestion(ix, rec, md.name, attrs, `${p}/attrs`, null, nodeId);
  });
}

/**
 * Suggestion marks (03 §5): an identifier belongs to one user (I2), and `fmt.before` has the shape
 * of CDM-002: `{ marks, attrs }`, the previous marks of text or the previous style, alignment or
 * list level of a block (CDM-040), each passing its own grammar.
 */
function checkSuggestion(
  ix: DefinitionIndex,
  rec: Recorder,
  name: string,
  attrs: Record<string, JsonValue>,
  path: string,
  blockHost: string | null,
  nodeId: string | null,
): void {
  const sid = attrs['id'];
  const user = attrs['user'];
  if (typeof sid === 'string' && typeof user === 'string')
    rec.suggestion(sid, user, `${path}/user`, nodeId);
  if (name !== 'fmt') return;
  const before = attrs['before'];
  if (before === null || before === undefined) return;
  const bad = (at: string, why: string) => rec.add('fmt_before', at, nodeId, `fmt.before: ${why}`);
  const bp = `${path}/before`;
  if (!isObject(before)) return bad(bp, 'must be an object with `marks` and `attrs`');
  for (const key of Object.keys(before))
    if (key !== 'marks' && key !== 'attrs') bad(`${bp}/${key}`, `unknown member "${key}"`);
  const marks = before['marks'];
  if (marks !== undefined) {
    if (!Array.isArray(marks)) bad(`${bp}/marks`, 'marks must be an array');
    else if (blockHost && marks.length)
      bad(`${bp}/marks`, 'a block suggestion records attributes, not marks');
    else
      marks.forEach((m, i) => {
        const mp = `${bp}/marks/${i}`;
        const md =
          isObject(m) && typeof m['type'] === 'string' ? ix.marks.get(m['type']) : undefined;
        if (!isObject(m) || !md) return bad(mp, 'not a mark of the definition');
        if (SUGGESTIONS.has(md.name)) return bad(mp, 'a suggestion mark cannot be a previous mark');
        for (const key of Object.keys(m))
          if (key !== 'type' && key !== 'attrs') bad(`${mp}/${key}`, `unknown member "${key}"`);
        const ma = m['attrs'] ?? {};
        if (!isObject(ma)) return bad(`${mp}/attrs`, 'attrs must be an object');
        for (const [k, value] of Object.entries(ma)) {
          if (!Object.hasOwn(md.attrs, k))
            bad(`${mp}/attrs/${k}`, `unknown attribute of ${md.name}`);
          else
            for (const p of grammarProblems(md.attrs[k]!.grammar, value, `${mp}/attrs/${k}`))
              bad(p.path, p.message);
        }
      });
  }
  const prev = before['attrs'];
  if (prev !== undefined) {
    if (!isObject(prev)) return bad(`${bp}/attrs`, 'attrs must be an object');
    const host = blockHost ? ix.nodes.get(blockHost) : undefined;
    for (const [k, value] of Object.entries(prev)) {
      const ap = `${bp}/attrs/${k}`;
      if (!host) bad(ap, 'text has no attributes to record');
      else if (!BLOCK_FORMAT_ATTRIBUTES.includes(k) || !Object.hasOwn(host.attrs, k))
        bad(
          ap,
          `a block suggestion records only ${BLOCK_FORMAT_ATTRIBUTES.join(', ')} of a ${blockHost}`,
        );
      else
        for (const p of grammarProblems(host.attrs[k]!.grammar, value, ap)) bad(p.path, p.message);
    }
  }
}

function collectRefs(
  rec: Recorder,
  spec: Readonly<Record<string, AttrDef>>,
  attrs: Record<string, JsonValue>,
  path: string,
  nodeId: string | null,
  fromStyleKind?: string,
): void {
  for (const [name, a] of Object.entries(spec)) {
    const value = attrs[name];
    if (value === null || value === undefined) continue;
    refsIn(
      rec,
      a.grammar,
      value,
      `${path}/${name}`,
      nodeId,
      name === 'basedOn' ? fromStyleKind : undefined,
    );
  }
}

function refsIn(
  rec: Recorder,
  g: Grammar,
  value: JsonValue,
  path: string,
  nodeId: string | null,
  fromStyleKind?: string,
): void {
  if (value === null) return;
  if (g.kind === 'ref' && typeof value === 'string') {
    // A value that is not an identifier of its kind is I11 already; it names nothing to resolve.
    if (grammarProblems(g, value, path).length) return;
    const use: RefUse = { to: g.to, value, path, nodeId };
    if (fromStyleKind) use.fromStyleKind = fromStyleKind;
    rec.ref(use);
  } else if (g.kind === 'object' && isObject(value)) {
    for (const [k, sub] of Object.entries(g.properties)) {
      if (!Object.hasOwn(value, k)) continue;
      const inner = (value as Record<string, JsonValue>)[k];
      if (inner !== undefined) refsIn(rec, sub, inner, `${path}/${k}`, nodeId);
    }
  } else if (g.kind === 'array' && Array.isArray(value)) {
    const n = Math.min(value.length, g.maxItems);
    for (let i = 0; i < n; i++) refsIn(rec, g.items, value[i]!, `${path}/${i}`, nodeId);
  } else if (g.kind === 'elementTree' && isObject(value) && typeof value['ref'] === 'string') {
    // A shared preserved tree (spike S11): it must resolve to a preserved_def (I4).
    if (grammarProblems(g, value, path).length) return;
    rec.ref({ to: 'preservedDef', value: value['ref'], path: `${path}/ref`, nodeId });
  }
}

const targetRe = new RegExp(FIELD_TARGET_PATTERN);

/** `kind` of a field and the target forms and names it takes (CDM-002; ADR 0018). */
const TARGET_FORMS: Readonly<Record<string, readonly string[]>> = {
  ref: ['bookmark', 'node', 'eq'],
  styleRef: ['style'],
  formValue: ['field'],
};

function collect(
  ix: DefinitionIndex,
  rec: Recorder,
  type: string,
  attrs: Record<string, JsonValue>,
  path: string,
  ancestors: readonly string[],
  nodeId: string | null,
): void {
  const nd = ix.nodes.get(type)!;
  const ap = `${path}/attrs`;
  const id = attrs['id'];
  if (ix.idNodes.has(type) && typeof id === 'string') rec.id(id, `${ap}/id`);
  collectRefs(
    rec,
    nd.attrs,
    attrs,
    ap,
    nodeId,
    type === 'style_def' ? show(attrs['kind']) : undefined,
  );

  switch (type) {
    case 'settings':
      rec.settings(
        typeof attrs['defaultParagraphStyle'] === 'string' ? attrs['defaultParagraphStyle'] : null,
      );
      break;
    case 'style_def': {
      if (typeof id !== 'string') break;
      const kind = show(attrs['kind']);
      const builtIn = attrs['builtIn'] === true;
      rec.style(id, {
        kind,
        basedOn: typeof attrs['basedOn'] === 'string' ? attrs['basedOn'] : null,
        builtIn,
        path: ap,
        outlineLevel: typeof attrs['outlineLevel'] === 'number',
        numbered: isObject(attrs['numbering']),
      });
      const reserved = Object.hasOwn(BUILT_IN_STYLES, id) ? BUILT_IN_STYLES[id] : undefined;
      if (reserved && (!builtIn || reserved !== kind))
        rec.add(
          'reserved_style_id',
          `${ap}/id`,
          nodeId,
          `"${id}" is reserved for the built-in ${reserved} style`,
        );
      if (!reserved && builtIn)
        rec.add(
          'reserved_style_id',
          `${ap}/builtIn`,
          nodeId,
          `"${id}" is not a built-in style identifier`,
        );
      // Table properties belong to table styles only (03 §4.5; CDM-017).
      if (kind !== 'table') {
        for (const p of ['cellMargins', 'headerRowShading', 'bandedRows'])
          if (attrs[p] !== null && attrs[p] !== undefined)
            rec.add(
              'table_property',
              `${ap}/${p}`,
              nodeId,
              `${p} is a table property; "${id}" is a ${kind} style`,
            );
        const borders = attrs['borders'];
        if (isObject(borders))
          for (const side of ['insideH', 'insideV'])
            if (borders[side] !== null && borders[side] !== undefined)
              rec.add(
                'table_property',
                `${ap}/borders/${side}`,
                nodeId,
                `${side} borders are table properties; "${id}" is a ${kind} style`,
              );
      }
      if (isObject(attrs['numbering']))
        numberingUse(rec, attrs['numbering'], `${ap}/numbering`, nodeId);
      break;
    }
    case 'numbering_def':
      if (typeof id === 'string')
        rec.numberingDef(id, Array.isArray(attrs['levels']) ? attrs['levels'].length : 0);
      break;
    case 'page_setup':
      if (typeof id === 'string') rec.pageSetup(id);
      break;
    case 'preserved_def':
      if (typeof id === 'string') rec.preservedDef(id);
      break;
    case 'preserved_inline':
      if (attrs['fragment'] === null && attrs['tree'] === null)
        rec.add(
          'preserved_without_payload',
          ap,
          nodeId,
          'preserved inline content needs its fragment asset or, for a small marker, its tree',
        );
      break;
    case 'source_def':
      if (typeof id === 'string') rec.source(id);
      break;
    case 'story':
      if (typeof id === 'string') rec.story(id, show(attrs['kind']));
      break;
    case 'region':
      rec.region(id, `${ap}/id`, nodeId);
      break;
    case 'paragraph':
      if (typeof id === 'string')
        rec.paragraph(
          id,
          typeof attrs['style'] === 'string' ? attrs['style'] : null,
          isObject(attrs['numbering']),
        );
      if (isObject(attrs['numbering']))
        numberingUse(rec, attrs['numbering'], `${ap}/numbering`, nodeId);
      break;
    case 'table':
      if (ancestors.includes('story') || ancestors.includes('footnote'))
        rec.add(
          'table_in_story_or_footnote',
          path,
          nodeId,
          'tables are not allowed in headers, footers or footnotes',
        );
      break;
    case 'footnote':
      if (ancestors.includes('footnote'))
        rec.add(
          'footnote_in_footnote',
          path,
          nodeId,
          'a footnote is not allowed inside a footnote',
        );
      else if (ancestors.includes('caption'))
        rec.add('footnote_in_caption', path, nodeId, 'a footnote is not allowed inside a caption');
      break;
    case 'anchor':
      // Bookmark names are reference targets, so they are unique (CDM-002, ADR 0018).
      if (typeof attrs['name'] === 'string')
        rec.name('anchor', attrs['name'], `${ap}/name`, nodeId);
      break;
    case 'equation_block':
      if (typeof attrs['label'] === 'string') rec.name('eq', attrs['label'], `${ap}/label`, nodeId);
      checkMath(rec, attrs['latex'], true, `${ap}/latex`, nodeId);
      break;
    case 'equation':
      checkMath(rec, attrs['latex'], false, `${ap}/latex`, nodeId);
      break;
    case 'figure':
      if (attrs['placement'] === 'float' && ancestors.includes('table_cell'))
        rec.add(
          'float_in_cell',
          `${ap}/placement`,
          nodeId,
          'a floating figure is not allowed in a table cell',
        );
      break;
    case 'toc':
      if (
        typeof attrs['minLevel'] === 'number' &&
        typeof attrs['maxLevel'] === 'number' &&
        attrs['minLevel'] > attrs['maxLevel']
      )
        rec.add(
          'toc_levels',
          `${ap}/minLevel`,
          nodeId,
          `minLevel ${attrs['minLevel']} is above maxLevel ${attrs['maxLevel']}`,
        );
      break;
    case 'break':
      if (
        (attrs['kind'] === 'page' || attrs['kind'] === 'column') &&
        ancestors.some((a) => a === 'table_cell' || a === 'caption' || a === 'footnote')
      )
        rec.add(
          'break_in_container',
          `${ap}/kind`,
          nodeId,
          `a ${show(attrs['kind'])} break is not allowed in cells, captions or footnotes`,
        );
      break;
    case 'field':
      checkFieldNode(rec, attrs, ap, nodeId);
      break;
    case 'form_field':
      if (ancestors.includes('story') || ancestors.includes('footnote'))
        rec.add(
          'form_field_placement',
          path,
          nodeId,
          'form fields are not allowed in headers, footers or footnotes (12 §3.2)',
        );
      break;
    case 'extension_block':
      if (attrs['fallbackAsset'] === null && attrs['fallbackText'] === null)
        rec.add(
          'extension_fallback',
          ap,
          nodeId,
          'an extension block needs a fallback picture or a fallback text (13 §7.3)',
        );
      break;
    case 'extension_inline':
      if (attrs['fallbackText'] === null)
        rec.add(
          'extension_fallback',
          `${ap}/fallbackText`,
          nodeId,
          'an inline extension needs a fallback text (13 §7.3)',
        );
      break;
  }
}

function numberingUse(
  rec: Recorder,
  n: Record<string, unknown>,
  path: string,
  nodeId: string | null,
): void {
  if (typeof n['numberingId'] === 'string' && typeof n['level'] === 'number')
    rec.numbering({
      numberingId: n['numberingId'],
      level: n['level'],
      path: `${path}/level`,
      nodeId,
    });
}

/** The `field` node: the target form and name its kind takes (CDM-002), collected for I4. */
function checkFieldNode(
  rec: Recorder,
  attrs: Record<string, JsonValue>,
  ap: string,
  nodeId: string | null,
): void {
  const kind = show(attrs['kind']);
  const target = attrs['target'];
  const forms = Object.hasOwn(TARGET_FORMS, kind) ? TARGET_FORMS[kind]! : [];
  // A target outside its grammar is I11 already and names nothing.
  if (typeof target === 'string' && !targetRe.test(target)) return;
  if (typeof target === 'string') {
    const scheme = target.split(':')[0] ?? '';
    if (!forms.includes(scheme))
      rec.add(
        'field_target_form',
        `${ap}/target`,
        nodeId,
        forms.length
          ? `a ${kind} field targets ${forms.map((f) => `${f}:`).join(', ')}, not ${scheme}:`
          : `a ${kind} field takes no target`,
      );
    else rec.target({ value: target, kind, path: `${ap}/target`, nodeId });
  } else if (forms.length && target === null)
    rec.add('field_target_form', `${ap}/target`, nodeId, `a ${kind} field needs a target`);
  // A `seq` field without a name is allowed: it counts in no sequence and shows nothing (CDM-042).
  if (kind !== 'seq' && attrs['name'] !== null && attrs['name'] !== undefined)
    rec.add('field_target_form', `${ap}/name`, nodeId, `a ${kind} field takes no sequence name`);
}

function checkMath(
  rec: Recorder,
  latex: JsonValue | undefined,
  display: boolean,
  path: string,
  nodeId: string | null,
): void {
  if (typeof latex !== 'string' || latex === '') return;
  rec.math(latex, display, path, nodeId);
}

/**
 * I6: in every row, the column spans of its cells plus the columns covered by cells spanning down
 * from earlier rows add up to the length of `grid`, without overlap; row spans do not run past the
 * last row; `headerRows` is at most the number of rows. (03 §8 states the rule without row spans;
 * ADR 0018 records this reading.)
 */
function checkTableGeometry(
  rec: Recorder,
  tableAttrs: Record<string, JsonValue>,
  rows: readonly unknown[],
  tablePath: string,
  nodeId: string | null,
): void {
  const headerRows = tableAttrs['headerRows'];
  if (typeof headerRows === 'number' && headerRows > rows.length)
    rec.add(
      'header_rows',
      `${tablePath}/attrs/headerRows`,
      nodeId,
      `headerRows ${headerRows} is more than the ${rows.length} rows of the table`,
    );
  const grid = tableAttrs['grid'];
  if (!Array.isArray(grid) || grid.length > LIMITS.tableColumns) return;
  const columns = grid.length;
  let carry = new Array<number>(columns).fill(0);
  rows.forEach((row, r) => {
    if (!isObject(row) || !Array.isArray(row['content'])) return;
    const occupied = carry.map((c) => c > 0);
    const next = carry.map((c) => Math.max(0, c - 1));
    let col = 0;
    let overflow = false;
    for (const cell of row['content'] as unknown[]) {
      if (!isObject(cell)) continue;
      while (col < columns && occupied[col]) col++;
      const attrs = isObject(cell['attrs']) ? cell['attrs'] : {};
      const colspan = typeof attrs['colspan'] === 'number' ? attrs['colspan'] : 1;
      const rowspan = typeof attrs['rowspan'] === 'number' ? attrs['rowspan'] : 1;
      if (r + rowspan > rows.length)
        rec.add(
          'row_span_past_end',
          `${tablePath}/content/${r}`,
          nodeId,
          `a cell spans ${rowspan} rows, past the last row`,
        );
      if (col + colspan > columns) {
        overflow = true;
        break;
      }
      for (let k = 0; k < colspan; k++) {
        occupied[col + k] = true;
        next[col + k] = rowspan - 1;
      }
      col += colspan;
    }
    if (overflow || occupied.some((o) => !o))
      rec.add(
        'row_columns',
        `${tablePath}/content/${r}`,
        nodeId,
        `row ${r} does not cover exactly the ${columns} columns of the grid`,
      );
    carry = next;
  });
}

/** The messages of the violations a recorder decides from the rest of the document. */
export const MESSAGES = {
  deep: (): string => `nesting deeper than ${LIMITS.depth}`,
  duplicateId: (id: string, first: string): string => `identifier "${id}" is also used at ${first}`,
  suggestionUser: (sid: string, firstUser: string, firstPath: string, user: string): string =>
    `suggestion "${sid}" belongs to "${firstUser}" (${firstPath}), not to "${user}"`,
  targetName: (kind: 'anchor' | 'eq', name: string): string =>
    kind === 'anchor'
      ? `bookmark name "${name}" is used twice; references to it would be ambiguous`
      : `equation label "${name}" is used twice; references to it would be ambiguous`,
  regionReused: (id: string): string =>
    `region identifier "${id}" was removed from this document before and cannot be reused`,
  math: (reason: string): string => `math gate: ${reason}`,
};
