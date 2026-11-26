/**
 * Caret, hit testing and selection geometry for lines with reordered runs (WASM-015 criterion 3),
 * in Node.js. The line is one paragraph 'p' with a left-to-right run of three offsets followed on the
 * page by a right-to-left run of three offsets; every offset is five points wide, so each expected
 * position is exact. The runs are given by hand here; `packages/perf/test/wasm-015-caret-bidi.test.ts`
 * takes them from the kernel.
 */
import { describe, expect, it } from 'vitest';
import {
  caretGeometry,
  hitTest,
  moveVertical,
  selectionRects,
  type LineRun,
  type LineRuns,
  type SpanWidth,
} from './caret.ts';
import type { LayoutLine, LayoutPage, LayoutTree, ParagraphFragment } from './tree.ts';

const perOffset: SpanWidth = (_block, from, to) => (to - from) * 5;

function paragraph(ranges: ReadonlyArray<readonly [number, number]>): ParagraphFragment {
  const lines: LayoutLine[] = ranges.map(([from, to], i) => ({
    from,
    to,
    x: 0,
    y: i * 12,
    width: (to - from) * 5,
    height: 12,
  }));
  return {
    kind: 'paragraph',
    blockId: 'p',
    from: ranges[0]![0],
    to: ranges[ranges.length - 1]![1],
    x: 10,
    y: 100,
    width: 200,
    height: ranges.length * 12,
    lines,
  };
}

function treeOf(ranges: ReadonlyArray<readonly [number, number]>): LayoutTree {
  const page: LayoutPage = {
    index: 0,
    section: 0,
    width: 200,
    height: 300,
    fragments: [paragraph(ranges)],
    header: [],
    footer: [],
    footnotes: [],
  };
  return { engine: 'test', measurer: 'test', pages: [page] };
}

/** 'abc' then three right-to-left characters: the runs in visual order. */
const mixed: readonly LineRun[] = [
  { from: 0, to: 3, level: 0 },
  { from: 3, to: 6, level: 1 },
];
const mixedRuns: LineRuns = (_block, from, to) => (from === 0 && to === 6 ? mixed : null);

describe('caret in a line with reordered runs (WASM-015)', () => {
  const tree = treeOf([[0, 6]]);
  // Page x of each offset 0 to 6: the left-to-right run grows rightwards from x 10; the
  // right-to-left run starts at its right edge, x 40, and grows leftwards.
  const expectedX = [10, 15, 20, 40, 35, 30, 25];

  it('puts the caret of each logical offset at its visual place', () => {
    expectedX.forEach((x, offset) => {
      const caret = caretGeometry(tree, { blockId: 'p', offset }, perOffset, mixedRuns);
      expect(caret?.x, `offset ${offset}`).toBe(x);
    });
  });

  it('keeps the old logical order without runs, and when every run is left to right', () => {
    const plain = caretGeometry(tree, { blockId: 'p', offset: 4 }, perOffset);
    expect(plain?.x).toBe(30);
    const ltrOnly: LineRuns = () => [
      { from: 0, to: 3, level: 0 },
      { from: 3, to: 6, level: 2 },
    ];
    expect(caretGeometry(tree, { blockId: 'p', offset: 4 }, perOffset, ltrOnly)?.x).toBe(30);
  });

  it('maps a point back to the logical offset of the nearest caret place', () => {
    expectedX.forEach((x, offset) => {
      const pos = hitTest(tree, 0, x, 104, perOffset, mixedRuns);
      // Offset 3 and offset 2 are the two ends of the junction; each is its own place.
      expect(pos, `x ${x}`).toEqual({ blockId: 'p', offset });
    });
    expect(hitTest(tree, 0, 36, 104, perOffset, mixedRuns)?.offset).toBe(4);
    expect(hitTest(tree, 0, 2, 104, perOffset, mixedRuns)?.offset).toBe(0);
  });

  it('gives one rectangle for each part of a selection that is contiguous on the page', () => {
    const across = selectionRects(
      tree,
      { blockId: 'p', offset: 2 },
      { blockId: 'p', offset: 5 },
      perOffset,
      mixedRuns,
    );
    // 'c' is at 20 to 25; the first two right-to-left characters are at 30 to 40.
    expect(across.map((r) => [r.x, r.width])).toEqual([
      [20, 5],
      [30, 10],
    ]);
    const whole = selectionRects(
      tree,
      { blockId: 'p', offset: 0 },
      { blockId: 'p', offset: 6 },
      perOffset,
      mixedRuns,
    );
    expect(whole.map((r) => [r.x, r.width])).toEqual([[10, 30]]);
    const rtlOnly = selectionRects(
      tree,
      { blockId: 'p', offset: 4 },
      { blockId: 'p', offset: 6 },
      perOffset,
      mixedRuns,
    );
    expect(rtlOnly.map((r) => [r.x, r.width])).toEqual([[25, 10]]);
  });

  it('moves up and down with the goal x in visual space', () => {
    const two = treeOf([
      [0, 6],
      [6, 12],
    ]);
    const runs: LineRuns = (_b, from, to) =>
      from === 0 && to === 6
        ? mixed
        : [
            { from: 6, to: 9, level: 0 },
            { from: 9, to: 12, level: 1 },
          ];
    // Offset 4 is at x 35 on line 1; on line 2 the same x is inside the right-to-left run [9, 12),
    // whose offset 10 is at 35 as well (40 - 5 to the right of 9).
    const down = moveVertical(two, { blockId: 'p', offset: 4 }, 'down', undefined, perOffset, runs);
    expect(down.goalX).toBe(35);
    expect(down.pos.offset).toBe(10);
  });
});
