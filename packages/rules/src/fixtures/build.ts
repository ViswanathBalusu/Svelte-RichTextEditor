/**
 * Builders that keep the fixture sources short. The published file (spec/rules/) holds the
 * expanded cases; these helpers exist only on the authoring side.
 */
import type { JsonValue } from '@docedit/model';
import type {
  ExpressionCase,
  FixtureCategory,
  FixtureGiven,
  PatternCase,
  ProblemExpect,
  RulesCase,
  StateExpect,
  ValueCase,
} from '../conformance.ts';
import type { FieldInfo } from '../fields.ts';

export const text = (key: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({
  key,
  kind: 'text',
  ...extra,
});
export const num = (key: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({
  key,
  kind: 'number',
  ...extra,
});
export const date = (key: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({
  key,
  kind: 'date',
  ...extra,
});
export const check = (key: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({
  key,
  kind: 'checkbox',
  ...extra,
});
export const choice = (
  key: string,
  options: string[],
  extra: Partial<FieldInfo> = {},
): FieldInfo => ({
  key,
  kind: 'choice',
  options,
  ...extra,
});
export const formula = (key: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({
  key,
  kind: 'formula',
  ...extra,
});
export const sig = (key: string): FieldInfo => ({ key, kind: 'signature' });

export const f = (key: string): JsonValue => ({ field: key });

export const dec = (value: string | null) => ({ type: 'decimal', value });
export const bool = (value: boolean | null) => ({ type: 'boolean', value });
export const str = (value: string | null) => ({ type: 'string', value });
export const day = (value: string | null) => ({ type: 'date', value });
export const err = (type: string, error: string) => ({ type, error });
export const problems = (...list: ProblemExpect[]) => ({ problems: list });
export const p = (
  code: string,
  path: string,
  more: Partial<ProblemExpect> = {},
): ProblemExpect => ({
  code,
  path,
  ...more,
});

export function expr(
  category: FixtureCategory,
  id: string,
  covers: string[],
  expression: JsonValue,
  expect: ExpressionCase['expect'],
  given: FixtureGiven = {},
  tags?: string[],
): ExpressionCase {
  const c: ExpressionCase = { id, category, kind: 'expression', covers, given, expression, expect };
  if (tags) c.tags = tags;
  return c;
}

type Rest<F> = F extends (first: never, ...rest: infer R) => unknown ? R : never;

/** `expr` with its category fixed. */
export const expressionsOf =
  (category: FixtureCategory) =>
  (...a: Rest<typeof expr>): ExpressionCase =>
    expr(category, ...a);

export function rules(
  category: FixtureCategory,
  id: string,
  covers: string[],
  list: JsonValue[],
  expect: RulesCase['expect'],
  given: FixtureGiven = {},
  description?: string,
): RulesCase {
  const c: RulesCase = { id, category, kind: 'rules', covers, given, rules: list, expect };
  if (description) c.description = description;
  return c;
}

export function pattern(
  id: string,
  source: string,
  input: string | undefined,
  expect: PatternCase['expect'],
  tags?: string[],
): PatternCase {
  const c: PatternCase = {
    id,
    category: 'patterns',
    kind: 'pattern',
    covers: ['matches'],
    pattern: source,
    expect,
  };
  if (input !== undefined) c.input = input;
  if (tags) c.tags = tags;
  return c;
}

export function value(
  id: string,
  field: FieldInfo,
  v: JsonValue,
  codes: string[],
  covers: string[] = [],
): ValueCase {
  return {
    id,
    category: 'values',
    kind: 'value',
    covers,
    given: { fields: [field] },
    value: v,
    expect: { problems: codes },
  };
}

/** A field state as the runner reports it. */
export function st(
  visible: boolean,
  enabled: boolean,
  required: boolean,
  more: Partial<StateExpect> = {},
): StateExpect {
  return { visible, enabled, required, ...more };
}
