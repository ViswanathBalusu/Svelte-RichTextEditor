// Page numbers from a page section's start and format (FE-137 criterion 4, lane V-FE-129-141).
// A page field prints the number of its page in the section's format; a section that starts at a
// number counts from it. Tests run in Node.js only.
import { describe, expect, it } from 'vitest';
import { fieldText, pageNumberOf, pageNumberText } from '../index.ts';

describe('page numbers follow the page section start and format (FE-137)', () => {
  it('counts from the section start, page by page', () => {
    expect(pageNumberOf(5, 0)).toBe(5);
    expect(pageNumberOf(5, 2)).toBe(7);
    expect(pageNumberOf(0, 0)).toBe(0);
  });

  it('refuses a fractional start or a negative index', () => {
    expect(() => pageNumberOf(1.5, 0)).toThrow(RangeError);
    expect(() => pageNumberOf(1, -1)).toThrow(RangeError);
  });

  it('prints the number in each page number format', () => {
    expect(pageNumberText(4, 'decimal')).toBe('4');
    expect(pageNumberText(4, 'lowerRoman')).toBe('iv');
    expect(pageNumberText(4, 'upperRoman')).toBe('IV');
    expect(pageNumberText(1, 'lowerLetter')).toBe('a');
    expect(pageNumberText(27, 'upperLetter')).toBe('AA');
  });

  it('gives a page field the text of its page, in its section format', () => {
    // Section starts at 3 in upper Roman: the third page prints "V".
    const number = pageNumberOf(3, 2);
    const r = fieldText({ kind: 'page' }, { pageNumber: number, pageNumberFormat: 'upperRoman' });
    expect(r).toEqual({ computed: true, text: 'V' });
  });

  it('keeps the decimal format when the section names none', () => {
    const r = fieldText({ kind: 'page' }, { pageNumber: 7 });
    expect(r).toEqual({ computed: true, text: '7' });
  });

  it('gives a page count in decimal, whatever the page number format', () => {
    const r = fieldText({ kind: 'pageCount' }, { pageCount: 12, pageNumberFormat: 'lowerRoman' });
    expect(r).toEqual({ computed: true, text: '12' });
  });

  it('still computes no page field when the typesetter has given no number', () => {
    expect(fieldText({ kind: 'page' }).computed).toBe(false);
    expect(fieldText({ kind: 'pageCount' }).computed).toBe(false);
  });
});
