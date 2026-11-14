/**
 * Table pagination (FE-083), in Node.js. The rows of the first tests are built directly, so each case
 * states its heights; the last tests lay out CDM tables through `toFlow` and `layoutFlow`. The random
 * sweep uses a seeded generator (mulberry32), so every run is repeatable.
 */
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { layoutFlow } from './engine.ts';
import {
  paginate,
  type PageItem,
  type PageSetup,
  type PaginatedPage,
  type ParagraphItem,
  type TableItem,
  type TableRowItem,
} from './paginate.ts';
import type { ItemProviders } from './items.ts';
import { firstFitBreaker, type BreakOpportunities } from './lines.ts';
import { fixedWidthMeasurer } from './measure.ts';
import {
  checkCoverage,
  type LayoutFragment,
  type LayoutRow,
  type ParagraphFragment,
  type TableFragment,
} from './tree.ts';
import {
  hitTest,
  paintedLines,
  selectionRects,
  type DocPosition,
  type SpanWidth,
} from './caret.ts';

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };

/** A page of the given body height and width 80, with no margins, so that the body is the page. */
const page = (height: number): PageSetup => ({ width: 80, height, margins: { ...ZERO } });

/** A row of one cell with no paragraphs, of the given height. */
function row(
  id: string,
  height: number,
  over: { header?: boolean; cantSplit?: boolean } = {},
): TableRowItem {
  return {
    rowId: id,
    header: over.header ?? false,
    cantSplit: over.cantSplit ?? false,
    height,
    cells: [{ cellId: `${id}/c`, x: 0, width: 80, margins: { ...ZERO }, paragraphs: [] }],
  };
}

const table = (id: string, rows: readonly TableRowItem[]): TableItem => ({
  kind: 'table',
  blockId: id,
  x: 0,
  width: 80,
  rows,
});

/** The table fragments of each page, with the page's index. */
function tablesOf(pages: readonly PaginatedPage[]): { page: number; frag: TableFragment }[] {
  return pages.flatMap((p) =>
    p.fragments.flatMap((f: LayoutFragment) =>
      f.kind === 'table' ? [{ page: p.index, frag: f }] : [],
    ),
  );
}

/** The row ids of each table fragment, with whether each row is a repeated header. */
function rowsOf(
  pages: readonly PaginatedPage[],
): { page: number; rows: string[]; repeated: boolean[] }[] {
  return tablesOf(pages).map(({ page: index, frag }) => ({
    page: index,
    rows: frag.rows.map((r) => r.rowId),
    repeated: frag.rows.map((r) => r.repeated),
  }));
}

describe('FE-083 table pagination (table items placed by row)', () => {
  it('continues a table on the next page and places every row once (criterion 1, rows part)', () => {
    const rows = Array.from({ length: 6 }, (_, i) => row(`r${i}`, 30));
    const result = paginate([table('t', rows)], page(100));
    expect(result.pages.length).toBe(2);
    expect(rowsOf(result.pages)).toEqual([
      { page: 0, rows: ['r0', 'r1', 'r2'], repeated: [false, false, false] },
      { page: 1, rows: ['r3', 'r4', 'r5'], repeated: [false, false, false] },
    ]);
    // Rows keep their order and do not overlap: each starts where the previous one ends.
    const placed = tablesOf(result.pages).flatMap((t) => t.frag.rows);
    placed.forEach((r, i) => expect(r.y).toBe((i % 3) * 30));
    expect(result.overflowed).toEqual([]);
  });

  it('repeats the header rows at the top of every continuation piece (criterion 2)', () => {
    const rows = [
      row('h0', 20, { header: true }),
      row('b1', 30),
      row('b2', 30),
      row('b3', 30),
      row('b4', 30),
      row('b5', 30),
    ];
    const result = paginate([table('t', rows)], page(100));
    expect(rowsOf(result.pages)).toEqual([
      { page: 0, rows: ['h0', 'b1', 'b2'], repeated: [false, false, false] },
      { page: 1, rows: ['h0', 'b3', 'b4'], repeated: [true, false, false] },
      { page: 2, rows: ['h0', 'b5'], repeated: [true, false] },
    ]);
    // The repeated copy sits at the top of its page, and the body row after it below it.
    const second = tablesOf(result.pages)[1]!.frag;
    expect(second.rows[0]!.y).toBe(0);
    expect(second.rows[1]!.y).toBe(20);
  });

  it('moves a cantSplit row whole to the next page (criterion 3)', () => {
    const rows = [row('a', 60), row('b', 60, { cantSplit: true })];
    const result = paginate([table('t', rows)], page(100));
    expect(result.pages.length).toBe(2);
    const moved = tablesOf(result.pages)[1]!;
    expect(moved.page).toBe(1);
    expect(moved.frag.rows).toHaveLength(1);
    expect(moved.frag.rows[0]).toMatchObject({ rowId: 'b', y: 0, height: 60 });
  });

  it('places a row taller than the body alone and reports the table as overflowed', () => {
    const rows = [row('a', 30), row('big', 150), row('c', 30)];
    const result = paginate([table('t', rows)], page(100));
    expect(rowsOf(result.pages).map((p) => p.rows)).toEqual([['a'], ['big'], ['c']]);
    expect(result.overflowed).toEqual(['t']);
    // The row is laid out at its full height: it is not clipped or dropped.
    expect(tablesOf(result.pages)[1]!.frag.rows[0]!.height).toBe(150);
  });

  it('starts a table below the content before it on the same page', () => {
    const para: ParagraphItem = {
      kind: 'paragraph',
      fragment: {
        kind: 'paragraph',
        blockId: 'p',
        from: 0,
        to: 1,
        x: 0,
        y: 0,
        width: 80,
        height: 20,
        lines: [{ from: 0, to: 1, x: 0, y: 0, width: 10, height: 20 }],
      },
      spaceBefore: 0,
      spaceAfter: 0,
      keepNext: false,
      keepLines: false,
      pageBreakBefore: false,
      widowControl: false,
    };
    const result = paginate([para, table('t', [row('a', 30)])], page(100));
    expect(tablesOf(result.pages)[0]!.frag.y).toBe(20);
    expect(tablesOf(result.pages)[0]!.frag.rows[0]!.y).toBe(20);
  });

  it('terminates and places every row once on random tables, with and without headers', () => {
    let seed = 0x5eed;
    const next = (): number => {
      // mulberry32: a small seeded generator, so that the sweep repeats.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let c = 0; c < 200; c++) {
      const count = 1 + Math.floor(next() * 14);
      const headers = Math.floor(next() * 3);
      const rows = Array.from({ length: count }, (_, i) =>
        row(`r${i}`, 5 + Math.floor(next() * 60), { header: i < headers }),
      );
      const items: PageItem[] = [table('t', rows)];
      const result = paginate(items, page(40 + Math.floor(next() * 80)));
      const bodyRows = rowsOf(result.pages).flatMap((p) => p.rows.filter((_, i) => !p.repeated[i]));
      expect(bodyRows).toEqual(rows.map((r) => r.rowId));
      expect(result.pageCountSettled).toBe(true);
    }
  });
});

describe('FE-083 tables from the flow (tableItem and layoutFlow)', () => {
  const afterSpace: BreakOpportunities = {
    opportunities(text) {
      const out: number[] = [];
      for (let i = 0; i + 1 < text.length; i++)
        if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
      return out;
    },
  };
  const providers: ItemProviders = {
    measurer: fixedWidthMeasurer(),
    breaks: afterSpace,
    lineBreaker: firstFitBreaker,
  };
  const text = (t: string): CdmNode => ({ type: 'text', text: t });
  const paragraph = (id: string, content: CdmNode[]): CdmNode => ({
    type: 'paragraph',
    attrs: { id, style: 'Normal' },
    content,
  });
  const cell = (content: CdmNode[]): CdmNode => ({ type: 'table_cell', attrs: {}, content });
  /** A table of rows, each row a list of cell nodes (see `cell`). */
  const tableNode = (id: string, rows: CdmNode[][], headerRows: number): CdmNode => ({
    type: 'table',
    attrs: { id, grid: [4000, 4000], headerRows },
    content: rows.map((cells) => ({ type: 'table_row', attrs: {}, content: cells })),
  });
  function envelope(body: CdmNode[]): CdmEnvelopeLike {
    return {
      doc: {
        type: 'doc',
        content: [
          {
            type: 'defs',
            content: [
              {
                type: 'settings',
                attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
              },
              {
                type: 'style_def',
                attrs: {
                  id: 'Normal',
                  kind: 'paragraph',
                  name: 'Normal',
                  builtIn: true,
                  fontFamily: 'Noto Serif',
                  fontSize: 220,
                },
              },
              {
                type: 'page_setup',
                attrs: {
                  id: 'ps1',
                  width: 11906,
                  height: 16838,
                  marginTop: 1440,
                  marginRight: 1440,
                  marginBottom: 1440,
                  marginLeft: 1440,
                },
              },
            ],
          },
          { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
        ],
      },
    };
  }

  it('lays a long table out over pages, repeats its header row, and covers every cell paragraph', () => {
    const rows: CdmNode[][] = [
      [cell([paragraph('h-a', [text('Head A')])]), cell([paragraph('h-b', [text('Head B')])])],
    ];
    for (let i = 0; i < 60; i++)
      rows.push([
        cell([paragraph(`a${i}`, [text(`cell a number ${i} with some words in it`)])]),
        cell([paragraph(`b${i}`, [text(`cell b number ${i}`)])]),
      ]);
    const flow = toFlow(envelope([tableNode('t1', rows, 1)]));
    const result = layoutFlow(flow, providers);
    expect(result.unplaced).toEqual([]);
    expect(result.tree.pages.length).toBeGreaterThan(1);
    const repeats = result.tree.pages
      .slice(1)
      .map((p) =>
        p.fragments.flatMap((f) => (f.kind === 'table' ? f.rows.filter((r) => r.repeated) : [])),
      );
    for (const r of repeats) expect(r.length).toBeGreaterThan(0);
    expect(checkCoverage(flow, result.tree)).toEqual([]);
  });

  it('freezes the rows, cells and cell fragments of a table, so that a mutation throws (FE-078 criterion 1)', () => {
    const rows: CdmNode[][] = [
      [cell([paragraph('h-a', [text('Head A')])]), cell([paragraph('h-b', [text('Head B')])])],
      [cell([paragraph('a', [text('Body A')])]), cell([paragraph('b', [text('Body B')])])],
    ];
    const result = layoutFlow(toFlow(envelope([tableNode('t1', rows, 1)])), providers);
    const frag = result.tree.pages[0]!.fragments.find((f) => f.kind === 'table');
    if (frag?.kind !== 'table') throw new Error('expected a table fragment on the first page');
    const firstRow = frag.rows[0]!;
    const firstCell = firstRow.cells[0]!;
    const firstPara = firstCell.fragments[0]!;
    expect(Object.isFrozen(frag)).toBe(true);
    expect(Object.isFrozen(frag.rows)).toBe(true);
    expect(Object.isFrozen(firstRow)).toBe(true);
    expect(Object.isFrozen(firstRow.cells)).toBe(true);
    expect(Object.isFrozen(firstCell.fragments)).toBe(true);
    expect(Object.isFrozen(firstPara)).toBe(true);
    expect(() => {
      (frag.rows as LayoutRow[]).push(firstRow);
    }).toThrow(TypeError);
    expect(() => {
      (firstRow as { height: number }).height = 0;
    }).toThrow(TypeError);
    expect(() => {
      (firstCell.fragments as LayoutFragment[]).length = 0;
    }).toThrow(TypeError);
  });

  it('hit tests a point in each cell to a position of that cell, and skips repeated header copies (FE-096 criterion 2)', () => {
    const rows: CdmNode[][] = [
      [cell([paragraph('a1', [text('Alpha cell')])]), cell([paragraph('b1', [text('Beta cell')])])],
    ];
    for (let i = 0; i < 90; i++)
      rows.push([
        cell([paragraph(`a${i + 2}`, [text(`row ${i}`)])]),
        cell([paragraph(`b${i + 2}`, [text(`col ${i}`)])]),
      ]);
    const tree = layoutFlow(toFlow(envelope([tableNode('t', rows, 1)])), providers).tree;
    expect(tree.pages.length).toBeGreaterThan(1);
    const span: SpanWidth = (_block, from, to) => (to - from) * 6;
    const first = tree.pages[0]!.fragments.find((f) => f.kind === 'table');
    if (first?.kind !== 'table') throw new Error('expected a table fragment on the first page');
    const at = (cellIndex: number): ParagraphFragment => {
      const fragment = first.rows[0]!.cells[cellIndex]!.fragments[0];
      if (fragment?.kind !== 'paragraph') throw new Error('expected a paragraph in the cell');
      return fragment;
    };
    const left = at(0);
    const right = at(1);
    const hit = (p: ParagraphFragment): DocPosition | null =>
      hitTest(tree, 0, p.x + p.lines[0]!.x + 1, p.y + p.lines[0]!.y + 1, span);
    expect(hit(left)?.blockId).toBe('a1');
    expect(hit(right)?.blockId).toBe('b1');
    // A selection from the first cell to the second gives one rectangle per cell line, in reading order.
    const picked = selectionRects(
      tree,
      { blockId: 'a1', offset: 0 },
      { blockId: 'b1', offset: 'Beta cell'.length },
      span,
    );
    expect(picked.map((r) => r.page)).toEqual([0, 0]);
    expect(picked[0]!.x).toBe(left.x + left.lines[0]!.x);
    expect(picked[1]!.x).toBe(right.x + right.lines[0]!.x);
    // The header row repeats on the second page: its copy lines are not hit targets.
    const headerLines = paintedLines(tree).filter((l) => l.blockId === 'a1' || l.blockId === 'b1');
    expect(headerLines.map((l) => l.page)).toEqual([0, 0]);
  });

  it('hit tests blank space in a cell, beside or below its text and in either half of the gap to the neighbour, to a position in that cell (FE-096 criterion 2)', () => {
    const long = 'many words that wrap over several lines in this cell';
    const rows: CdmNode[][] = [
      [cell([paragraph('a1', [text('Al')])]), cell([paragraph('b1', [text(long)])])],
      [cell([paragraph('a2', [text(long)])]), cell([paragraph('b2', [text('Be')])])],
    ];
    const tree = layoutFlow(toFlow(envelope([tableNode('t', rows, 0)])), providers).tree;
    const span: SpanWidth = (_block, from, to) => (to - from) * 6;
    const frag = tree.pages[0]!.fragments.find((f) => f.kind === 'table');
    if (frag?.kind !== 'table') throw new Error('expected a table fragment on the first page');
    const para = (r: number, c: number): ParagraphFragment => {
      const fragment = frag.rows[r]!.cells[c]!.fragments[0];
      if (fragment?.kind !== 'paragraph') throw new Error('expected a paragraph in the cell');
      return fragment;
    };
    const hit = (px: number, py: number): DocPosition | null => hitTest(tree, 0, px, py, span);

    // Row 1: a short left cell beside a right cell that wraps, so the row is taller than the left
    // cell's text and the right cell's text sits level with the blank space of the left cell.
    const [row1, row2] = [frag.rows[0]!, frag.rows[1]!];
    const [cellA, cellB] = [row1.cells[0]!, row1.cells[1]!];
    const a1 = para(0, 0);
    const b1 = para(0, 1);
    expect(b1.lines.length).toBeGreaterThan(1);
    const aEnd = a1.x + a1.lines[0]!.x + a1.lines[0]!.width;
    const bStart = b1.x + b1.lines[0]!.x;
    const middle = (aEnd + bStart) / 2;
    const nearA = (aEnd + middle) / 2;
    const nearB = (middle + cellA.x + cellA.width) / 2;
    // Both points are in the left cell's box, and the second is nearer the right cell's text.
    expect(nearA).toBeGreaterThan(aEnd);
    expect(nearB).toBeGreaterThan(middle);
    expect(nearB).toBeLessThan(cellA.x + cellA.width);
    const endA1: DocPosition = { blockId: 'a1', offset: 'Al'.length };
    const level = a1.y + a1.lines[0]!.y + a1.lines[0]!.height / 2;
    const lastB = b1.lines[b1.lines.length - 1]!;
    const below = b1.y + lastB.y + lastB.height / 2;
    expect(below).toBeLessThan(row1.y + row1.height);
    for (const px of [nearA, nearB]) {
      // Beside the text, on its line, and below it, level with the right cell's last line.
      expect(hit(px, level)).toEqual(endA1);
      expect(hit(px, below)).toEqual(endA1);
    }
    // Just inside the left cell's right edge, and just inside the right cell's left edge.
    expect(hit(cellA.x + cellA.width - 0.5, below)).toEqual(endA1);
    expect(hit(cellB.x + 0.5, below)?.blockId).toBe('b1');

    // Row 2, the mirror: a right cell with short text beside a left cell that wraps. Blank space in
    // the right cell, left of or below its text, gives a position in the right cell, never the left.
    const a2 = para(1, 0);
    const b2 = para(1, 1);
    const [cellA2, cellB2] = [row2.cells[0]!, row2.cells[1]!];
    const lastA2 = a2.lines[a2.lines.length - 1]!;
    const lowA2 = a2.y + lastA2.y + lastA2.height / 2;
    const b2Start = b2.x + b2.lines[0]!.x;
    const a2End = a2.x + a2.lines[0]!.x + a2.lines[0]!.width;
    expect(cellB2.x).toBeLessThan(b2Start);
    for (const px of [cellB2.x + 0.5, (cellB2.x + b2Start) / 2]) {
      expect(hit(px, b2.y + b2.lines[0]!.y + 1)).toEqual({ blockId: 'b2', offset: 0 });
      expect(hit(px, lowA2)).toEqual({ blockId: 'b2', offset: 0 });
    }
    // The left cell's own blank space, beyond its first line's end, stays in the left cell.
    expect(a2End).toBeLessThan(cellA2.x + cellA2.width - 0.5);
    expect(hit(cellA2.x + cellA2.width - 0.5, lowA2)?.blockId).toBe('a2');
    // Every painted line of the table records the box of its own cell.
    for (const line of paintedLines(tree)) {
      expect(line.cells).toHaveLength(1);
      const box = line.cells[0]!;
      expect(line.x).toBeGreaterThanOrEqual(box.x);
      expect(line.y).toBeGreaterThanOrEqual(box.y);
      expect(line.y + line.height).toBeLessThanOrEqual(box.y + box.height + 1e-9);
    }
  });

  it('reports a table with a nested table as unplaced, and places the rest of the body', () => {
    const nested = tableNode('inner', [[cell([paragraph('x', [text('inner')])])]], 0);
    const outer = tableNode('outer', [[cell([nested])]], 0);
    const flow = toFlow(envelope([outer, paragraph('after', [text('After the table.')])]));
    const result = layoutFlow(flow, providers);
    expect(result.unplaced).toEqual(['outer']);
    const pieces = result.tree.pages.flatMap((p) => p.fragments.map((f) => f.kind));
    expect(pieces).toContain('paragraph');
  });
});
