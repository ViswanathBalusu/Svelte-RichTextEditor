/**
 * Number formats for list labels, caption sequences and footnote marks (03 §4.1, §7; CDM-042).
 * The rules for the values 03 leaves open (zero, large numbers, footnote symbols) are recorded in
 * docs/adr/0032-layout-semantics.md and pinned by `fixtures/semantics/numbering-lists.json`.
 */
import type { FootnoteFormat } from '../cascade/styles.ts';

/** The level formats of 03 §4.1. */
export type NumberFormat =
  | 'decimal'
  | 'lowerLetter'
  | 'upperLetter'
  | 'lowerRoman'
  | 'upperRoman'
  | 'lowerGreek'
  | 'bullet'
  | 'none';

/** The 24 lower-case Greek letters of Word's custom sequence "α, β, γ, ...", without final sigma. */
export const GREEK_LOWER: readonly string[] = [...'αβγδεζηθικλμνξοπρστυφχψω'];

/**
 * Lower-case Greek letters in the way `letters` writes Latin ones: α to ω, then αα to ωω, then ααα.
 * That is the rule the model applies to every letter format; Word's own rule past the 24th letter was
 * not measured, so the repeat is the same as for Latin letters (03 §7.1).
 */
export function greekLetters(value: number): string {
  const letter = GREEK_LOWER[(value - 1) % GREEK_LOWER.length]!;
  return letter.repeat(Math.floor((value - 1) / GREEK_LOWER.length) + 1);
}

/** The bullet of a `bullet` level whose `bulletChar` is null. */
export const DEFAULT_BULLET = '•';

/** Footnote symbols in order; after the last, the cycle repeats with each symbol doubled, and so on. */
export const FOOTNOTE_SYMBOLS: readonly string[] = ['*', '†', '‡', '§'];

const ROMAN: readonly (readonly [number, string])[] = [
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
];

/** Lower-case Roman numerals; thousands are written as repeated `m`, so every positive value has one. */
export function roman(value: number): string {
  let out = 'm'.repeat(Math.floor(value / 1000));
  let rest = value % 1000;
  for (const [n, digits] of ROMAN) {
    while (rest >= n) {
      out += digits;
      rest -= n;
    }
  }
  return out;
}

/** Lower-case letters as Word writes them: a to z, then aa to zz, then aaa, and so on. */
export function letters(value: number): string {
  const letter = String.fromCharCode(97 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

/**
 * Formats a counter value. Letters and Roman numerals have no zero, so a value below one prints
 * nothing, as Word does (owner decision 238); a negative value (which only an uncounted level with
 * `start` 0 could hold) counts as 0.
 * `bullet` gives the bullet character and `none` the empty string.
 */
export function formatNumber(value: number, format: string, bulletChar?: string | null): string {
  const n = Math.max(0, Math.trunc(value));
  switch (format) {
    case 'bullet':
      return bulletChar ?? DEFAULT_BULLET;
    case 'none':
      return '';
    case 'lowerLetter':
      return n < 1 ? '' : letters(n);
    case 'upperLetter':
      return n < 1 ? '' : letters(n).toUpperCase();
    case 'lowerRoman':
      return n < 1 ? '' : roman(n);
    case 'upperRoman':
      return n < 1 ? '' : roman(n).toUpperCase();
    case 'lowerGreek':
      return n < 1 ? '' : greekLetters(n);
    default:
      return String(n);
  }
}

/** A footnote mark: the number in `settings.footnoteFormat` (03 §4.1). */
export function footnoteMark(value: number, format: FootnoteFormat): string {
  if (format !== 'symbol') return formatNumber(value, format);
  const n = Math.max(1, Math.trunc(value));
  const symbol = FOOTNOTE_SYMBOLS[(n - 1) % FOOTNOTE_SYMBOLS.length]!;
  return symbol.repeat(Math.floor((n - 1) / FOOTNOTE_SYMBOLS.length) + 1);
}

/** The formats a `seq` field's `format` may name; anything else is decimal (ADR 0032). */
const SEQUENCE_FORMATS = new Set([
  'decimal',
  'lowerLetter',
  'upperLetter',
  'lowerRoman',
  'upperRoman',
]);

export function sequenceFormat(format: unknown): NumberFormat {
  return typeof format === 'string' && SEQUENCE_FORMATS.has(format)
    ? (format as NumberFormat)
    : 'decimal';
}
