/**
 * The rules language (12 §5.1, §5.2; ADR 0012; ADR 0030): a closed set of operators and effects in
 * a JSON tree, checked in three passes.
 *
 * 1. Shape: every node is a literal or an object with one member naming an operand or operator;
 *    arities, the bounds of the CDM grammar and the pattern subset are checked here.
 * 2. Graph: `set` effects and the fields they read form a graph that must have no cycle (I14); its
 *    order is the evaluation order (12 §5.2).
 * 3. Types: every operand has a static type; string literals take the type their position needs,
 *    once, when the rule is checked; nothing is converted while a rule is evaluated.
 *
 * Nothing here evaluates rule text as code: a rule is data that the evaluator walks.
 */
import { DEFINITION_ID_PATTERN, FIELD_KEY_PATTERN } from './cdm.ts';
import { parseDate } from './dates.ts';
import { type Decimal, parseDecimal } from './decimal.ts';
import { type FieldInfo, type FieldKind, kindType } from './fields.ts';
import {
  type JsonValue,
  byCodeUnits,
  canonicalBytes,
  codePointLength,
  hasControlCharacter,
  isObject,
  jsonDepth,
  pointer,
} from './json.ts';
import { LIMITS } from './limits.ts';
import { compilePattern, maxMatchSteps, type Pattern } from './pattern.ts';

export const COMPARISON_OPERATORS = ['==', '!=', '<', '<=', '>', '>='] as const;
export const LOGIC_OPERATORS = ['and', 'or', 'not'] as const;
export const PREDICATE_OPERATORS = ['in', 'empty', 'matches'] as const;
export const FORMULA_OPERATORS = [
  '+',
  '-',
  '*',
  '/',
  'round',
  'sum',
  'min',
  'max',
  'concat',
  'if',
] as const;
export const OPERATORS = [
  ...COMPARISON_OPERATORS,
  ...LOGIC_OPERATORS,
  ...PREDICATE_OPERATORS,
  ...FORMULA_OPERATORS,
] as const;
export type Operator = (typeof OPERATORS)[number];
export const OPERANDS = ['field', 'role', 'now'] as const;
export const FIELD_EFFECTS = [
  'show',
  'hide',
  'require',
  'enable',
  'disable',
  'validate',
  'set',
] as const;
export type FieldEffect = (typeof FIELD_EFFECTS)[number];
/** Valid only in the workflow resource's `routing` (12 §5.1), never in a `rule_def`. */
export const ROUTING_EFFECTS = ['addParticipant', 'skipParticipant'] as const;

/** Static types. `null` is the type of the null literal and of a formula no rule sets. */
export type Type = 'boolean' | 'decimal' | 'string' | 'date' | 'signature' | 'null';

/** Errors an evaluation can produce instead of a value (ADR 0030 §1). */
export type RuntimeError =
  'division_by_zero' | 'overflow' | 'too_long' | 'invalid_value' | 'no_clock';

/** Values while a rule is evaluated. Dates are day numbers; decimals are exact. */
export type Value =
  | null
  | { t: 'boolean'; v: boolean }
  | { t: 'decimal'; v: Decimal }
  | { t: 'string'; v: string }
  | { t: 'date'; v: number }
  | { t: 'signature' }
  | { t: 'error'; code: RuntimeError };

export type ProblemCode =
  | 'bad_shape'
  | 'unknown_operator'
  | 'unknown_effect'
  | 'routing_effect'
  | 'wrong_arity'
  | 'number_literal'
  | 'invalid_literal'
  | 'type_mismatch'
  | 'unknown_field'
  | 'unknown_role'
  | 'unknown_option'
  | 'reserved_kind'
  | 'not_a_formula'
  | 'pattern_syntax'
  | 'pattern_unsupported'
  | 'pattern_limit'
  | 'too_large'
  | 'too_deep'
  | 'duplicate_rule'
  | 'duplicate_key'
  | 'conflicting_effects'
  | 'conflicting_rules'
  | 'cycle'
  | 'too_many_rules';

export interface RuleProblem {
  code: ProblemCode;
  /** JSON Pointer to the offending node, under the rule's own path. */
  path: string;
  /** The rule concerned, when its identifier could be read. */
  rule?: string;
  /** Field keys concerned: the keys on a cycle, the keys two rules both decide, an unknown key. */
  keys?: string[];
  /** For pattern problems: the construct, such as `back-reference`. */
  construct?: string;
  message: string;
}

/** A typed expression. Every node carries its static type and the path it came from. */
export type Expr =
  | { k: 'lit'; ty: Type; v: Value; path: string }
  | { k: 'field'; ty: Type; key: string; kind: FieldKind; path: string }
  | { k: 'role'; ty: 'boolean'; role: string; path: string }
  | { k: 'now'; ty: 'date'; path: string }
  | {
      k: 'op';
      ty: Type;
      op: Operator;
      args: Expr[];
      path: string;
      /** `in`: the list, typed like the operand. */
      list?: Value[];
      /** `round`: places. */
      places?: number;
      /** `matches`: the compiled pattern. */
      pattern?: Pattern;
    };

export type Effect =
  | { k: 'show' | 'hide' | 'require' | 'enable' | 'disable'; keys: string[]; path: string }
  | { k: 'validate'; keys: string[]; message: string; path: string }
  | { k: 'set'; key: string; value: Expr; path: string };

export interface CompiledRule {
  id: string;
  path: string;
  when: Expr;
  then: Effect[];
  else: Effect[];
}

export interface RuleSet {
  /** Sorted by identifier, so that nothing depends on the order rules are stored in. */
  readonly rules: readonly CompiledRule[];
  readonly fields: ReadonlyMap<string, FieldInfo>;
  /** Field keys in the order given (document order). */
  readonly fieldOrder: readonly string[];
  /** Formula fields in dependency order (12 §5.2). */
  readonly formulaOrder: readonly string[];
  readonly formulaTypes: ReadonlyMap<string, 'decimal' | 'string' | 'null'>;
  /** The one rule that sets each formula field. */
  readonly setter: ReadonlyMap<string, CompiledRule>;
  /** The one rule that shows or hides each field, and the one that enables or disables it. */
  readonly visibility: ReadonlyMap<string, CompiledRule>;
  readonly enablement: ReadonlyMap<string, CompiledRule>;
  /** The rules that may require each field, or attach a `validate` message to it. */
  readonly requires: ReadonlyMap<string, readonly CompiledRule[]>;
  readonly validates: ReadonlyMap<string, readonly CompiledRule[]>;
  /** For each rule, the formula fields its condition reads. For each formula, the formulas its `set` reads. */
  readonly ruleNeeds: ReadonlyMap<string, readonly string[]>;
  readonly formulaNeeds: ReadonlyMap<string, readonly string[]>;
  /** An upper bound on the steps of one evaluation, for admission control (04 §12). */
  readonly maxSteps: number;
}

export interface RuleInput {
  /** The `rule_def` attributes: `id`, `when`, `then`, `else` (and `ext`, which rules ignore). */
  attrs: unknown;
  /** JSON Pointer of the attributes, used as the prefix of every problem's path. */
  path: string;
}

export interface CompileEnvironment {
  fields: readonly FieldInfo[];
  /** The document's `role_def` identifiers. Without it, `{ "role": ... }` is not checked. */
  roles?: readonly string[];
}

export type CompileResult =
  { ok: true; ruleSet: RuleSet; problems: [] } | { ok: false; problems: RuleProblem[] };

// ---------------------------------------------------------------------------------------------
// Pass 1: shape

type ULit = { k: 'lit'; v: null | boolean | string; path: string };
type UExpr =
  | ULit
  | { k: 'field'; key: string; path: string }
  | { k: 'role'; role: string; path: string }
  | { k: 'now'; path: string }
  | {
      k: 'op';
      op: Operator;
      args: UExpr[];
      path: string;
      list?: Array<{ v: string; path: string }>;
      places?: number;
      pattern?: Pattern;
    };

type UEffect =
  | { k: 'show' | 'hide' | 'require' | 'enable' | 'disable'; keys: string[]; path: string }
  | { k: 'validate'; keys: string[]; message: string; path: string }
  | { k: 'set'; key: string; value: UExpr; path: string };

interface URule {
  id: string | null;
  path: string;
  when: UExpr | null;
  then: UEffect[];
  else: UEffect[];
  /** False when some part failed its shape check. */
  sound: boolean;
}

const fieldKeyRe = new RegExp(FIELD_KEY_PATTERN);
const idRe = new RegExp(DEFINITION_ID_PATTERN);
const OPERATOR_SET = new Set<string>(OPERATORS);
const EFFECT_SET = new Set<string>(FIELD_EFFECTS);
const ROUTING_SET = new Set<string>(ROUTING_EFFECTS);

const ARITY: Readonly<Record<Operator, [number, number]>> = {
  '==': [2, 2],
  '!=': [2, 2],
  '<': [2, 2],
  '<=': [2, 2],
  '>': [2, 2],
  '>=': [2, 2],
  and: [2, Infinity],
  or: [2, Infinity],
  not: [1, 1],
  in: [2, 2],
  empty: [1, 1],
  matches: [2, 2],
  '+': [2, Infinity],
  '-': [1, 2],
  '*': [2, Infinity],
  '/': [2, 2],
  round: [2, 2],
  sum: [1, Infinity],
  min: [1, Infinity],
  max: [1, Infinity],
  concat: [1, Infinity],
  if: [3, 3],
};

class Problems {
  readonly list: RuleProblem[] = [];
  rule: string | undefined;

  add(code: ProblemCode, path: string, message: string, extra: Partial<RuleProblem> = {}): null {
    const p: RuleProblem = { code, path, message, ...extra };
    if (this.rule !== undefined && p.rule === undefined) p.rule = this.rule;
    this.list.push(p);
    return null;
  }
}

function parseExpr(json: JsonValue, path: string, pr: Problems): UExpr | null {
  if (json === null || typeof json === 'boolean' || typeof json === 'string')
    return { k: 'lit', v: json, path };
  if (typeof json === 'number')
    return pr.add(
      'number_literal',
      path,
      'numbers are written as strings in rules, for example "12.50"; only the places of round are a JSON number',
    );
  if (Array.isArray(json))
    return pr.add(
      'bad_shape',
      path,
      'an expression is a literal or an object with one member; a list is allowed only as the list of in',
    );
  const names = Object.keys(json);
  if (names.length !== 1)
    return pr.add(
      'bad_shape',
      path,
      `an expression object has exactly one member naming its operator or operand, not ${names.length}`,
    );
  const name = names[0]!;
  const arg = json[name]!;
  const p = pointer(path, name);
  if (name === 'field') {
    if (typeof arg !== 'string' || !fieldKeyRe.test(arg))
      return pr.add('bad_shape', p, 'a field operand names a field key, such as "tenant.income"');
    return { k: 'field', key: arg, path };
  }
  if (name === 'role') {
    if (typeof arg !== 'string' || !idRe.test(arg))
      return pr.add(
        'bad_shape',
        p,
        'a role operand names a role identifier, such as "role_tenant"',
      );
    return { k: 'role', role: arg, path };
  }
  if (name === 'now') {
    if (arg !== 'date') return pr.add('bad_shape', p, 'the only form is { "now": "date" }');
    return { k: 'now', path };
  }
  if (!OPERATOR_SET.has(name)) {
    if (ROUTING_SET.has(name))
      return pr.add('routing_effect', path, `${name} is a routing effect, not an operator`);
    if (EFFECT_SET.has(name))
      return pr.add('unknown_operator', path, `${name} is an effect, not an operator`);
    return pr.add('unknown_operator', path, `"${name}" is not an operator of the rules language`);
  }
  const op = name as Operator;
  if (!Array.isArray(arg))
    return pr.add(
      'bad_shape',
      p,
      `the operands of ${op} are a list, for example { "${op}": [ ... ] }`,
    );
  const [lo, hi] = ARITY[op];
  if (arg.length < lo || arg.length > hi)
    return pr.add(
      'wrong_arity',
      p,
      lo === hi
        ? `${op} takes ${lo} operand${lo === 1 ? '' : 's'}, not ${arg.length}`
        : hi === Infinity
          ? `${op} takes at least ${lo} operands, not ${arg.length}`
          : `${op} takes ${lo} or ${hi} operands, not ${arg.length}`,
    );
  const node: UExpr & { k: 'op' } = { k: 'op', op, args: [], path };
  let sound = true;
  const operands = op === 'in' || op === 'matches' || op === 'round' ? arg.slice(0, 1) : arg;
  operands.forEach((a, i) => {
    const e = parseExpr(a, pointer(p, i), pr);
    if (e) node.args.push(e);
    else sound = false;
  });
  const second = arg[1];
  const sp = pointer(p, 1);
  if (op === 'in') {
    if (!Array.isArray(second) || second.length === 0)
      return pr.add('bad_shape', sp, 'the second operand of in is a non-empty list of literals');
    node.list = [];
    second.forEach((item, j) => {
      if (typeof item !== 'string') {
        sound = false;
        pr.add(
          typeof item === 'number' ? 'number_literal' : 'bad_shape',
          pointer(sp, j),
          'the list of in holds strings: option identifiers, decimals such as "12.50", or dates',
        );
      } else node.list!.push({ v: item, path: pointer(sp, j) });
    });
  } else if (op === 'matches') {
    if (typeof second !== 'string')
      return pr.add(
        'bad_shape',
        sp,
        'the second operand of matches is a pattern, written as a string',
      );
    const r = compilePattern(second);
    if (!r.ok)
      return pr.add(r.problem.code, sp, r.problem.message, { construct: r.problem.construct });
    node.pattern = r.pattern;
  } else if (op === 'round') {
    if (
      typeof second !== 'number' ||
      !Number.isInteger(second) ||
      second < 0 ||
      second > LIMITS.roundPlaces
    )
      return pr.add(
        'bad_shape',
        sp,
        `the places of round are a whole number from 0 to ${LIMITS.roundPlaces}, written as a JSON number`,
      );
    node.places = second;
  }
  return sound ? node : null;
}

function parseKeys(json: JsonValue, path: string, pr: Problems): string[] | null {
  if (!Array.isArray(json) || json.length === 0)
    return pr.add('bad_shape', path, 'an effect names a non-empty list of field keys');
  const keys: string[] = [];
  let sound = true;
  json.forEach((k, i) => {
    if (typeof k !== 'string' || !fieldKeyRe.test(k)) {
      sound = false;
      pr.add('bad_shape', pointer(path, i), 'a field key such as "tenant.spouseName"');
    } else if (keys.includes(k)) {
      sound = false;
      pr.add('duplicate_key', pointer(path, i), `"${k}" is listed twice`, { keys: [k] });
    } else keys.push(k);
  });
  return sound ? keys : null;
}

function parseEffect(json: JsonValue, path: string, pr: Problems): UEffect | null {
  if (!isObject(json) || Object.keys(json).length !== 1)
    return pr.add('bad_shape', path, 'an effect is an object with one member naming the effect');
  const name = Object.keys(json)[0]!;
  const arg = json[name]!;
  const p = pointer(path, name);
  if (ROUTING_SET.has(name))
    return pr.add(
      'routing_effect',
      path,
      `${name} is a routing effect; routing rules live in the workflow resource, not in a rule_def (12 §5.1, §5.4)`,
    );
  if (!EFFECT_SET.has(name))
    return pr.add(
      'unknown_effect',
      path,
      OPERATOR_SET.has(name)
        ? `${name} is an operator, not an effect`
        : `"${name}" is not an effect of the rules language`,
    );
  const effect = name as FieldEffect;
  if (effect === 'validate') {
    if (!isObject(arg) || Object.keys(arg).sort().join(',') !== 'fields,message')
      return pr.add('bad_shape', p, 'validate is { "fields": [keys], "message": "..." }');
    const keys = parseKeys(arg['fields']!, pointer(p, 'fields'), pr);
    const message = arg['message'];
    if (
      typeof message !== 'string' ||
      codePointLength(message) < 1 ||
      codePointLength(message) > LIMITS.messageLength ||
      hasControlCharacter(message)
    )
      return pr.add(
        'bad_shape',
        pointer(p, 'message'),
        `a validate message is text of 1 to ${LIMITS.messageLength} characters without control characters`,
      );
    return keys ? { k: 'validate', keys, message, path } : null;
  }
  if (effect === 'set') {
    if (!isObject(arg) || Object.keys(arg).sort().join(',') !== 'field,value')
      return pr.add('bad_shape', p, 'set is { "field": key, "value": expression }');
    const key = arg['field'];
    if (typeof key !== 'string' || !fieldKeyRe.test(key))
      return pr.add('bad_shape', pointer(p, 'field'), 'set names the key of a formula field');
    const value = parseExpr(arg['value']!, pointer(p, 'value'), pr);
    return value ? { k: 'set', key, value, path } : null;
  }
  const keys = parseKeys(arg, p, pr);
  return keys ? { k: effect, keys, path } : null;
}

function parseEffects(json: JsonValue | undefined, path: string, pr: Problems): UEffect[] | null {
  if (json === undefined || json === null) return [];
  if (!Array.isArray(json)) return pr.add('bad_shape', path, 'effects are a list');
  const out: UEffect[] = [];
  let sound = true;
  json.forEach((e, i) => {
    const parsed = parseEffect(e, pointer(path, i), pr);
    if (parsed) out.push(parsed);
    else sound = false;
  });
  return sound ? out : null;
}

function boundsOk(value: JsonValue, path: string, pr: Problems): boolean {
  if (jsonDepth(value, LIMITS.ruleDepth) > LIMITS.ruleDepth) {
    pr.add('too_deep', path, `nested deeper than ${LIMITS.ruleDepth} levels`);
    return false;
  }
  const bytes = canonicalBytes(value);
  if (bytes === null) {
    pr.add('bad_shape', path, 'not JSON');
    return false;
  }
  if (bytes > LIMITS.ruleAttributeBytes) {
    pr.add(
      'too_large',
      path,
      `${bytes} bytes of canonical JSON, more than ${LIMITS.ruleAttributeBytes}`,
    );
    return false;
  }
  return true;
}

function parseRule(input: RuleInput, pr: Problems): URule {
  const { attrs, path } = input;
  const rule: URule = { id: null, path, when: null, then: [], else: [], sound: false };
  pr.rule = undefined;
  if (!isObject(attrs)) {
    pr.add('bad_shape', path, 'a rule is an object with id, when, then and else');
    return rule;
  }
  const rec = attrs as Record<string, JsonValue>;
  let sound = true;
  const id = rec['id'];
  if (typeof id !== 'string' || !idRe.test(id)) {
    pr.add(
      'bad_shape',
      pointer(path, 'id'),
      'a rule identifier of 1 to 64 letters, digits, _ or -',
    );
    sound = false;
  } else {
    rule.id = id;
    pr.rule = id;
  }
  for (const k of Object.keys(rec))
    if (!['id', 'when', 'then', 'else', 'ext'].includes(k)) {
      pr.add('bad_shape', pointer(path, k), `a rule has no member "${k}"`);
      sound = false;
    }
  if (!('when' in rec)) {
    pr.add('bad_shape', pointer(path, 'when'), 'a rule needs a condition, when');
    sound = false;
  } else if (boundsOk(rec['when']!, pointer(path, 'when'), pr)) {
    rule.when = parseExpr(rec['when']!, pointer(path, 'when'), pr);
    if (!rule.when) sound = false;
  } else sound = false;
  if (!('then' in rec) || !Array.isArray(rec['then'])) {
    pr.add('bad_shape', pointer(path, 'then'), 'a rule needs a list of effects, then');
    sound = false;
  } else if (boundsOk(rec['then']!, pointer(path, 'then'), pr)) {
    const t = parseEffects(rec['then'], pointer(path, 'then'), pr);
    if (t) rule.then = t;
    else sound = false;
  } else sound = false;
  if (rec['else'] !== undefined && rec['else'] !== null) {
    if (boundsOk(rec['else'], pointer(path, 'else'), pr)) {
      const e = parseEffects(rec['else'], pointer(path, 'else'), pr);
      if (e) rule.else = e;
      else sound = false;
    } else sound = false;
  }
  rule.sound = sound && rule.id !== null;
  return rule;
}

// ---------------------------------------------------------------------------------------------
// Pass 2: graph

function fieldRefs(e: UExpr, out: Set<string>): Set<string> {
  if (e.k === 'field') out.add(e.key);
  else if (e.k === 'op') for (const a of e.args) fieldRefs(a, out);
  return out;
}

interface Graph {
  /** Formula keys in dependency order. */
  order: string[];
  ruleNeeds: Map<string, string[]>;
  formulaNeeds: Map<string, string[]>;
  /** Formula keys on cycles, one list per cycle. */
  cycles: Array<{ keys: string[]; rules: string[] }>;
}

/**
 * Nodes are rules (`r:` + id) and formula fields (`f:` + key). A rule needs the formulas its
 * condition reads; a formula needs the rule that sets it and the formulas its `set` reads.
 */
function buildGraph(
  rules: readonly URule[],
  setter: ReadonlyMap<string, URule>,
  isFormula: (key: string) => boolean,
): Graph {
  const edges = new Map<string, string[]>();
  const ruleNeeds = new Map<string, string[]>();
  const formulaNeeds = new Map<string, string[]>();
  for (const r of rules) {
    if (!r.id) continue;
    const needs = r.when
      ? [...fieldRefs(r.when, new Set())].filter(isFormula).sort(byCodeUnits)
      : [];
    ruleNeeds.set(r.id, needs);
    edges.set(
      `r:${r.id}`,
      needs.map((k) => `f:${k}`),
    );
  }
  for (const [key, r] of setter) {
    const refs = new Set<string>();
    for (const e of [...r.then, ...r.else])
      if (e.k === 'set' && e.key === key) fieldRefs(e.value, refs);
    const needs = [...refs].filter(isFormula).sort(byCodeUnits);
    formulaNeeds.set(key, needs);
    edges.set(`f:${key}`, [`r:${r.id}`, ...needs.map((k) => `f:${k}`)]);
  }
  // Tarjan's strongly connected components, iteratively, over nodes in sorted order.
  const nodes = [...edges.keys()].sort(byCodeUnits);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: Graph['cycles'] = [];
  const order: string[] = [];
  let counter = 0;
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; i: number }> = [{ node: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const top = work[work.length - 1]!;
      const next = edges.get(top.node) ?? [];
      if (top.i < next.length) {
        const w = next[top.i++]!;
        if (!edges.has(w)) continue; // a formula no rule sets: a leaf
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, i: 0 });
        } else if (onStack.has(w)) low.set(top.node, Math.min(low.get(top.node)!, index.get(w)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1]!.node;
        low.set(parent, Math.min(low.get(parent)!, low.get(top.node)!));
      }
      if (low.get(top.node) === index.get(top.node)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== top.node);
        const selfLoop = (edges.get(top.node) ?? []).includes(top.node);
        if (component.length > 1 || selfLoop) {
          cycles.push({
            keys: component
              .filter((n) => n.startsWith('f:'))
              .map((n) => n.slice(2))
              .sort(byCodeUnits),
            rules: component
              .filter((n) => n.startsWith('r:'))
              .map((n) => n.slice(2))
              .sort(byCodeUnits),
          });
        } else if (top.node.startsWith('f:')) order.push(top.node.slice(2));
      }
    }
  }
  // Tarjan emits components in reverse topological order of the edges "needs", which is the
  // order dependencies come first in, because every edge points at what a node needs.
  return { order, ruleNeeds, formulaNeeds, cycles };
}

// ---------------------------------------------------------------------------------------------
// Pass 3: types

type Pending = { pending: true; lit: ULit & { v: string } };
type Typed = Expr | Pending;

const isPending = (t: Typed): t is Pending => 'pending' in t;

interface TypeEnv {
  fields: ReadonlyMap<string, FieldInfo>;
  roles: ReadonlySet<string> | null;
  formulaTypes: ReadonlyMap<string, 'decimal' | 'string' | 'null'>;
  pr: Problems;
}

const lit = (ty: Type, v: Value, path: string): Expr => ({ k: 'lit', ty, v, path });

/** Reads a pending string literal as a value of type `ty`, or reports why it cannot be one. */
function literalAs(t: Pending, ty: Type, env: TypeEnv): Expr | null {
  const { v, path } = t.lit;
  switch (ty) {
    case 'string':
    case 'null':
      return lit('string', { t: 'string', v }, path);
    case 'decimal': {
      const d = parseDecimal(v);
      if (!d)
        return env.pr.add(
          'invalid_literal',
          path,
          `"${v}" is not a decimal; write decimals such as "12.50"`,
        );
      return lit('decimal', { t: 'decimal', v: d }, path);
    }
    case 'date': {
      const d = parseDate(v);
      if (d === null)
        return env.pr.add(
          'invalid_literal',
          path,
          `"${v}" is not a calendar date such as "2026-11-06"`,
        );
      return lit('date', { t: 'date', v: d }, path);
    }
    default:
      return env.pr.add('type_mismatch', path, `a string cannot stand where a ${ty} is needed`);
  }
}

/** A string literal standing where a decimal or a date is needed and nothing else decides which. */
function decimalOrDate(t: Pending): 'decimal' | 'date' | null {
  if (parseDecimal(t.lit.v)) return 'decimal';
  if (parseDate(t.lit.v) !== null) return 'date';
  return null;
}

function infer(u: UExpr, env: TypeEnv): Typed | null {
  switch (u.k) {
    case 'lit':
      if (typeof u.v === 'string') return { pending: true, lit: u as ULit & { v: string } };
      if (u.v === null) return lit('null', null, u.path);
      return lit('boolean', { t: 'boolean', v: u.v }, u.path);
    case 'field': {
      const f = env.fields.get(u.key);
      if (!f)
        return env.pr.add('unknown_field', u.path, `no field has the key "${u.key}"`, {
          keys: [u.key],
        });
      if (f.kind === 'attachment')
        return env.pr.add(
          'reserved_kind',
          u.path,
          'attachment fields are reserved and hold no value',
        );
      const ty: Type =
        f.kind === 'formula' ? (env.formulaTypes.get(u.key) ?? 'null') : kindType(f.kind)!;
      return { k: 'field', ty, key: u.key, kind: f.kind, path: u.path };
    }
    case 'role':
      if (env.roles && !env.roles.has(u.role))
        return env.pr.add('unknown_role', u.path, `no role_def has the identifier "${u.role}"`);
      return { k: 'role', ty: 'boolean', role: u.role, path: u.path };
    case 'now':
      return { k: 'now', ty: 'date', path: u.path };
    case 'op':
      return typeOp(u, env);
  }
}

/** Types an operand that must have type `want` (or be null). */
function expect(u: UExpr, want: Type, env: TypeEnv, why: string): Expr | null {
  const t = infer(u, env);
  if (!t) return null;
  if (isPending(t)) return literalAs(t, want, env);
  if (t.ty === want || t.ty === 'null') return t;
  return env.pr.add('type_mismatch', u.path, `${why}, not a ${t.ty}`);
}

/**
 * Gives operands one common type: the type of the operands that have one, which every string
 * literal is then read as. Without one, `fallback` decides.
 */
function unify(
  items: Typed[],
  allowed: readonly Type[],
  fallback: 'string' | 'decimalOrDate',
  env: TypeEnv,
  path: string,
  what: string,
): { ty: Type; exprs: Expr[] } | null {
  const concrete = new Set<Type>();
  for (const t of items) if (!isPending(t) && t.ty !== 'null') concrete.add(t.ty);
  if (concrete.size > 1)
    return env.pr.add(
      'type_mismatch',
      path,
      `${what}: a ${[...concrete].join(' and a ')} cannot be compared or combined`,
    );
  let ty: Type | null = concrete.size ? [...concrete][0]! : null;
  if (ty !== null && !allowed.includes(ty))
    return env.pr.add('type_mismatch', path, `${what} does not accept a ${ty}`);
  if (ty === null) {
    const pendings = items.filter(isPending);
    if (!pendings.length) ty = 'null';
    else if (fallback === 'string') ty = 'string';
    else {
      const kinds = new Set(pendings.map(decimalOrDate));
      if (kinds.has(null) || kinds.size > 1) {
        const bad = pendings.find((p) => decimalOrDate(p) === null) ?? pendings[0]!;
        return env.pr.add(
          'invalid_literal',
          bad.lit.path,
          `${what} needs decimals such as "12.50" or dates such as "2026-11-06"`,
        );
      }
      ty = [...kinds][0]!;
    }
  }
  const exprs: Expr[] = [];
  let sound = true;
  for (const t of items) {
    const e = isPending(t) ? literalAs(t, ty, env) : t;
    if (e) exprs.push(e);
    else sound = false;
  }
  return sound ? { ty, exprs } : null;
}

/** A choice field compared with literals: every literal must be one of its options. */
function checkOptions(
  field: Expr,
  literals: Array<{ v: string; path: string }>,
  env: TypeEnv,
): boolean {
  if (field.k !== 'field' || field.kind !== 'choice') return true;
  const options = env.fields.get(field.key)?.options ?? [];
  let ok = true;
  for (const l of literals)
    if (!options.includes(l.v)) {
      ok = false;
      env.pr.add('unknown_option', l.path, `"${l.v}" is not an option of "${field.key}"`, {
        keys: [field.key],
      });
    }
  return ok;
}

function typeOp(u: UExpr & { k: 'op' }, env: TypeEnv): Expr | null {
  const { op, path } = u;
  const node = (ty: Type, args: Expr[], extra: Partial<Expr & { k: 'op' }> = {}): Expr => ({
    k: 'op',
    ty,
    op,
    args,
    path,
    ...extra,
  });
  const all = (want: Type, why: string): Expr[] | null => {
    const out: Expr[] = [];
    let sound = true;
    for (const a of u.args) {
      const e = expect(a, want, env, why);
      if (e) out.push(e);
      else sound = false;
    }
    return sound ? out : null;
  };
  const inferAll = (): Typed[] | null => {
    const out: Typed[] = [];
    let sound = true;
    for (const a of u.args) {
      const t = infer(a, env);
      if (t) out.push(t);
      else sound = false;
    }
    return sound ? out : null;
  };
  switch (op) {
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=': {
      const items = inferAll();
      if (!items) return null;
      const ordering = op !== '==' && op !== '!=';
      if (items.some((t) => !isPending(t) && t.ty === 'signature'))
        return env.pr.add('type_mismatch', path, 'a signature can only be tested with empty');
      const r = ordering
        ? unify(
            items,
            ['decimal', 'date'],
            'decimalOrDate',
            env,
            path,
            `${op} compares decimals or dates, so it`,
          )
        : unify(items, ['boolean', 'decimal', 'string', 'date'], 'string', env, path, op);
      if (!r) return null;
      const [a, b] = items;
      if (isPending(b!) && !isPending(a!)) checkOptions(a!, [b!.lit], env);
      if (isPending(a!) && !isPending(b!)) checkOptions(b!, [a!.lit], env);
      return node('boolean', r.exprs);
    }
    case 'and':
    case 'or': {
      const args = all('boolean', `${op} combines conditions (booleans)`);
      return args ? node('boolean', args) : null;
    }
    case 'not': {
      const args = all('boolean', 'not negates a condition (a boolean)');
      return args ? node('boolean', args) : null;
    }
    case 'in': {
      const needle = infer(u.args[0]!, env);
      if (!needle) return null;
      if (!isPending(needle) && !['decimal', 'string', 'date', 'null'].includes(needle.ty))
        return env.pr.add(
          'type_mismatch',
          path,
          `in tests strings, decimals or dates, not a ${needle.ty}`,
        );
      const ty: Type = isPending(needle) || needle.ty === 'null' ? 'string' : needle.ty;
      const n = isPending(needle) ? literalAs(needle, ty, env) : needle;
      if (!n) return null;
      const list: Value[] = [];
      let sound = true;
      for (const item of u.list!) {
        const e = literalAs(
          { pending: true, lit: { k: 'lit', v: item.v, path: item.path } },
          ty,
          env,
        );
        if (e && e.k === 'lit') list.push(e.v);
        else sound = false;
      }
      if (!checkOptions(n, u.list!, env)) sound = false;
      return sound ? node('boolean', [n], { list }) : null;
    }
    case 'empty': {
      const t = infer(u.args[0]!, env);
      if (!t) return null;
      const e = isPending(t) ? literalAs(t, 'string', env) : t;
      return e ? node('boolean', [e]) : null;
    }
    case 'matches': {
      const args = all('string', 'matches tests a string');
      return args ? node('boolean', args, { pattern: u.pattern! }) : null;
    }
    case '+':
    case '-':
    case '*':
    case '/':
    case 'sum': {
      const args = all('decimal', `${op} calculates with decimals`);
      return args ? node('decimal', args) : null;
    }
    case 'round': {
      const args = all('decimal', 'round rounds a decimal');
      return args ? node('decimal', args, { places: u.places! }) : null;
    }
    case 'min':
    case 'max': {
      const items = inferAll();
      if (!items) return null;
      const r = unify(
        items,
        ['decimal', 'date'],
        'decimalOrDate',
        env,
        path,
        `${op} takes decimals or dates, so it`,
      );
      return r ? node(r.ty, r.exprs) : null;
    }
    case 'concat': {
      const args = all('string', 'concat joins strings');
      return args ? node('string', args) : null;
    }
    case 'if': {
      const c = expect(
        u.args[0]!,
        'boolean',
        env,
        'the first operand of if is a condition (a boolean)',
      );
      const a = infer(u.args[1]!, env);
      const b = infer(u.args[2]!, env);
      if (!c || !a || !b) return null;
      if ([a, b].some((t) => !isPending(t) && t.ty === 'signature'))
        return env.pr.add('type_mismatch', path, 'if cannot yield a signature');
      const r = unify(
        [a, b],
        ['boolean', 'decimal', 'string', 'date'],
        'string',
        env,
        path,
        'the branches of if',
      );
      return r ? node(r.ty, [c, ...r.exprs]) : null;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The rule set

/** Effects that name fields without computing a value. */
type KeyEffect = 'show' | 'hide' | 'require' | 'enable' | 'disable' | 'validate';

function nodeCount(e: Expr): number {
  let n = 1;
  if (e.k === 'op') {
    for (const a of e.args) n += nodeCount(a);
    if (e.list) n += e.list.length;
    if (e.pattern) n += maxMatchSteps(e.pattern, LIMITS.valueBytes);
  }
  return n;
}

/**
 * Checks a set of rules against a document's fields and roles: shapes, references (I14), types,
 * conflicts, cycles (I14) and the count (I15). Returns the compiled rule set, or every problem
 * found. Never throws on any JSON input.
 */
export function compileRules(inputs: readonly RuleInput[], env: CompileEnvironment): CompileResult {
  const pr = new Problems();
  const fields = new Map<string, FieldInfo>();
  for (const f of env.fields) if (!fields.has(f.key)) fields.set(f.key, f);
  const fieldOrder = [...fields.keys()];
  if (inputs.length > LIMITS.rules)
    pr.add('too_many_rules', '', `${inputs.length} rules, more than ${LIMITS.rules} (I15)`);

  const parsed = inputs.map((input) => parseRule(input, pr));
  pr.rule = undefined;

  // Identifiers are unique.
  const byId = new Map<string, URule>();
  for (const r of parsed) {
    if (!r.id) continue;
    if (byId.has(r.id)) {
      pr.add(
        'duplicate_rule',
        pointer(r.path, 'id'),
        `the rule identifier "${r.id}" is used twice`,
        { rule: r.id },
      );
      r.sound = false;
      byId.get(r.id)!.sound = false;
    } else byId.set(r.id, r);
  }

  // References and conflicts of the effects.
  const deciders = {
    visibility: new Map<string, URule[]>(),
    enablement: new Map<string, URule[]>(),
    set: new Map<string, URule[]>(),
  };
  const note = (map: Map<string, URule[]>, key: string, r: URule) => {
    const list = map.get(key) ?? [];
    if (!list.includes(r)) list.push(r);
    map.set(key, list);
  };
  const done = { show: 'shown', hide: 'hidden', enable: 'enabled', disable: 'disabled' } as const;
  for (const r of parsed) {
    if (!r.id) continue;
    pr.rule = r.id;
    for (const [branch, effects] of [
      ['then', r.then],
      ['else', r.else],
    ] as const) {
      const seen = {
        visibility: new Map<string, keyof typeof done>(),
        enablement: new Map<string, keyof typeof done>(),
        set: new Set<string>(),
      };
      for (const e of effects) {
        const targets: Array<[string, string]> =
          e.k === 'set'
            ? [[e.key, pointer(pointer(e.path, 'set'), 'field')]]
            : e.k === 'validate'
              ? e.keys.map((k, i) => [
                  k,
                  pointer(pointer(pointer(e.path, 'validate'), 'fields'), i),
                ])
              : e.keys.map((k, i) => [k, pointer(pointer(e.path, e.k), i)]);
        for (const [key, at] of targets) {
          const f = fields.get(key);
          if (!f) {
            pr.add('unknown_field', at, `no field has the key "${key}"`, { keys: [key] });
            r.sound = false;
            continue;
          }
          if (e.k === 'set') {
            if (f.kind !== 'formula') {
              pr.add(
                'not_a_formula',
                at,
                `set writes formula fields only; "${key}" is a ${f.kind} field`,
                {
                  keys: [key],
                },
              );
              r.sound = false;
            } else if (seen.set.has(key)) {
              pr.add('conflicting_effects', at, `"${key}" is set twice in ${branch}`, {
                keys: [key],
              });
              r.sound = false;
            } else {
              seen.set.add(key);
              note(deciders.set, key, r);
            }
          } else if (e.k !== 'require' && e.k !== 'validate') {
            const group = e.k === 'show' || e.k === 'hide' ? 'visibility' : 'enablement';
            const before = seen[group].get(key);
            if (before && before !== e.k) {
              pr.add(
                'conflicting_effects',
                at,
                `"${key}" is both ${done[before]} and ${done[e.k]} in ${branch}`,
                {
                  keys: [key],
                },
              );
              r.sound = false;
            }
            seen[group].set(key, e.k);
            note(deciders[group], key, r);
          }
        }
      }
    }
  }
  pr.rule = undefined;
  for (const [group, map] of Object.entries(deciders)) {
    for (const [key, list] of map) {
      if (list.length < 2) continue;
      const ids = list.map((r) => r.id!).sort(byCodeUnits);
      const what =
        group === 'visibility'
          ? 'shows or hides'
          : group === 'enablement'
            ? 'enables or disables'
            : 'sets';
      for (const r of list) {
        r.sound = false;
        pr.add(
          'conflicting_rules',
          r.path,
          `only one rule ${what} a field; "${key}" is decided by ${ids.join(' and ')}`,
          { rule: r.id!, keys: [key] },
        );
      }
    }
  }

  // Graph and evaluation order.
  const isFormula = (key: string) => fields.get(key)?.kind === 'formula';
  const setterU = new Map<string, URule>();
  for (const [key, list] of deciders.set) if (list.length === 1) setterU.set(key, list[0]!);
  const graph = buildGraph(
    parsed.filter((r) => r.id && byId.get(r.id) === r),
    setterU,
    isFormula,
  );
  for (const c of graph.cycles) {
    const first = setterU.get(c.keys[0]!);
    pr.add(
      'cycle',
      first ? first.path : '',
      `the values of ${c.keys.map((k) => `"${k}"`).join(', ')} depend on each other (I14)`,
      { keys: c.keys, ...(c.rules.length === 1 ? { rule: c.rules[0]! } : {}) },
    );
    for (const id of c.rules) {
      const r = byId.get(id);
      if (r) r.sound = false;
    }
  }

  // Types, formulas first, in dependency order.
  const formulaTypes = new Map<string, 'decimal' | 'string' | 'null'>();
  const tenv: TypeEnv = { fields, roles: env.roles ? new Set(env.roles) : null, formulaTypes, pr };
  const typedWhen = new Map<URule, Expr | null>();
  const whenOf = (r: URule): Expr | null => {
    if (!typedWhen.has(r)) {
      pr.rule = r.id ?? undefined;
      const e = r.when ? expect(r.when, 'boolean', tenv, 'a condition is a boolean') : null;
      typedWhen.set(r, e);
      if (!e) r.sound = false;
    }
    return typedWhen.get(r)!;
  };
  const typedSets = new Map<UEffect, Expr | null>();
  const typeSet = (r: URule, e: UEffect & { k: 'set' }): Expr | null => {
    pr.rule = r.id ?? undefined;
    const t = infer(e.value, tenv);
    let out: Expr | null = null;
    if (t) {
      if (isPending(t)) out = literalAs(t, 'string', tenv);
      else if (t.ty === 'decimal' || t.ty === 'string') out = t;
      else
        pr.add(
          'type_mismatch',
          pointer(pointer(e.path, 'set'), 'value'),
          `a formula yields a decimal or a string, not a ${t.ty}`,
        );
    }
    if (!out) r.sound = false;
    typedSets.set(e, out);
    return out;
  };
  const cyclic = new Set(graph.cycles.flatMap((c) => c.keys));
  const typeFormula = (key: string) => {
    const r = setterU.get(key);
    if (!r || cyclic.has(key)) return;
    whenOf(r);
    let ty: 'decimal' | 'string' | null = null;
    for (const e of [...r.then, ...r.else]) {
      if (e.k !== 'set' || e.key !== key) continue;
      const t = typeSet(r, e);
      if (!t) continue;
      const tt = t.ty as 'decimal' | 'string';
      if (ty && ty !== tt) {
        pr.add(
          'type_mismatch',
          e.path,
          `"${key}" is a ${ty} in one branch and a ${tt} in the other`,
          { keys: [key] },
        );
        r.sound = false;
      }
      ty ??= tt;
    }
    if (ty) formulaTypes.set(key, ty);
  };
  for (const key of graph.order) typeFormula(key);
  for (const r of parsed) whenOf(r);
  pr.rule = undefined;

  if (pr.list.length) return { ok: false, problems: pr.list };

  // Every rule is sound: build the compiled set.
  const compiled = new Map<URule, CompiledRule>();
  const effectOut = (r: URule, e: UEffect): Effect =>
    e.k === 'set' ? { k: 'set', key: e.key, value: typedSets.get(e)!, path: e.path } : e;
  // With no problem left, every set effect targets a formula with one setter outside any cycle,
  // so the formula pass above typed it.
  for (const r of parsed)
    compiled.set(r, {
      id: r.id!,
      path: r.path,
      when: typedWhen.get(r)!,
      then: r.then.map((e) => effectOut(r, e)),
      else: r.else.map((e) => effectOut(r, e)),
    });

  const rules = [...compiled.values()].sort((a, b) => byCodeUnits(a.id, b.id));
  const one = (map: Map<string, URule[]>) => {
    const out = new Map<string, CompiledRule>();
    for (const [key, list] of map) out.set(key, compiled.get(list[0]!)!);
    return out;
  };
  const many = (effect: KeyEffect) => {
    const out = new Map<string, CompiledRule[]>();
    for (const r of rules)
      for (const e of [...r.then, ...r.else])
        if (e.k === effect)
          for (const key of e.keys) {
            const list = out.get(key) ?? [];
            if (!list.includes(r)) list.push(r);
            out.set(key, list);
          }
    return out;
  };
  let maxSteps = 0;
  for (const r of rules) {
    maxSteps += nodeCount(r.when);
    for (const e of [...r.then, ...r.else]) if (e.k === 'set') maxSteps += nodeCount(e.value);
  }
  for (const key of fieldOrder)
    if (isFormula(key) && !formulaTypes.has(key)) formulaTypes.set(key, 'null');
  return {
    ok: true,
    problems: [],
    ruleSet: {
      rules,
      fields,
      fieldOrder,
      formulaOrder: graph.order,
      formulaTypes,
      setter: one(deciders.set),
      visibility: one(deciders.visibility),
      enablement: one(deciders.enablement),
      requires: many('require'),
      validates: many('validate'),
      ruleNeeds: graph.ruleNeeds,
      formulaNeeds: graph.formulaNeeds,
      maxSteps,
    },
  };
}

/** Checks one expression on its own (formula fields have no rules here, so their type is null). */
export function compileExpression(
  json: unknown,
  env: CompileEnvironment,
  path = '',
): { ok: true; expr: Expr } | { ok: false; problems: RuleProblem[] } {
  const pr = new Problems();
  const fields = new Map<string, FieldInfo>();
  for (const f of env.fields) if (!fields.has(f.key)) fields.set(f.key, f);
  let expr: Expr | null = null;
  if (boundsOk(json as JsonValue, path, pr)) {
    const u = parseExpr(json as JsonValue, path, pr);
    if (u) {
      const t = infer(u, {
        fields,
        roles: env.roles ? new Set(env.roles) : null,
        formulaTypes: new Map(),
        pr,
      });
      if (t)
        expr = isPending(t)
          ? literalAs(t, 'string', { fields, roles: null, formulaTypes: new Map(), pr })
          : t;
    }
  }
  return expr && !pr.list.length ? { ok: true, expr } : { ok: false, problems: pr.list };
}

/** Rule inputs from a plain list of `rule_def` attributes; paths are `/0`, `/1`, ... */
export const rulesFromList = (list: readonly unknown[]): RuleInput[] =>
  list.map((attrs, i) => ({ attrs, path: `/${i}` }));
