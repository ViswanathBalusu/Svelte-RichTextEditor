/**
 * The rules fixtures and their runner (12 §5.2, §10 profile `rules`; 05 §9, §11; FRW-020). A case
 * gives inputs (an expression or a rule set, field definitions and values, roles, the date and
 * time zone, a pattern and a value) and the expected result. Results are compared as canonical
 * JSON, with problem lists compared as sets of `{ code, path, construct, keys }`: messages are for
 * people and are not part of the contract.
 *
 * A backend in another language can run the published file (spec/rules/) with its own adapter;
 * the runner reports every failing case by identifier.
 */
import { canonicalize, type JsonValue } from '@docedit/model';
import {
  type EvaluationContext,
  encodeValue,
  evaluateExpression,
  evaluateRules,
} from './evaluate.ts';
import type { FieldInfo } from './fields.ts';
import { byCodeUnits } from './json.ts';
import { type RuleProblem, compileRules, rulesFromList } from './language.ts';
import { compilePattern, matchPattern } from './pattern.ts';
import { validateFields } from './validate.ts';

/** The conformance profile and the feature it maps to (12 §10). */
export const PROFILE = { profile: 'rules', feature: 'rules' } as const;

export type FixtureCategory =
  'operators' | 'decimal' | 'dates' | 'patterns' | 'rules' | 'invalid' | 'values';

export interface FixtureGiven {
  fields?: FieldInfo[];
  values?: Record<string, JsonValue>;
  /** The document's `role_def` identifiers; role operands are checked against them. */
  roleDefs?: string[];
  /** The evaluating participant's roles, or the preview's. */
  roles?: string[];
  /** The server's instant and the workflow's time zone. */
  now?: { instant: string; timeZone: string } | null;
}

export interface ProblemExpect {
  code: string;
  path: string;
  construct?: string;
  keys?: string[];
}

export interface StateExpect {
  visible: boolean;
  enabled: boolean;
  required: boolean;
  messages?: Array<{ rule: string; message: string }>;
  value?: string | null;
  error?: string;
  by?: { visible?: string; enabled?: string; required?: string[]; value?: string };
}

interface CaseBase {
  id: string;
  category: FixtureCategory;
  /** The operators, operands and effects the case exercises; the coverage check reads it. */
  covers: string[];
  /** `null` marks a row with a null operand; `type` a row with an operand of a wrong type. */
  tags?: string[];
  description?: string;
  given?: FixtureGiven;
}

export interface ExpressionCase extends CaseBase {
  kind: 'expression';
  expression: JsonValue;
  expect:
    | { type: string; value: JsonValue }
    | { type: string; error: string }
    | { problems: ProblemExpect[] };
}

export interface RulesCase extends CaseBase {
  kind: 'rules';
  rules: JsonValue[];
  expect:
    | { fields: Record<string, StateExpect>; rules: Record<string, string> }
    | { problems: ProblemExpect[] };
}

export interface PatternCase extends CaseBase {
  kind: 'pattern';
  pattern: string;
  input?: string;
  expect: { matches: boolean } | { problems: ProblemExpect[] };
}

export interface ValueCase extends CaseBase {
  kind: 'value';
  /** One field (given.fields[0]) and the entry checked against it, without rules. */
  value: JsonValue;
  expect: { problems: string[] };
}

export type FixtureCase = ExpressionCase | RulesCase | PatternCase | ValueCase;

export interface FixtureSet {
  rules: string;
  cases: readonly FixtureCase[];
}

const problemsOut = (ps: readonly RuleProblem[]): ProblemExpect[] =>
  ps
    .map((p) => {
      const o: ProblemExpect = { code: p.code, path: p.path };
      if (p.construct !== undefined) o.construct = p.construct;
      if (p.keys !== undefined) o.keys = p.keys;
      return o;
    })
    .sort((a, b) => byCodeUnits(canonicalize(a), canonicalize(b)));

const contextOf = (g: FixtureGiven = {}): EvaluationContext => ({
  roles: g.roles ?? [],
  now: g.now ?? null,
});

const envOf = (g: FixtureGiven = {}) => ({
  fields: g.fields ?? [],
  ...(g.roleDefs ? { roles: g.roleDefs } : {}),
});

/** What this package gives for a case, in the shape of the case's `expect`. */
export function runCase(c: FixtureCase): unknown {
  switch (c.kind) {
    case 'expression': {
      const r = evaluateExpression(c.expression, {
        ...envOf(c.given),
        values: c.given?.values ?? {},
        context: contextOf(c.given),
      });
      if (r.ok) return r.result;
      return 'problems' in r ? { problems: problemsOut(r.problems) } : { error: r.code };
    }
    case 'rules': {
      const compiled = compileRules(rulesFromList(c.rules), envOf(c.given));
      if (!compiled.ok) return { problems: problemsOut(compiled.problems) };
      const ev = evaluateRules(compiled.ruleSet, c.given?.values ?? {}, contextOf(c.given));
      if (!ev.ok) return { error: ev.code };
      const fields: Record<string, StateExpect> = {};
      for (const s of ev.fields) {
        const o: StateExpect = { visible: s.visible, enabled: s.enabled, required: s.required };
        if (s.messages.length) o.messages = s.messages;
        if ('value' in s) o.value = s.value ?? null;
        if (s.error !== undefined) o.error = s.error;
        const by = Object.fromEntries(Object.entries(s.by).filter(([, v]) => v !== undefined));
        if (Object.keys(by).length) o.by = by;
        fields[s.key] = o;
      }
      const rules: Record<string, string> = {};
      for (const r of ev.rules)
        rules[r.id] = typeof r.outcome === 'string' ? r.outcome : `error:${r.outcome.error}`;
      return { fields, rules };
    }
    case 'pattern': {
      const p = compilePattern(c.pattern);
      if (!p.ok)
        return { problems: [{ code: p.problem.code, path: '', construct: p.problem.construct }] };
      return { matches: matchPattern(p.pattern, c.input ?? '').matched };
    }
    case 'value': {
      const field = c.given?.fields?.[0];
      if (!field) return { problems: ['no field given'] };
      const reports = validateFields([field], { [field.key]: c.value });
      return { problems: (reports[0]?.problems ?? []).map((p) => p.code) };
    }
  }
}

/** The expectation in its compared form (problem lists as sorted sets). */
function expectedOf(c: FixtureCase): unknown {
  const e = c.expect as Record<string, unknown>;
  if (c.kind !== 'value' && Array.isArray(e['problems']))
    return {
      problems: [...(e['problems'] as ProblemExpect[])].sort((a, b) =>
        byCodeUnits(canonicalize(a), canonicalize(b)),
      ),
    };
  return e;
}

export interface ConformanceReport {
  profile: typeof PROFILE.profile;
  feature: typeof PROFILE.feature;
  rules: string;
  passed: string[];
  failed: Array<{ id: string; expected: unknown; actual: unknown }>;
}

/**
 * Runs every case through `run` (this package by default, or a candidate backend's adapter) and
 * reports each failing case by identifier.
 */
export function runFixtures(
  set: FixtureSet,
  run: (c: FixtureCase) => unknown = runCase,
): ConformanceReport {
  const report: ConformanceReport = { ...PROFILE, rules: set.rules, passed: [], failed: [] };
  for (const c of set.cases) {
    let actual: unknown;
    try {
      actual = run(c);
    } catch (e) {
      actual = { exception: (e as Error).message };
    }
    const expected = expectedOf(c);
    if (canonicalize(actual) === canonicalize(expected)) report.passed.push(c.id);
    else report.failed.push({ id: c.id, expected, actual });
  }
  return report;
}

export { encodeValue };
