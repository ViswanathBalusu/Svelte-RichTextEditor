/**
 * The measurement cache (FE-079), in Node.js with deterministic fake providers. Canvas and font-file
 * providers are not covered here: canvas needs a browser (see canvas.universal.test.ts), and the S5
 * comparison is not built.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceTableMeasurer,
  cachingMeasurer,
  countingMeasurer,
  fixedWidthMeasurer,
  SYNTHETIC_SERIF,
  type FontKey,
} from './measure.ts';

const font = (sizePt: number, extra: Partial<FontKey> = {}): FontKey => ({
  family: 'alias-a',
  sizePt,
  bold: false,
  italic: false,
  ...extra,
});

describe('the measurement cache (FE-079)', () => {
  it('answers a repeated key from the cache, without calling the provider again', () => {
    const { measurer, stats } = countingMeasurer(advanceTableMeasurer(SYNTHETIC_SERIF));
    const cached = cachingMeasurer(measurer, 0);

    const first = cached.advance(font(10), 'Hello world');
    const second = cached.advance(font(10), 'Hello world');
    expect(second).toBe(first);
    expect(stats.advanceCalls).toBe(1);

    // Any change to the key is a miss: size, text, weight, slant or alias.
    cached.advance(font(11), 'Hello world');
    cached.advance(font(10), 'Hello worlds');
    cached.advance(font(10, { bold: true }), 'Hello world');
    cached.advance(font(10, { italic: true }), 'Hello world');
    cached.advance(font(10, { family: 'alias-b' }), 'Hello world');
    expect(stats.advanceCalls).toBe(6);
  });

  it('caches vertical metrics by font key as well', () => {
    const { measurer, stats } = countingMeasurer(fixedWidthMeasurer());
    const cached = cachingMeasurer(measurer, 0);
    const a = cached.lineMetrics(font(12));
    const b = cached.lineMetrics(font(12));
    expect(b).toEqual(a);
    expect(stats.lineMetricsCalls).toBe(1);
  });

  it('misses every earlier entry when the font epoch advances', () => {
    const inner = countingMeasurer(advanceTableMeasurer(SYNTHETIC_SERIF));
    const epochZero = cachingMeasurer(inner.measurer, 0);
    epochZero.advance(font(10), 'abc');
    epochZero.advance(font(10), 'abc');
    expect(inner.stats.advanceCalls).toBe(1);

    // A font load advances the epoch: the new cache holds no earlier entry, so the provider runs.
    const epochOne = cachingMeasurer(inner.measurer, 1);
    epochOne.advance(font(10), 'abc');
    expect(inner.stats.advanceCalls).toBe(2);
    expect(epochOne.id).not.toBe(epochZero.id);
  });

  it('gives the same answers as the provider it wraps', () => {
    const inner = advanceTableMeasurer(SYNTHETIC_SERIF);
    const cached = cachingMeasurer(inner, 0);
    for (const text of ['', 'a', 'Wiki pedia, 2026.', 'ﬁ ligature and 字']) {
      expect(cached.advance(font(9.5), text)).toBe(inner.advance(font(9.5), text));
    }
  });

  it('passes per-unit advances through the cache only when the provider offers them', () => {
    const withUnits = cachingMeasurer(fixedWidthMeasurer(), 0);
    expect(withUnits.advances?.(font(10), 'ab')).toEqual([5, 5]);
    const without = cachingMeasurer(
      {
        id: 'no-units',
        advance: () => 1,
        lineMetrics: () => ({ ascent: 1, descent: 0, lineGap: 0 }),
      },
      0,
    );
    expect(without.advances).toBeUndefined();
  });
});

describe('deterministic fake providers for Node.js tests (FE-079)', () => {
  it('return the same advances and metrics on every call', () => {
    const a = advanceTableMeasurer(SYNTHETIC_SERIF);
    const b = advanceTableMeasurer(SYNTHETIC_SERIF);
    const text = 'Typeset, once more: illi.';
    expect(a.advance(font(10), text)).toBe(b.advance(font(10), text));
    expect(a.advances?.(font(10), text)).toEqual(b.advances?.(font(10), text));
    expect(a.lineMetrics(font(10))).toEqual(b.lineMetrics(font(10)));
    const sum = a.advances!(font(10), text).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(a.advance(font(10), text), 9);
  });
});
