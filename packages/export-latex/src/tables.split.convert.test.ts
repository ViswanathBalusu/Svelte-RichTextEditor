/**
 * EXP-039 (Node.js only): a table row taller than a page is split at block boundaries, from the
 * heights of the editor's own page layout (owner decision 114), and the preflight reports it before
 * export. The measure here is built by hand; `tables.split.layout.test.ts` takes it from the real
 * layout engine. The compiled PDF is checked by `tables.split.compile.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';
import { preflight } from './preflight.ts';
import type { TableMeasure } from './table-measure.ts';

const CLASS = '% class\n';
const BODY = 100;

interface Built {
  table: J;
  tableId: string;
  rowIds: string[];
  paraIds: string[][];
}

/**
 * A table of `headerRows` header rows, then a short row and a tall row. The tall row's first cell
 * holds `blocks` paragraphs and its second cell one.
 */
function build(blocks: number, headerRows = 1): Built {
  const tableId = nid('t');
  const rowIds: string[] = [];
  const paraIds: string[][] = [];
  const mk = (cells: string[][]): J => {
    const rowId = nid('r');
    rowIds.push(rowId);
    return {
      type: 'table_row',
      attrs: { id: rowId },
      content: cells.map((texts) => ({
        type: 'table_cell',
        attrs: { id: nid('c') },
        content: texts.map((text) => {
          const p = para(text);
          (paraIds[rowIds.length - 1] ??= []).push((p.attrs as J)['id'] as string);
          return p;
        }),
      })),
    };
  };
  const rows = [
    ...Array.from({ length: headerRows }, () => mk([['Head A'], ['Head B']])),
    mk([['Short A'], ['Short B']]),
    mk([Array.from({ length: blocks }, (_, i) => `Block ${i + 1}`), ['Side note']]),
  ];
  return {
    table: { type: 'table', attrs: { id: tableId, grid: [2880, 2880], headerRows }, content: rows },
    tableId,
    rowIds,
    paraIds,
  };
}

/** The measure of a built table: every paragraph of the tall row is `each` high. */
function measureOf(b: Built, each: number, headerRows = 1): TableMeasure {
  const doc_ = b.table.content as J[];
  return {
    engine: 'test',
    measurer: 'test',
    tables: [
      {
        tableId: b.tableId,
        body: BODY,
        rows: doc_.map((row, r) => {
          const cells = (row.content as J[]).map((cell) => ({
            cellId: (cell.attrs as J)['id'] as string,
            blocks: (cell.content as J[]).map((p) => ({
              blockId: (p.attrs as J)['id'] as string,
              height: r === headerRows + 1 ? each : 10,
            })),
          }));
          const tallest = Math.max(...cells.map((c) => c.blocks.reduce((s, x) => s + x.height, 0)));
          const overhead = 6;
          return {
            rowId: (row.attrs as J)['id'] as string,
            height: tallest + overhead,
            overhead,
            cells,
          };
        }),
      },
    ],
  };
}

async function convert(b: Built, measure?: TableMeasure) {
  return run(doc([b.table]), {
    classFiles: { 'docedit.cls': CLASS, 'docedit.lua': '-- lua\n' },
    ...(measure ? { tableMeasure: measure } : {}),
  });
}

const rowEnds = (lines: string[]): number => lines.filter((l) => l === '\\\\').length;

describe('EXP-039 criterion 1: a row taller than a page is split at block boundaries', () => {
  it('sets a tall row as continuation rows and warns with the table and the row', async () => {
    const b = build(6);
    const plain = await convert(b);
    const split = await convert(b, measureOf(b, 40));
    // 40 + 6 per block: two blocks fit a page body of 100, three do not: 3 parts.
    const extra = rowEnds(blockLines(split, b.tableId)) - rowEnds(blockLines(plain, b.tableId));
    expect(extra).toBe(2);
    const warning = split.diagnostics.filter((d) => d.code === 'row_split');
    expect(warning).toHaveLength(1);
    expect(warning[0]!.message).toContain(b.tableId);
    expect(warning[0]!.message).toContain('row 3');
    expect(warning[0]!.message).toContain('3 continuation rows');
    expect(warning[0]!.blockId).toBe(b.tableId);
  });

  it('keeps every block once and in order', async () => {
    const b = build(6);
    const split = await convert(b, measureOf(b, 40));
    const main = split.files['main.tex']!;
    const at = [1, 2, 3, 4, 5, 6].map((i) => main.indexOf(`Block ${i}`));
    expect(at.every((x) => x >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    for (const i of [1, 2, 3, 4, 5, 6]) expect(main.split(`Block ${i}`).length - 1).toBe(1);
    expect(main.split('Side note').length - 1).toBe(1);
  });

  it('maps the lines of the continuation rows to the original table block', async () => {
    const b = build(6);
    const split = await convert(b, measureOf(b, 40));
    const lines = blockLines(split, b.tableId);
    // Header row (twice: first and repeated head), short row, three parts of the tall row.
    expect(rowEnds(lines)).toBe(2 + 1 + 3);
    // And the row's own paragraphs are blocks of their own, as before.
    expect(split.map.blocks).toContain(b.paraIds[2]![0]);
  });

  it('splits nothing and says nothing without a measure, or when the row fits', async () => {
    const b = build(6);
    const none = await convert(b);
    expect(none.diagnostics.map((d) => d.code)).not.toContain('row_split');
    const fits = await convert(b, measureOf(b, 10));
    expect(fits.diagnostics.map((d) => d.code)).not.toContain('row_split');
    expect(fits.files['main.tex']).toBe(none.files['main.tex']);
  });

  it('does not split a header row', async () => {
    // The tall row as the header row: never split.
    const headerTall = build(6, 0);
    const m = measureOf(headerTall, 40, 0);
    (headerTall.table.attrs as J)['headerRows'] = 2;
    const res = await convert(headerTall, m);
    expect(res.diagnostics.map((d) => d.code)).not.toContain('row_split');
  });
});

describe('EXP-039 criterion 3: a block taller than a page is named', () => {
  it('names the paragraph that does not fit a page alone', async () => {
    const b = build(3);
    const res = await convert(b, measureOf(b, 150));
    const d = res.diagnostics.filter((x) => x.code === 'block_taller_than_page');
    expect(d.length).toBeGreaterThan(0);
    expect(d.map((x) => x.blockId)).toContain(b.paraIds[2]![0]);
    expect(d[0]!.message).toContain('row 3');
    expect(d[0]!.message).toContain(b.tableId);
  });
});

describe('EXP-039 criterion 4: the preflight reports the row before export', () => {
  it('reports the row and the blocks with the same measure the converter gets', async () => {
    const b = build(6);
    const envelope = doc([b.table]);
    const warnings = preflight(envelope, undefined, measureOf(b, 40));
    const row = warnings.filter((w) => w.code === 'row_taller_than_page');
    expect(row).toHaveLength(1);
    expect(row[0]!.blockId).toBe(b.tableId);
    expect(row[0]!.message).toContain('row 3');
    expect(warnings.some((w) => w.code === 'block_taller_than_page')).toBe(false);

    const tall = build(2);
    const w2 = preflight(doc([tall.table]), undefined, measureOf(tall, 150));
    expect(w2.filter((w) => w.code === 'block_taller_than_page').map((w) => w.blockId)).toContain(
      tall.paraIds[2]![0],
    );
  });

  it('reports nothing without a measure, and the job carries no duplicate of it', async () => {
    const b = build(6);
    expect(preflight(doc([b.table]))).toEqual([]);
    const res = await convert(b, measureOf(b, 40));
    expect(res.diagnostics.map((d) => d.code)).not.toContain('row_taller_than_page');
  });
});
