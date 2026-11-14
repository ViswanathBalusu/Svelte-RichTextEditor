/**
 * Justification by computed word spacing (FE-091, criterion 2), in Node.js. The property cases use a
 * seeded generator (mulberry32), so every run is repeatable.
 */
import { describe, expect, it } from 'vitest';
import { justifyLine, stretchableSpaces } from './justify.ts';

/** mulberry32: `random(n)` is a whole number in [0, n). */
function mulberry32(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(u * n);
  };
}

const ALPHABET = ['a', 'b', 'W', ' ', ' ', ' ', '\t', '.'];

function randomLine(random: (n: number) => number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ALPHABET[random(ALPHABET.length)]!;
  return s;
}

describe('justification by computed word spacing (FE-091, criterion 2)', () => {
  it('stretches ordinary and no-break spaces, and never a tab', () => {
    // 'a' NBSP 'b' SP 'c' TAB 'd' SP 'e': the spaces at 1, 3 and 7 stretch, the tab at 5 does not.
    const text = 'a b c\td e';
    expect(stretchableSpaces(text)).toEqual([1, 3, 7]);
    expect(stretchableSpaces('a\tb\tc')).toEqual([]);
  });

  it('excludes the trailing run of spaces, no-break spaces and tabs at the end of the line', () => {
    expect(stretchableSpaces('ab   \t')).toEqual([]);
    const body = 'one two three';
    expect(stretchableSpaces(body + '   \t')).toEqual(stretchableSpaces(body));
    // A space before a word stays; the trailing blanks after the word do not.
    expect(stretchableSpaces('x y  ')).toEqual([1]);
  });

  it('gives a line with no stretchable space no word spacing', () => {
    expect(justifyLine('abc', 30, 60)).toMatchObject({ wordSpacing: 0, spaces: [] });
    expect(justifyLine('abc   ', 30, 60)).toMatchObject({ wordSpacing: 0, spaces: [] });
  });

  it('does not shrink a line that is already at or over its target width', () => {
    expect(justifyLine('a b c', 100, 100).wordSpacing).toBe(0);
    expect(justifyLine('a b c', 120, 100).wordSpacing).toBe(0);
    expect(justifyLine('a b c', Number.NaN, 100).wordSpacing).toBe(0);
    expect(justifyLine('a b c', 50, Number.POSITIVE_INFINITY).wordSpacing).toBe(0);
  });

  it('gives the extra space to the stretchable spaces as one equal word spacing (property)', () => {
    const random = mulberry32(0xf091);
    for (let i = 0; i < 400; i++) {
      const text = randomLine(random, 1 + random(40));
      const natural = 10 + random(500);
      const target = natural + random(300);
      const result = justifyLine(text, natural, target);
      const count = stretchableSpaces(text).length;
      expect(result.spaces).toEqual(stretchableSpaces(text));
      if (count === 0 || target <= natural) {
        expect(result.wordSpacing).toBe(0);
        continue;
      }
      // Every stretchable space receives the same value, and together they add the extra space.
      expect(result.wordSpacing * count).toBeCloseTo(target - natural, 9);
      expect(result.wordSpacing).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns frozen results, and the same result for the same input', () => {
    const a = justifyLine('one two three', 120, 180);
    const b = justifyLine('one two three', 120, 180);
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.spaces)).toBe(true);
  });
});
