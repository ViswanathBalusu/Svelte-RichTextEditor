/**
 * A table in a multi-column section does not span pages (FE-085 criterion 4; 03 §10), in Node.js.
 * The pages are two columns of 35 points with a 10-point gap on a 100-point body. The paragraph
 * helper builds fragments from line heights, as in `paginate-regions.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  paginate,
  type PageItem,
  type PageMargins,
  type PageSetup,
  type ParagraphItem,
  type TableItem,
  type TableRowItem,
} from './paginate.ts';
import type { LayoutFragment, ParagraphFragment, TableFragment } from './tree.ts';

const NO_MARGINS: PageMargins = { top: 0, right: 0, bottom: 0, left: 0 };

const setup = (over: Partial<PageSetup> = {}): PageSetup => ({
  width: 80,
  height: 100,
  margins: NO_MARGINS,
  columns: 2,
  columnGap: 10,
  ...over,
});

/** A paragraph whose lines have the given heights, one line per entry. */
function para(id: string, heights: readonly number[]): ParagraphItem {
  let y = 0;
  let offset = 0;
  const lines = heights.map((height) => {
    const line = { from: offset, to: offset + 10, x: 0, y, width: 35, height };
    y += height;
    offset += 10;
    return line;
  });
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    blockId: id,
    from: 0,
    to: offset,
    x: 0,
    y: 0,
    width: 35,
    height: y,
    lines,
  };
  return {
    kind: 'paragraph',
    fragment,
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: false,
  } as ParagraphItem;
}

/** A one-cell row of the given height in a 35-point table. */
function row(id: string, height: number): TableRowItem {
  return {
    rowId: id,
    header: false,
    cantSplit: false,
    height,
    cells: [{ cellId: `${id}/c`, x: 0, width: 35, margins: NO_MARGINS, paragraphs: [] }],
  };
}

const table = (id: string, heights: readonly number[]): TableItem => ({
  kind: 'table',
  blockId: id,
  x: 0,
  width: 35,
  rows: heights.map((h, i) => row(`${id}${i}`, h)),
});

/** The table fragments of each page, with the page's index. */
function tablesOf(
  pages: readonly { index: number; fragments: readonly LayoutFragment[] }[],
): { page: number; frag: TableFragment }[] {
  return pages.flatMap((p) =>
    p.fragments.flatMap((f) => (f.kind === 'table' ? [{ page: p.index, frag: f }] : [])),
  );
}

describe('a table in a multi-column section (FE-085 criterion 4)', () => {
  it('stays on the page when the rest of the page holds it', () => {
    // Column 0 is full (ten 10-point lines); column 1 has four lines, so 60 points remain there.
    const items: PageItem[] = [
      para(
        'a',
        Array.from({ length: 14 }, () => 10),
      ),
      table('t', [25, 25]),
    ];
    const { pages } = paginate(items, setup());
    expect(pages).toHaveLength(1);
    const found = tablesOf(pages);
    expect(found.map((t) => t.page)).toEqual([0]);
    expect(found[0]!.frag.rows).toHaveLength(2);
    expect(found[0]!.frag.x).toBe(45);
    expect(found[0]!.frag.y).toBe(40);
  });

  it('moves the whole table to a new page when the rest of the page cannot hold it', () => {
    // 60 points remain on page 1 and the table needs 70, so it starts page 2 and stays there.
    const items: PageItem[] = [
      para(
        'a',
        Array.from({ length: 14 }, () => 10),
      ),
      table('t', [35, 35]),
    ];
    const { pages } = paginate(items, setup());
    expect(pages).toHaveLength(2);
    const found = tablesOf(pages);
    expect(found.map((t) => t.page)).toEqual([1]);
    expect(found[0]!.frag.rows).toHaveLength(2);
    expect(found[0]!.frag.y).toBe(0);
    expect(found[0]!.frag.x).toBe(0);
  });

  it('still lets a table span pages in a single-column section', () => {
    // The rule is for multi-column sections: here the second row moves to page 2 on its own.
    const items: PageItem[] = [
      para(
        'a',
        Array.from({ length: 6 }, () => 10),
      ),
      table('t', [35, 35]),
    ];
    const { pages } = paginate(items, setup({ columns: 1, columnGap: 0 }));
    expect(pages).toHaveLength(2);
    expect(tablesOf(pages).map((t) => t.page)).toEqual([0, 1]);
  });

  it('keeps a table taller than a page spanning pages, with every row placed once', () => {
    const items: PageItem[] = [
      para(
        'a',
        Array.from({ length: 14 }, () => 10),
      ),
      table('t', [60, 60, 60]),
    ];
    const { pages } = paginate(items, setup());
    expect(pages.length).toBeGreaterThan(1);
    const rows = tablesOf(pages).flatMap((t) => t.frag.rows.map((r) => r.rowId));
    expect(rows).toEqual(['t0', 't1', 't2']);
  });
});
