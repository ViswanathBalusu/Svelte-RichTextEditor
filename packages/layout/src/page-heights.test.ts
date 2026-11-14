/**
 * Page heights and the visible-page window (FE-089 criterion 2; engine half of FE-092). Node.js
 * only: the store and the window are plain data, so no browser or DOM is needed.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pageHeights, visiblePages } from './page-heights.ts';

describe('page heights (FE-089 criterion 2)', () => {
  it('estimates an uncomputed page with the fallback until a page is computed', () => {
    const h = pageHeights(700);
    expect(h.heightOf(5)).toEqual({ height: 700, estimated: true });
    expect(h.computedCount).toBe(0);
  });

  it('estimates with the mean of the computed heights', () => {
    const h = pageHeights(700);
    h.setComputed(0, 600);
    h.setComputed(2, 800);
    expect(h.heightOf(5)).toEqual({ height: 700, estimated: true });
    expect(h.computedCount).toBe(2);
  });

  it('replaces an estimate when the page is computed, and moves the estimate with it', () => {
    const h = pageHeights(700);
    h.setComputed(0, 600);
    h.setComputed(1, 800);
    expect(h.heightOf(1)).toEqual({ height: 800, estimated: false });
    h.setComputed(1, 1000);
    expect(h.heightOf(1)).toEqual({ height: 1000, estimated: false });
    expect(h.heightOf(9)).toEqual({ height: 800, estimated: true });
  });

  it('forgets the computed heights from a page on, so they are estimates again', () => {
    const h = pageHeights(700);
    h.setComputed(0, 600);
    h.setComputed(3, 900);
    h.setComputed(4, 500);
    h.invalidateFrom(3);
    expect(h.heightOf(0)).toEqual({ height: 600, estimated: false });
    expect(h.heightOf(3)).toEqual({ height: 600, estimated: true });
    expect(h.computedCount).toBe(1);
  });

  it('keeps the heights of pages whatever window is mounted (FE-092 criterion 3, data half)', () => {
    const h = pageHeights(700);
    h.setComputed(10, 500);
    // Scrolling away and back asks the store only; the computed height is still there.
    visiblePages(h, 40, 0, 800, 1, 10);
    visiblePages(h, 40, 9000, 800, 1, 10);
    expect(h.heightOf(10)).toEqual({ height: 500, estimated: false });
  });

  it('rejects an index or a length that is not a finite non-negative number', () => {
    const h = pageHeights(700);
    expect(() => h.setComputed(-1, 10)).toThrow(RangeError);
    expect(() => h.setComputed(1.5, 10)).toThrow(RangeError);
    expect(() => h.setComputed(0, Number.NaN)).toThrow(RangeError);
    expect(() => h.setComputed(0, -4)).toThrow(RangeError);
    expect(() => pageHeights(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('keeps the estimate equal to the mean of the computed heights (property)', () => {
    const op = fc.oneof(
      fc.record({
        kind: fc.constant('set'),
        index: fc.integer({ min: 0, max: 30 }),
        height: fc.integer({ min: 0, max: 2000 }),
      }),
      fc.record({ kind: fc.constant('invalidate'), from: fc.integer({ min: 0, max: 30 }) }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 80 }), (ops) => {
        const h = pageHeights(700);
        const model = new Map<number, number>();
        for (const o of ops) {
          if (o.kind === 'set') {
            h.setComputed(o.index, o.height);
            model.set(o.index, o.height);
          } else {
            h.invalidateFrom(o.from);
            for (const k of [...model.keys()]) if (k >= o.from) model.delete(k);
          }
        }
        expect(h.computedCount).toBe(model.size);
        const mean =
          model.size === 0 ? 700 : [...model.values()].reduce((a, b) => a + b, 0) / model.size;
        for (let i = 0; i <= 31; i++) {
          const got = h.heightOf(i);
          const known = model.get(i);
          if (known !== undefined) expect(got).toEqual({ height: known, estimated: false });
          else expect(got.estimated).toBe(true);
          if (known === undefined) expect(got.height).toBeCloseTo(mean, 9);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('visible pages (engine half of FE-092 criterion 1)', () => {
  it('mounts the same number of pages whatever the document length', () => {
    // The window is in the middle of each document, so the ends do not clamp it.
    const counts = [100, 1000, 5000];
    const widths = counts.map((n) => {
      const h = pageHeights(100);
      const w = visiblePages(h, n, 1234, 800, 2, 0);
      return w === null ? -1 : w.last - w.first + 1;
    });
    // 800 points of viewport over 100-point pages meets at most nine pages, plus two of overscan
    // on each side.
    for (const w of widths) expect(w).toBeLessThanOrEqual(13);
    expect(new Set(widths).size).toBe(1);
  });

  it('starts at the first page at the top and clamps the overscan at the document ends', () => {
    const h = pageHeights(100);
    expect(visiblePages(h, 50, 0, 250, 2, 0)).toEqual({ first: 0, last: 4 });
    expect(visiblePages(h, 50, 4900, 250, 2, 0)).toEqual({ first: 47, last: 49 });
  });

  it('counts the gap between pages when it finds the window', () => {
    const h = pageHeights(100);
    // Page k starts at k * 110 and ends 100 points later. The viewport 200 to 320 meets page 1
    // (110 to 210) and page 2 (220 to 320); with no overscan that is pages 1 and 2.
    expect(visiblePages(h, 20, 200, 120, 0, 10)).toEqual({ first: 1, last: 2 });
  });

  it('mounts the last page when the scroll position is past the end', () => {
    const h = pageHeights(100);
    expect(visiblePages(h, 5, 10_000, 800, 0, 0)).toEqual({ first: 4, last: 4 });
  });

  it('returns null for a document with no pages', () => {
    expect(visiblePages(pageHeights(100), 0, 0, 800, 2, 0)).toBeNull();
  });

  it('uses computed heights where they are known and estimates elsewhere', () => {
    const h = pageHeights(100);
    h.setComputed(0, 400);
    // Page 0 is 400 points high, so a viewport of 300 at the top still shows only page 0.
    expect(visiblePages(h, 10, 0, 300, 0, 0)).toEqual({ first: 0, last: 0 });
    expect(visiblePages(h, 10, 400, 100, 0, 0)).toEqual({ first: 1, last: 1 });
  });
});
