/**
 * FRW-024 (lane V-FRW-019-036): the logic of the rule builder. Node.js 22.18, vitest.
 * Criteria 2 to 5 are tested here on the builder's functions; criteria 1 (the interface) and 6
 * (keyboard, focus and axe) need the interface and are not claimed by this file.
 */
import type { JsonValue } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import {
  addRule,
  builderAccess,
  checkRuleSet,
  openRule,
  ruleSentence,
  saveRule,
  setBranch,
  setCondition,
} from '../src/builder.ts';
import { FIXTURE_CASES } from '../src/fixtures/index.ts';
import { choice, f, formula, text } from '../src/fixtures/build.ts';
import type { FieldInfo } from '../src/fields.ts';
import { LIMITS } from '../src/limits.ts';

const SPOUSE_FIELDS: FieldInfo[] = [
  choice('tenant.maritalStatus', ['single', 'married']),
  text('tenant.spouseName'),
];

const SPOUSE_RULE: JsonValue = {
  id: 'r_spouse',
  when: { '==': [f('tenant.maritalStatus'), 'married'] },
  then: [{ show: ['tenant.spouseName'] }, { require: ['tenant.spouseName'] }],
  else: [{ hide: ['tenant.spouseName'] }],
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('criterion 2: a valid rule opened in the builder and saved unchanged is identical', () => {
  // Every rule of every valid rules case in the fixtures (the cases whose expectation is not a list of
  // problems), opened and saved in turn.
  const valid = FIXTURE_CASES.filter(
    (c) => c.kind === 'rules' && !('problems' in (c.expect as object)),
  );

  it('the fixtures contain valid rules to round-trip', () => {
    expect(valid.length).toBeGreaterThan(20);
  });

  it('opens and saves every rule of every valid fixture without change', () => {
    let count = 0;
    for (const c of valid) {
      if (c.kind !== 'rules') continue;
      for (const json of c.rules) {
        const opened = openRule(json);
        expect(opened).not.toBeNull();
        expect(saveRule(opened!)).toEqual(clone(json));
        count += 1;
      }
    }
    // 37 rules at the time of writing; the count is reported, not asserted against a target.
    expect(count).toBeGreaterThan(30);
  });

  it('keeps members the builder does not edit, such as ext', () => {
    const json = { ...(SPOUSE_RULE as object), ext: { note: 'kept' } } as JsonValue;
    expect(saveRule(openRule(json)!)).toEqual(clone(json));
  });

  it('an edit replaces only the member it changes, and the source is not mutated', () => {
    const opened = openRule(SPOUSE_RULE)!;
    const edited = setCondition(opened, { '==': [f('tenant.maritalStatus'), 'single'] });
    const saved = saveRule(edited) as Record<string, unknown>;
    expect(saved['when']).toEqual({ '==': [f('tenant.maritalStatus'), 'single'] });
    expect(saved['then']).toEqual((SPOUSE_RULE as Record<string, unknown>)['then']);
    expect(saveRule(opened)).toEqual(clone(SPOUSE_RULE));
  });

  it('refuses a value that has no identifier', () => {
    expect(openRule({ when: true, then: [] })).toBeNull();
    expect(openRule([SPOUSE_RULE])).toBeNull();
  });
});

describe('criterion 3: a rule that refers to a missing key, or forms a cycle, is refused with the keys', () => {
  it('a rule on a key that does not exist is refused, naming the key', () => {
    const rule = openRule({
      id: 'r_missing',
      when: { '==': [f('tenant.unknown'), 'x'] },
      then: [{ show: ['tenant.spouseName'] }],
    })!;
    const res = addRule([], rule, SPOUSE_FIELDS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal.code).toBe('invalid_rules');
    if (res.refusal.code !== 'invalid_rules') return;
    const named = res.refusal.problems.flatMap((p) => p.keys ?? []);
    expect(named).toContain('tenant.unknown');
  });

  it('a set of formulas that depend on each other in a cycle is refused, naming the keys on it', () => {
    const fields: FieldInfo[] = [formula('calc.a'), formula('calc.b')];
    const rules: JsonValue[] = [
      {
        id: 'r_a',
        when: true,
        then: [{ set: { field: 'calc.a', value: { '+': [f('calc.b'), '1'] } } }],
      },
      {
        id: 'r_b',
        when: true,
        then: [{ set: { field: 'calc.b', value: { '+': [f('calc.a'), '1'] } } }],
      },
    ];
    const check = checkRuleSet(rules, fields);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    const cycle = check.problems.find((p) => p.code === 'cycle');
    expect(cycle).toBeDefined();
    expect(cycle?.keys).toEqual(expect.arrayContaining(['calc.a', 'calc.b']));
  });

  it('a valid rule is accepted by addRule', () => {
    const res = addRule([], openRule(SPOUSE_RULE)!, SPOUSE_FIELDS);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rules).toEqual([SPOUSE_RULE]);
  });
});

describe('criterion 4: a document at 500 rules refuses one more', () => {
  it('the builder limit is the rules limit of the language (I15)', () => {
    expect(LIMITS.rules).toBe(500);
  });

  it('refuses the 501st rule with rule_limit and a message, without compiling the set', () => {
    const full: JsonValue[] = Array.from({ length: 500 }, (_, i) => ({
      id: `r_${i}`,
      when: true,
    }));
    const res = addRule(full, openRule(SPOUSE_RULE)!, SPOUSE_FIELDS);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.refusal.code).toBe('rule_limit');
    expect(res.refusal.code === 'rule_limit' && res.refusal.message).toContain('500');
  });

  it('accepts the 500th rule', () => {
    const almost: JsonValue[] = Array.from({ length: 499 }, (_, i) => ({
      id: `r_${i}`,
      when: true,
      then: [],
    }));
    const res = addRule(almost, openRule(SPOUSE_RULE)!, SPOUSE_FIELDS);
    expect(res.ok).toBe(true);
  });
});

describe('criterion 5: a user without structure sees the builder read-only', () => {
  it('a caller with structure may edit, a caller without it may not', () => {
    expect(builderAccess({ structure: true })).toBe('edit');
    expect(builderAccess({ structure: false })).toBe('read_only');
  });
});

describe('the sentence view (criterion 1, logic only)', () => {
  it('renders the 12 §5.1 example as the sentence the spec gives', () => {
    const sentence = ruleSentence(openRule(SPOUSE_RULE)!);
    expect(sentence).toBe(
      'If tenant.maritalStatus is married, show tenant.spouseName and require tenant.spouseName; otherwise hide tenant.spouseName.',
    );
  });

  it('returns null for a condition the sentence form does not express, rather than guessing', () => {
    const rule = openRule({
      id: 'r_x',
      when: { and: [true, true] },
      then: [{ show: ['tenant.spouseName'] }],
    })!;
    expect(ruleSentence(rule)).toBeNull();
  });

  it('setBranch changes the effects shown in the sentence', () => {
    const rule = setBranch(openRule(SPOUSE_RULE)!, 'else', [{ disable: ['tenant.spouseName'] }]);
    expect(ruleSentence(rule)).toBe(
      'If tenant.maritalStatus is married, show tenant.spouseName and require tenant.spouseName; otherwise disable tenant.spouseName.',
    );
  });
});
