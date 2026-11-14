/**
 * Table rows cut inside a paragraph, at a line (FE-083 criterion 1, the line-level cut), in Node.js.
 * The rows are built with their lines, so each case states its geometry.
 */
import { describe, expect, it } from 'vitest';
import {
  paginate,
  type PageSetup,
  type PaginatedPage,
  type ParagraphItem,
  type TableCellItem,
  type TableItem,
  type TableRowItem,
} from './paginate.ts';
import { splitRowAtLine } from './row-line-split.ts';
import type { LayoutFragment, TableFragment } from './tree.ts';

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };
const page = (height: number): PageSetup => ({ width: 80, height, margins: { ...ZERO } });

/** A paragraph of `count` lines, each `lineHeight` tall, with offsets 0 to `count`. */
function para(id: string, count: number, lineHeight: number): ParagraphItem {
  const lines = Array.from({ length: count }, (_, i) => ({
    from: i,
    to: i + 1,
    x: 0,
    y: i * lineHeight,
    width: 80,
    height: lineHeight,
  }));
  return {
    kind: 'paragraph',
    fragment: {
      kind: 'paragraph',
      blockId: id,
      from: 0,
      to: count,
      x: 0,
      y: 0,
      width: 80,
      height: count * lineHeight,
      lines,
    },
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: false,
  };
}

/** A row with one paragraph per cell, of the given line counts and line height. */
function row(
  id: string,
  lineCounts: readonly number[],
  lineHeight: number,
  cantSplit = false,
): TableRowItem {
  const cells: TableCellItem[] = lineCounts.map((count, c) => ({
    cellId: `${id}/c${c}`,
    x: c * 40,
    width: 40,
    margins: { ...ZERO },
    paragraphs: [para(`${id}-${c}`, count, lineHeight)],
  }));
  const height = Math.max(0, ...lineCounts.map((n) => n * lineHeight));
  return { rowId: id, header: false, cantSplit, height, cells };
}

const table = (rows: readonly TableRowItem[]): TableItem => ({
  kind: 'table',
  blockId: 't',
  x: 0,
  width: 80,
  rows,
});

function tablesOf(pages: readonly PaginatedPage[]): { page: number; frag: TableFragment }[] {
  return pages.flatMap((p) =>
    p.fragments.flatMap((f: LayoutFragment) =>
      f.kind === 'table' ? [{ page: p.index, frag: f }] : [],
    ),
  );
}

describe('FE-083 rows cut inside a paragraph (row-line-split)', () => {
  it('cuts a one-paragraph row between two lines and continues the tail on the next page (criterion 1)', () => {
    // Five lines of 10 in each cell, in a body of 35: three lines on page 1, two on page 2.
    const result = paginate([table([row('r', [5], 10)])], page(35));
    expect(result.overflowed).toEqual([]);
    const placed = tablesOf(result.pages);
    expect(placed.map((p) => p.page)).toEqual([0, 1]);
    expect(placed[0]!.frag.rows[0]).toMatchObject({ rowId: 'r', y: 0, height: 30 });
    expect(placed[1]!.frag.rows[0]).toMatchObject({ rowId: 'r', y: 0, height: 20 });
    const headLines = placed[0]!.frag.rows[0]!.cells[0]!.fragments;
    const tailLines = placed[1]!.frag.rows[0]!.cells[0]!.fragments;
    expect(headLines).toEqual([
      expect.objectContaining({ kind: 'paragraph', from: 0, to: 3, height: 30 }),
    ]);
    expect(tailLines).toEqual([
      expect.objectContaining({ kind: 'paragraph', from: 3, to: 5, height: 20 }),
    ]);
    // Every line is placed once, in order, across the two pieces.
    const offsets = [...headLines, ...tailLines].flatMap((f) =>
      f.kind === 'paragraph' ? f.lines.map((l) => l.from) : [],
    );
    expect(offsets).toEqual([0, 1, 2, 3, 4]);
  });

  it('uses one line position for every cell, and a shorter cell goes whole into the head', () => {
    // Cell A: 4 lines of 10. Cell B: 2 lines of 10. In a body of 25 the head holds two lines each.
    const cuts = splitRowAtLine(row('r', [4, 2], 10), 25);
    expect(cuts).not.toBeNull();
    expect(cuts!.head.height).toBe(20);
    expect(cuts!.head.cells[1]!.paragraphs[0]!.fragment.lines).toHaveLength(2);
    expect(cuts!.tail.cells[1]!.paragraphs).toEqual([]);
    expect(cuts!.tail.cells[0]!.paragraphs[0]!.fragment.lines).toHaveLength(2);
  });

  it('keeps a cantSplit row whole, and cuts nothing that leaves no line in the head', () => {
    expect(splitRowAtLine(row('r', [5], 10, true), 35)).toBeNull();
    expect(splitRowAtLine(row('r', [5], 10), 5)).toBeNull();
  });

  it('places every line of a longer cell once and in order over three pages (sweep)', () => {
    for (let count = 1; count <= 12; count++) {
      const result = paginate([table([row('r', [count], 10)])], page(30));
      const offsets = tablesOf(result.pages).flatMap((p) =>
        p.frag.rows.flatMap((r) =>
          r.cells.flatMap((c) =>
            c.fragments.flatMap((f) => (f.kind === 'paragraph' ? f.lines.map((l) => l.from) : [])),
          ),
        ),
      );
      expect(offsets).toEqual(Array.from({ length: count }, (_, i) => i));
      for (const { frag } of tablesOf(result.pages)) expect(frag.height).toBeLessThanOrEqual(30);
    }
  });
});
