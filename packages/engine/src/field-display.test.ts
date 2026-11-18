// FRW-079 criterion 4: `format` changes the display only. The function turns a stored value into
// the text a control shows while nobody edits it, and it never changes the value it is given.
import { describe, expect, it } from 'vitest';
import { formatFieldValue } from './field-display.ts';

describe('the display of a number field (12 §3.2)', () => {
  it.each([
    ['12.5', { decimals: 2 }, '12.50'],
    ['12', { decimals: 2 }, '12.00'],
    ['12.345', { decimals: 2 }, '12.35'],
    ['12.344', { decimals: 2 }, '12.34'],
    ['-12.345', { decimals: 2 }, '-12.35'],
    ['0.995', { decimals: 2 }, '1.00'],
    ['999.5', { decimals: 0 }, '1000'],
    ['1234.5', { prefix: '€', suffix: ' a month' }, '€1234.5 a month'],
    ['1234.5', { decimals: 1, prefix: '$' }, '$1234.5'],
  ])('shows %s under %j as %s', (value, format, text) => {
    expect(formatFieldValue('number', value, format)).toBe(text);
  });

  it('shows the value as it is when the format changes nothing, or the value is no decimal', () => {
    expect(formatFieldValue('number', '12.5', {})).toBeNull();
    expect(formatFieldValue('number', '12.5', null)).toBeNull();
    expect(formatFieldValue('number', '12,5', { decimals: 2 })).toBeNull();
    expect(formatFieldValue('number', '', { decimals: 2 })).toBeNull();
    expect(formatFieldValue('number', null, { decimals: 2 })).toBeNull();
  });

  it('does not read a number as a binary float', () => {
    // 0.1 + 0.2 style values and values beyond 2^53 keep every digit.
    expect(formatFieldValue('number', '9007199254740993.5', { decimals: 1 })).toBe(
      '9007199254740993.5',
    );
    expect(formatFieldValue('number', '0.30000000000000004', { decimals: 3 })).toBe('0.300');
  });
});

describe('the display of a date field (12 §3.2)', () => {
  it.each([
    ['2026-11-17', 'dd.MM.yyyy', '17.11.2026'],
    ['2026-11-07', 'd/M/yy', '7/11/26'],
    ['2026-01-31', "yyyy 'week' MM", '2026 week 01'],
  ])('shows %s under %s as %s', (value, datePattern, text) => {
    expect(formatFieldValue('date', value, { datePattern })).toBe(text);
  });

  it('shows the value as it is without a pattern, or when the date does not exist', () => {
    expect(formatFieldValue('date', '2026-11-17', {})).toBeNull();
    expect(formatFieldValue('date', '17 November', { datePattern: 'dd.MM.yyyy' })).toBeNull();
  });
});

it('formats no other kind', () => {
  for (const kind of ['text', 'checkbox', 'choice', 'signature'])
    expect(formatFieldValue(kind, '12.5', { decimals: 2, prefix: '€' })).toBeNull();
});
