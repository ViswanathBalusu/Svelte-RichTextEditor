// FRW-023 criterion 6: `dependentKeys` names the fields whose state a change of values can change,
// so that the editor evaluates those and no others.
import { describe, expect, it } from 'vitest';
import { compileRules, dependentKeys, evaluateRules, type FieldInfo } from '../src/index.ts';

const fields: FieldInfo[] = ['name', 'spouse', 'amount', 'email', 'total', 'unrelated', 'tax'].map(
  (key) => ({
    key,
    kind: key === 'total' || key === 'tax' ? 'formula' : key === 'amount' ? 'number' : 'text',
  }),
);

const rules = [
  {
    id: 'r_spouse',
    when: { '==': [{ field: 'name' }, 'Ada'] },
    then: [{ show: ['spouse'] }, { require: ['spouse'] }],
    else: [{ hide: ['spouse'] }],
  },
  {
    id: 'r_total',
    when: true,
    then: [{ set: { field: 'total', value: { '*': [{ field: 'amount' }, '2'] } } }],
  },
  {
    // Reads the formula `total`, so it follows a change of `amount` through it.
    id: 'r_lock',
    when: { '>=': [{ field: 'total' }, '100'] },
    then: [{ disable: ['email'] }],
  },
  {
    id: 'r_tax',
    when: true,
    then: [{ set: { field: 'tax', value: { '*': [{ field: 'total' }, '0.2'] } } }],
  },
];

const compiled = compileRules(
  rules.map((attrs, i) => ({ attrs, path: `/${i}` })),
  { fields },
);
if (!compiled.ok) throw new Error(JSON.stringify(compiled.problems));
const set = compiled.ruleSet;

describe('the fields a change of values can change (FRW-023 criterion 6)', () => {
  it('names the changed field and the fields its rules name, in document order', () => {
    expect(dependentKeys(set, ['name'])).toEqual(['name', 'spouse']);
  });

  it('follows a formula to the rules that read it', () => {
    expect(dependentKeys(set, ['amount'])).toEqual(['amount', 'email', 'total', 'tax']);
  });

  it('names only the field itself when no rule reads it, and nothing for a key that is no field', () => {
    expect(dependentKeys(set, ['unrelated'])).toEqual(['unrelated']);
    expect(dependentKeys(set, ['nope'])).toEqual([]);
    expect(dependentKeys(set, [])).toEqual([]);
  });

  it('gives the states a full evaluation gives, for the fields it names', () => {
    const values = { name: 'Ada', spouse: null, amount: '60', email: null, unrelated: 'x' };
    const ctx = { roles: [] };
    const all = evaluateRules(set, values, ctx);
    if (!all.ok) throw new Error('budget');
    for (const changed of [['name'], ['amount'], ['unrelated'], ['name', 'amount']]) {
      const keys = dependentKeys(set, changed);
      const part = evaluateRules(set, values, ctx, { keys });
      if (!part.ok) throw new Error('budget');
      expect(part.fields).toEqual(all.fields.filter((f) => keys.includes(f.key)));
    }
  });
});
