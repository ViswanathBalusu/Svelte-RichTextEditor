// Values derived from hidden content (FRW-089; ADR 0019): the closure of hidden keys under the rule
// set, its monotonicity, idempotence and order independence, and the conditioned fields.
import type { JsonValue } from '@docedit/model';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { derivedFromHidden, fieldsRead } from '../src/hidden.ts';
import type { FieldInfo } from '../src/fields.ts';
import { compileRules, rulesFromList, type RuleSet } from '../src/language.ts';

const FIELDS: FieldInfo[] = [
  { key: 'status', kind: 'choice', options: ['single', 'married'] },
  { key: 'spouse', kind: 'text' },
  { key: 'a', kind: 'number' },
  { key: 'b', kind: 'number' },
  { key: 'agree', kind: 'checkbox' },
  { key: 'free', kind: 'text' },
  { key: 'note', kind: 'text' },
  { key: 'total', kind: 'formula' },
  { key: 'vat', kind: 'formula' },
  { key: 'gross', kind: 'formula' },
  { key: 'label', kind: 'formula' },
];
const INPUT_KEYS = FIELDS.map((field) => field.key).filter(
  (key) => !['total', 'vat', 'gross', 'label'].includes(key),
);

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
    id: 'r_note',
    when: { and: [f('agree'), { '==': [f('free'), 'yes'] }] },
    then: [{ enable: ['note'] }],
    else: [{ disable: ['note'] }],
  },
];

function compiled(list: JsonValue[] = RULES): RuleSet {
  const r = compileRules(rulesFromList(list), { fields: FIELDS, roles: [] });
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.ruleSet;
}

const RULE_SET = compiled();

describe('derivedFromHidden (FRW-089)', () => {
  it('hides every formula that reads a hidden amount, through the chain', () => {
    const result = derivedFromHidden(RULE_SET, ['a']);
    expect(result.hidden).toEqual(['a', 'gross', 'label', 'total', 'vat']);
    expect(result.derived).toEqual(['gross', 'label', 'total', 'vat']);
  });

  it('hides a label that concatenates a hidden text, but no formula that does not read it', () => {
    const result = derivedFromHidden(RULE_SET, ['spouse']);
    expect(result.derived).toEqual(['label']);
  });

  it('hides a label whose condition reads a hidden formula (implicit flow)', () => {
    const result = derivedFromHidden(RULE_SET, ['b']);
    expect(result.derived).toEqual(['gross', 'label', 'total', 'vat']);
  });

  it('reports a field whose visibility a hidden condition decides, without hiding its value', () => {
    const result = derivedFromHidden(RULE_SET, ['status']);
    expect(result.derived).toEqual([]);
    expect(result.conditioned).toEqual(['spouse']);
  });

  it('reports the enablement of a field that a hidden checkbox decides', () => {
    const result = derivedFromHidden(RULE_SET, ['agree']);
    expect(result.derived).toEqual([]);
    expect(result.conditioned).toEqual(['note']);
  });

  it('derives nothing from no hidden keys, or from keys no rule reads', () => {
    expect(derivedFromHidden(RULE_SET, [])).toEqual({ hidden: [], derived: [], conditioned: [] });
    expect(derivedFromHidden(RULE_SET, ['free']).derived).toEqual([]);
    expect(derivedFromHidden(RULE_SET, ['no_such_key']).hidden).toEqual(['no_such_key']);
  });

  it('gives the same answer whatever order the rules are stored in', () => {
    const reversed = compiled([...RULES].reverse());
    fc.assert(
      fc.property(fc.subarray(INPUT_KEYS), (hidden) => {
        expect(derivedFromHidden(reversed, hidden)).toEqual(derivedFromHidden(RULE_SET, hidden));
      }),
    );
  });

  it('is closed: a rule reading a hidden key sets only hidden targets', () => {
    fc.assert(
      fc.property(fc.subarray(INPUT_KEYS), (hidden) => {
        const { hidden: closed } = derivedFromHidden(RULE_SET, hidden);
        const set = new Set(closed);
        const reads = (keys: Set<string>) => [...keys].some((key) => set.has(key));
        for (const rule of RULE_SET.rules) {
          const conditionHidden = reads(fieldsRead(rule.when));
          for (const effect of [...rule.then, ...rule.else]) {
            if (effect.k !== 'set') continue;
            if (conditionHidden || reads(fieldsRead(effect.value))) {
              expect(set.has(effect.key)).toBe(true);
            }
          }
        }
      }),
    );
  });

  it('is monotone: hiding more keys never hides fewer', () => {
    fc.assert(
      fc.property(fc.subarray(INPUT_KEYS), fc.subarray(INPUT_KEYS), (small, extra) => {
        const big = [...new Set([...small, ...extra])];
        const low = new Set(derivedFromHidden(RULE_SET, small).hidden);
        const high = new Set(derivedFromHidden(RULE_SET, big).hidden);
        for (const key of low) expect(high.has(key)).toBe(true);
      }),
    );
  });

  it('is idempotent: the closure of a closure is itself', () => {
    fc.assert(
      fc.property(fc.subarray(INPUT_KEYS), (hidden) => {
        const once = derivedFromHidden(RULE_SET, hidden);
        expect(derivedFromHidden(RULE_SET, once.hidden).hidden).toEqual(once.hidden);
      }),
    );
  });
});
