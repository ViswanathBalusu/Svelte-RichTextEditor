/**
 * The grammar that the web view checks before it applies a style value through the CSSOM (I11;
 * FE-067 criterion 4). The mark views call these functions; the DOM application itself needs a
 * browser and is not tested here.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { colourValue, fontFamilyValue, fontSizeValue } from '../src/view-support.ts';

describe('colour values match their grammar (FE-067 criterion 4)', () => {
  it('accepts a six-digit upper-case hex colour and returns it unchanged', () => {
    expect(colourValue('#0A1B2C')).toBe('#0A1B2C');
  });

  it('refuses anything else, so that the default colour applies', () => {
    for (const v of ['#abcdef', 'red', '#GGGGGG', '#0A1B2C;', '#0A1B2C}', '#0A1B2', '', null, 0]) {
      expect(colourValue(v)).toBeUndefined();
    }
  });
});

describe('size values match their grammar (FE-067 criterion 4)', () => {
  it('turns twentieths of a point into points for integers from 20 to 32760', () => {
    expect(fontSizeValue(20)).toBe('1pt');
    expect(fontSizeValue(24)).toBe('1.2pt');
    expect(fontSizeValue(32760)).toBe('1638pt');
  });

  it('refuses out-of-range values, fractions, strings and non-finite numbers', () => {
    for (const v of [19, 32761, 20.5, '24', NaN, Infinity, null, undefined]) {
      expect(fontSizeValue(v)).toBeUndefined();
    }
  });

  it('is never undefined for an integer in range, and always a positive point size', () => {
    fc.assert(
      fc.property(fc.integer({ min: 20, max: 32760 }), (v) => {
        const out = fontSizeValue(v);
        expect(out).toMatch(/^\d+(\.\d+)?pt$/);
        expect(Number.parseFloat(out!)).toBeGreaterThan(0);
      }),
    );
  });
});

describe('family values match their grammar (FE-067 criterion 4)', () => {
  it('quotes a plain family name', () => {
    expect(fontFamilyValue('Noto Serif')).toBe('"Noto Serif"');
  });

  it('refuses names that could close the quote or start another declaration', () => {
    for (const v of [
      'Arial"; background: red',
      'a{}',
      'Times\\',
      '<b>',
      '',
      '-leading',
      'x'.repeat(65),
      42,
    ]) {
      expect(fontFamilyValue(v)).toBeUndefined();
    }
  });

  it('never returns a value that carries a character outside the quoted name', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        const out = fontFamilyValue(s);
        if (out === undefined) return;
        const inner = out.slice(1, -1);
        expect(out.startsWith('"') && out.endsWith('"')).toBe(true);
        expect(inner).toMatch(/^[A-Za-z0-9 ._+-]+$/);
      }),
    );
  });
});
