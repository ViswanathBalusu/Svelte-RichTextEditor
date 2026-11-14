// The semantics of ADR 0030 that FRW-016 and FRW-017 name, checked directly. Runs in Node.js and
// in Chromium, Firefox and WebKit, so the editor and the authority give the same answers.
import { describe, expect, it } from 'vitest';
import { evaluateExpression, evaluateRules } from './evaluate.ts';
import type { FieldInfo } from './fields.ts';
import { compileExpression, compileRules, rulesFromList } from './language.ts';

const FIELDS: FieldInfo[] = [
  { key: 't', kind: 'text' },
  { key: 'n', kind: 'number' },
  { key: 'd', kind: 'date' },
  { key: 'c', kind: 'checkbox' },
  { key: 'c2', kind: 'checkbox' },
  { key: 'status', kind: 'choice', options: ['single', 'married', 'partnered'] },
  { key: 'fx', kind: 'formula' },
];

const value = (expression: unknown, values: Record<string, unknown> = {}, context = {}) => {
  const r = evaluateExpression(expression, {
    fields: FIELDS,
    values: values as never,
    context: { roles: [], ...context },
  });
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.result;
};

const problemCodes = (expression: unknown): string[] => {
  const r = compileExpression(expression, { fields: FIELDS });
  return r.ok ? [] : r.problems.map((p) => p.code);
};

describe('strict typed comparison (FRW-016)', () => {
  it('never converts between types: the string "5" and the decimal 5 do not compare', () => {
    const typed = { t: { field: 't' }, n: { field: 'n' }, d: { field: 'd' }, c: { field: 'c' } };
    for (const [a, ea] of Object.entries(typed))
      for (const [b, eb] of Object.entries(typed)) {
        if (a === b) continue;
        for (const op of ['==', '!=', '<', '<=', '>', '>='])
          expect(problemCodes({ [op]: [ea, eb] }), `${a} ${op} ${b}`).toEqual(['type_mismatch']);
      }
    // Two string literals are strings; the decimal reading happens only where a decimal is needed.
    expect(value({ '==': ['5', '5.0'] })).toEqual({ type: 'boolean', value: false });
    expect(value({ '==': [{ field: 'n' }, '5.0'] }, { n: '5' })).toEqual({
      type: 'boolean',
      value: true,
    });
    expect(value({ '==': [{ field: 't' }, '5.0'] }, { t: '5' })).toEqual({
      type: 'boolean',
      value: false,
    });
  });

  it('gives the null rows of the semantics table for every comparison', () => {
    for (const op of ['<', '<=', '>', '>='])
      expect(value({ [op]: [{ field: 'n' }, '1'] }), op).toEqual({ type: 'boolean', value: null });
    expect(value({ '==': [{ field: 'n' }, null] })).toEqual({ type: 'boolean', value: true });
    expect(value({ '==': [{ field: 'n' }, '1'] })).toEqual({ type: 'boolean', value: false });
    expect(value({ '!=': [{ field: 'n' }, '1'] })).toEqual({ type: 'boolean', value: true });
    expect(value({ in: [{ field: 'status' }, ['single']] })).toEqual({
      type: 'boolean',
      value: false,
    });
    expect(value({ matches: [{ field: 't' }, 'a+'] })).toEqual({ type: 'boolean', value: null });
  });

  it('uses Kleene logic for and, or and not, with booleans only', () => {
    const V = [true, false, null] as const;
    const and = (a: boolean | null, b: boolean | null) =>
      a === false || b === false ? false : a === null || b === null ? null : true;
    const or = (a: boolean | null, b: boolean | null) =>
      a === true || b === true ? true : a === null || b === null ? null : false;
    for (const a of V)
      for (const b of V) {
        const values = { c: a, c2: b };
        const ops = [{ field: 'c' }, { field: 'c2' }];
        expect(value({ and: ops }, values), `${a} and ${b}`).toEqual({
          type: 'boolean',
          value: and(a, b),
        });
        expect(value({ or: ops }, values), `${a} or ${b}`).toEqual({
          type: 'boolean',
          value: or(a, b),
        });
      }
    expect(value({ not: [{ field: 'c' }] }, { c: null })).toEqual({ type: 'boolean', value: null });
    for (const operand of ['yes', { field: 'n' }, { field: 't' }, { field: 'd' }])
      for (const op of ['and', 'or'])
        expect(
          problemCodes({ [op]: [{ field: 'c' }, operand] }),
          `${op} ${JSON.stringify(operand)}`,
        ).toEqual(['type_mismatch']);
    expect(
      value({ in: [{ field: 'status' }, ['married', 'partnered']] }, { status: 'partnered' }),
    ).toEqual({
      type: 'boolean',
      value: true,
    });
  });

  it('treats null, the empty string and an unticked checkbox as empty, and nothing else', () => {
    expect(value({ empty: [{ field: 't' }] }, {})).toEqual({ type: 'boolean', value: true });
    expect(value({ empty: [{ field: 't' }] }, { t: '' })).toEqual({ type: 'boolean', value: true });
    expect(value({ empty: [{ field: 't' }] }, { t: ' ' })).toEqual({
      type: 'boolean',
      value: false,
    });
    expect(value({ empty: [{ field: 'c' }] }, { c: false })).toEqual({
      type: 'boolean',
      value: true,
    });
    expect(value({ empty: [{ field: 'n' }] }, { n: '0' })).toEqual({
      type: 'boolean',
      value: false,
    });
    expect(value({ empty: [{ field: 'd' }] }, { d: '2026-01-01' })).toEqual({
      type: 'boolean',
      value: false,
    });
  });

  it('answers role tests for exactly the participant roles, or the preview roles', () => {
    const roles = ['role_a', 'role_b'];
    expect(value({ role: 'role_a' }, {}, { roles })).toEqual({ type: 'boolean', value: true });
    expect(value({ role: 'role_b' }, {}, { roles })).toEqual({ type: 'boolean', value: true });
    expect(value({ role: 'role_c' }, {}, { roles })).toEqual({ type: 'boolean', value: false });
    // An author's preview: no participant, the roles chosen for the preview.
    expect(value({ role: 'role_c' }, {}, { roles: ['role_c'] })).toEqual({
      type: 'boolean',
      value: true,
    });
    expect(value({ role: 'role_a' }, {}, { roles: [] })).toEqual({ type: 'boolean', value: false });
  });

  it('gives the workflow time zone date, whatever the host time zone is', () => {
    // These expectations are fixed, and the same in every engine and host time zone this runs in.
    const now = (instant: string, timeZone: string) =>
      value({ now: 'date' }, {}, { now: { instant, timeZone } });
    expect(now('2026-03-28T23:30:00.000Z', 'Europe/Berlin')).toEqual({
      type: 'date',
      value: '2026-03-29',
    });
    expect(now('2026-03-28T23:30:00.000Z', 'America/New_York')).toEqual({
      type: 'date',
      value: '2026-03-28',
    });
    expect(now('2026-03-28T23:30:00.000Z', 'Asia/Tokyo')).toEqual({
      type: 'date',
      value: '2026-03-29',
    });
    expect(now('2026-03-28T23:30:00.000Z', 'UTC')).toEqual({ type: 'date', value: '2026-03-28' });
  });

  it('compares decimals as decimals and dates as calendar dates, never as strings', () => {
    // As strings "9.99" > "10" and "100" < "20"; as decimals the opposite.
    expect(value({ '<': [{ field: 'n' }, '10'] }, { n: '9.99' })).toEqual({
      type: 'boolean',
      value: true,
    });
    expect(value({ '<': ['20', '100'] })).toEqual({ type: 'boolean', value: true });
    expect(value({ '==': [{ field: 'n' }, '1.000'] }, { n: '1' })).toEqual({
      type: 'boolean',
      value: true,
    });
    expect(value({ '<': [{ field: 'd' }, '2026-01-01'] }, { d: '2025-12-31' })).toEqual({
      type: 'boolean',
      value: true,
    });
    expect(value({ max: [{ field: 'd' }, '2026-02-01'] }, { d: '2026-01-31' })).toEqual({
      type: 'date',
      value: '2026-02-01',
    });
  });
});

describe('formulas on decimal strings (FRW-017)', () => {
  it('calculates exactly with the fixed precision', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // what a binary float gives
    expect(value({ '+': ['0.1', '0.2'] })).toEqual({ type: 'decimal', value: '0.3' });
    expect(value({ '-': ['0.3', '0.1'] })).toEqual({ type: 'decimal', value: '0.2' });
    expect(value({ '*': ['0.1', '3'] })).toEqual({ type: 'decimal', value: '0.3' });
    expect(value({ '/': ['1', '8'] })).toEqual({ type: 'decimal', value: '0.125' });
    expect(value({ round: ['0.125', 2] })).toEqual({ type: 'decimal', value: '0.13' });
    expect(value({ sum: ['10.00', '0.01', '0.02'] })).toEqual({ type: 'decimal', value: '10.03' });
    expect(value({ min: ['1.5', '1.49'] })).toEqual({ type: 'decimal', value: '1.49' });
    expect(value({ max: ['-1', '-2'] })).toEqual({ type: 'decimal', value: '-1' });
    expect(value({ concat: ['a', { if: [true, 'b', 'c'] }] })).toEqual({
      type: 'string',
      value: 'ab',
    });
  });

  it('stays exact beyond the 15 to 17 significant digits of a binary double', () => {
    expect(2 ** 53 + 1).toBe(2 ** 53); // a double loses the 1
    expect(value({ '+': ['9007199254740992', '1'] })).toEqual({
      type: 'decimal',
      value: '9007199254740993',
    });
    expect(value({ '*': ['123456789012345678901', '1000000000'] })).toEqual({
      type: 'decimal',
      value: '123456789012345678901000000000',
    });
    expect(value({ '-': ['1000000000000000000000000000000.01', '0.02'] })).toEqual({
      type: 'decimal',
      value: '999999999999999999999999999999.99',
    });
  });

  it('writes formula values as decimal strings or strings, and type errors give the error result', () => {
    const fields: FieldInfo[] = [
      { key: 'a', kind: 'number' },
      { key: 'b', kind: 'number' },
      { key: 'share', kind: 'formula' },
      { key: 'label', kind: 'formula' },
    ];
    const compiled = compileRules(
      rulesFromList([
        {
          id: 'r1',
          when: true,
          then: [{ set: { field: 'share', value: { '/': [{ field: 'a' }, { field: 'b' }] } } }],
        },
        { id: 'r2', when: true, then: [{ set: { field: 'label', value: { concat: ['Share'] } } }] },
      ]),
      { fields },
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const run = (values: Record<string, unknown>) => {
      const ev = evaluateRules(compiled.ruleSet, values as never, { roles: [] });
      if (!ev.ok) throw new Error('budget');
      return Object.fromEntries(ev.fields.map((s) => [s.key, { value: s.value, error: s.error }]));
    };
    expect(run({ a: '10', b: '4' })['share']).toEqual({ value: '2.5', error: undefined });
    expect(run({ a: '10', b: '4' })['label']).toEqual({ value: 'Share', error: undefined });
    expect(run({ a: '10', b: '0' })['share']).toEqual({ value: null, error: 'division_by_zero' });
    expect(run({ a: '10' })['share']).toEqual({ value: null, error: undefined });
    // A stored value of the wrong type is an error value, never an exception or a conversion.
    expect(run({ a: 10, b: '4' })['share']).toEqual({ value: null, error: 'invalid_value' });
    expect(run({ a: 'ten', b: '4' })['share']).toEqual({ value: null, error: 'invalid_value' });
  });

  it('gives division by zero and null operands their defined results', () => {
    expect(value({ '/': ['1', '0'] })).toEqual({ type: 'decimal', error: 'division_by_zero' });
    expect(value({ '/': ['0', '0'] })).toEqual({ type: 'decimal', error: 'division_by_zero' });
    expect(value({ '/': [{ field: 'n' }, '0'] })).toEqual({ type: 'decimal', value: null });
    for (const op of ['+', '-', '*', '/'])
      expect(value({ [op]: [{ field: 'n' }, '2'] }), op).toEqual({ type: 'decimal', value: null });
    expect(value({ round: [{ field: 'n' }, 2] })).toEqual({ type: 'decimal', value: null });
    expect(value({ sum: [{ field: 'n' }, '2'] })).toEqual({ type: 'decimal', value: '2' });
  });

  it('types if and concat when the rule is saved', () => {
    expect(problemCodes({ if: [{ field: 'c' }, { field: 'n' }, { field: 't' }] })).toEqual([
      'type_mismatch',
    ]);
    expect(problemCodes({ if: [{ field: 'n' }, 'a', 'b'] })).toEqual(['type_mismatch']);
    expect(problemCodes({ concat: ['Total: ', { field: 'n' }] })).toEqual(['type_mismatch']);
    expect(problemCodes({ concat: [{ field: 'd' }] })).toEqual(['type_mismatch']);
    expect(problemCodes({ if: [{ field: 'c' }, '10', { field: 'n' }] })).toEqual([]);
    expect(problemCodes({ if: [{ field: 'c' }, 'ten', { field: 'n' }] })).toEqual([
      'invalid_literal',
    ]);
  });
});
