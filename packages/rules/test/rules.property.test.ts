// Rule sets (FRW-015, FRW-019; ADR 0030 §7): one pass in dependency order, each node once, the same
// result whatever order the rules are stored in, never an exception on any JSON, a step budget for
// admission control, and an evaluation limited to what a fill check needs.
import type { JsonValue } from '@docedit/model';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { evaluateRules } from '../src/evaluate.ts';
import type { FieldInfo } from '../src/fields.ts';
import { compileExpression, compileRules, rulesFromList, type RuleSet } from '../src/language.ts';

const FIELDS: FieldInfo[] = [
  { key: 'status', kind: 'choice', options: ['single', 'married'] },
  { key: 'spouse', kind: 'text' },
  { key: 'a', kind: 'number' },
  { key: 'b', kind: 'number' },
  { key: 'start', kind: 'date' },
  { key: 'end', kind: 'date' },
  { key: 'agree', kind: 'checkbox', required: true },
  { key: 'note', kind: 'text', readOnly: true },
  { key: 'total', kind: 'formula' },
  { key: 'vat', kind: 'formula' },
  { key: 'gross', kind: 'formula' },
  { key: 'label', kind: 'formula' },
];
const f = (key: string) => ({ field: key });
const RULES: JsonValue[] = [
  {
    id: 'r_spouse',
    when: { '==': [f('status'), 'married'] },
    then: [{ show: ['spouse'] }, { require: ['spouse'] }],
    else: [{ hide: ['spouse'] }],
  },
  {
    id: 'r_total',
    when: true,
    then: [{ set: { field: 'total', value: { sum: [f('a'), f('b')] } } }],
  },
  {
    id: 'r_vat',
    when: { '>': [f('total'), '0'] },
    then: [{ set: { field: 'vat', value: { round: [{ '*': [f('total'), '0.19'] }, 2] } } }],
  },
  {
    id: 'r_gross',
    when: true,
    then: [{ set: { field: 'gross', value: { '+': [f('total'), f('vat')] } } }],
  },
  {
    id: 'r_label',
    when: { '>': [f('gross'), '1000'] },
    then: [{ set: { field: 'label', value: { concat: ['Large order: ', f('spouse')] } } }],
    else: [{ set: { field: 'label', value: 'Small order' } }],
  },
  {
    id: 'r_dates',
    when: { '>=': [f('end'), f('start')] },
    then: [],
    else: [{ validate: { fields: ['end'], message: 'The end date is before the start date.' } }],
  },
  {
    id: 'r_note',
    when: { and: [f('agree'), { role: 'role_clerk' }] },
    then: [{ enable: ['note'] }],
    else: [{ disable: ['note'] }],
  },
];

function compiled(list: JsonValue[] = RULES): RuleSet {
  const r = compileRules(rulesFromList(list), {
    fields: FIELDS,
    roles: ['role_clerk', 'role_client'],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.ruleSet;
}

const values = fc.record(
  {
    status: fc.constantFrom('single', 'married', null, 'other', 5),
    spouse: fc.oneof(fc.string({ maxLength: 8 }), fc.constant(null)),
    a: fc.oneof(
      fc.constantFrom('0', '12.50', '-3', '999.99', '1e3', null),
      fc.integer().map(String),
    ),
    b: fc.oneof(
      fc.constantFrom('0.01', '1000', null, 'x'),
      fc.integer({ min: -9999, max: 9999 }).map(String),
    ),
    start: fc.constantFrom('2026-01-01', '2026-12-31', null, '2026-02-30'),
    end: fc.constantFrom('2026-06-01', null, true),
    agree: fc.constantFrom(true, false, null, 'yes'),
    note: fc.constantFrom('x', null),
  },
  { requiredKeys: [] },
);
const contexts = fc.record({
  roles: fc.subarray(['role_clerk', 'role_client']),
  now: fc.constant({ instant: '2026-11-06T09:00:00.000Z', timeZone: 'Europe/Berlin' }),
});

describe('evaluation order', () => {
  it('gives the same result whatever order the rules are stored in', () => {
    const base = compiled();
    fc.assert(
      fc.property(
        fc.shuffledSubarray(RULES, { minLength: RULES.length }),
        values,
        contexts,
        (order, v, ctx) => {
          const a = evaluateRules(base, v, ctx);
          const b = evaluateRules(compiled(order), v, ctx);
          expect(b).toEqual(a);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('evaluates each node once, in dependency order (a chain and a fan-out)', () => {
    // A chain of 200 formulas f0 = a + 1, f1 = f0 + 1, ... stored in reverse order, and 50 formulas
    // that all read the end of the chain.
    const n = 200;
    const fields: FieldInfo[] = [{ key: 'a', kind: 'number' }];
    const list: JsonValue[] = [];
    for (let i = 0; i < n; i++) {
      fields.push({ key: `f${i}`, kind: 'formula' });
      list.push({
        id: `r${i}`,
        when: true,
        then: [{ set: { field: `f${i}`, value: { '+': [f(i === 0 ? 'a' : `f${i - 1}`), '1'] } } }],
      });
    }
    for (let j = 0; j < 50; j++) {
      fields.push({ key: `g${j}`, kind: 'formula' });
      list.push({
        id: `s${j}`,
        when: { '>': [f(`f${n - 1}`), '0'] },
        then: [{ set: { field: `g${j}`, value: { '*': [f(`f${n - 1}`), '2'] } } }],
      });
    }
    list.reverse();
    const c = compileRules(rulesFromList(list), { fields });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.ruleSet.formulaOrder.slice(0, 3)).toEqual(['f0', 'f1', 'f2']);
    const ev = evaluateRules(c.ruleSet, { a: '1' }, { roles: [] });
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    // Every node of every condition and formula, exactly once: the static count of nodes.
    expect(ev.steps).toBe(c.ruleSet.maxSteps);
    const byKey = new Map(ev.fields.map((s) => [s.key, s]));
    expect(byKey.get(`f${n - 1}`)!.value).toBe(String(n + 1));
    expect(byKey.get('g49')!.value).toBe(String(2 * (n + 1)));
  });

  it('evaluates only what the requested fields depend on', () => {
    const rs = compiled();
    fc.assert(
      fc.property(
        values,
        contexts,
        fc.subarray(
          FIELDS.map((x) => x.key),
          { minLength: 1 },
        ),
        (v, ctx, keys) => {
          const full = evaluateRules(rs, v, ctx);
          const part = evaluateRules(rs, v, ctx, { keys });
          if (!full.ok || !part.ok) throw new Error('budget');
          const want = full.fields.filter((s) => keys.includes(s.key));
          expect(part.fields.sort((x, y) => (x.key < y.key ? -1 : 1))).toEqual(
            want.sort((x, y) => (x.key < y.key ? -1 : 1)),
          );
          expect(part.steps).toBeLessThanOrEqual(full.steps);
        },
      ),
      { numRuns: 300 },
    );
    // The fill check of the spouse's name needs one rule.
    const one = evaluateRules(rs, { status: 'married' }, { roles: [] }, { keys: ['spouse'] });
    expect(one.ok && one.rules.map((r) => r.id)).toEqual(['r_spouse']);
  });
});

describe('totality', () => {
  it('never throws on any JSON as a rule, and reports problems with paths', () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 6 }), fc.jsonValue({ maxDepth: 6 }), (when, effect) => {
        for (const attrs of [
          when,
          { id: 'r', when, then: [effect] },
          { id: 'r', when: true, then: effect, else: when },
        ]) {
          const r = compileRules(rulesFromList([attrs]), { fields: FIELDS });
          if (!r.ok) for (const p of r.problems) expect(p.path.startsWith('/0')).toBe(true);
        }
        const e = compileExpression(when, { fields: FIELDS });
        if (!e.ok) expect(e.problems.length).toBeGreaterThan(0);
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws on any stored values', () => {
    const rs = compiled();
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom(...FIELDS.map((x) => x.key)), fc.jsonValue({ maxDepth: 3 })),
        contexts,
        (v, ctx) => {
          // fast-check's JSON values are the CDM's JSON values, typed by another declaration.
          const ev = evaluateRules(rs, v as Record<string, JsonValue>, ctx);
          expect(ev.ok).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('budget (04 §12 admission control)', () => {
  it('stops after the budget and reports the steps, the same everywhere', () => {
    const rs = compiled();
    const full = evaluateRules(rs, { a: '1', b: '2', status: 'married' }, { roles: [] });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.steps).toBeLessThanOrEqual(rs.maxSteps);
    const exact = evaluateRules(
      rs,
      { a: '1', b: '2', status: 'married' },
      { roles: [], budget: full.steps },
    );
    expect(exact.ok).toBe(true);
    const short = evaluateRules(
      rs,
      { a: '1', b: '2', status: 'married' },
      { roles: [], budget: full.steps - 1 },
    );
    expect(short).toEqual({ ok: false, code: 'budget_exceeded', steps: full.steps });
  });
});
