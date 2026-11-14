/**
 * Movement by one page of the layout (FE-097 criterion 3), in Node.js. The trees are built by hand
 * with five points per offset, as in `caret.test.ts`; a seeded generator (mulberry32) drives the
 * property over random pages.
 */
import { describe, expect, it } from 'vitest';
import {
  caretGeometry,
  movePage,
  paintedLines,
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

const perOffset: SpanWidth = (_block, from, to) => (to - from) * 5;

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

const treeOf = (pages: LayoutPage[]): LayoutTree => ({ engine: 'test', measurer: 'test', pages });

/** Page 0: 'p' with lines A (0 to 4, y 100) and B (4 to 10, y 112); page 1: 'q' (0 to 5, y 100). */
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

describe('movement by one page of the layout (FE-097 criterion 3)', () => {
  it('moves Page Down to the line on the next page at the same height, keeping the goal x', () => {
    const t = twoPages();
    // Line A is at y 100; 'q' is at y 100 too, and x 20 is offset 2 in it.
    const down = movePage(t, { blockId: 'p', offset: 2 }, 'down', undefined, perOffset);
    expect(down).toEqual({ pos: { blockId: 'q', offset: 2 }, goalX: 20 });
  });

  it('takes the line nearest the caret height when the next page has several', () => {
    const t = treeOf([
      page(0, [paragraph('p', 10, 100, [[0, 4]]), paragraph('p2', 10, 150, [[0, 4]])]),
      page(1, [paragraph('q', 10, 100, [[0, 5]]), paragraph('r', 10, 150, [[0, 5]])]),
    ]);
    expect(movePage(t, { blockId: 'p2', offset: 0 }, 'down', undefined, perOffset).pos).toEqual({
      blockId: 'r',
      offset: 0,
    });
    expect(movePage(t, { blockId: 'p', offset: 0 }, 'down', undefined, perOffset).pos).toEqual({
      blockId: 'q',
      offset: 0,
    });
  });

  it('passes over a page with no body line', () => {
    const t = treeOf([
      page(0, [paragraph('p', 10, 100, [[0, 4]])]),
      page(1, []),
      page(2, [paragraph('q', 10, 100, [[0, 5]])]),
    ]);
    expect(movePage(t, { blockId: 'p', offset: 1 }, 'down', undefined, perOffset).pos).toEqual({
      blockId: 'q',
      offset: 1,
    });
  });

  it('moves Page Up to the previous page', () => {
    const t = twoPages();
    expect(movePage(t, { blockId: 'q', offset: 3 }, 'up', undefined, perOffset)).toEqual({
      pos: { blockId: 'p', offset: 3 },
      goalX: 25,
    });
  });

  it('goes to the first or last body line of the document when no page lies that way', () => {
    const t = twoPages();
    expect(movePage(t, { blockId: 'q', offset: 0 }, 'down', undefined, perOffset).pos).toEqual({
      blockId: 'q',
      offset: 0,
    });
    expect(movePage(t, { blockId: 'p', offset: 0 }, 'up', undefined, perOffset).pos).toEqual({
      blockId: 'p',
      offset: 0,
    });
    // Page Down from the first page's first line goes to the page after, not the document's end.
    expect(movePage(t, { blockId: 'p', offset: 0 }, 'down', undefined, perOffset).pos.blockId).toBe(
      'q',
    );
  });

  it('keeps the goal x that the caller carries on', () => {
    const t = twoPages();
    const r = movePage(t, { blockId: 'p', offset: 2 }, 'down', 7, perOffset);
    expect(r.goalX).toBe(7);
    // Goal x 7 is 3 points left of line q's text, so the nearest position is its start.
    expect(r.pos).toEqual({ blockId: 'q', offset: 0 });
  });

  it('gives back a position that maps to a painted line, on random pages (property)', () => {
    // mulberry32: a seeded generator, so the sweep is the same on every run.
    let seed = 0x5eed;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let run = 0; run < 60; run++) {
      const pages: LayoutPage[] = [];
      const pageCount = 1 + Math.floor(rand() * 5);
      let block = 0;
      for (let p = 0; p < pageCount; p++) {
        const frags: LayoutFragment[] = [];
        const paragraphs = Math.floor(rand() * 3);
        for (let k = 0; k < paragraphs; k++) {
          const lineCount = 1 + Math.floor(rand() * 3);
          const ranges: [number, number][] = [];
          let at = 0;
          for (let l = 0; l < lineCount; l++) {
            const to = at + 1 + Math.floor(rand() * 4);
            ranges.push([at, to]);
            at = to;
          }
          frags.push(paragraph(`b${block++}`, 10, 100 + k * 40, ranges));
        }
        pages.push(page(p, frags));
      }
      const tree = treeOf(pages);
      const lines = paintedLines(tree);
      for (const line of lines) {
        for (const direction of ['down', 'up'] as const) {
          const start: DocPosition = { blockId: line.blockId, offset: line.from };
          const moved = movePage(tree, start, direction, undefined, perOffset);
          // The result is on a painted line, and its caret can be drawn.
          expect(caretGeometry(tree, moved.pos, perOffset)).not.toBeNull();
          const targetPage = caretGeometry(tree, moved.pos, perOffset)!.page;
          const pageOfStart = line.page;
          if (direction === 'down' && targetPage !== pageOfStart)
            expect(targetPage).toBeGreaterThan(pageOfStart);
          if (direction === 'up' && targetPage !== pageOfStart)
            expect(targetPage).toBeLessThan(pageOfStart);
        }
      }
    }
  });
});
