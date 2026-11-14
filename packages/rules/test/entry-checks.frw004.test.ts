// The static entry checks of FRW-004 (12 §3.2; ADR 0030 §1, §8): number bounds compared as
// decimals, text length limits counted in code points, the presets, and `required` for empty
// entries. The control's `aria-invalid` and message (criterion 1 of FRW-004) are the editor's and
// are not tested here; this file tests the one implementation the editor will call.
import { describe, expect, it } from 'vitest';
import { type FieldInfo, checkEntry } from '../src/fields.ts';
import { validateFields } from '../src/validate.ts';

describe('FRW-004 number bounds', () => {
  const income: FieldInfo = {
    key: 'income',
    kind: 'number',
    validation: { min: '0', max: '1000000' },
  };

  it('refuses -1 and 1000000.01 and accepts the bounds themselves', () => {
    expect(checkEntry(income, '-1')).toEqual([expect.objectContaining({ code: 'min' })]);
    expect(checkEntry(income, '1000000.01')).toEqual([expect.objectContaining({ code: 'max' })]);
    expect(checkEntry(income, '0')).toEqual([]);
    expect(checkEntry(income, '1000000')).toEqual([]);
    expect(checkEntry(income, '0.00')).toEqual([]);
  });

  it('reports the same field through validateFields', () => {
    const report = validateFields([income], { income: '1000000.01' });
    expect(report.map((r) => [r.key, r.problems.map((p) => p.code)])).toEqual([
      ['income', ['max']],
    ]);
    expect(validateFields([income], { income: '1000000' })).toEqual([]);
  });

  it('compares bounds exactly, never as binary floats', () => {
    // 0.1 and 0.3 have no exact binary form; the decimal comparison still sees 0.30000...01 as above 0.3.
    const f: FieldInfo = { key: 'n', kind: 'number', validation: { min: '0', max: '0.3' } };
    expect(checkEntry(f, '0.3')).toEqual([]);
    expect(checkEntry(f, '0.30000000000000000001')).toEqual([
      expect.objectContaining({ code: 'max' }),
    ]);
  });
});

describe('FRW-004 text length limits', () => {
  const code: FieldInfo = {
    key: 'code',
    kind: 'text',
    validation: { minLength: 2, maxLength: 3 },
  };

  it('reports an entry shorter or longer than the limits, with a message', () => {
    const short = checkEntry(code, 'a');
    expect(short).toEqual([expect.objectContaining({ code: 'min_length' })]);
    expect(short[0]!.message).toMatch(/at least 2/);
    const long = checkEntry(code, 'abcd');
    expect(long).toEqual([expect.objectContaining({ code: 'max_length' })]);
    expect(long[0]!.message).toMatch(/at most 3/);
  });

  it('counts code points, not UTF-16 units', () => {
    // Two emoji are four UTF-16 units but two code points: inside the limits.
    expect(checkEntry(code, '\u{1F600}\u{1F600}')).toEqual([]);
    // Three emoji are six UTF-16 units and three code points: still inside maxLength 3.
    expect(checkEntry(code, '\u{1F600}\u{1F600}\u{1F600}')).toEqual([]);
    // Four emoji are four code points: refused.
    expect(checkEntry(code, '\u{1F600}'.repeat(4))).toEqual([
      expect.objectContaining({ code: 'max_length' }),
    ]);
  });
});

describe('FRW-004 presets', () => {
  const preset = (name: 'email' | 'phone' | 'postcode'): FieldInfo => ({
    key: name,
    kind: 'text',
    validation: { preset: name },
  });

  it('refuses an e-mail address that does not match the preset', () => {
    expect(checkEntry(preset('email'), 'jane@')).toEqual([
      expect.objectContaining({ code: 'preset' }),
    ]);
    expect(checkEntry(preset('email'), 'jane@example.com')).toEqual([]);
  });

  it('refuses a telephone number with too few digits and accepts a plain international one', () => {
    expect(checkEntry(preset('phone'), '12')).toEqual([
      expect.objectContaining({ code: 'preset' }),
    ]);
    expect(checkEntry(preset('phone'), '+44 20 7946 0958')).toEqual([]);
  });

  it('refuses a postcode of one character and accepts a UK postcode', () => {
    expect(checkEntry(preset('postcode'), 'A')).toEqual([
      expect.objectContaining({ code: 'preset' }),
    ]);
    expect(checkEntry(preset('postcode'), 'SW1A 1AA')).toEqual([]);
  });

  it('applies a preset to an empty entry only through required (an empty entry passes)', () => {
    expect(checkEntry(preset('email'), '')).toEqual([]);
    expect(checkEntry(preset('email'), null)).toEqual([]);
  });
});

describe('FRW-004 required and empty', () => {
  const spouse: FieldInfo = { key: 'spouse', kind: 'text', required: true };
  const income: FieldInfo = { key: 'income', kind: 'number', required: true };

  it('reports a required field that is null, an empty string or absent as required', () => {
    for (const value of [null, '', undefined] as const) {
      const report = validateFields([spouse], value === undefined ? {} : { spouse: value });
      expect(report.map((r) => [r.key, r.problems.map((p) => p.code)])).toEqual([
        ['spouse', ['required']],
      ]);
    }
  });

  it('reports a required number that is null as required, and a filled one not at all', () => {
    expect(validateFields([income], { income: null })[0]!.problems[0]!.code).toBe('required');
    expect(validateFields([income], { income: '0' })).toEqual([]);
  });
});
