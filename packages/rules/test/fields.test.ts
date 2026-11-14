// The static checks of fields (FRW-003, FRW-004, FRW-015, FRW-018; ADR 0030 §8): the value type
// check agrees with model.validate() (invariant I15), a field's own definition is checked
// (limits that do not apply, limits in the wrong order, a pattern outside the subset), the presets
// are inside the subset, and the bounds the rules share with the CDM grammar are equal to it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JsonValue } from '@docedit/model';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { patternLengthBound, ruleAttributeBounds } from '../src/cdm.ts';
import { evaluateRules } from '../src/evaluate.ts';
import {
  type FieldInfo,
  type FieldKind,
  PRESETS,
  PRESET_NAMES,
  checkEntry,
  checkFieldDefinition,
  checkFieldValue,
  presetPattern,
} from '../src/fields.ts';
import { compileRules, rulesFromList } from '../src/language.ts';
import { LIMITS } from '../src/limits.ts';
import { validateFields } from '../src/validate.ts';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const root = resolve(import.meta.dirname, '../../..');
const example = JSON.parse(
  readFileSync(resolve(root, 'packages/model/fixtures/example-03-12.json'), 'utf8'),
) as J;
const SIGNED = { asset: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8c9d', mode: 'drawn' };

/** model.validate() on a document holding one field with this value: any violation at the value? */
function modelRefuses(kind: FieldKind, value: JsonValue): boolean {
  const d = structuredClone(example);
  d['requires'] = ['fields'];
  const attrs: J = { id: 'fField0000000001', key: 'k', kind, label: 'K', value };
  if (kind === 'choice')
    attrs['options'] = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
  d['doc'].content[1].content[2].content = [{ type: 'form_field', attrs }];
  return validate(d).violations.some((v) => v.path.endsWith('/value'));
}

const SAMPLES: Array<[FieldKind, JsonValue]> = [
  ['text', 'hello'],
  ['text', ''],
  ['text', 5],
  ['text', true],
  ['text', 'x'.repeat(4096)],
  ['text', 'x'.repeat(4097)],
  ['text', 'é'.repeat(2048)],
  ['text', 'é'.repeat(2049)],
  ['number', '12.50'],
  ['number', '-0'],
  ['number', '0.000001'],
  ['number', 12],
  ['number', 12.5],
  ['number', '1e3'],
  ['number', '+1'],
  ['number', '01'],
  ['number', '.5'],
  ['number', '1'.repeat(64)],
  ['date', '2024-02-29'],
  ['date', '2026-02-29'],
  ['date', '1900-02-29'],
  ['date', '2000-02-29'],
  ['date', '0100-01-01'],
  ['date', '9999-12-31'],
  ['date', '2026-13-01'],
  ['date', '2026-11-06T00:00:00Z'],
  ['date', 20261106],
  ['dateSigned', '2026-11-06'],
  ['dateSigned', '06.11.2026'],
  ['checkbox', true],
  ['checkbox', false],
  ['checkbox', 'true'],
  ['checkbox', 1],
  ['choice', 'yes'],
  ['choice', 'maybe'],
  ['choice', 1],
  ['signature', SIGNED],
  ['signature', { ...SIGNED, mode: 'stamped' }],
  ['signature', { asset: 'not-a-uuid', mode: 'typed' }],
  ['signature', { ...SIGNED, extra: 1 }],
  ['initials', SIGNED],
  ['initials', 'JD'],
  ['formula', '12.5'],
  ['formula', 'twelve'],
  ['formula', 12],
  ['attachment', 'file'],
];

describe('field values (I15)', () => {
  it('gives the same verdict as model.validate() for every kind', () => {
    // Three known differences are left out and reported: the model refuses dates before the year
    // 0100 (it reads them through Date.UTC, which maps the years 0 to 99 to 1900 to 1999); it does
    // not apply the 4 KiB limit to formula strings; and it accepts number values longer than the
    // 64 characters of the model's own isDecimalString.
    for (const [kind, value] of SAMPLES)
      expect(
        checkFieldValue({ kind, options: ['yes', 'no'] }, value) !== null,
        `${kind} ${JSON.stringify(value).slice(0, 40)}`,
      ).toBe(modelRefuses(kind, value));
    for (const v of [null] as const)
      for (const [kind] of SAMPLES) expect(checkFieldValue({ kind }, v)).toBeNull();
  });

  it('checks a signature image against the attached assets when they are given', () => {
    expect(
      checkFieldValue({ kind: 'signature' }, SIGNED, { attachedAssets: new Set([SIGNED.asset]) }),
    ).toBeNull();
    expect(
      checkFieldValue({ kind: 'signature' }, SIGNED, { attachedAssets: new Set() }),
    ).toMatchObject({ code: 'not_attached' });
  });
});

describe('field definitions', () => {
  it('refuses a validation pattern outside the subset, naming the construct (FRW-018)', () => {
    const field: FieldInfo = {
      key: 'iban',
      kind: 'text',
      validation: { pattern: '([A-Z]{2})\\1' },
    };
    expect(checkFieldDefinition(field)).toEqual([
      expect.objectContaining({
        code: 'pattern_unsupported',
        path: '/validation/pattern',
        construct: 'back-reference',
      }),
    ]);
    expect(
      checkFieldDefinition({ key: 'x', kind: 'text', validation: { pattern: '(?<=a)b' } })[0],
    ).toMatchObject({
      construct: 'look-behind',
    });
    expect(
      checkFieldDefinition({ key: 'x', kind: 'text', validation: { pattern: '[A-Z]{2}[0-9]+' } }),
    ).toEqual([]);
  });

  it('refuses limits that do not apply to the kind or that contradict each other', () => {
    expect(
      checkFieldDefinition({ key: 'n', kind: 'number', validation: { minLength: 2 } }),
    ).toEqual([expect.objectContaining({ code: 'not_applicable', path: '/validation/minLength' })]);
    expect(checkFieldDefinition({ key: 't', kind: 'text', validation: { min: '1' } })).toEqual([
      expect.objectContaining({ code: 'not_applicable', path: '/validation/min' }),
    ]);
    expect(
      checkFieldDefinition({ key: 'n', kind: 'number', validation: { min: '10', max: '9.99' } }),
    ).toEqual([expect.objectContaining({ code: 'bad_limit', path: '/validation/min' })]);
    expect(
      checkFieldDefinition({ key: 't', kind: 'text', validation: { minLength: 5, maxLength: 4 } }),
    ).toEqual([expect.objectContaining({ code: 'bad_limit' })]);
    expect(checkFieldDefinition({ key: 'c', kind: 'choice', options: ['a', 'a'] })).toEqual([
      expect.objectContaining({ code: 'duplicate_option', path: '/options/1/id' }),
    ]);
  });

  it('defines the presets inside the pattern subset and its limits', () => {
    for (const name of PRESET_NAMES) {
      const p = presetPattern(name);
      expect(p.source).toBe(PRESETS[name]);
      expect(p.size).toBeLessThanOrEqual(LIMITS.patternProgram);
    }
  });
});

describe('validateFields (FRW-004)', () => {
  const fields: FieldInfo[] = [
    { key: 'status', kind: 'choice', options: ['single', 'married'] },
    { key: 'spouse', kind: 'text', required: true },
    { key: 'income', kind: 'number', required: true, validation: { min: '0', max: '1000000' } },
    { key: 'email', kind: 'text', validation: { preset: 'email' } },
    { key: 'end', kind: 'date' },
  ];
  const rules = compileRules(
    rulesFromList([
      {
        id: 'r_spouse',
        when: { '==': [{ field: 'status' }, 'married'] },
        then: [{ show: ['spouse'] }],
        else: [{ hide: ['spouse'] }],
      },
      {
        id: 'r_end',
        when: { '>=': [{ field: 'end' }, '2026-01-01'] },
        then: [],
        else: [{ validate: { fields: ['end'], message: 'Choose a date in 2026 or later.' } }],
      },
    ]),
    { fields },
  );

  it('reports required, type, limit, preset and rule problems of visible fields only', () => {
    if (!rules.ok) throw new Error(JSON.stringify(rules.problems));
    const values = { status: 'single', income: '1000000.01', email: 'jane@', end: '2025-12-31' };
    const report = validateFields(
      fields,
      values,
      evaluateRules(rules.ruleSet, values, { roles: [] }),
    );
    expect(report.map((r) => [r.key, r.problems.map((p) => p.code)])).toEqual([
      ['income', ['max']],
      ['email', ['preset']],
      ['end', ['rule']],
    ]);
    expect(report[2]!.problems[0]).toMatchObject({
      rule: 'r_end',
      message: 'Choose a date in 2026 or later.',
    });
    // Married: the spouse's name is shown, so its requirement applies.
    const married = { ...values, status: 'married', income: '-1' };
    const r2 = validateFields(
      fields,
      married,
      evaluateRules(rules.ruleSet, married, { roles: [] }),
    );
    expect(r2.map((r) => [r.key, r.problems.map((p) => p.code)])).toEqual([
      ['spouse', ['required']],
      ['income', ['min']],
      ['email', ['preset']],
      ['end', ['rule']],
    ]);
    // Without rules, the static flags alone.
    expect(validateFields(fields, {}).map((r) => r.key)).toEqual(['spouse', 'income']);
  });

  it('compares bounds as decimals, never as binary floats', () => {
    const f: FieldInfo = { key: 'n', kind: 'number', validation: { min: '0.1', max: '0.3' } };
    expect(checkEntry(f, '0.30')).toEqual([]);
    expect(checkEntry(f, '0.300000000000000000001')).toEqual([
      expect.objectContaining({ code: 'max' }),
    ]);
    expect(checkEntry(f, '0.1')).toEqual([]);
    expect(checkEntry(f, '0.09999999999999999999')).toEqual([
      expect.objectContaining({ code: 'min' }),
    ]);
  });
});

describe('bounds shared with the CDM grammar', () => {
  it('are equal to the grammar of rule_def and validation.pattern', () => {
    for (const b of Object.values(ruleAttributeBounds()))
      expect(b).toEqual({ maxBytes: LIMITS.ruleAttributeBytes, maxDepth: LIMITS.ruleDepth });
    expect(patternLengthBound()).toBe(LIMITS.patternLength);
  });
});
