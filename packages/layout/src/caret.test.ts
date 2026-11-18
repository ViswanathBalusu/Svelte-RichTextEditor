/**
 * Hit testing, caret and selection geometry, and movement by line, computed from the layout tree
 * (FE-096, FE-097), in Node.js. The trees are built by hand with five points per offset, so every
 * expected position is exact. A seeded generator (mulberry32) drives the round-trip property.
 */
import { describe, expect, it } from 'vitest';
import {
  caretGeometry,
  hitTest,
  lineBounds,
  moveVertical,
  paintedLines,
  selectionRects,
  type DocPosition,
  type SpanWidth,
} from './caret.ts';
import type {
  LayoutFragment,
  LayoutLine,
  LayoutPage,
  LayoutTree,
  ParagraphFragment,
} from './tree.ts';

/** Five points per offset: the width of text[from, to) is 5 pt for each of its positions. */
const perOffset: SpanWidth = (_block, from, to) => (to - from) * 5;

/** A paragraph at (x, y) whose lines cover the given ranges, each `lineHeight` tall. */
function paragraph(
  blockId: string,
  x: number,
  y: number,
  ranges: ReadonlyArray<readonly [number, number]>,
  lineHeight = 12,
): ParagraphFragment {
  const lines: LayoutLine[] = ranges.map(([from, to], i) => ({
    from,
    to,
    x: 0,
    y: i * lineHeight,
    width: (to - from) * 5,
    height: lineHeight,
  }));
  return {
    kind: 'paragraph',
    blockId,
    from: ranges[0]![0],
    to: ranges[ranges.length - 1]![1],
    x,
    y,
    width: 200,
    height: ranges.length * lineHeight,
    lines,
  };
}

function page(index: number, fragments: LayoutFragment[]): LayoutPage {
  return {
    index,
    section: 0,
    width: 200,
    height: 300,
    fragments,
    header: [],
    footer: [],
    footnotes: [],
  };
}

function treeOf(pages: LayoutPage[]): LayoutTree {
  return { engine: 'test', measurer: 'test', pages };
}

/** One paragraph 'p' of ten offsets: line A covers 0 to 4 and line B covers 4 to 10. */
const oneParagraph = (): LayoutTree =>
  treeOf([
    page(0, [
      paragraph('p', 10, 100, [
        [0, 4],
        [4, 10],
      ]),
    ]),
  ]);

/** Page 0 holds 'p' (lines 0 to 4 and 4 to 10); page 1 holds 'q' (one line, 0 to 5). */
const twoPages = (): LayoutTree =>
  treeOf([
    page(0, [
      paragraph('p', 10, 100, [
        [0, 4],
        [4, 10],
      ]),
    ]),
    page(1, [paragraph('q', 10, 100, [[0, 5]])]),
  ]);

describe('hit testing (FE-096)', () => {
  it('returns the nearest offset in the line the point is in', () => {
    const t = oneParagraph();
    // Line A is at y 100 to 112, line B at y 112 to 124; the text of A starts at x 10.
    expect(hitTest(t, 0, 12, 105, perOffset)).toEqual({ blockId: 'p', offset: 0 });
    expect(hitTest(t, 0, 18, 105, perOffset)).toEqual({ blockId: 'p', offset: 2 });
    expect(hitTest(t, 0, 25, 115, perOffset)).toEqual({ blockId: 'p', offset: 7 });
  });

  it('gives the start of a line for a point left of it, and its last position for a point beyond it', () => {
    const t = oneParagraph();
    expect(hitTest(t, 0, -40, 118, perOffset)).toEqual({ blockId: 'p', offset: 4 });
    // Line A (0 to 4) is wrapped: offset 4 starts line B, so its last position is 3.
    expect(hitTest(t, 0, 900, 105, perOffset)).toEqual({ blockId: 'p', offset: 3 });
    // Line B is the last line of the block, so its last position is the block's end.
    expect(hitTest(t, 0, 900, 118, perOffset)).toEqual({ blockId: 'p', offset: 10 });
  });

  it('keeps the caret on the clicked line for a click beyond the end of a wrapped line', () => {
    const t = oneParagraph();
    const hit = hitTest(t, 0, 900, 105, perOffset);
    expect(hit).not.toBeNull();
    // Line A is at y 100; the caret drawn for the hit position is on line A, not on line B.
    expect(caretGeometry(t, hit!, perOffset)).toEqual({ page: 0, x: 25, y: 100, height: 12 });
    // The same for a block that runs on to the next page: the last line of page 0 is not final.
    const split = treeOf([
      page(0, [
        paragraph('p', 10, 100, [
          [0, 4],
          [4, 8],
        ]),
      ]),
      page(1, [paragraph('p', 10, 100, [[8, 12]])]),
    ]);
    const end = hitTest(split, 0, 900, 118, perOffset);
    expect(end).toEqual({ blockId: 'p', offset: 7 });
    expect(caretGeometry(split, end!, perOffset)).toMatchObject({ page: 0, y: 112 });
  });

  it('takes a point in the gap between two lines to the nearer one, and the earlier on a tie', () => {
    // Two paragraphs of 10 pt lines: the first occupies y 100 to 110, the second y 112 to 122.
    const t = treeOf([
      page(0, [paragraph('p', 10, 100, [[0, 4]], 10), paragraph('q', 10, 112, [[0, 4]], 10)]),
    ]);
    expect(hitTest(t, 0, 10, 110.4, perOffset)?.blockId).toBe('p');
    expect(hitTest(t, 0, 10, 111.6, perOffset)?.blockId).toBe('q');
    expect(hitTest(t, 0, 10, 111, perOffset)?.blockId).toBe('p');
  });

  it('returns null for a page with no body line', () => {
    expect(hitTest(treeOf([page(0, [])]), 0, 10, 10, perOffset)).toBeNull();
  });

  it('keeps a click in the blank space of a cell inside that cell, the innermost one for a nested table (criterion 2)', () => {
    // An outer table of one row (y 0 to 100) and two cells: L (x 0 to 100) and R (x 100 to 200).
    // L holds a nested table of one row (y 0 to 60) with cells L1 (x 0 to 50) and L2 (x 50 to 100),
    // then paragraph 'l'. R holds paragraph 'r'. Every point below is nearer another cell's text.
    const inner: LayoutFragment = {
      kind: 'table',
      blockId: 'inner',
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      rows: [
        {
          rowId: 'ir',
          repeated: false,
          y: 0,
          height: 60,
          cells: [
            { cellId: 'L1', x: 0, width: 50, fragments: [paragraph('n1', 2, 2, [[0, 2]])] },
            { cellId: 'L2', x: 50, width: 50, fragments: [paragraph('n2', 52, 2, [[0, 8]])] },
          ],
        },
      ],
    };
    const outer: LayoutFragment = {
      kind: 'table',
      blockId: 'outer',
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      rows: [
        {
          rowId: 'or',
          repeated: false,
          y: 0,
          height: 100,
          cells: [
            { cellId: 'L', x: 0, width: 100, fragments: [inner, paragraph('l', 2, 70, [[0, 3]])] },
            { cellId: 'R', x: 100, width: 100, fragments: [paragraph('r', 102, 2, [[0, 4]])] },
          ],
        },
      ],
    };
    const t = treeOf([page(0, [outer])]);
    // In L1, right of its text and below it, nearer the text of L2.
    expect(hitTest(t, 0, 45, 8, perOffset)).toEqual({ blockId: 'n1', offset: 2 });
    expect(hitTest(t, 0, 45, 40, perOffset)).toEqual({ blockId: 'n1', offset: 2 });
    // In L2, beyond its text's end and nearer the text of R.
    expect(hitTest(t, 0, 98, 8, perOffset)).toEqual({ blockId: 'n2', offset: 8 });
    // In L below the nested table: L's own lines only.
    expect(hitTest(t, 0, 45, 90, perOffset)).toEqual({ blockId: 'l', offset: 3 });
    // In R, left of and below its text, nearer the text of 'l'.
    expect(hitTest(t, 0, 101, 76, perOffset)).toEqual({ blockId: 'r', offset: 0 });
    // Each line records its cells, outermost first.
    expect(paintedLines(t).map((l) => [l.blockId, l.cells.map((c) => c.cellId)])).toEqual([
      ['n1', ['L', 'L1']],
      ['n2', ['L', 'L2']],
      ['l', ['L']],
      ['r', ['R']],
    ]);
  });
});

describe('caret geometry (FE-096)', () => {
  it('places the caret from the tree: at a wrap point it starts the next line', () => {
    const t = oneParagraph();
    expect(caretGeometry(t, { blockId: 'p', offset: 0 }, perOffset)).toEqual({
      page: 0,
      x: 10,
      y: 100,
      height: 12,
    });
    expect(caretGeometry(t, { blockId: 'p', offset: 6 }, perOffset)).toEqual({
      page: 0,
      x: 20,
      y: 112,
      height: 12,
    });
    expect(caretGeometry(t, { blockId: 'p', offset: 4 }, perOffset)?.y).toBe(112);
    // The end of the block is the end of its last line.
    expect(caretGeometry(t, { blockId: 'p', offset: 10 }, perOffset)?.x).toBe(40);
  });

  it('returns null for a block with no line on the pages', () => {
    expect(caretGeometry(oneParagraph(), { blockId: 'missing', offset: 0 }, perOffset)).toBeNull();
  });
});

describe('selection rectangles (FE-096)', () => {
  it('draws one rectangle per line the selection crosses, in either direction', () => {
    const t = oneParagraph();
    const expected = [
      { page: 0, x: 20, y: 100, width: 10, height: 12 },
      { page: 0, x: 10, y: 112, width: 10, height: 12 },
    ];
    expect(
      selectionRects(t, { blockId: 'p', offset: 2 }, { blockId: 'p', offset: 6 }, perOffset),
    ).toEqual(expected);
    expect(
      selectionRects(t, { blockId: 'p', offset: 6 }, { blockId: 'p', offset: 2 }, perOffset),
    ).toEqual(expected);
  });

  it('draws a selection on one line the same in either direction', () => {
    const t = oneParagraph();
    const expected = [{ page: 0, x: 20, y: 100, width: 10, height: 12 }];
    expect(
      selectionRects(t, { blockId: 'p', offset: 2 }, { blockId: 'p', offset: 0 }, perOffset),
    ).toEqual([{ page: 0, x: 10, y: 100, width: 10, height: 12 }]);
    expect(
      selectionRects(t, { blockId: 'p', offset: 4 }, { blockId: 'p', offset: 2 }, perOffset),
    ).toEqual(expected);
    expect(
      selectionRects(t, { blockId: 'p', offset: 2 }, { blockId: 'p', offset: 4 }, perOffset),
    ).toEqual(expected);
  });

  it('gives one rectangle per page when the selection runs from one page to the next', () => {
    const rects = selectionRects(
      twoPages(),
      { blockId: 'p', offset: 6 },
      { blockId: 'q', offset: 3 },
      perOffset,
    );
    expect(rects).toEqual([
      { page: 0, x: 20, y: 112, width: 20, height: 12 },
      { page: 1, x: 10, y: 100, width: 15, height: 12 },
    ]);
  });

  it('gives no rectangle for an empty selection', () => {
    expect(
      selectionRects(
        oneParagraph(),
        { blockId: 'p', offset: 5 },
        { blockId: 'p', offset: 5 },
        perOffset,
      ),
    ).toEqual([]);
  });
});

describe('movement by line (FE-097)', () => {
  it('moves up and down keeping the horizontal position, and carries the goal x on', () => {
    const t = oneParagraph();
    // From offset 2 (x 20) down: line B at x 20 is offset 6, which is 10 points into the line.
    const down = moveVertical(t, { blockId: 'p', offset: 2 }, 'down', undefined, perOffset);
    expect(down).toEqual({ pos: { blockId: 'p', offset: 6 }, goalX: 20 });
    const up = moveVertical(t, down.pos, 'up', down.goalX, perOffset);
    expect(up).toEqual({ pos: { blockId: 'p', offset: 2 }, goalX: 20 });
  });

  it('moves from the last line of a page to the first line of the next page', () => {
    const t = twoPages();
    const down = moveVertical(t, { blockId: 'p', offset: 6 }, 'down', undefined, perOffset);
    // The goal x is 20; on line q (at x 10) that is 10 points in, which is offset 2.
    expect(down).toEqual({ pos: { blockId: 'q', offset: 2 }, goalX: 20 });
  });

  it('does not move past the first or the last line', () => {
    const t = oneParagraph();
    const last = { blockId: 'p', offset: 6 };
    expect(moveVertical(t, last, 'down', undefined, perOffset).pos).toEqual(last);
    const first = { blockId: 'p', offset: 1 };
    expect(moveVertical(t, first, 'up', 7, perOffset)).toEqual({ pos: first, goalX: 7 });
  });

  it('gives the start and the end of the painted line for Home and End', () => {
    const t = oneParagraph();
    expect(lineBounds(t, { blockId: 'p', offset: 6 })).toEqual({
      start: { blockId: 'p', offset: 4 },
      end: { blockId: 'p', offset: 10 },
    });
    // Line A is wrapped, so End on it stays on it: offset 3, not 4 (which starts line B).
    expect(lineBounds(t, { blockId: 'p', offset: 2 })).toEqual({
      start: { blockId: 'p', offset: 0 },
      end: { blockId: 'p', offset: 3 },
    });
    const end = lineBounds(t, { blockId: 'p', offset: 2 })!.end;
    expect(caretGeometry(t, end, perOffset)?.y).toBe(100);
  });

  /** One paragraph 'p' wrapped in three lines: 0 to 4, 4 to 14 and 14 to 20, at y 100, 112, 124. */
  const threeLines = (): LayoutTree =>
    treeOf([
      page(0, [
        paragraph('p', 10, 100, [
          [0, 4],
          [4, 14],
          [14, 20],
        ]),
      ]),
    ]);

  it('reaches the first line of a wrapped paragraph from its last in two presses of Up', () => {
    const t = threeLines();
    // Offset 19 is 25 points into line 14 to 20, so x 35.
    const up1 = moveVertical(t, { blockId: 'p', offset: 19 }, 'up', undefined, perOffset);
    expect(up1).toEqual({ pos: { blockId: 'p', offset: 9 }, goalX: 35 });
    expect(caretGeometry(t, up1.pos, perOffset)?.y).toBe(112);
    // Line 0 to 4 is 20 points wide, short of x 35: the caret goes to its last position, 3.
    const up2 = moveVertical(t, up1.pos, 'up', up1.goalX, perOffset);
    expect(up2).toEqual({ pos: { blockId: 'p', offset: 3 }, goalX: 35 });
    expect(caretGeometry(t, up2.pos, perOffset)?.y).toBe(100);
    // A third press stays on the first line, and the goal x is kept.
    expect(moveVertical(t, up2.pos, 'up', up2.goalX, perOffset)).toEqual(up2);
  });

  it('moves Up and Down to a wrapped line with a goal x beyond its end, without skipping it', () => {
    // Lines 0 to 10, 10 to 12 (short) and 12 to 20, at y 100, 112 and 124.
    const t = treeOf([
      page(0, [
        paragraph('p', 10, 100, [
          [0, 10],
          [10, 12],
          [12, 20],
        ]),
      ]),
    ]);
    // Offset 9 is at x 55; line 10 to 12 ends at x 20, so Down goes to its last position, 11.
    const down1 = moveVertical(t, { blockId: 'p', offset: 9 }, 'down', undefined, perOffset);
    expect(down1).toEqual({ pos: { blockId: 'p', offset: 11 }, goalX: 55 });
    expect(caretGeometry(t, down1.pos, perOffset)?.y).toBe(112);
    // The goal x is carried on: line 12 to 20 at x 55 is 45 points in, past its end (40), so 20.
    const down2 = moveVertical(t, down1.pos, 'down', down1.goalX, perOffset);
    expect(down2).toEqual({ pos: { blockId: 'p', offset: 20 }, goalX: 55 });
    expect(caretGeometry(t, down2.pos, perOffset)?.y).toBe(124);
    // And back up: the short line again, then offset 9 on the first line.
    const up1 = moveVertical(t, down2.pos, 'up', down2.goalX, perOffset);
    expect(up1.pos).toEqual({ blockId: 'p', offset: 11 });
    expect(caretGeometry(t, up1.pos, perOffset)?.y).toBe(112);
    expect(moveVertical(t, up1.pos, 'up', up1.goalX, perOffset).pos).toEqual({
      blockId: 'p',
      offset: 9,
    });
  });

  it('moves Down to a short first line of the next page that is followed by more of its block', () => {
    // Page 0 holds 'p' (0 to 10); page 1 holds 'q' wrapped in lines 0 to 2 and 2 to 9.
    const t = treeOf([
      page(0, [paragraph('p', 10, 100, [[0, 10]])]),
      page(1, [
        paragraph('q', 10, 100, [
          [0, 2],
          [2, 9],
        ]),
      ]),
    ]);
    // Offset 8 is at x 50; line 0 to 2 of 'q' ends at x 20, so its last position, 1.
    const down = moveVertical(t, { blockId: 'p', offset: 8 }, 'down', undefined, perOffset);
    expect(down).toEqual({ pos: { blockId: 'q', offset: 1 }, goalX: 50 });
    expect(caretGeometry(t, down.pos, perOffset)).toMatchObject({ page: 1, y: 100 });
  });

  it('moves Down from a page to the next when one block runs across both', () => {
    const t = treeOf([
      page(0, [
        paragraph('p', 10, 100, [
          [0, 4],
          [4, 8],
        ]),
      ]),
      page(1, [
        paragraph('p', 10, 100, [
          [8, 12],
          [12, 20],
        ]),
      ]),
    ]);
    // From offset 2 with a goal x far right: line 4 to 8 (last of page 0, not of the block) gives 7.
    const d1 = moveVertical(t, { blockId: 'p', offset: 2 }, 'down', 900, perOffset);
    expect(d1.pos).toEqual({ blockId: 'p', offset: 7 });
    expect(caretGeometry(t, d1.pos, perOffset)).toMatchObject({ page: 0, y: 112 });
    // Then the first line of page 1, which is wrapped too: 11, on page 1.
    const d2 = moveVertical(t, d1.pos, 'down', d1.goalX, perOffset);
    expect(d2.pos).toEqual({ blockId: 'p', offset: 11 });
    expect(caretGeometry(t, d2.pos, perOffset)).toMatchObject({ page: 1, y: 100 });
  });
});

describe('caret, hit testing and movement agree (FE-096, FE-097, property)', () => {
  it('finds the position again from the caret drawn for it, and stays on the target line, on random pages', () => {
    let s = 20261115 >>> 0;
    const next = (): number => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const blocks = ['a', 'b', 'c', 'd'];
    for (let trial = 0; trial < 60; trial++) {
      const pages: LayoutPage[] = [];
      const fragmentsOf: LayoutFragment[][] = [[], []];
      const ranges = new Map<string, number>();
      const cursor = [0, 0];
      blocks.forEach((id) => {
        const target = next() < 0.5 ? 0 : 1;
        const count = 1 + Math.floor(next() * 4);
        const cuts: Array<[number, number]> = [];
        let at = 0;
        for (let i = 0; i < count; i++) {
          const to = at + 1 + Math.floor(next() * 9);
          cuts.push([at, to]);
          at = to;
        }
        ranges.set(id, at);
        const y = cursor[target]!;
        const frag = paragraph(id, Math.floor(next() * 40), y, cuts);
        cursor[target] = y + frag.height + 4;
        fragmentsOf[target]!.push(frag);
      });
      fragmentsOf.forEach((fragments, i) => pages.push(page(i, fragments)));
      const t = treeOf(pages);
      // A block-dependent width, so that the blocks do not all measure alike.
      const span: SpanWidth = (block, from, to) => (to - from) * (4 + (block.charCodeAt(0) % 3));
      for (const [id, end] of ranges)
        for (let offset = 0; offset <= end; offset++) {
          const pos: DocPosition = { blockId: id, offset };
          const caret = caretGeometry(t, pos, span);
          expect(caret).not.toBeNull();
          const hit = hitTest(t, caret!.page, caret!.x, caret!.y + caret!.height / 2, span);
          expect(hit).toEqual(pos);
        }
      // Up and Down, with any goal x (inside a line, left of it or far beyond its end), land on
      // the painted line next to the current one, and a click anywhere along a line stays on it.
      const lines = paintedLines(t);
      const goals = [-50, 0, 7, 13, 22, 31, 48, 75, 900];
      lines.forEach((line, i) => {
        for (const goal of goals) {
          const click = hitTest(t, line.page, goal, line.y + line.height / 2, span);
          expect(caretGeometry(t, click!, span)).toMatchObject({ page: line.page, y: line.y });
          const start: DocPosition = { blockId: line.blockId, offset: line.from };
          const up = moveVertical(t, start, 'up', goal, span);
          const above = lines[i - 1] ?? line;
          expect(caretGeometry(t, up.pos, span)).toMatchObject({ page: above.page, y: above.y });
          const down = moveVertical(t, start, 'down', goal, span);
          const below = lines[i + 1] ?? line;
          expect(caretGeometry(t, down.pos, span)).toMatchObject({ page: below.page, y: below.y });
        }
      });
    }
  });
});
