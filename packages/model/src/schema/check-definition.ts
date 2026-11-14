/**
 * Generation-time checks on the definition (CDM-006): every attribute has a complete grammar
 * (type, and the range, length, pattern or bound its type needs) and a default, and the default is
 * valid for the grammar (except `presence: required` attributes, whose null default only lets
 * ProseMirror create the node). Node and mark names are unique, every content expression parses,
 * and every name it mentions exists. Each problem names the attribute.
 */
import { MAX_INTEROPERABLE_INTEGER } from '../conventions/validators.ts';
import type {
  CdmDefinition,
  Grammar,
  MarkDef,
  NodeDef,
  ProjectionNodeDef,
  RefTarget,
} from '../definition/grammar.ts';
import { checkGrammar } from '../validate/grammar-check.ts';
import { extendContent, parseContent } from './content-expr.ts';

const REF_TARGETS: readonly RefTarget[] = [
  'paragraphStyle',
  'characterStyle',
  'tableStyle',
  'anyStyle',
  'numbering',
  'pageSetup',
  'headerStory',
  'footerStory',
  'asset',
  'role',
  'source',
  'preservedDef',
];

const INVARIANTS = new Set([
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
  'I6',
  'I7',
  'I8',
  'I9',
  'I10',
  'I11',
  'I12',
  'I13',
  'I14',
  'I15',
]);
/** I15: field values, which the field invariants check whole (src/fields/invariants.ts). */
const GRAMMAR_INVARIANTS = new Set(['I7', 'I9', 'I11', 'I12', 'I15']);
const PROBLEM_KINDS = new Set([
  '*',
  'type',
  'null',
  'length',
  'pattern',
  'control',
  'range',
  'enum',
  'reference',
  'member',
  'count',
  'size',
  'depth',
  'key',
  'element',
]);

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
const isBound = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && Math.abs(n) <= MAX_INTEROPERABLE_INTEGER;

function checkPattern(pattern: unknown, where: string, problems: string[]): void {
  if (typeof pattern !== 'string') return void problems.push(`${where}: pattern is not a string`);
  if (!pattern.startsWith('^') || !pattern.endsWith('$'))
    problems.push(`${where}: pattern is not anchored`);
  try {
    new RegExp(pattern);
  } catch {
    problems.push(`${where}: pattern does not compile`);
  }
}

/**
 * The grammar itself is complete (CDM-006: "an attribute with no type, range, length or pattern
 * fails and names the attribute"): strings have a maximum length, integers a range inside the
 * interoperable range of RFC 8785, enumerations values, references a target, arrays a maximum
 * count, and free JSON a size and depth bound.
 */
export function checkGrammarShape(g: Grammar | undefined, where: string): string[] {
  const problems: string[] = [];
  if (!g || typeof g !== 'object') return [`${where}: no grammar`];
  switch (g.kind) {
    case 'string':
      if (!isCount(g.maxLength)) problems.push(`${where}: string without a maximum length`);
      if (
        g.minLength !== undefined &&
        (!Number.isSafeInteger(g.minLength) || g.minLength < 0 || g.minLength > g.maxLength)
      )
        problems.push(`${where}: minimum length out of range`);
      if (g.pattern !== undefined) checkPattern(g.pattern, where, problems);
      break;
    case 'integer':
      if (!isBound(g.min) || !isBound(g.max))
        problems.push(`${where}: integer without a range inside the interoperable range`);
      else if (g.min > g.max) problems.push(`${where}: integer range is empty`);
      break;
    case 'boolean':
      break;
    case 'enum':
      if (!Array.isArray(g.values) || g.values.length === 0)
        problems.push(`${where}: enumeration without values`);
      else if (
        new Set(g.values).size !== g.values.length ||
        g.values.some((x) => typeof x !== 'string')
      )
        problems.push(`${where}: enumeration values are not unique strings`);
      break;
    case 'ref':
      if (!REF_TARGETS.includes(g.to)) problems.push(`${where}: reference without a known target`);
      break;
    case 'object': {
      const entries = Object.entries(g.properties ?? {});
      if (entries.length === 0) problems.push(`${where}: object without properties`);
      for (const [k, sub] of entries) problems.push(...checkGrammarShape(sub, `${where}/${k}`));
      for (const r of g.required ?? [])
        if (!(r in (g.properties ?? {})))
          problems.push(`${where}: required "${r}" is not a property`);
      break;
    }
    case 'array':
      if (!isCount(g.maxItems)) problems.push(`${where}: array without a maximum count`);
      if (
        g.minItems !== undefined &&
        (!Number.isSafeInteger(g.minItems) || g.minItems < 0 || g.minItems > g.maxItems)
      )
        problems.push(`${where}: minimum count out of range`);
      problems.push(...checkGrammarShape(g.items, `${where}/items`));
      break;
    case 'json':
    case 'elementTree':
      if (!isCount(g.maxBytes) || !isCount(g.maxDepth))
        problems.push(`${where}: free JSON without a size and depth bound`);
      if (g.kind === 'json' && g.keyPattern !== undefined)
        checkPattern(g.keyPattern, `${where} keys`, problems);
      break;
    default:
      problems.push(
        `${where}: unknown grammar kind ${JSON.stringify((g as { kind?: unknown }).kind)}`,
      );
  }
  return problems;
}

export function checkDefinition(def: CdmDefinition): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const groups = new Set<string>();
  const features = new Set<string>(def.features.map((f) => f.name));
  for (const n of def.nodes)
    for (const g of (n.group ?? '').split(' ').filter(Boolean)) groups.add(g);

  const checkAttrs = (
    owner: NodeDef | MarkDef | ProjectionNodeDef,
    kind: string,
    needsExt = true,
  ) => {
    for (const [name, a] of Object.entries(owner.attrs)) {
      const where = `${kind} ${owner.name}.${name}`;
      const shape = checkGrammarShape(a.grammar, where);
      problems.push(...shape);
      if (!('default' in a) || a.default === undefined) problems.push(`${where}: no default`);
      if (!a.doc) problems.push(`${where}: no description`);
      if (a.feature !== undefined && !features.has(a.feature))
        problems.push(`${where}: unknown feature ${a.feature}`);
      for (const [value, feature] of Object.entries(a.valueFeatures ?? {})) {
        if (a.grammar.kind !== 'enum' || !a.grammar.values.includes(value))
          problems.push(`${where}: value feature for "${value}", which is not one of its values`);
        if (!features.has(feature)) problems.push(`${where}: unknown feature ${feature}`);
      }
      for (const [problem, invariant] of Object.entries(a.reportAs ?? {})) {
        if (!PROBLEM_KINDS.has(problem)) problems.push(`${where}: unknown problem kind ${problem}`);
        if (!INVARIANTS.has(String(invariant)))
          problems.push(`${where}: reports ${problem} as unknown invariant ${String(invariant)}`);
        // Grammar problems have codes under these invariants only (src/validate/codes.ts).
        else if (!GRAMMAR_INVARIANTS.has(String(invariant)))
          problems.push(`${where}: grammar problems cannot be reported as ${String(invariant)}`);
      }
      if (shape.length || !('default' in a) || a.default === undefined) continue;
      // A required attribute's default exists only so that ProseMirror can create the node.
      if (a.presence === 'required') continue;
      for (const msg of checkGrammar(a.grammar, a.default, where))
        problems.push(`default is invalid: ${msg}`);
    }
    if (needsExt && owner.name !== 'text' && !('ext' in owner.attrs))
      problems.push(`${kind} ${owner.name}: no ext attribute (03 §11.2)`);
  };

  for (const n of def.nodes) {
    if (names.has(n.name)) problems.push(`duplicate node ${n.name}`);
    names.add(n.name);
    checkAttrs(n, 'node');
    if (n.feature && !def.features.some((f) => f.name === n.feature))
      problems.push(`node ${n.name}: unknown feature ${n.feature}`);
  }
  for (const n of def.nodes) {
    if (!n.content) continue;
    try {
      const tokens = n.content.match(/\w+/g) ?? [];
      parseContent(n.content);
      for (const t of tokens)
        if (!names.has(t) && !groups.has(t))
          problems.push(`node ${n.name}: content names unknown "${t}"`);
    } catch (e) {
      problems.push(`node ${n.name}: ${(e as Error).message}`);
    }
  }
  const markNames = new Set<string>();
  for (const m of def.marks) {
    if (markNames.has(m.name)) problems.push(`duplicate mark ${m.name}`);
    markNames.add(m.name);
    checkAttrs(m, 'mark');
    if (m.feature && !features.has(m.feature))
      problems.push(`mark ${m.name}: unknown feature ${m.feature}`);
  }
  // Projection nodes (ADR 0019) never reach a stored document, so they carry no `ext`; each names
  // the nodes whose content may hold it, and that content must be one we can extend.
  for (const p of def.projection ?? []) {
    if (names.has(p.name)) problems.push(`projection node ${p.name}: also a node of the document`);
    names.add(p.name);
    checkAttrs(p, 'projection node', false);
    if (p.content !== undefined) problems.push(`projection node ${p.name}: must be a leaf`);
    for (const host of p.allowedIn) {
      const n = def.nodes.find((x) => x.name === host);
      if (!n?.content) problems.push(`projection node ${p.name}: ${host} has no content to extend`);
      else
        try {
          extendContent(n.content, p.name);
        } catch (e) {
          problems.push(`projection node ${p.name}: ${(e as Error).message}`);
        }
    }
  }
  return problems;
}
