// The rule builder's form model and its sentence (FRW-024; shell/rule-builder.ts): a rule opened into
// the form reads back to the same parts, the form checks only what it can, and every word of the
// sentence comes from the string catalogue, so a table that reorders the words reorders the sentence.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RulePartsView } from '../src/core-api.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import {
  OPERATOR_KEYS,
  RULE_EFFECTS,
  RULE_OPERATORS,
  emptyForm,
  formFromParts,
  formProblems,
  partsFromForm,
  sameForm,
  sentenceOf,
} from '../src/shell/rule-builder.ts';

/** The source table's translator, with `{name}` replaced by the parameter. */
function translator(table: Readonly<Record<string, unknown>>) {
  return (key: string, values?: Readonly<Record<string, string | number>>): string => {
    const raw = table[key];
    if (typeof raw !== 'string') return `<${key}>`;
    return raw.replace(/\{(\w+)\}/g, (match, name: string) => String(values?.[name] ?? match));
  };
}
const t = translator(EN_GB as unknown as Record<string, unknown>);

const SPOUSE: RulePartsView = {
  left: { field: 'tenant.maritalStatus' },
  operator: '==',
  right: { literal: 'married' },
  then: [
    { effect: 'show', keys: ['tenant.spouseName'] },
    { effect: 'require', keys: ['tenant.spouseName'] },
  ],
  otherwise: [{ effect: 'hide', keys: ['tenant.spouseName'] }],
};

describe('the sentence (FRW-024 criterion 1)', () => {
  it('reads as the sentence of 12 §11', () => {
    expect(sentenceOf(SPOUSE, t)).toBe(
      'If tenant.maritalStatus is married, show tenant.spouseName and require tenant.spouseName; otherwise hide tenant.spouseName.',
    );
  });

  it('has no otherwise when the rule has none, and joins the keys of one effect', () => {
    expect(
      sentenceOf(
        {
          left: { field: 'a' },
          operator: '>=',
          right: { literal: '10' },
          then: [{ effect: 'disable', keys: ['b', 'c'] }],
          otherwise: null,
        },
        t,
      ),
    ).toBe('If a is at least 10, disable b and c.');
  });

  it('takes every word from the catalogue: a table with other words gives another sentence', () => {
    const other = translator({
      'rule.sentence': '{then} si {left} {operator} {right}.',
      'rule.sentence.otherwise': '{then} si {left} {operator} {right}, sinon {otherwise}.',
      'rule.and': ' et ',
      'rule.op.eq': 'vaut',
      'rule.effect.show': 'afficher {fields}',
      'rule.effect.require': 'exiger {fields}',
      'rule.effect.hide': 'masquer {fields}',
    });
    expect(sentenceOf(SPOUSE, other)).toBe(
      'afficher tenant.spouseName et exiger tenant.spouseName si tenant.maritalStatus vaut married, sinon masquer tenant.spouseName.',
    );
  });

  it('has a string for every operator and every effect', () => {
    for (const op of RULE_OPERATORS) expect(EN_GB).toHaveProperty([OPERATOR_KEYS[op]]);
    for (const effect of RULE_EFFECTS) expect(EN_GB).toHaveProperty([`rule.effect.${effect}`]);
  });
});

describe('the form (FRW-024 criteria 1 and 2)', () => {
  it('opens a rule into rows, one for each key of an effect, and reads back to the same sentence', () => {
    const form = formFromParts('r_spouse', {
      ...SPOUSE,
      then: [{ effect: 'show', keys: ['a', 'b'] }],
    });
    expect(form.then).toEqual([
      { effect: 'show', key: 'a' },
      { effect: 'show', key: 'b' },
    ]);
    expect(sentenceOf(partsFromForm(form), t)).toBe(
      sentenceOf(
        {
          ...SPOUSE,
          then: [
            { effect: 'show', keys: ['a'] },
            { effect: 'show', keys: ['b'] },
          ],
        },
        t,
      ),
    );
  });

  it('reads back to the same parts for any rule whose effects name one key each', () => {
    const operand = fc.oneof(
      fc.record({ field: fc.constantFrom('a', 'b', 'c') }),
      fc.record({ literal: fc.constantFrom('x', '10', 'true') }),
    );
    const effects = fc.array(
      fc.record({
        effect: fc.constantFrom(...RULE_EFFECTS),
        keys: fc.constantFrom(['a'], ['b'], ['c']),
      }),
      { minLength: 1, maxLength: 3 },
    );
    fc.assert(
      fc.property(
        operand,
        fc.constantFrom(...RULE_OPERATORS),
        operand,
        effects,
        fc.option(effects, { nil: null }),
        (left, operator, right, then, otherwise) => {
          const parts: RulePartsView = { left, operator, right, then, otherwise };
          const form = formFromParts('r', parts);
          expect(partsFromForm(form)).toEqual(parts);
          expect(sameForm(form, formFromParts('r', parts))).toBe(true);
        },
      ),
    );
  });

  it('checks that something is chosen and a value is given, and nothing more', () => {
    const form = emptyForm('rule_1');
    expect(formProblems(form).map((p) => p.code)).toEqual(['left', 'right', 'effect']);
    form.left.value = 'a';
    form.right.value = '5';
    form.then[0]!.key = 'b';
    expect(formProblems(form)).toEqual([]);
    form.hasOtherwise = true;
    expect(formProblems(form).map((p) => p.code)).toEqual(['otherwiseEffect']);
    form.otherwise.push({ effect: 'hide', key: 'b' });
    expect(formProblems(form)).toEqual([]);
    form.id = '  ';
    expect(formProblems(form).map((p) => p.code)).toEqual(['id']);
  });
});
