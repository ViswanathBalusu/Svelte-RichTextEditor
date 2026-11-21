/**
 * The arithmetic of the ruler (UX-102): where the markers are, how far they may go, what a drag or
 * a key makes of them, and the patch for `setParagraphFormat`. The ruler component is not built, so
 * these tests do not show a ruler on screen; they check the numbers it will use.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ParagraphFormatView } from '../src/core-api.ts';
import {
  MAX_TABS,
  MIN_TEXT_TWIPS,
  addTab,
  indentPatch,
  indentsOf,
  keyPlace,
  markerAt,
  markerRange,
  moveMarker,
  moveTab,
  normaliseTabs,
  removeTab,
  snap,
  tabsPatch,
} from '../src/shell/ruler.ts';

const COLUMN = 9026;
const view = (over: Partial<ParagraphFormatView> = {}): ParagraphFormatView => ({
  count: 1,
  indentLeft: 0,
  indentRight: 0,
  indentFirstLine: 0,
  tabs: [],
  defaultTabStop: 720,
  page: { width: 11906, marginLeft: 1440, marginRight: 1440 },
  editable: true,
  ...over,
});

describe('ruler markers', () => {
  it('puts the markers at the indents', () => {
    const i = { left: 720, right: 360, firstLine: -360 };
    expect(markerAt('left', i, COLUMN)).toBe(720);
    expect(markerAt('firstLine', i, COLUMN)).toBe(360);
    expect(markerAt('right', i, COLUMN)).toBe(COLUMN - 360);
  });

  it('moves the first line with the left marker and the first-line marker alone', () => {
    const i = { left: 720, right: 0, firstLine: 360 };
    expect(moveMarker('left', 1440, i, COLUMN)).toEqual({ left: 1440, right: 0, firstLine: 360 });
    expect(moveMarker('firstLine', 360, i, COLUMN)).toEqual({
      left: 720,
      right: 0,
      firstLine: -360,
    });
    expect(moveMarker('right', COLUMN - 500, i, COLUMN).right).toBe(500);
  });

  it('keeps at least the least text between the indents', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('left', 'firstLine', 'right' as const),
        fc.integer({ min: -2000, max: 20000 }),
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (kind, at, left, right, firstLine) => {
          const out = moveMarker(kind, at, { left, right, firstLine }, COLUMN);
          const start = Math.max(out.left, out.left + out.firstLine);
          const end = COLUMN - out.right;
          expect(out.left).toBeGreaterThanOrEqual(0);
          expect(out.right).toBeGreaterThanOrEqual(0);
          if (
            left + right + MIN_TEXT_TWIPS + Math.max(0, firstLine) <= COLUMN &&
            firstLine >= -left
          )
            expect(end - start).toBeGreaterThanOrEqual(MIN_TEXT_TWIPS - 1);
        },
      ),
    );
  });

  it('reads a value the paragraphs do not share as 0, and writes it', () => {
    const f = view({ indentLeft: null });
    const before = indentsOf(f);
    expect(before.left).toBe(0);
    expect(indentPatch(before, { ...before, right: 360 }, f)).toEqual({
      indentLeft: 0,
      indentRight: 360,
    });
    expect(indentPatch(before, before, view())).toBeNull();
  });
});

describe('ruler keys and grid', () => {
  it('snaps to a quarter of a centimetre', () => {
    expect(snap(0)).toBe(0);
    expect(snap(140)).toBe(142);
  });

  it('moves by the grid, by the page step and to the ends, inside the range', () => {
    const range = { min: 0, max: 5000 };
    expect(keyPlace('ArrowRight', 0, range)).toBe(142);
    expect(keyPlace('ArrowLeft', 0, range)).toBe(0);
    expect(keyPlace('ArrowLeft', 100, range, true)).toBe(142);
    expect(keyPlace('End', 0, range)).toBe(5000);
    expect(keyPlace('Home', 300, range)).toBe(0);
    expect(keyPlace('x', 300, range)).toBeNull();
  });

  it('gives a range with the least text left between the indents', () => {
    const r = markerRange('right', { left: 1000, right: 0, firstLine: 0 }, COLUMN);
    expect(r.min).toBe(1000 + MIN_TEXT_TWIPS);
    expect(r.max).toBe(COLUMN);
  });
});

describe('ruler tab stops', () => {
  const left = (position: number) => ({
    position,
    align: 'left' as const,
    leader: 'none' as const,
  });

  it('keeps tab stops by position, one at a position', () => {
    expect(normaliseTabs([left(2000), left(1000), left(2000)]).map((t) => t.position)).toEqual([
      1000, 2000,
    ]);
  });

  it('adds, moves and removes a stop', () => {
    const added = addTab([left(2000)], 1000);
    expect(added.map((t) => t.position)).toEqual([1000, 2000]);
    expect(moveTab(added, 0, 3000).map((t) => t.position)).toEqual([2000, 3000]);
    expect(removeTab(added, 1).map((t) => t.position)).toEqual([1000]);
  });

  it('holds no more than the CDM does', () => {
    const many = Array.from({ length: MAX_TABS }, (_, i) => left(i * 100));
    expect(addTab(many, 99999 % 31680)).toHaveLength(MAX_TABS);
  });

  it('sends null for no stops', () => {
    expect(tabsPatch([])).toEqual({ tabs: null });
    expect(tabsPatch([left(10)])).toEqual({ tabs: [left(10)] });
  });
});
