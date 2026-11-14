/**
 * Evaluation (12 §5.2, §5.3; ADR 0030 §1, §7): one pass in dependency order. Each formula is
 * computed once, after everything it reads; each rule's condition is evaluated at most once; the
 * result does not depend on the order rules are stored in, because rules are sorted by identifier
 * and every node is a pure function of field values, the participant's roles and the date.
 *
 * Errors are values, never exceptions: a division by zero gives the error `division_by_zero`,
 * which propagates through every operator that reads it. Null is the empty value and follows the
 * per-operator table of ADR 0030 §1. Booleans are never inferred from other types.
 */
import type { JsonValue } from '@docedit/model';
import { calendarDateIn, formatDate, parseDate } from './dates.ts';
import {
  type Decimal,
  add,
  compare,
  divide,
  formatDecimal,
  isDecimalError,
  multiply,
  negate,
  parseDecimal,
  round,
  subtract,
} from './decimal.ts';
import { type FieldInfo, checkFieldValue } from './fields.ts';
import { byCodeUnits, utf8Length } from './json.ts';
import {
  type CompiledRule,
  type CompileEnvironment,
  type Effect,
  type Expr,
  type RuleProblem,
  type RuleSet,
  type RuntimeError,
  type Type,
  type Value,
  compileExpression,
} from './language.ts';
import { LIMITS } from './limits.ts';
import { matchPattern } from './pattern.ts';

export interface EvaluationContext {
  /**
   * The evaluating participant's roles. For an author's preview, the roles chosen for the preview;
   * an empty list when nobody is filling (12 §5.1).
   */
  roles: readonly string[];
  /**
   * The current instant, from the server's clock, and the workflow's time zone (12 §5.1). Needed
   * only by `{ "now": "date" }`; without it that operand is the error `no_clock`.
   */
  now?: { instant: string; timeZone: string } | null;
  /** Stops with `budget_exceeded` after this many steps (admission control, 04 §12). */
  budget?: number;
}

export type ValueMap = Readonly<Record<string, JsonValue | undefined>>;

export interface FieldState {
  key: string;
  /** The node identifier, when the fields came from a document. */
  id?: string | null;
  visible: boolean;
  enabled: boolean;
  /** Static `required` or a `require` effect; never true for a hidden field. */
  required: boolean;
  /** The messages of the `validate` effects that apply, by rule identifier; none for a hidden field. */
  messages: Array<{ rule: string; message: string }>;
  /** Formula fields: the computed value as a decimal string or a string, or null. */
  value?: string | null;
  /** Formula fields: the error that left the value null. */
  error?: RuntimeError;
  /** The rules behind each property, so that a rejection can name the rule (12 §5.3). */
  by: { visible?: string; enabled?: string; required?: string[]; value?: string };
}

export type RuleOutcome = 'then' | 'else' | { error: RuntimeError };

export type Evaluation =
  | {
      ok: true;
      /** In field order; only the requested fields when `keys` was given. */
      fields: FieldState[];
      /** The rules that were evaluated, by identifier. */
      rules: Array<{ id: string; outcome: RuleOutcome }>;
      steps: number;
    }
  | { ok: false; code: 'budget_exceeded'; steps: number };

class BudgetExceeded extends Error {}

/** Reads a stored value as the type of its kind; formulas are computed, never read. */
function readStored(f: FieldInfo, raw: JsonValue | undefined): Value {
  if (raw === null || raw === undefined) return null;
  if (checkFieldValue(f, raw) !== null) return { t: 'error', code: 'invalid_value' };
  switch (f.kind) {
    case 'text':
    case 'choice':
      return { t: 'string', v: raw as string };
    case 'number':
      return { t: 'decimal', v: parseDecimal(raw as string)! };
    case 'date':
    case 'dateSigned':
      return { t: 'date', v: parseDate(raw as string)! };
    case 'checkbox':
      return { t: 'boolean', v: raw as boolean };
    case 'signature':
    case 'initials':
      return { t: 'signature' };
    default:
      return null;
  }
}

const isError = (v: Value): v is { t: 'error'; code: RuntimeError } =>
  v !== null && v.t === 'error';
const bool = (v: boolean): Value => ({ t: 'boolean', v });
const decimalValue = (r: ReturnType<typeof add>): Value =>
  isDecimalError(r) ? { t: 'error', code: r } : { t: 'decimal', v: r };

/** Strict equality of two non-error values of one type; null equals only null. */
function equal(a: Value, b: Value): boolean {
  if (a === null || b === null) return a === b;
  switch (a.t) {
    case 'boolean':
    case 'string':
    case 'date':
      return b.t === a.t && b.v === a.v;
    case 'decimal':
      return b.t === 'decimal' && compare(a.v, b.v) === 0;
    default:
      return false;
  }
}

function order(a: Value, b: Value): number {
  if (a !== null && b !== null) {
    if (a.t === 'decimal' && b.t === 'decimal') return compare(a.v, b.v);
    if (a.t === 'date' && b.t === 'date') return a.v - b.v;
  }
  return 0;
}

class Evaluator {
  steps = 0;
  private readonly budget: number;
  private readonly stored = new Map<string, Value>();
  readonly computed = new Map<string, Value>();
  readonly outcomes = new Map<string, RuleOutcome>();
  private today: Value | undefined;
  private readonly rs: Pick<RuleSet, 'fields'>;
  private readonly values: ValueMap;
  private readonly ctx: EvaluationContext;

  constructor(rs: Pick<RuleSet, 'fields'>, values: ValueMap, ctx: EvaluationContext) {
    this.rs = rs;
    this.values = values;
    this.ctx = ctx;
    this.budget = ctx.budget ?? Infinity;
  }

  private tick(n = 1): void {
    this.steps += n;
    if (this.steps > this.budget) throw new BudgetExceeded();
  }

  private field(e: Expr & { k: 'field' }): Value {
    if (e.kind === 'formula') return this.computed.get(e.key) ?? null;
    let v = this.stored.get(e.key);
    if (v === undefined) {
      v = readStored(this.rs.fields.get(e.key)!, this.values[e.key]);
      this.stored.set(e.key, v);
    }
    return v;
  }

  private now(): Value {
    if (this.today === undefined) {
      const clock = this.ctx.now;
      const date = clock ? calendarDateIn(clock.instant, clock.timeZone) : null;
      this.today =
        date === null ? { t: 'error', code: 'no_clock' } : { t: 'date', v: parseDate(date)! };
    }
    return this.today;
  }

  /** Evaluates every operand left to right; returns the first error, or the values. */
  private all(args: readonly Expr[]): Value[] | Value {
    const out: Value[] = [];
    for (const a of args) {
      const v = this.ev(a);
      if (isError(v)) return v;
      out.push(v);
    }
    return out;
  }

  ev(e: Expr): Value {
    this.tick();
    switch (e.k) {
      case 'lit':
        return e.v;
      case 'field':
        return this.field(e);
      case 'role':
        return bool(this.ctx.roles.includes(e.role));
      case 'now':
        return this.now();
      case 'op':
        return this.op(e);
    }
  }

  private op(e: Expr & { k: 'op' }): Value {
    const { args } = e;
    switch (e.op) {
      case '==':
      case '!=': {
        const r = this.all(args);
        if (!Array.isArray(r)) return r;
        const same = equal(r[0]!, r[1]!);
        return bool(e.op === '==' ? same : !same);
      }
      case '<':
      case '<=':
      case '>':
      case '>=': {
        const r = this.all(args);
        if (!Array.isArray(r)) return r;
        const [a, b] = r as [Value, Value];
        if (a === null || b === null) return null;
        const c = order(a, b);
        return bool(e.op === '<' ? c < 0 : e.op === '<=' ? c <= 0 : e.op === '>' ? c > 0 : c >= 0);
      }
      case 'and':
      case 'or': {
        // Kleene logic, left to right: `and` stops at the first false, `or` at the first true.
        const stop = e.op === 'or';
        let unknown = false;
        for (const a of args) {
          const v = this.ev(a);
          if (isError(v)) return v;
          if (v === null) unknown = true;
          else if (v.t === 'boolean' && v.v === stop) return bool(stop);
        }
        return unknown ? null : bool(!stop);
      }
      case 'not': {
        const v = this.ev(args[0]!);
        if (v === null || isError(v)) return v;
        return bool(!(v as { v: boolean }).v);
      }
      case 'in': {
        const v = this.ev(args[0]!);
        if (isError(v)) return v;
        if (v === null) return bool(false);
        this.tick(e.list!.length);
        return bool(e.list!.some((item) => equal(v, item)));
      }
      case 'empty': {
        const v = this.ev(args[0]!);
        if (isError(v)) return v;
        if (v === null) return bool(true);
        if (v.t === 'string') return bool(v.v === '');
        if (v.t === 'boolean') return bool(!v.v);
        return bool(false);
      }
      case 'matches': {
        const v = this.ev(args[0]!);
        if (v === null || isError(v)) return v;
        const r = matchPattern(e.pattern!, (v as { v: string }).v);
        this.tick(r.steps);
        return bool(r.matched);
      }
      case '+':
      case '*':
      case '/':
      case '-': {
        const r = this.all(args);
        if (!Array.isArray(r)) return r;
        if (r.some((v) => v === null)) return null;
        const ds = r.map((v) => (v as { v: Decimal }).v);
        if (e.op === '-')
          return decimalValue(ds.length === 1 ? negate(ds[0]!) : subtract(ds[0]!, ds[1]!));
        if (e.op === '/') return decimalValue(divide(ds[0]!, ds[1]!));
        const f = e.op === '+' ? add : multiply;
        let acc: Decimal = ds[0]!;
        for (let i = 1; i < ds.length; i++) {
          const next = f(acc, ds[i]!);
          if (isDecimalError(next)) return { t: 'error', code: next };
          acc = next;
        }
        return { t: 'decimal', v: acc };
      }
      case 'round': {
        const v = this.ev(args[0]!);
        if (v === null || isError(v)) return v;
        return decimalValue(round((v as { v: Decimal }).v, e.places!));
      }
      case 'sum': {
        const r = this.all(args);
        if (!Array.isArray(r)) return r;
        const ds = r.filter((v) => v !== null).map((v) => (v as { v: Decimal }).v);
        if (!ds.length) return null;
        let acc: Decimal = ds[0]!;
        for (let i = 1; i < ds.length; i++) {
          const next = add(acc, ds[i]!);
          if (isDecimalError(next)) return { t: 'error', code: next };
          acc = next;
        }
        // Adding zero applies the bounds of a result to a single operand too.
        return decimalValue(add(acc, { c: 0n, s: 0 }));
      }
      case 'min':
      case 'max': {
        const r = this.all(args);
        if (!Array.isArray(r)) return r;
        const present = r.filter((v) => v !== null);
        if (!present.length) return null;
        let best = present[0]!;
        for (const v of present.slice(1)) {
          const c = order(v, best);
          if (e.op === 'min' ? c < 0 : c > 0) best = v;
        }
        return best;
      }
      case 'concat': {
        const r = this.all(args);
        if (!Array.isArray(r)) return r;
        const parts = r.filter((v) => v !== null).map((v) => (v as { v: string }).v);
        if (!parts.length) return null;
        const s = parts.join('');
        if (utf8Length(s) > LIMITS.valueBytes) return { t: 'error', code: 'too_long' };
        return { t: 'string', v: s };
      }
      case 'if': {
        const c = this.ev(args[0]!);
        if (isError(c)) return c;
        return this.ev(c !== null && (c as { v: boolean }).v === true ? args[1]! : args[2]!);
      }
    }
  }

  outcome(r: CompiledRule): RuleOutcome {
    let o = this.outcomes.get(r.id);
    if (o === undefined) {
      const v = this.ev(r.when);
      // A condition that is true applies `then`; false or null (unknown) applies `else`.
      o = isError(v) ? { error: v.code } : v !== null && v.t === 'boolean' && v.v ? 'then' : 'else';
      this.outcomes.set(r.id, o);
    }
    return o;
  }

  /** The effects of the branch a rule applies; none when its condition failed. */
  branch(r: CompiledRule): readonly Effect[] {
    const o = this.outcome(r);
    return o === 'then' ? r.then : o === 'else' ? r.else : [];
  }
}

/** The formulas and rules needed for the states of `keys`, in evaluation order. */
function needed(
  rs: RuleSet,
  keys: readonly string[],
): { formulas: Set<string>; rules: Set<string> } {
  const formulas = new Set<string>();
  const rules = new Set<string>();
  const addRule = (r: CompiledRule | undefined) => {
    if (!r || rules.has(r.id)) return;
    rules.add(r.id);
    for (const k of rs.ruleNeeds.get(r.id) ?? []) addFormula(k);
  };
  const addFormula = (k: string) => {
    if (formulas.has(k)) return;
    formulas.add(k);
    addRule(rs.setter.get(k));
    for (const d of rs.formulaNeeds.get(k) ?? []) addFormula(d);
  };
  for (const key of keys) {
    addRule(rs.visibility.get(key));
    addRule(rs.enablement.get(key));
    for (const r of rs.requires.get(key) ?? []) addRule(r);
    for (const r of rs.validates.get(key) ?? []) addRule(r);
    if (rs.fields.get(key)?.kind === 'formula') addFormula(key);
  }
  return { formulas, rules };
}

/**
 * Evaluates a compiled rule set for the given field values (12 §5.3): the visibility, enablement,
 * requirement and `validate` messages of every field, and the value of every formula. With `keys`,
 * only what those fields' states depend on is evaluated, which is what the authority's fill check
 * needs (12 §4.2: "the rules that depend on the field").
 */
export function evaluateRules(
  rs: RuleSet,
  values: ValueMap,
  ctx: EvaluationContext,
  options: { keys?: readonly string[] } = {},
): Evaluation {
  const ev = new Evaluator(rs, values, ctx);
  const keys = options.keys ? options.keys.filter((k) => rs.fields.has(k)) : rs.fieldOrder;
  const need = options.keys ? needed(rs, keys) : null;
  try {
    for (const key of rs.formulaOrder) {
      if (need && !need.formulas.has(key)) continue;
      const r = rs.setter.get(key);
      if (!r) continue;
      const o = ev.outcome(r);
      if (typeof o === 'object') {
        ev.computed.set(key, { t: 'error', code: o.error });
        continue;
      }
      const set = (o === 'then' ? r.then : r.else).find((e) => e.k === 'set' && e.key === key);
      ev.computed.set(key, set && set.k === 'set' ? ev.ev(set.value) : null);
    }
    for (const r of rs.rules) if (!need || need.rules.has(r.id)) ev.outcome(r);
    const fields = keys.map((key) => state(rs, ev, key));
    const rules = [...ev.outcomes.entries()]
      .sort((a, b) => byCodeUnits(a[0], b[0]))
      .map(([id, outcome]) => ({ id, outcome }));
    return { ok: true, fields, rules, steps: ev.steps };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { ok: false, code: 'budget_exceeded', steps: ev.steps };
    throw e;
  }
}

function state(rs: RuleSet, ev: Evaluator, key: string): FieldState {
  const f = rs.fields.get(key)!;
  const st: FieldState = {
    key,
    visible: true,
    enabled: !f.readOnly,
    required: f.required === true,
    messages: [],
    by: {},
  };
  if (f.id !== undefined) st.id = f.id;
  const vr = rs.visibility.get(key);
  if (vr)
    for (const e of ev.branch(vr))
      if ((e.k === 'show' || e.k === 'hide') && e.keys.includes(key)) {
        st.visible = e.k === 'show';
        st.by.visible = vr.id;
      }
  const er = rs.enablement.get(key);
  if (er)
    for (const e of ev.branch(er))
      if ((e.k === 'enable' || e.k === 'disable') && e.keys.includes(key)) {
        // Static readOnly cannot be lifted by a rule (12 §3.2: rules can also disable a field).
        st.enabled = e.k === 'enable' && !f.readOnly;
        st.by.enabled = er.id;
      }
  for (const r of rs.requires.get(key) ?? [])
    if (ev.branch(r).some((e) => e.k === 'require' && e.keys.includes(key))) {
      st.required = true;
      (st.by.required ??= []).push(r.id);
    }
  for (const r of rs.validates.get(key) ?? [])
    for (const e of ev.branch(r))
      if (e.k === 'validate' && e.keys.includes(key))
        st.messages.push({ rule: r.id, message: e.message });
  if (f.kind === 'formula') {
    const v = ev.computed.get(key) ?? null;
    st.value = null;
    if (v !== null && v.t === 'error') st.error = v.code;
    else if (v !== null && v.t === 'decimal') st.value = formatDecimal(v.v);
    else if (v !== null && v.t === 'string') st.value = v.v;
    const setter = rs.setter.get(key);
    if (setter) st.by.value = setter.id;
  }
  if (!st.visible) {
    st.required = false;
    st.messages = [];
    delete st.by.required;
  }
  return st;
}

/** A value as the fixtures write it: its static type, and its value or error. */
export type EncodedValue = { type: Type; value: JsonValue } | { type: Type; error: RuntimeError };

export function encodeValue(ty: Type, v: Value): EncodedValue {
  if (v === null) return { type: ty, value: null };
  switch (v.t) {
    case 'error':
      return { type: ty, error: v.code };
    case 'decimal':
      return { type: ty, value: formatDecimal(v.v) };
    case 'date':
      return { type: ty, value: formatDate(v.v) };
    case 'signature':
      return { type: ty, value: 'present' };
    default:
      return { type: ty, value: v.v };
  }
}

/** Checks and evaluates one expression on its own: the rule builder's preview, and the fixtures. */
export function evaluateExpression(
  json: unknown,
  env: CompileEnvironment & { values?: ValueMap; context?: EvaluationContext },
):
  | { ok: true; result: EncodedValue; steps: number }
  | { ok: false; problems: RuleProblem[] }
  | { ok: false; code: 'budget_exceeded'; steps: number } {
  const c = compileExpression(json, env);
  if (!c.ok) return c;
  const fields = new Map(env.fields.map((f) => [f.key, f] as const));
  const ev = new Evaluator({ fields }, env.values ?? {}, env.context ?? { roles: [] });
  try {
    const v = ev.ev(c.expr);
    return { ok: true, result: encodeValue(c.expr.ty, v), steps: ev.steps };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { ok: false, code: 'budget_exceeded', steps: ev.steps };
    throw e;
  }
}
