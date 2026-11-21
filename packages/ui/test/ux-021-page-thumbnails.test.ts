/**
 * UX-021 criterion 1, the rule behind it (lane w3, 2026-11-21): which thumbnails of the navigation
 * pane are in the DOM for a scroll position, how the list is laid out, and where the keys move.
 * Node.js; the pane that applies the rule runs in the browsers (packages/ui/e2e and
 * packages/element/e2e, ux-021-page-thumbnails.spec.ts).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  THUMB_GAP,
  THUMB_LABEL,
  THUMB_OVERSCAN,
  THUMB_PAD,
  THUMB_WIDTH,
  pageStep,
  revealScroll,
  thumbBottom,
  thumbHeight,
  thumbKey,
  thumbLayout,
  thumbWindow,
  type PageSize,
} from '../src/shell/page-thumbnails.ts';

const A4: PageSize = { width: 595.28, height: 841.89 };
const A4_LANDSCAPE: PageSize = { width: 841.89, height: 595.28 };

const sizes = fc.array(
  fc.oneof(
    fc.constant(A4),
    fc.constant(A4_LANDSCAPE),
    fc.record({
      width: fc.double({ min: 100, max: 2000, noNaN: true }),
      height: fc.double({ min: 100, max: 2000, noNaN: true }),
    }),
  ),
  { minLength: 1, maxLength: 400 },
);

describe('UX-021: the size of a thumbnail follows its page', () => {
  it('is as tall as the page is, in proportion, and A4 when the size is not known', () => {
    expect(thumbHeight(A4)).toBe(Math.round((THUMB_WIDTH * 841.89) / 595.28));
    expect(thumbHeight(A4_LANDSCAPE)).toBe(Math.round((THUMB_WIDTH * 595.28) / 841.89));
    expect(thumbHeight(null)).toBe(thumbHeight(A4));
    expect(thumbHeight({ width: 0, height: 100 })).toBe(thumbHeight(A4));
    expect(thumbHeight({ width: Number.NaN, height: 100 })).toBe(thumbHeight(A4));
  });

  it('is never flatter than a quarter of its width nor taller than four times it', () => {
    expect(thumbHeight({ width: 1000, height: 1 })).toBe(THUMB_WIDTH / 4);
    expect(thumbHeight({ width: 1, height: 1000 })).toBe(THUMB_WIDTH * 4);
  });
});

describe('UX-021: the list is laid out one thumbnail under the other', () => {
  it('gives each item its place, and the list the height of all of them', () => {
    const layout = thumbLayout(3, (i) => (i === 1 ? A4_LANDSCAPE : A4));
    const tall = thumbHeight(A4);
    const flat = thumbHeight(A4_LANDSCAPE);
    expect(layout.heights).toEqual([tall, flat, tall]);
    expect(layout.tops).toEqual([
      THUMB_PAD,
      THUMB_PAD + tall + THUMB_LABEL + THUMB_GAP,
      THUMB_PAD + tall + flat + 2 * (THUMB_LABEL + THUMB_GAP),
    ]);
    expect(layout.total).toBe(2 * tall + flat + 3 * THUMB_LABEL + 2 * THUMB_GAP + 2 * THUMB_PAD);
    // The same space after the last item as before the first.
    expect(thumbBottom(layout, 2)).toBe(layout.total - THUMB_PAD);
  });

  it('is empty for no pages and for a count that is not a whole positive number', () => {
    for (const count of [0, -3, 2.5, Number.NaN])
      expect(thumbLayout(count, () => A4)).toEqual({ tops: [], heights: [], total: 0 });
    expect(
      thumbWindow(
        thumbLayout(0, () => A4),
        0,
        400,
      ),
    ).toBeNull();
  });

  it('keeps the items in order without overlap, for any sizes (property)', () => {
    fc.assert(
      fc.property(sizes, (pages) => {
        const layout = thumbLayout(pages.length, (i) => pages[i] ?? null);
        expect(layout.tops).toHaveLength(pages.length);
        expect(layout.tops[0]).toBe(THUMB_PAD);
        for (let i = 1; i < pages.length; i++)
          expect(layout.tops[i]).toBe(thumbBottom(layout, i - 1) + THUMB_GAP);
        expect(layout.total).toBe(thumbBottom(layout, pages.length - 1) + THUMB_PAD);
      }),
    );
  });
});

describe('UX-021 criterion 1: only the thumbnails near what the list shows are in the DOM', () => {
  it('holds a handful of a thousand pages, wherever the list is scrolled', () => {
    const layout = thumbLayout(1000, () => A4);
    const viewport = 448;
    const perItem = thumbHeight(A4) + THUMB_LABEL + THUMB_GAP;
    const most = Math.ceil(viewport / perItem) + 1 + 2 * THUMB_OVERSCAN;
    for (const scrollTop of [0, 1, 5000, layout.total / 2, layout.total - viewport]) {
      const win = thumbWindow(layout, scrollTop, viewport)!;
      expect(win.last - win.first + 1).toBeLessThanOrEqual(most);
    }
    expect(thumbWindow(layout, 0, viewport)).toEqual({ first: 0, last: 2 + THUMB_OVERSCAN });
    expect(thumbWindow(layout, layout.total - viewport, viewport)!.last).toBe(999);
    expect(thumbWindow(layout, layout.total - viewport, viewport)!.first).toBeGreaterThan(990);
  });

  it('shows the first items of a list that has no size yet', () => {
    const layout = thumbLayout(50, () => A4);
    expect(thumbWindow(layout, 0, 0)).toEqual({ first: 0, last: THUMB_OVERSCAN });
  });

  it('holds every item that is in view, and none beyond the overscan (property)', () => {
    fc.assert(
      fc.property(
        sizes,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 1500 }),
        fc.integer({ min: 0, max: 4 }),
        (pages, where, viewport, overscan) => {
          const layout = thumbLayout(pages.length, (i) => pages[i] ?? null);
          const scrollTop = Math.floor(where * Math.max(0, layout.total - viewport));
          const win = thumbWindow(layout, scrollTop, viewport, overscan)!;
          expect(win.first).toBeGreaterThanOrEqual(0);
          expect(win.last).toBeLessThan(pages.length);
          expect(win.first).toBeLessThanOrEqual(win.last);
          const inView = (i: number): boolean =>
            thumbBottom(layout, i) > scrollTop && (layout.tops[i] ?? 0) < scrollTop + viewport;
          let visible = 0;
          for (let i = 0; i < pages.length; i++) {
            if (!inView(i)) continue;
            visible++;
            // In view: in the DOM.
            expect(i).toBeGreaterThanOrEqual(win.first);
            expect(i).toBeLessThanOrEqual(win.last);
          }
          // Not more than what is in view, the overscan on each side, and the one item a list
          // without a size starts with.
          expect(win.last - win.first + 1).toBeLessThanOrEqual(Math.max(1, visible) + 2 * overscan);
        },
      ),
    );
  });
});

describe('UX-021: the list scrolls to an item only as far as it must', () => {
  const layout = thumbLayout(40, () => A4);
  const viewport = 448;

  it('stays where it is for an item that is already whole in the list', () => {
    expect(revealScroll(layout, 1, 0, viewport)).toBe(0);
  });

  it('puts an item below at the bottom edge, and an item above at the top edge, with its space', () => {
    expect(revealScroll(layout, 10, 0, viewport)).toBe(
      thumbBottom(layout, 10) + THUMB_PAD - viewport,
    );
    expect(revealScroll(layout, 3, 5000, viewport)).toBe(layout.tops[3]! - THUMB_PAD);
    // The first item is shown from the very start of the list.
    expect(revealScroll(layout, 0, 5000, viewport)).toBe(0);
  });

  it('leaves the position alone for an item that is not there', () => {
    expect(revealScroll(layout, 99, 123, viewport)).toBe(123);
  });

  it('shows the item whole afterwards, inside the list, for any position (property)', () => {
    fc.assert(
      fc.property(
        sizes,
        fc.nat(),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 50, max: 1500 }),
        (pages, pick, where, view) => {
          const l = thumbLayout(pages.length, (i) => pages[i] ?? null);
          const index = pick % pages.length;
          const max = Math.max(0, l.total - view);
          const from = Math.floor(where * max);
          const to = revealScroll(l, index, from, view);
          expect(to).toBeGreaterThanOrEqual(0);
          expect(to).toBeLessThanOrEqual(max);
          // The item with the space around it.
          const top = l.tops[index]! - THUMB_PAD;
          const bottom = thumbBottom(l, index) + THUMB_PAD;
          if (bottom - top <= view) {
            expect(top).toBeGreaterThanOrEqual(to);
            expect(bottom).toBeLessThanOrEqual(to + view);
          } else expect(to).toBe(Math.min(max, top));
          // An item that was whole in the list does not move it.
          if (top >= from && bottom <= from + view) expect(to).toBe(from);
        },
      ),
    );
  });
});

describe('UX-021: the keys of the list', () => {
  it('moves by one, to the ends, and by what fits in the list', () => {
    expect(thumbKey('ArrowDown', 3, 10)).toBe(4);
    expect(thumbKey('ArrowUp', 3, 10)).toBe(2);
    expect(thumbKey('Home', 3, 10)).toBe(0);
    expect(thumbKey('End', 3, 10)).toBe(9);
    expect(thumbKey('PageDown', 3, 10, 4)).toBe(7);
    expect(thumbKey('PageUp', 3, 10, 4)).toBe(0);
  });

  it('stops at the ends, and leaves other keys alone', () => {
    expect(thumbKey('ArrowUp', 0, 10)).toBe(0);
    expect(thumbKey('ArrowDown', 9, 10)).toBe(9);
    expect(thumbKey('PageDown', 8, 10, 5)).toBe(9);
    for (const key of ['ArrowLeft', 'ArrowRight', 'Enter', ' ', 'a', 'Tab', 'Escape'])
      expect(thumbKey(key, 3, 10)).toBeNull();
    expect(thumbKey('ArrowDown', 0, 0)).toBeNull();
  });

  it('never leaves the list (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'),
        fc.integer({ min: 1, max: 2000 }),
        fc.nat(),
        fc.integer({ min: -3, max: 50 }),
        (key, count, at, step) => {
          const next = thumbKey(key, at % count, count, step)!;
          expect(next).toBeGreaterThanOrEqual(0);
          expect(next).toBeLessThan(count);
        },
      ),
    );
  });

  it('a page key moves by the items that fit in the list, and by one at least', () => {
    const layout = thumbLayout(40, () => A4);
    const perItem = thumbHeight(A4) + THUMB_LABEL + THUMB_GAP;
    expect(pageStep(layout, 0, 3 * perItem + 10)).toBe(3);
    expect(pageStep(layout, 0, 10)).toBe(1);
    expect(pageStep(layout, 0, 0)).toBe(1);
  });
});
