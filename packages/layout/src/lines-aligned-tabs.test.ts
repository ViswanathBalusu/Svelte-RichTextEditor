/**
 * Centre, right and decimal tab stops in the first-fit breaker (FE-081 criterion 3), in Node.js.
 *
 * A one-point em and a one-point font size make every character one point wide, so the expected
 * widths below are counted by hand. The break opportunities are none: each case is one line, so the
 * line's width is the position where its text ends. Sweeps use a seeded generator (mulberry32).
 */
import { describe, expect, it } from 'vitest';
import { breakParagraph, type BreakOpportunities, type ParagraphInput } from './lines.ts';
import { fixedWidthMeasurer, type FontKey } from './measure.ts';

const noBreaks: BreakOpportunities = { opportunities: () => [] };
const measurer = fixedWidthMeasurer({ emWidth: 1 });
const font: FontKey = { family: 'synthetic-serif', sizePt: 1, bold: false, italic: false };

function oneLine(text: string, tabStops: ParagraphInput['tabStops'], columnWidth = 1000): number {
  const fragment = breakParagraph(
    {
      blockId: 'p1',
      runs: [{ text, font }],
      markFont: font,
      columnWidth,
      line: { rule: 'multiple', factor: 1 },
      ...(tabStops ? { tabStops } : {}),
    },
    measurer,
    noBreaks,
  );
  expect(fragment.lines).toHaveLength(1);
  return fragment.lines[0]!.width;
}

/** Seeded generator (mulberry32): the same seed gives the same sequence on every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('aligned tab stops (FE-081 criterion 3)', () => {
  it('ends the text after a right stop at the stop', () => {
    // 'a' is 1 pt, the tab moves to the right stop at 50, and 'bcd' (3 pt) ends there.
    expect(oneLine('a\tbcd', [{ position: 50, align: 'right' }])).toBe(50);
  });

  it('centres the text after a centre stop on the stop', () => {
    // 'bcd' is 3 pt wide, so it starts at 48.5 and ends at 51.5.
    expect(oneLine('a\tbcd', [{ position: 50, align: 'center' }])).toBe(51.5);
  });

  it('puts the first full stop of the text after a decimal stop on the stop', () => {
    // 'bb' is 2 pt before the full stop, so the segment starts at 48 and ends at 53.
    expect(oneLine('a\tbb.cc', [{ position: 50, align: 'decimal' }])).toBe(53);
  });

  it('ends a segment with no full stop at a decimal stop', () => {
    // No full stop: the whole 3 pt segment is placed before the stop, so it ends at 50.
    expect(oneLine('a\tbbb', [{ position: 50, align: 'decimal' }])).toBe(50);
  });

  it('starts a segment wider than the space left at the current position', () => {
    // 'bcdef' is 5 pt, more than the 3 pt before the stop at 3: the segment starts at 1, not at -2.
    expect(oneLine('a\tbcdef', [{ position: 3, align: 'right' }])).toBe(6);
  });

  it('applies each stop to the text after its own tab', () => {
    // Right stop at 20 takes 'bb' (ends at 20); centre stop at 40 takes 'c' (1 pt, starts at 39.5).
    const width = oneLine('a\tbb\tc', [
      { position: 20, align: 'right' },
      { position: 40, align: 'center' },
    ]);
    expect(width).toBe(40.5);
  });

  it('keeps a bare number as a left stop', () => {
    expect(oneLine('a\tbcd', [50])).toBe(53);
    expect(oneLine('a\tbcd', [{ position: 50, align: 'left' }])).toBe(53);
  });

  it('gives a right-aligned segment the same end on every seeded case', () => {
    const next = rng(0x5eed);
    for (let k = 0; k < 300; k++) {
      const len = 1 + Math.floor(next() * 8);
      const stop = 10 + Math.floor(next() * 80);
      const seg = 'x'.repeat(len);
      // The stop is past 'a' and the segment, so the segment is placed before it and ends at it.
      if (stop < 1 + len) continue;
      expect(oneLine(`a\t${seg}`, [{ position: stop, align: 'right' }])).toBe(stop);
    }
  });

  it('centres a seeded segment on its stop, with the half-width on either side', () => {
    const next = rng(0xc0ffee);
    for (let k = 0; k < 300; k++) {
      const len = 1 + Math.floor(next() * 8);
      const stop = 10 + Math.floor(next() * 80);
      if (stop - len / 2 < 1) continue;
      const seg = 'x'.repeat(len);
      expect(oneLine(`a\t${seg}`, [{ position: stop, align: 'center' }])).toBe(stop + len / 2);
    }
  });

  it('places the first full stop of a seeded segment on the decimal stop', () => {
    const next = rng(0xdec1);
    for (let k = 0; k < 300; k++) {
      const before = Math.floor(next() * 6);
      const after = Math.floor(next() * 6);
      const stop = 20 + Math.floor(next() * 60);
      if (stop - before < 1) continue;
      const seg = `${'x'.repeat(before)}.${'y'.repeat(after)}`;
      const len = seg.length;
      // The segment starts at stop - before and ends len characters later.
      expect(oneLine(`a\t${seg}`, [{ position: stop, align: 'decimal' }])).toBe(
        stop - before + len,
      );
    }
  });
});
