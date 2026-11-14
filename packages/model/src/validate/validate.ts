/**
 * model.validate(): the invariants of 03 §8 (I1 to I12), and through the registration point of
 * CDM-013 the field invariants of 12 §3.6 (I13 to I15, src/fields/invariants.ts) and whatever other
 * packages register. The authority runs the same checks on the result of every commit (04 §5 step
 * 6), whatever the step types were.
 *
 * Every violation carries its invariant, a stable code (codes.ts), the JSON Pointer of what is
 * wrong and the `id` of the node it concerns. Some invariants are not functions of the document
 * alone. The context supplies what they need: attached assets (I4), region identifiers removed
 * earlier (I3), the identifier changes of the commit (I2), the math gate (I8). Whatever a caller
 * leaves out is reported as not checked, never as passed.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { canonicalize } from '../canonical/jcs.ts';
import {
  canonicalEnvelopeLenient,
  type JsonEnvelope,
  type JsonNode,
} from '../canonical/canonical-form.ts';
import { utf8 } from '../conventions/platform.ts';
import {
  BLOCK_FORMAT_ATTRIBUTES,
  BUILT_IN_STYLES,
  CDM1,
  FIELD_TARGET_PATTERN,
  NODE_MARK_HOSTS,
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
import { indexDefinition, type DefinitionIndex } from '../definition/index.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import { BUILT_IN_CHECKS, MODEL_CODES } from './built-in.ts';
import { VIOLATION_CODES, type BuiltInCode } from './codes.ts';
import { grammarProblems, show } from './grammar-check.ts';
import { registeredInvariants } from './registry.ts';
import type {
  DocumentView,
  IndexedNode,
  InvariantCheck,
  ValidationContext,
  ValidationResult,
  Violation,
  ViolationReport,
} from './types.ts';

export type {
  IdentifierChange,
  InvariantId,
  ValidationContext,
  ValidationResult,
  Violation,
} from './types.ts';

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

interface RefUse {
  to: RefTarget;
  value: string;
  path: string;
  nodeId: string | null;
  /** For style_def.basedOn: the kind of the style that refers. */
  fromStyleKind?: string;
}

interface StyleInfo {
  kind: string;
  basedOn: string | null;
  builtIn: boolean;
  path: string;
  outlineLevel: boolean;
  numbered: boolean;
}

interface ParagraphInfo {
  style: string | null;
  numbered: boolean;
  caption: boolean;
}

interface State {
  ix: DefinitionIndex;
  ctx: ValidationContext;
  requires: Set<string>;
  v: Violation[];
  ids: Map<string, string>;
  styles: Map<string, StyleInfo>;
  defaultStyle: string | null;
  numberingLevels: Map<string, number>;
  numberingUses: Array<{ numberingId: string; level: number; path: string; nodeId: string | null }>;
  pageSetups: Set<string>;
  stories: Map<string, string>;
  sources: Set<string>;
  preservedDefs: Set<string>;
  anchors: Set<string>;
  eqLabels: Set<string>;
  paragraphs: Map<string, ParagraphInfo>;
  fieldTargets: Array<{ value: string; kind: string; path: string; nodeId: string | null }>;
  refs: RefUse[];
  suggestionUsers: Map<string, { user: string; path: string }>;
  regions: number;
  tooDeep: boolean;
  nodes: IndexedNode[];
  byType: Map<string, IndexedNode[]>;
  byPath: Map<string, IndexedNode>;
  /** `display:latex` of every formula in the previous document; null without one. */
  previousLatex: Set<string> | null;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function add(
  st: State,
  code: BuiltInCode,
  path: string,
  nodeId: string | null,
  message: string,
): void {
  st.v.push({ invariant: VIOLATION_CODES[code].invariant, code, path, nodeId, message });
}

export function validate(envelope: unknown, ctx: ValidationContext = {}): ValidationResult {
  const def = ctx.def ?? CDM1;
  const ix = indexDefinition(def);
  const v: Violation[] = [];
  const notChecked: string[] = [];
  if (!ctx.attachedAssets) notChecked.push('I4 (asset references: no attached-asset list given)');
  if (!ctx.mathGate) notChecked.push('I8 (no math gate given)');
  if (!ctx.retiredRegionIds) notChecked.push('I3 (region identifiers removed earlier: none given)');
  // "A non-null id never changes" is a rule about a transition: it needs the identifier changes
  // the commit's steps made, not only its result.
  if (!ctx.identifierChanges)
    notChecked.push('I2 (a non-null id never changes: no identifier changes given)');

  const st: State = {
    ix,
    ctx,
    requires: new Set(),
    v,
    ids: new Map(),
    styles: new Map(),
    defaultStyle: null,
    numberingLevels: new Map(),
    numberingUses: [],
    pageSetups: new Set(),
    stories: new Map(),
    sources: new Set(),
    preservedDefs: new Set(),
    anchors: new Set(),
    eqLabels: new Set(),
    paragraphs: new Map(),
    fieldTargets: [],
    refs: [],
    suggestionUsers: new Map(),
    regions: 0,
    tooDeep: false,
    nodes: [],
    byType: new Map(),
    byPath: new Map(),
    previousLatex: null,
  };

  // Envelope (03 §2): closed, `cdm` is this major version, `requires` names known features once.
  if (!isObject(envelope)) {
    add(st, 'not_an_object', '', null, 'the document is not a JSON object');
    return { valid: false, violations: v, notChecked };
  }
  for (const key of Object.keys(envelope)) {
    if (key !== 'cdm' && key !== 'requires' && key !== 'doc')
      add(
        st,
        'envelope_member',
        `/${key}`,
        null,
        `unknown envelope member "${key}"; metadata belongs to the document resource, not the CDM`,
      );
  }
  if (envelope['cdm'] !== def.cdm) add(st, 'cdm_version', '/cdm', null, `cdm must be ${def.cdm}`);
  const req = envelope['requires'];
  if (!Array.isArray(req))
    add(st, 'requires_invalid', '/requires', null, 'requires must be an array');
  else
    req.forEach((f, i) => {
      if (typeof f !== 'string' || !ix.features.has(f as never))
        add(st, 'requires_invalid', `/requires/${i}`, null, `unknown feature ${JSON.stringify(f)}`);
      else if (st.requires.has(f))
        add(st, 'requires_invalid', `/requires/${i}`, null, `feature "${f}" listed twice`);
      else st.requires.add(f);
    });

  const doc = envelope['doc'];
  if (!isObject(doc) || doc['type'] !== def.topNode) {
    add(st, 'top_node', '/doc', null, `doc must be a "${def.topNode}" node`);
    return { valid: false, violations: v, notChecked };
  }
  if (ctx.previous !== undefined && ctx.mathGate) st.previousLatex = latexOf(ctx.previous);

  walk(st, doc, '/doc', [], 1, null);
  resolveReferences(st);
  checkStyleChains(st);
  checkNumberingLevels(st);
  checkIdentifierChanges(st);
  checkLimits(st, envelope as unknown as JsonEnvelope);
  runChecks(st, envelope, notChecked);

  // I1: content expressions and allowed marks, exactly as ProseMirror applies them. A document
  // nested beyond the limit is already invalid (I7) and is not handed to the recursive parser.
  if (!st.tooDeep && !v.some((x) => x.invariant === 'I1')) {
    try {
      const schema = ctx.schema ?? cdmSchema();
      schema.nodeFromJSON(doc).check();
    } catch (e) {
      add(st, 'schema_content', '/doc', null, `schema: ${(e as Error).message}`);
    }
  }
  v.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { valid: v.length === 0, violations: v, notChecked };
}

/** Validates a ProseMirror document (as the authority holds it). */
export function validateDoc(
  doc: PMNode,
  requires: readonly string[],
  ctx: ValidationContext = {},
): ValidationResult {
  return validate(
    { cdm: (ctx.def ?? CDM1).cdm, requires: [...requires], doc: doc.toJSON() as JsonNode },
    ctx,
  );
}

const ALLOWED_KEYS = new Set(['type', 'attrs', 'content', 'marks']);
const TEXT_KEYS = new Set(['type', 'text', 'marks']);

function walk(
  st: State,
  node: Record<string, unknown>,
  path: string,
  ancestors: string[],
  depth: number,
  nearestId: string | null,
): void {
  const { ix } = st;
  const type = node['type'];
  if (typeof type !== 'string')
    return add(st, 'unknown_node_type', path, nearestId, 'node without a type');
  const nd = ix.nodes.get(type);
  if (!nd) {
    if (ix.projectionNodes.has(type))
      return add(
        st,
        'projection_only_node',
        path,
        nearestId,
        `"${type}" exists only in a reader's projection and is never stored (ADR 0019)`,
      );
    return add(st, 'unknown_node_type', path, nearestId, `unknown node type "${type}"`);
  }
  if (depth > LIMITS.depth) {
    // Report once and stop descending, so that hostile nesting costs no unbounded recursion.
    if (!st.tooDeep)
      add(st, 'nesting_too_deep', path, nearestId, `nesting deeper than ${LIMITS.depth}`);
    st.tooDeep = true;
    return;
  }
  const allowed = type === 'text' ? TEXT_KEYS : ALLOWED_KEYS;
  for (const key of Object.keys(node))
    if (!allowed.has(key))
      add(st, 'unknown_member', `${path}/${key}`, nearestId, `unknown member "${key}" on ${type}`);
  if (nd.feature && !st.requires.has(nd.feature))
    add(
      st,
      'feature_missing',
      path,
      nearestId,
      `"${type}" belongs to feature "${nd.feature}", which requires does not list`,
    );

  if (type === 'text') {
    if (typeof node['text'] !== 'string' || node['text'] === '')
      add(st, 'empty_text', `${path}/text`, nearestId, 'text nodes need non-empty text');
    checkMarks(st, node['marks'], `${path}/marks`, false, type, nearestId);
    return;
  }

  const attrs = checkAttrs(st, nd, node['attrs'], `${path}/attrs`, type, nearestId);
  const own = st.ix.idNodes.has(type) && typeof attrs['id'] === 'string' ? attrs['id'] : null;
  const nodeId = own ?? nearestId;
  const entry: IndexedNode = { type, attrs, path, ancestors, nodeId, node };
  st.nodes.push(entry);
  st.byPath.set(path, entry);
  let list = st.byType.get(type);
  if (!list) st.byType.set(type, (list = []));
  list.push(entry);

  // I3: regions and section breaks are direct children of the body; regions do not nest.
  if (type === 'region' || type === 'section_break') {
    const parent = ancestors[ancestors.length - 1];
    if (parent !== 'body') {
      if (type === 'region' && ancestors.includes('region'))
        add(st, 'nested_region', path, nodeId, 'regions do not nest');
      else
        add(
          st,
          'misplaced_container',
          path,
          nodeId,
          `a ${type} must be a direct child of the body, not of ${parent ?? 'nothing'}`,
        );
    }
  }
  // Inline atoms carry marks as text does, formatting and suggestions alike (spike S11, change 1);
  // on blocks, marks are node marks (03 §5).
  if (node['marks'] !== undefined)
    checkMarks(st, node['marks'], `${path}/marks`, !nd.inline, type, nodeId);
  collect(st, type, attrs, path, ancestors, nodeId);

  const content = node['content'];
  if (content !== undefined) {
    if (!Array.isArray(content))
      add(st, 'malformed', `${path}/content`, nodeId, 'content must be an array');
    else {
      if (!nd.content)
        add(st, 'content_on_leaf', `${path}/content`, nodeId, `${type} has no content`);
      if (type === 'footnote') {
        const paragraphs = content.filter((c) => isObject(c) && c['type'] === 'paragraph').length;
        if (paragraphs > LIMITS.footnoteParagraphs)
          add(
            st,
            'footnote_paragraphs',
            `${path}/content`,
            nodeId,
            `a footnote holds one paragraph in version 1, not ${paragraphs} (CDM-001)`,
          );
      }
      const next = [...ancestors, type];
      content.forEach((child, i) => {
        if (!isObject(child))
          add(st, 'malformed', `${path}/content/${i}`, nodeId, 'child is not a node object');
        else walk(st, child, `${path}/content/${i}`, next, depth + 1, nodeId);
      });
      if (type === 'table') checkTableGeometry(st, attrs, content, path, nodeId);
      if (type === 'paragraph' && typeof own === 'string') {
        const info = st.paragraphs.get(own);
        if (info)
          info.caption = content.some(
            (c) =>
              isObject(c) &&
              c['type'] === 'field' &&
              isObject(c['attrs']) &&
              c['attrs']['kind'] === 'seq',
          );
      }
    }
  }
}

/** The problems of one attribute value, each under the invariant its attribute names. */
function grammarViolations(
  st: State,
  a: AttrDef,
  value: unknown,
  path: string,
  nodeId: string | null,
): void {
  for (const p of grammarProblems(a.grammar, value, path)) {
    const inv = a.reportAs?.[p.kind] ?? a.reportAs?.['*'] ?? 'I11';
    add(st, GRAMMAR_CODES[inv] ?? 'attribute_invalid', p.path, nodeId, p.message);
  }
}

/** Checks the attributes of a node or mark; returns the effective values (defaults filled in). */
function checkAttrs(
  st: State,
  owner: NodeDef | MarkDef,
  given: unknown,
  path: string,
  ownerName: string,
  nodeId: string | null,
): Record<string, JsonValue> {
  const spec = owner.attrs;
  const out: Record<string, JsonValue> = {};
  if (given !== undefined && !isObject(given)) {
    add(st, 'malformed', path, nodeId, 'attrs must be an object');
    given = undefined;
  }
  const rec = (given ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(rec))
    if (!Object.hasOwn(spec, key))
      add(
        st,
        'unknown_attribute',
        `${path}/${key}`,
        nodeId,
        `unknown attribute "${key}" on ${ownerName}`,
      );
  for (const [name, a] of Object.entries(spec)) {
    const present = Object.hasOwn(rec, name);
    const value = (present ? rec[name] : a.default) as JsonValue;
    out[name] = value;
    // A required attribute must be given: its default only lets ProseMirror create the node.
    if (a.presence === 'required' && (!present || value === null || value === undefined)) {
      const own = name === 'id' && st.ix.idNodes.has(ownerName);
      if (own) add(st, 'missing_id', `${path}/${name}`, nodeId, `${ownerName} has no identifier`);
      else if (a.reportAs?.['*'] === 'I12')
        add(
          st,
          'extension_envelope',
          `${path}/${name}`,
          nodeId,
          `${ownerName}.${name} is required`,
        );
      else
        add(st, 'attribute_missing', `${path}/${name}`, nodeId, `${ownerName}.${name} is required`);
      continue;
    }
    // Field values (`reportAs` I15) are checked whole, by kind, by the field invariants.
    if (present && a.reportAs?.['*'] !== 'I15')
      grammarViolations(st, a, value, `${path}/${name}`, nodeId);
    if (a.feature && value !== null && !st.requires.has(a.feature))
      add(
        st,
        'feature_missing',
        `${path}/${name}`,
        nodeId,
        `${ownerName}.${name} belongs to feature "${a.feature}", which requires does not list`,
      );
    if (a.valueFeatures && typeof value === 'string' && Object.hasOwn(a.valueFeatures, value)) {
      const feature = a.valueFeatures[value]!;
      if (!st.requires.has(feature))
        add(
          st,
          'feature_missing',
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
  st: State,
  marks: unknown,
  path: string,
  nodeMarks: boolean,
  host: string,
  nodeId: string | null,
): void {
  const { ix } = st;
  if (marks === undefined) return;
  if (!Array.isArray(marks)) return add(st, 'malformed', path, nodeId, 'marks must be an array');
  if (nodeMarks && marks.length && !NODE_MARK_HOSTS.includes(host))
    add(
      st,
      'node_mark_host',
      path,
      nodeId,
      `node marks are allowed only on ${NODE_MARK_HOSTS.join(', ')}, not on ${host}`,
    );
  marks.forEach((m, i) => {
    const p = `${path}/${i}`;
    if (!isObject(m) || typeof m['type'] !== 'string')
      return add(st, 'unknown_mark_type', p, nodeId, 'mark without a type');
    for (const key of Object.keys(m))
      if (key !== 'type' && key !== 'attrs')
        add(st, 'unknown_member', `${p}/${key}`, nodeId, `unknown member "${key}" on a mark`);
    const md = ix.marks.get(m['type']);
    if (!md) return add(st, 'unknown_mark_type', p, nodeId, `unknown mark type "${m['type']}"`);
    if (nodeMarks && !SUGGESTIONS.has(md.name))
      add(
        st,
        'node_mark_host',
        p,
        nodeId,
        `only suggestion marks can be node marks, not ${md.name}`,
      );
    if (md.feature && !st.requires.has(md.feature))
      add(
        st,
        'feature_missing',
        p,
        nodeId,
        `mark "${md.name}" belongs to feature "${md.feature}", which requires does not list`,
      );
    const attrs = checkAttrs(st, md, m['attrs'], `${p}/attrs`, md.name, nodeId);
    collectRefs(st, md.attrs, attrs, `${p}/attrs`, nodeId);
    if (SUGGESTIONS.has(md.name))
      checkSuggestion(st, md.name, attrs, `${p}/attrs`, nodeMarks ? host : null, nodeId);
  });
}

/**
 * Suggestion marks (03 §5): an identifier belongs to one user (I2), and `fmt.before` has the shape
 * of CDM-002: `{ marks, attrs }`, the previous marks of text or the previous style, alignment or
 * list level of a block (CDM-040), each passing its own grammar.
 */
function checkSuggestion(
  st: State,
  name: string,
  attrs: Record<string, JsonValue>,
  path: string,
  blockHost: string | null,
  nodeId: string | null,
): void {
  const sid = attrs['id'];
  const user = attrs['user'];
  if (typeof sid === 'string' && typeof user === 'string') {
    const first = st.suggestionUsers.get(sid);
    if (!first) st.suggestionUsers.set(sid, { user, path: `${path}/user` });
    else if (first.user !== user)
      add(
        st,
        'suggestion_user',
        `${path}/user`,
        nodeId,
        `suggestion "${sid}" belongs to "${first.user}" (${first.path}), not to "${user}"`,
      );
  }
  if (name !== 'fmt') return;
  const before = attrs['before'];
  if (before === null || before === undefined) return;
  const bad = (at: string, why: string) => add(st, 'fmt_before', at, nodeId, `fmt.before: ${why}`);
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
          isObject(m) && typeof m['type'] === 'string' ? st.ix.marks.get(m['type']) : undefined;
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
    const host = blockHost ? st.ix.nodes.get(blockHost) : undefined;
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
  st: State,
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
      st,
      a.grammar,
      value,
      `${path}/${name}`,
      nodeId,
      name === 'basedOn' ? fromStyleKind : undefined,
    );
  }
}

function refsIn(
  st: State,
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
    st.refs.push(use);
  } else if (g.kind === 'object' && isObject(value)) {
    for (const [k, sub] of Object.entries(g.properties)) {
      if (!Object.hasOwn(value, k)) continue;
      const inner = (value as Record<string, JsonValue>)[k];
      if (inner !== undefined) refsIn(st, sub, inner, `${path}/${k}`, nodeId);
    }
  } else if (g.kind === 'array' && Array.isArray(value)) {
    const n = Math.min(value.length, g.maxItems);
    for (let i = 0; i < n; i++) refsIn(st, g.items, value[i]!, `${path}/${i}`, nodeId);
  } else if (g.kind === 'elementTree' && isObject(value) && typeof value['ref'] === 'string') {
    // A shared preserved tree (spike S11): it must resolve to a preserved_def (I4).
    if (grammarProblems(g, value, path).length) return;
    st.refs.push({ to: 'preservedDef', value: value['ref'], path: `${path}/ref`, nodeId });
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
  st: State,
  type: string,
  attrs: Record<string, JsonValue>,
  path: string,
  ancestors: string[],
  nodeId: string | null,
): void {
  const { ix, ctx } = st;
  const nd = ix.nodes.get(type)!;
  const ap = `${path}/attrs`;
  const id = attrs['id'];
  if (ix.idNodes.has(type) && typeof id === 'string') {
    const first = st.ids.get(id);
    if (first !== undefined)
      add(st, 'duplicate_id', `${ap}/id`, id, `identifier "${id}" is also used at ${first}`);
    else st.ids.set(id, `${ap}/id`);
  }
  collectRefs(
    st,
    nd.attrs,
    attrs,
    ap,
    nodeId,
    type === 'style_def' ? show(attrs['kind']) : undefined,
  );

  switch (type) {
    case 'settings':
      st.defaultStyle =
        typeof attrs['defaultParagraphStyle'] === 'string' ? attrs['defaultParagraphStyle'] : null;
      break;
    case 'style_def': {
      if (typeof id !== 'string') break;
      const kind = show(attrs['kind']);
      const builtIn = attrs['builtIn'] === true;
      st.styles.set(id, {
        kind,
        basedOn: typeof attrs['basedOn'] === 'string' ? attrs['basedOn'] : null,
        builtIn,
        path: ap,
        outlineLevel: typeof attrs['outlineLevel'] === 'number',
        numbered: isObject(attrs['numbering']),
      });
      const reserved = Object.hasOwn(BUILT_IN_STYLES, id) ? BUILT_IN_STYLES[id] : undefined;
      if (reserved && (!builtIn || reserved !== kind))
        add(
          st,
          'reserved_style_id',
          `${ap}/id`,
          nodeId,
          `"${id}" is reserved for the built-in ${reserved} style`,
        );
      if (!reserved && builtIn)
        add(
          st,
          'reserved_style_id',
          `${ap}/builtIn`,
          nodeId,
          `"${id}" is not a built-in style identifier`,
        );
      // Table properties belong to table styles only (03 §4.5; CDM-017).
      if (kind !== 'table') {
        for (const p of ['cellMargins', 'headerRowShading', 'bandedRows'])
          if (attrs[p] !== null && attrs[p] !== undefined)
            add(
              st,
              'table_property',
              `${ap}/${p}`,
              nodeId,
              `${p} is a table property; "${id}" is a ${kind} style`,
            );
        const borders = attrs['borders'];
        if (isObject(borders))
          for (const side of ['insideH', 'insideV'])
            if (borders[side] !== null && borders[side] !== undefined)
              add(
                st,
                'table_property',
                `${ap}/borders/${side}`,
                nodeId,
                `${side} borders are table properties; "${id}" is a ${kind} style`,
              );
      }
      if (isObject(attrs['numbering']))
        numberingUse(st, attrs['numbering'], `${ap}/numbering`, nodeId);
      break;
    }
    case 'numbering_def':
      if (typeof id === 'string')
        st.numberingLevels.set(id, Array.isArray(attrs['levels']) ? attrs['levels'].length : 0);
      break;
    case 'page_setup':
      if (typeof id === 'string') st.pageSetups.add(id);
      break;
    case 'preserved_def':
      if (typeof id === 'string') st.preservedDefs.add(id);
      break;
    case 'preserved_inline':
      if (attrs['fragment'] === null && attrs['tree'] === null)
        add(
          st,
          'preserved_without_payload',
          ap,
          nodeId,
          'preserved inline content needs its fragment asset or, for a small marker, its tree',
        );
      break;
    case 'source_def':
      if (typeof id === 'string') st.sources.add(id);
      break;
    case 'story':
      if (typeof id === 'string') st.stories.set(id, show(attrs['kind']));
      break;
    case 'region':
      st.regions++;
      if (typeof id === 'string' && ctx.retiredRegionIds?.has(id))
        add(
          st,
          'region_id_reused',
          `${ap}/id`,
          nodeId,
          `region identifier "${id}" was removed from this document before and cannot be reused`,
        );
      break;
    case 'paragraph':
      if (typeof id === 'string')
        st.paragraphs.set(id, {
          style: typeof attrs['style'] === 'string' ? attrs['style'] : null,
          numbered: isObject(attrs['numbering']),
          caption: false,
        });
      if (isObject(attrs['numbering']))
        numberingUse(st, attrs['numbering'], `${ap}/numbering`, nodeId);
      break;
    case 'table':
      if (ancestors.includes('story') || ancestors.includes('footnote'))
        add(
          st,
          'table_in_story_or_footnote',
          path,
          nodeId,
          'tables are not allowed in headers, footers or footnotes',
        );
      break;
    case 'footnote':
      if (ancestors.includes('footnote'))
        add(
          st,
          'footnote_in_footnote',
          path,
          nodeId,
          'a footnote is not allowed inside a footnote',
        );
      else if (ancestors.includes('caption'))
        add(st, 'footnote_in_caption', path, nodeId, 'a footnote is not allowed inside a caption');
      break;
    case 'anchor':
      // Bookmark names are reference targets, so they are unique (CDM-002, ADR 0018).
      if (typeof attrs['name'] === 'string') {
        if (st.anchors.has(attrs['name']))
          add(
            st,
            'duplicate_target_name',
            `${ap}/name`,
            nodeId,
            `bookmark name "${attrs['name']}" is used twice; references to it would be ambiguous`,
          );
        st.anchors.add(attrs['name']);
      }
      break;
    case 'equation_block':
      if (typeof attrs['label'] === 'string') {
        if (st.eqLabels.has(attrs['label']))
          add(
            st,
            'duplicate_target_name',
            `${ap}/label`,
            nodeId,
            `equation label "${attrs['label']}" is used twice; references to it would be ambiguous`,
          );
        st.eqLabels.add(attrs['label']);
      }
      checkMath(st, attrs['latex'], true, `${ap}/latex`, nodeId);
      break;
    case 'equation':
      checkMath(st, attrs['latex'], false, `${ap}/latex`, nodeId);
      break;
    case 'figure':
      if (attrs['placement'] === 'float' && ancestors.includes('table_cell'))
        add(
          st,
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
        add(
          st,
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
        add(
          st,
          'break_in_container',
          `${ap}/kind`,
          nodeId,
          `a ${show(attrs['kind'])} break is not allowed in cells, captions or footnotes`,
        );
      break;
    case 'field':
      checkFieldNode(st, attrs, ap, nodeId);
      break;
    case 'form_field':
      if (ancestors.includes('story') || ancestors.includes('footnote'))
        add(
          st,
          'form_field_placement',
          path,
          nodeId,
          'form fields are not allowed in headers, footers or footnotes (12 §3.2)',
        );
      break;
    case 'extension_block':
      if (attrs['fallbackAsset'] === null && attrs['fallbackText'] === null)
        add(
          st,
          'extension_fallback',
          ap,
          nodeId,
          'an extension block needs a fallback picture or a fallback text (13 §7.3)',
        );
      break;
    case 'extension_inline':
      if (attrs['fallbackText'] === null)
        add(
          st,
          'extension_fallback',
          `${ap}/fallbackText`,
          nodeId,
          'an inline extension needs a fallback text (13 §7.3)',
        );
      break;
  }
}

function numberingUse(
  st: State,
  n: Record<string, unknown>,
  path: string,
  nodeId: string | null,
): void {
  if (typeof n['numberingId'] === 'string' && typeof n['level'] === 'number')
    st.numberingUses.push({
      numberingId: n['numberingId'],
      level: n['level'],
      path: `${path}/level`,
      nodeId,
    });
}

/** The `field` node: the target form and name its kind takes (CDM-002), collected for I4. */
function checkFieldNode(
  st: State,
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
      add(
        st,
        'field_target_form',
        `${ap}/target`,
        nodeId,
        forms.length
          ? `a ${kind} field targets ${forms.map((f) => `${f}:`).join(', ')}, not ${scheme}:`
          : `a ${kind} field takes no target`,
      );
    else st.fieldTargets.push({ value: target, kind, path: `${ap}/target`, nodeId });
  } else if (forms.length && target === null)
    add(st, 'field_target_form', `${ap}/target`, nodeId, `a ${kind} field needs a target`);
  // A `seq` field without a name is allowed: it counts in no sequence and shows nothing (CDM-042).
  if (kind !== 'seq' && attrs['name'] !== null && attrs['name'] !== undefined)
    add(st, 'field_target_form', `${ap}/name`, nodeId, `a ${kind} field takes no sequence name`);
}

function checkMath(
  st: State,
  latex: JsonValue | undefined,
  display: boolean,
  path: string,
  nodeId: string | null,
): void {
  if (!st.ctx.mathGate || typeof latex !== 'string' || latex === '') return;
  // A formula the previous document already held passed the gate when it was set (09 §6.3).
  if (st.previousLatex?.has(`${display}:${latex}`)) return;
  const reason = st.ctx.mathGate(latex, display);
  if (reason) add(st, 'math_refused', path, nodeId, `math gate: ${reason}`);
}

/** Every `display:latex` of a previous document, read without recursion and with a bound. */
function latexOf(previous: unknown): Set<string> {
  const out = new Set<string>();
  const root = isObject(previous) && isObject(previous['doc']) ? previous['doc'] : previous;
  const stack: unknown[] = [root];
  let budget = 2_000_000;
  while (stack.length && budget-- > 0) {
    const n = stack.pop();
    if (!isObject(n)) continue;
    const t = n['type'];
    const attrs = n['attrs'];
    if (
      (t === 'equation' || t === 'equation_block') &&
      isObject(attrs) &&
      typeof attrs['latex'] === 'string'
    )
      out.add(`${t === 'equation_block'}:${attrs['latex']}`);
    const content = n['content'];
    if (Array.isArray(content)) for (const c of content) stack.push(c);
  }
  return out;
}

/**
 * I6: in every row, the column spans of its cells plus the columns covered by cells spanning down
 * from earlier rows add up to the length of `grid`, without overlap; row spans do not run past the
 * last row; `headerRows` is at most the number of rows. (03 §8 states the rule without row spans;
 * ADR 0018 records this reading.)
 */
function checkTableGeometry(
  st: State,
  tableAttrs: Record<string, JsonValue>,
  rows: unknown[],
  tablePath: string,
  nodeId: string | null,
): void {
  const headerRows = tableAttrs['headerRows'];
  if (typeof headerRows === 'number' && headerRows > rows.length)
    add(
      st,
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
        add(
          st,
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
      add(
        st,
        'row_columns',
        `${tablePath}/content/${r}`,
        nodeId,
        `row ${r} does not cover exactly the ${columns} columns of the grid`,
      );
    carry = next;
  });
}

/** Whether a paragraph style, through its `basedOn` chain, has a property. */
function chainHas(st: State, style: string | null, pick: (s: StyleInfo) => boolean): boolean {
  let cur = style;
  for (let i = 0; cur && i <= LIMITS.basedOnDepth; i++) {
    const s = st.styles.get(cur);
    if (!s) return false;
    if (pick(s)) return true;
    cur = s.basedOn;
  }
  return false;
}

function resolveReferences(st: State): void {
  const { ctx } = st;
  for (const r of st.refs) {
    const fail = (code: BuiltInCode, why: string) => add(st, code, r.path, r.nodeId, why);
    switch (r.to) {
      case 'paragraphStyle':
      case 'characterStyle':
      case 'tableStyle': {
        const s = st.styles.get(r.value);
        const want =
          r.to === 'paragraphStyle'
            ? 'paragraph'
            : r.to === 'characterStyle'
              ? 'character'
              : 'table';
        if (!s) fail('unresolved_reference', `style "${r.value}" does not exist`);
        else if (s.kind !== want)
          fail(
            'wrong_reference_kind',
            `style "${r.value}" is a ${s.kind} style, not a ${want} style`,
          );
        break;
      }
      case 'anyStyle': {
        const s = st.styles.get(r.value);
        if (!s) fail('unresolved_reference', `style "${r.value}" does not exist`);
        else if (r.fromStyleKind && s.kind !== r.fromStyleKind)
          fail(
            'wrong_reference_kind',
            `basedOn "${r.value}" is a ${s.kind} style; a ${r.fromStyleKind} style must be based on one of its own kind`,
          );
        break;
      }
      case 'numbering':
        if (!st.numberingLevels.has(r.value))
          fail('unresolved_reference', `numbering definition "${r.value}" does not exist`);
        break;
      case 'pageSetup':
        if (!st.pageSetups.has(r.value))
          fail('unresolved_reference', `page setup "${r.value}" does not exist`);
        break;
      case 'headerStory':
      case 'footerStory': {
        const kind = st.stories.get(r.value);
        const want = r.to === 'headerStory' ? 'header' : 'footer';
        if (!kind) fail('unresolved_reference', `story "${r.value}" does not exist`);
        else if (kind !== want)
          fail('wrong_reference_kind', `story "${r.value}" is a ${kind}, not a ${want}`);
        break;
      }
      case 'source':
        if (!st.sources.has(r.value))
          fail('unresolved_reference', `source "${r.value}" does not exist`);
        break;
      case 'preservedDef':
        if (!st.preservedDefs.has(r.value))
          fail(
            'unresolved_reference',
            'preserved tree ' + JSON.stringify(r.value) + ' does not exist',
          );
        break;
      case 'role':
        // Roles are I13, checked by the field invariants (src/fields/invariants.ts).
        break;
      case 'asset':
        if (ctx.attachedAssets && !ctx.attachedAssets.has(r.value))
          fail('asset_not_attached', `asset "${r.value}" is not attached to this document`);
        break;
    }
  }
  for (const t of st.fieldTargets) {
    const colon = t.value.indexOf(':');
    const scheme = t.value.slice(0, colon);
    const target = t.value.slice(colon + 1);
    let why: string | null = null;
    switch (scheme) {
      case 'bookmark':
        if (!st.anchors.has(target)) why = 'names no bookmark';
        break;
      case 'node': {
        const p = st.paragraphs.get(target);
        if (!p) why = 'names no paragraph';
        else {
          const style = p.style ?? st.defaultStyle;
          const heading = chainHas(st, style, (s) => s.outlineLevel);
          const numbered = p.numbered || chainHas(st, style, (s) => s.numbered);
          if (!heading && !numbered && !p.caption)
            why = 'names a paragraph that is not a heading, a numbered paragraph or a caption';
        }
        break;
      }
      case 'eq':
        if (!st.eqLabels.has(target)) why = 'names no equation label';
        break;
      case 'style':
        if (!st.styles.has(target)) why = 'names no style';
        break;
      // `field:` targets are I14, checked by the field invariants.
    }
    if (why)
      add(st, 'field_target_unresolved', t.path, t.nodeId, `field target "${t.value}" ${why}`);
  }
}

/** I5: basedOn chains have no cycles and are at most ten styles deep. */
function checkStyleChains(st: State): void {
  for (const [id, s] of st.styles) {
    const seen = new Set<string>([id]);
    let cur = s.basedOn;
    let length = 1;
    while (cur) {
      if (seen.has(cur)) {
        add(
          st,
          'style_chain_cycle',
          `${s.path}/basedOn`,
          id,
          `basedOn chain of "${id}" has a cycle`,
        );
        break;
      }
      seen.add(cur);
      length++;
      if (length > LIMITS.basedOnDepth) {
        add(
          st,
          'style_chain_too_deep',
          `${s.path}/basedOn`,
          id,
          `basedOn chain of "${id}" is deeper than ${LIMITS.basedOnDepth}`,
        );
        break;
      }
      cur = st.styles.get(cur)?.basedOn ?? null;
    }
  }
}

/** I4: a numbering level exists in its definition (CDM-019, CDM-026). */
function checkNumberingLevels(st: State): void {
  for (const u of st.numberingUses) {
    const levels = st.numberingLevels.get(u.numberingId);
    if (levels !== undefined && u.level >= levels)
      add(
        st,
        'numbering_level_missing',
        u.path,
        u.nodeId,
        `level ${u.level} is not defined: "${u.numberingId}" has ${levels} level${levels === 1 ? '' : 's'}`,
      );
  }
}

/** I2 transition: a non-null identifier never changes, except when a copy gets its own. */
function checkIdentifierChanges(st: State): void {
  for (const c of st.ctx.identifierChanges ?? []) {
    if (c.from === null || c.from === c.to || c.copy === true) continue;
    const where = c.to !== null ? st.ids.get(c.to) : undefined;
    add(
      st,
      'id_changed',
      where ?? '',
      c.from,
      `the identifier "${c.from}" was changed to ${JSON.stringify(c.to)}`,
    );
  }
}

function checkLimits(st: State, env: JsonEnvelope): void {
  if (st.regions > LIMITS.regions)
    add(st, 'too_many_regions', '/doc', null, `${st.regions} regions, more than ${LIMITS.regions}`);
  if (st.tooDeep || st.v.some((x) => x.invariant === 'I1')) return;
  try {
    const bytes = utf8(canonicalize(canonicalEnvelopeLenient(env, st.ix.def))).length;
    if (bytes > LIMITS.canonicalBytes)
      add(st, 'canonical_too_large', '', null, `canonical size ${bytes} bytes, more than 16 MiB`);
  } catch (e) {
    add(st, 'not_canonicalisable', '', null, `not canonicalisable: ${(e as Error).message}`);
  }
}

/** The nearest node id for a path reported by a check that gave none. */
function nodeIdAt(st: State, path: string): string | null {
  for (let p = path; p.length > 0; p = p.slice(0, p.lastIndexOf('/'))) {
    const n = st.byPath.get(p);
    if (n) return n.nodeId;
  }
  return null;
}

/** Runs the built-in, registered and per-call checks through one interface (CDM-013). */
function runChecks(st: State, envelope: Record<string, unknown>, notChecked: string[]): void {
  const view: DocumentView = {
    envelope,
    requires: st.requires,
    context: st.ctx,
    nodes: st.nodes,
    ofType: (type) => st.byType.get(type) ?? [],
  };
  const checks: InvariantCheck[] = [
    ...BUILT_IN_CHECKS,
    ...registeredInvariants(),
    ...(st.ctx.invariants ?? []),
  ];
  for (const check of checks) {
    const report = (r: ViolationReport) => {
      const own = Object.hasOwn(check.codes, r.code) ? check.codes[r.code] : undefined;
      const known = own ?? (Object.hasOwn(MODEL_CODES, r.code) ? MODEL_CODES[r.code] : undefined);
      if (!known) {
        add(
          st,
          'check_failed',
          r.path,
          null,
          `check "${check.name}" reported the undeclared code "${r.code}"`,
        );
        return;
      }
      st.v.push({
        invariant: known.invariant,
        code: r.code,
        path: r.path,
        nodeId: r.nodeId !== undefined ? r.nodeId : nodeIdAt(st, r.path),
        message: r.message,
      });
    };
    try {
      check.check(view, report);
      if (check.notChecked) notChecked.push(...check.notChecked(view));
    } catch (e) {
      add(st, 'check_failed', '', null, `check "${check.name}" failed: ${(e as Error).message}`);
    }
  }
}
