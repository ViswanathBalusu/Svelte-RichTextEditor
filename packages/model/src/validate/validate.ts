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
 *
 * The checks of one node are in node-checks.ts and what resolves is in references.ts. The
 * incremental validation of a commit (incremental.ts) runs the same code on the nodes the commit
 * changed.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { canonicalize } from '../canonical/jcs.ts';
import {
  canonicalEnvelopeLenient,
  type JsonEnvelope,
  type JsonNode,
} from '../canonical/canonical-form.ts';
import { utf8 } from '../conventions/platform.ts';
import { CDM1 } from '../definition/cdm1.ts';
import { indexDefinition, type DefinitionIndex } from '../definition/index.ts';
import { cdmSchema } from '../prosemirror/index.ts';
import { BUILT_IN_CHECKS, MODEL_CODES } from './built-in.ts';
import { VIOLATION_CODES, type BuiltInCode } from './codes.ts';
import {
  LIMITS,
  isObject,
  walkNode,
  type FieldTargetUse,
  type NumberingUse,
  type ParagraphInfo,
  type Recorder,
  type RefUse,
  type StyleInfo,
} from './node-checks.ts';
import { levelProblem, refProblem, targetProblem } from './references.ts';
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
export { LIMITS } from './limits.ts';

interface State {
  ix: DefinitionIndex;
  ctx: ValidationContext;
  requires: Set<string>;
  v: Violation[];
  ids: Map<string, string>;
  styles: Map<string, StyleInfo>;
  defaultStyle: string | null;
  numberingLevels: Map<string, number>;
  numberingUses: NumberingUse[];
  pageSetups: Set<string>;
  stories: Map<string, string>;
  sources: Set<string>;
  preservedDefs: Set<string>;
  anchors: Set<string>;
  eqLabels: Set<string>;
  paragraphs: Map<string, ParagraphInfo>;
  fieldTargets: FieldTargetUse[];
  refs: RefUse[];
  suggestionUsers: Map<string, { user: string; path: string }>;
  regions: number;
  tooDeep: boolean;
  /** A lower bound of the canonical size passed 16 MiB: the walk stopped (I7; CDM-013). */
  tooLarge: boolean;
  /** Bytes the canonical form has at least, counted as the walk goes. */
  minBytes: number;
  nodes: IndexedNode[];
  byType: Map<string, IndexedNode[]>;
  byPath: Map<string, IndexedNode>;
  /** `display:latex` of every formula in the previous document; null without one. */
  previousLatex: Set<string> | null;
}

function add(
  st: State,
  code: BuiltInCode,
  path: string,
  nodeId: string | null,
  message: string,
): void {
  st.v.push({ invariant: VIOLATION_CODES[code].invariant, code, path, nodeId, message });
}

/** What the context did not let a validation check, in the words of `notChecked` (CDM-013). */
function contextGaps(ctx: ValidationContext): string[] {
  const notChecked: string[] = [];
  if (!ctx.attachedAssets) notChecked.push('I4 (asset references: no attached-asset list given)');
  if (!ctx.mathGate) notChecked.push('I8 (no math gate given)');
  if (!ctx.retiredRegionIds) notChecked.push('I3 (region identifiers removed earlier: none given)');
  // "A non-null id never changes" is a rule about a transition: it needs the identifier changes
  // the commit's steps made, not only its result.
  if (!ctx.identifierChanges)
    notChecked.push('I2 (a non-null id never changes: no identifier changes given)');
  return notChecked;
}

/** The checks a validation runs through the registration interface, in the order they run. */
export function checksOf(ctx: ValidationContext): InvariantCheck[] {
  return [...BUILT_IN_CHECKS, ...registeredInvariants(), ...(ctx.invariants ?? [])];
}

export function validate(envelope: unknown, ctx: ValidationContext = {}): ValidationResult {
  const def = ctx.def ?? CDM1;
  const ix = indexDefinition(def);
  const v: Violation[] = [];
  const notChecked = contextGaps(ctx);

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
    tooLarge: false,
    minBytes: 0,
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
  else if (req.length > ix.features.size)
    // Each feature is listed once, so a longer list is wrong whatever it holds; a hostile list is
    // not read item by item.
    add(
      st,
      'requires_invalid',
      '/requires',
      null,
      `requires has ${req.length} entries, more than the ${ix.features.size} features there are`,
    );
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

  // A document whose nodes and text alone are over the size limit is refused before the walk.
  if (nodesOverLimit(doc)) spend(st, LIMITS.canonicalBytes + 1, '', null);
  else walkNode(ix, recorder(st), doc, '/doc', [], 1, null);
  if (st.tooLarge) {
    // The walk stopped where the size passed the limit, so the checks that need the whole
    // document cannot run. They are listed as not checked, never as passed.
    notChecked.push(
      'every check past the point where the canonical size passed 16 MiB (I7): the walk stopped there',
    );
    v.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { valid: false, violations: v, notChecked };
  }
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

/** `{"type":""}`: what a node adds to the canonical form besides its name. */
const MIN_NODE_BYTES = 11;

/**
 * Counts bytes the canonical form is sure to have, and reports I7 once when they pass the limit.
 * The canonical form (03 §2) keeps every node with its type name, every character of text and
 * every attribute value that is not the default, so these counts are a lower bound of its size.
 * A hostile document is then refused where it passes the limit, before the grammar walk and the
 * exact measurement (CDM-013). The nodes and the text are counted before the walk
 * (`nodesOverLimit`), an attribute value where it is read. Returns whether the walk must stop.
 */
function spend(st: State, bytes: number, path: string, nodeId: string | null): boolean {
  st.minBytes += bytes;
  if (st.minBytes <= LIMITS.canonicalBytes) return false;
  if (!st.tooLarge)
    add(
      st,
      'canonical_too_large',
      path,
      nodeId,
      'the canonical size is more than 16 MiB: the limit is passed here',
    );
  st.tooLarge = true;
  return true;
}

/** What a node adds to the canonical form at the least: its text, or its braces and type name. */
function leastBytes(node: Record<string, unknown>): number {
  const type = node['type'];
  if (type === 'text') return typeof node['text'] === 'string' ? node['text'].length : 0;
  return typeof type === 'string' ? MIN_NODE_BYTES + type.length : 2;
}

/**
 * Whether the nodes and the text of a document alone are over the size limit (see `spend`). It
 * reads no attribute and reports nothing, stops as soon as the bound passes the limit, and does
 * not recurse, so hostile nesting and hostile length both cost at most the limit.
 */
function nodesOverLimit(doc: Record<string, unknown>): boolean {
  let n = leastBytes(doc);
  const stack: Array<Record<string, unknown>> = [doc];
  while (stack.length) {
    const content = stack.pop()!['content'];
    if (!Array.isArray(content)) continue;
    for (let i = 0; i < content.length; i++) {
      const child: unknown = content[i];
      if (!isObject(child)) continue;
      n += leastBytes(child);
      if (n > LIMITS.canonicalBytes) return true;
      stack.push(child);
    }
  }
  return false;
}

/**
 * Where the checks of one node (node-checks.ts) put what they find: the state of the walk. What
 * depends on the rest of the document is decided here in walk order (identifiers, suggestion users,
 * bookmark names and equation labels, features, retired regions, the math gate, the nesting limit),
 * or collected for the document-wide checks that follow the walk.
 */
function recorder(st: State): Recorder {
  return {
    add: (code, path, nodeId, message) => add(st, code, path, nodeId, message),
    missing: (feature) => !st.requires.has(feature),
    feature: (_feature, path, nodeId, message) => add(st, 'feature_missing', path, nodeId, message),
    deep(path, nodeId) {
      // Reported once, so that hostile nesting costs one violation.
      if (!st.tooDeep)
        add(st, 'nesting_too_deep', path, nodeId, `nesting deeper than ${LIMITS.depth}`);
      st.tooDeep = true;
    },
    oversize: (path, nodeId) => void spend(st, LIMITS.canonicalBytes + 1, path, nodeId),
    stopped: () => st.tooLarge,
    id(id, path) {
      const first = st.ids.get(id);
      if (first !== undefined)
        add(st, 'duplicate_id', path, id, `identifier "${id}" is also used at ${first}`);
      else st.ids.set(id, path);
    },
    suggestion(sid, user, path, nodeId) {
      const first = st.suggestionUsers.get(sid);
      if (!first) st.suggestionUsers.set(sid, { user, path });
      else if (first.user !== user)
        add(
          st,
          'suggestion_user',
          path,
          nodeId,
          `suggestion "${sid}" belongs to "${first.user}" (${first.path}), not to "${user}"`,
        );
    },
    name(kind, name, path, nodeId) {
      // Bookmark names and equation labels are reference targets, so they are unique (CDM-002,
      // ADR 0018).
      const names = kind === 'anchor' ? st.anchors : st.eqLabels;
      if (names.has(name))
        add(
          st,
          'duplicate_target_name',
          path,
          nodeId,
          `${kind === 'anchor' ? 'bookmark name' : 'equation label'} "${name}" is used twice; references to it would be ambiguous`,
        );
      names.add(name);
    },
    region(id, path, nodeId) {
      st.regions++;
      if (typeof id === 'string' && st.ctx.retiredRegionIds?.has(id))
        add(
          st,
          'region_id_reused',
          path,
          nodeId,
          `region identifier "${id}" was removed from this document before and cannot be reused`,
        );
    },
    math(latex, display, path, nodeId) {
      if (!st.ctx.mathGate) return;
      // A formula the previous document already held passed the gate when it was set (09 §6.3).
      if (st.previousLatex?.has(`${display}:${latex}`)) return;
      const reason = st.ctx.mathGate(latex, display);
      if (reason) add(st, 'math_refused', path, nodeId, `math gate: ${reason}`);
    },
    ref: (use) => void st.refs.push(use),
    target: (use) => void st.fieldTargets.push(use),
    numbering: (use) => void st.numberingUses.push(use),
    settings(defaultStyle) {
      st.defaultStyle = defaultStyle;
    },
    style: (id, info) => void st.styles.set(id, info),
    numberingDef: (id, levels) => void st.numberingLevels.set(id, levels),
    pageSetup: (id) => void st.pageSetups.add(id),
    preservedDef: (id) => void st.preservedDefs.add(id),
    source: (id) => void st.sources.add(id),
    story: (id, kind) => void st.stories.set(id, kind),
    paragraph: (id, style, numbered) =>
      void st.paragraphs.set(id, { style, numbered, caption: false }),
    caption(id, caption) {
      const info = st.paragraphs.get(id);
      if (info) info.caption = caption;
    },
    node(entry) {
      st.nodes.push(entry);
      st.byPath.set(entry.path, entry);
      let list = st.byType.get(entry.type);
      if (!list) st.byType.set(entry.type, (list = []));
      list.push(entry);
    },
  };
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

/** I4: every reference and every field target the walk collected resolves (references.ts). */
function resolveReferences(st: State): void {
  for (const r of st.refs) {
    const problem = refProblem(st, r, st.ctx.attachedAssets);
    if (problem) add(st, problem.code, r.path, r.nodeId, problem.why);
  }
  for (const t of st.fieldTargets) {
    const why = targetProblem(st, t.value);
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
    const why = levelProblem(st, u);
    if (why) add(st, 'numbering_level_missing', u.path, u.nodeId, why);
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
  for (const check of checksOf(st.ctx)) {
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
