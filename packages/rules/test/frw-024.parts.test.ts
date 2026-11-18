/**
 * FRW-024 (lane w4): the builder's form state. A rule of the sentence form is read into parts, the
 * interface edits the parts, and a save writes the members the parts stand for and keeps the rest.
 * Criterion 2 is exercised through the parts: every rule of every valid fixture is opened into parts
 * and saved from them, and nothing changes. Node.js 22.18, vitest.
 */
import type { JsonValue } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import {
  checkRuleSet,
  newRuleFromParts,
  openRule,
  ruleParts,
  ruleSentence,
  saveRuleParts,
  type RuleParts,
} from '../src/builder.ts';
import { FIXTURE_CASES } from '../src/fixtures/index.ts';
import { choice, f, text } from '../src/fixtures/build.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const SPOUSE: JsonValue = {
  id: 'r_spouse',
  when: { '==': [f('tenant.maritalStatus'), 'married'] },
  then: [{ show: ['tenant.spouseName'] }, { require: ['tenant.spouseName'] }],
  else: [{ hide: ['tenant.spouseName'] }],
  ext: { note: 'kept' },
};

const FIELDS = [
  choice('tenant.maritalStatus', ['single', 'married']),
  text('tenant.spouseName'),
  text('tenant.note'),
];

describe('the parts of a rule', () => {
  it('reads the sentence form into parts, and no other form', () => {
    const parts = ruleParts(openRule(SPOUSE)!);
    expect(parts).toEqual({
      left: { field: 'tenant.maritalStatus' },
      operator: '==',
      right: { literal: 'married' },
      then: [
        { effect: 'show', keys: ['tenant.spouseName'] },
        { effect: 'require', keys: ['tenant.spouseName'] },
      ],
      otherwise: [{ effect: 'hide', keys: ['tenant.spouseName'] }],
    });
    // A rule that is not a comparison, or has an effect with no phrase, has no parts.
    expect(ruleParts(openRule({ id: 'a', when: true, then: [{ hide: ['x'] }] })!)).toBeNull();
    expect(
      ruleParts(openRule({ id: 'a', when: { '==': [1, 2] }, then: [{ set: { field: 'x' } }] })!),
    ).toBeNull();
  });

  it('has parts exactly where the rule has a sentence, for every rule of the valid fixtures', () => {
    let both = 0;
    for (const c of FIXTURE_CASES) {
      if (c.kind !== 'rules' || 'problems' in (c.expect as object)) continue;
      for (const json of c.rules) {
        const rule = openRule(json)!;
        const parts = ruleParts(rule);
        expect(parts !== null).toBe(ruleSentence(rule) !== null);
        if (parts !== null) both += 1;
      }
    }
    expect(both).toBeGreaterThan(0);
  });
});

describe('a save from the parts (FRW-024 criterion 2)', () => {
  it('writes every valid rule of the fixtures back unchanged when its parts are unchanged', () => {
    let saved = 0;
    for (const c of FIXTURE_CASES) {
      if (c.kind !== 'rules' || 'problems' in (c.expect as object)) continue;
      for (const json of c.rules) {
        const rule = openRule(json)!;
        const parts = ruleParts(rule);
        if (parts === null) continue;
        expect(saveRuleParts(rule, parts)).toEqual(clone(json));
        saved += 1;
      }
    }
    expect(saved).toBeGreaterThan(0);
  });

  it('keeps the identifier and the members it does not read when the parts change', () => {
    const rule = openRule(SPOUSE)!;
    const parts = ruleParts(rule)!;
    const edited: RuleParts = {
      ...parts,
      right: { literal: 'single' },
      otherwise: null,
    };
    expect(saveRuleParts(rule, edited)).toEqual({
      id: 'r_spouse',
      when: { '==': [f('tenant.maritalStatus'), 'single'] },
      then: [{ show: ['tenant.spouseName'] }, { require: ['tenant.spouseName'] }],
      ext: { note: 'kept' },
    });
  });

  it('writes a literal true or false as a boolean, and anything else as text', () => {
    const rule = newRuleFromParts('r_new', {
      left: { field: 'tenant.note' },
      operator: '!=',
      right: { literal: 'true' },
      then: [{ effect: 'disable', keys: ['tenant.note'] }],
      otherwise: null,
    });
    expect(rule).toEqual({
      id: 'r_new',
      when: { '!=': [f('tenant.note'), true] },
      then: [{ disable: ['tenant.note'] }],
    });
  });

  it('builds a rule that the authority’s own check accepts, and refuses an unknown key', () => {
    const good = newRuleFromParts('r_ok', ruleParts(openRule(SPOUSE)!)!);
    expect(checkRuleSet([good], FIELDS)).toEqual({ ok: true });
    const bad = saveRuleParts(openRule(SPOUSE)!, {
      ...ruleParts(openRule(SPOUSE)!)!,
      then: [{ effect: 'show', keys: ['tenant.nobody'] }],
    });
    const check = checkRuleSet([bad], FIELDS);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.problems.some((p) => p.keys?.includes('tenant.nobody'))).toBe(true);
  });
});
