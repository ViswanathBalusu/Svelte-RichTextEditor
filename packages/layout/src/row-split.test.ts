/**
 * Table rows cut at paragraph boundaries (FE-083 criteria 1 and 4), in Node.js. The rows are built
 * directly with their paragraph heights, so each case states its geometry. The property test uses
 * fast-check with a fixed seed, so every run is repeatable.
 */
import fc from 'fast-check';
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
import { splitRowAt } from './row-split.ts';
import type { LayoutFragment, TableFragment } from './tree.ts';

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };
const page = (height: number): PageSetup => ({ width: 80, height, margins: { ...ZERO } });

/** A paragraph of the given height whose offsets are `from` to `from + 1`. */
function para(from: number, height: number): ParagraphItem {
  return {
    kind: 'paragraph',
    fragment: {
      kind: 'paragraph',
      blockId: `p${from}`,
      from,
      to: from + 1,
      x: 0,
      y: 0,
      width: 80,
      height,
      lines: [],
    },
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: false,
  };
}

/** A row whose cells hold the given paragraph heights; `from` counts on across the cells. */
function row(
  id: string,
  cells: readonly (readonly number[])[],
  over: { header?: boolean; cantSplit?: boolean } = {},
): TableRowItem {
  let from = 0;
  const built: TableCellItem[] = cells.map((heights, c) => ({
    cellId: `${id}/c${c}`,
    x: c * 40,
    width: 40,
    margins: { ...ZERO },
    paragraphs: heights.map((h) => para(from++, h)),
  }));
  const height = Math.max(
    0,
    ...built.map((c) => c.paragraphs.reduce((s, p) => s + p.fragment.height, 0)),
  );
  return {
    rowId: id,
    header: over.header ?? false,
    cantSplit: over.cantSplit ?? false,
    height,
    cells: built,
  };
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

/** The paragraph offsets of each cell, in placement order, over all pages. */
function offsetsByCell(pages: readonly PaginatedPage[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const { frag } of tablesOf(pages))
    for (const r of frag.rows)
      for (const c of r.cells) {
        const list = out.get(c.cellId) ?? [];
        for (const f of c.fragments) if (f.kind === 'paragraph') list.push(f.from);
        out.set(c.cellId, list);
      }
  return out;
}

describe('FE-083 rows cut at paragraph boundaries (row-split)', () => {
  it('cuts a row taller than the body between its paragraphs and continues the tail on the next page (criterion 4)', () => {
    const result = paginate([table([row('r', [[20, 20, 20]])])], page(50));
    expect(result.overflowed).toEqual([]);
    const placed = tablesOf(result.pages);
    expect(placed.map((p) => p.page)).toEqual([0, 1]);
    expect(placed[0]!.frag.rows[0]).toMatchObject({ rowId: 'r', y: 0, height: 40 });
    expect(placed[1]!.frag.rows[0]).toMatchObject({ rowId: 'r', y: 0, height: 20 });
    // Each piece records only the paragraphs it covers.
    expect(
      placed[0]!.frag.rows[0]!.cells[0]!.fragments.map((f) => f.kind === 'paragraph' && f.from),
    ).toEqual([0, 1]);
    expect(
      placed[1]!.frag.rows[0]!.cells[0]!.fragments.map((f) => f.kind === 'paragraph' && f.from),
    ).toEqual([2]);
  });

  it('uses one cut index for all cells, and a cell with fewer paragraphs goes whole into the head', () => {
    // Cell A: 20, 20. Cell B: 10, 10, 10. In a body of 35 the head holds one paragraph per cell.
    const result = paginate(
      [
        table([
          row('r', [
            [20, 20],
            [10, 10, 10],
          ]),
        ]),
      ],
      page(35),
    );
    const placed = tablesOf(result.pages);
    expect(placed.map((p) => p.page)).toEqual([0, 1]);
    expect(placed[0]!.frag.rows[0]!.height).toBe(20);
    expect(placed[1]!.frag.rows[0]!.height).toBe(20);
    expect(offsetsByCell(result.pages).get('r/c0')).toEqual([0, 1]);
    expect(offsetsByCell(result.pages).get('r/c1')).toEqual([2, 3, 4]);
  });

  it('keeps a header row whole and repeats it on each continuation of a cut row', () => {
    const rows = [row('h', [[20]], { header: true }), row('b', [[20, 20, 20]])];
    const result = paginate([table(rows)], page(50));
    const placed = tablesOf(result.pages);
    expect(placed.map((p) => p.frag.rows.map((r) => [r.rowId, r.repeated]))).toEqual([
      [
        ['h', false],
        ['b', false],
      ],
      [
        ['h', true],
        ['b', false],
      ],
      [
        ['h', true],
        ['b', false],
      ],
    ]);
    expect(result.overflowed).toEqual([]);
  });

  it('moves a cantSplit row whole, and a row with a single paragraph per cell, as before', () => {
    const cant = paginate(
      [table([row('a', [[60]]), row('b', [[20, 20, 20]], { cantSplit: true })])],
      page(50),
    );
    expect(tablesOf(cant.pages).map((p) => [p.page, p.frag.rows.map((r) => r.rowId)])).toEqual([
      [0, ['a']],
      [1, ['b']],
    ]);
    expect(cant.overflowed).toEqual(['t']);
    const single = paginate([table([row('a', [[30]]), row('b', [[60]])])], page(50));
    expect(tablesOf(single.pages).map((p) => [p.page, p.frag.rows.map((r) => r.rowId)])).toEqual([
      [0, ['a']],
      [1, ['b']],
    ]);
  });

  it('gives no cut when the head would not fit the room, and none for a paragraph taller than the body', () => {
    const rows = [row('r', [[30, 30]])];
    expect(splitRowAt(rows[0]!, 20)).toBeNull();
    expect(splitRowAt(rows[0]!, 30)?.head.height).toBe(30);
    const tall = paginate([table([row('t1', [[70, 10]])])], page(50));
    expect(tall.overflowed).toEqual(['t']);
    expect(tablesOf(tall.pages)[0]!.frag.rows[0]!.height).toBe(80);
  });

  it('cuts a row without losing or repeating a paragraph, on random tables (property test)', () => {
    const cellArb = fc.array(fc.integer({ min: 1, max: 40 }), { minLength: 0, maxLength: 4 });
    const rowArb = fc.array(cellArb, { minLength: 1, maxLength: 3 });
    fc.assert(
      fc.property(fc.array(rowArb, { minLength: 1, maxLength: 6 }), (rowsSpec) => {
        const rows = rowsSpec.map((cells, i) => row(`r${i}`, cells));
        const result = paginate([table(rows)], page(100));
        expect(result.overflowed).toEqual([]);
        // Every piece stays inside the body.
        for (const { frag } of tablesOf(result.pages))
          expect(frag.y + frag.height).toBeLessThanOrEqual(100 + 1e-6);
        // Each cell's paragraphs are placed once, in order.
        // The offsets count from 0 in each row, cell after cell (see `row`).
        const expected = new Map<string, number[]>();
        rowsSpec.forEach((cells, i) => {
          let from = 0;
          cells.forEach((heights, c) => {
            const list: number[] = [];
            for (let p = 0; p < heights.length; p++) list.push(from++);
            expected.set(`r${i}/c${c}`, list);
          });
        });
        const got = offsetsByCell(result.pages);
        for (const [cellId, offsets] of expected) {
          if (offsets.length === 0) continue;
          expect(got.get(cellId)).toEqual(offsets);
        }
      }),
      { seed: 20261113, numRuns: 300 },
    );
  });
});
