/**
 * EXP-039 criteria 1, 3 and 4 with the heights of the real layout engine (Node.js only): the
 * measure comes from `measureTables` of `@docedit/layout` (owner decision 114: the editor's own
 * page layout, no first compile pass), and the converter and the preflight take it unchanged. The
 * layout is imported by path because this package does not depend on it; tests may.
 */
import { describe, expect, it } from 'vitest';
import {
  firstFitBreaker,
  fixedWidthMeasurer,
  measureTables,
  type BreakOpportunities,
  type ItemProviders,
} from '../../layout/src/index.ts';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';
import { preflight } from './preflight.ts';

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

function tallTable(blocks: number): { table: J; tableId: string; ids: string[] } {
  const tableId = nid('t');
  const ids: string[] = [];
  const cellA = Array.from({ length: blocks }, (_, i) => {
    const p = para(`Block ${i + 1}`);
    ids.push((p.attrs as J)['id'] as string);
    return p;
  });
  const row = (cells: J[][]): J => ({
    type: 'table_row',
    attrs: { id: nid('r') },
    content: cells.map((content) => ({ type: 'table_cell', attrs: { id: nid('c') }, content })),
  });
  return {
    table: {
      type: 'table',
      attrs: { id: tableId, grid: [2880, 2880], headerRows: 1 },
      content: [row([[para('Head A')], [para('Head B')]]), row([cellA, [para('Side')]])],
    },
    tableId,
    ids,
  };
}

describe('EXP-039 with the heights of the editor layout', () => {
  const { table, tableId, ids } = tallTable(120);
  const envelope = doc([table]);
  const measure = measureTables(envelope as never, providers);
  const t = measure.tables.find((x) => x.tableId === tableId)!;

  it('measures the tall row as taller than the page body', () => {
    expect(t.body).toBeGreaterThan(0);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]!.height).toBeGreaterThan(t.body);
    expect(t.rows[0]!.height).toBeLessThan(t.body);
  });

  it('splits the row in the export, keeps the text, and warns', async () => {
    const plain = await run(envelope, {
      classFiles: { 'docedit.cls': '%\n', 'docedit.lua': '--\n' },
    });
    const split = await run(envelope, {
      classFiles: { 'docedit.cls': '%\n', 'docedit.lua': '--\n' },
      tableMeasure: measure,
    });
    const w = split.diagnostics.filter((d) => d.code === 'row_split');
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain(tableId);
    const ends = (b: typeof split): number =>
      blockLines(b, tableId).filter((l) => l === '\\\\').length;
    expect(ends(split)).toBeGreaterThan(ends(plain));
    const main = split.files['main.tex']!;
    for (let n = 1; n <= 120; n++)
      expect(main.match(new RegExp(`Block ${n}\\b`, 'g'))).toHaveLength(1);
    expect(ids).toHaveLength(120);
  });

  it('names a single paragraph that is taller than a page, in the export and the preflight', async () => {
    const long = para(Array.from({ length: 3000 }, () => 'word').join(' '));
    const id = (long.attrs as J)['id'] as string;
    const tableId = nid('t');
    const envelope = doc([
      {
        type: 'table',
        attrs: { id: tableId, grid: [2880, 2880] },
        content: [
          {
            type: 'table_row',
            attrs: { id: nid('r') },
            content: [
              { type: 'table_cell', attrs: { id: nid('c') }, content: [para('Before'), long] },
              { type: 'table_cell', attrs: { id: nid('c') }, content: [para('Side')] },
            ],
          },
        ],
      },
    ]);
    const measure = measureTables(envelope as never, providers);
    const b = await run(envelope, {
      classFiles: { 'docedit.cls': '%\n', 'docedit.lua': '--\n' },
      tableMeasure: measure,
    });
    const d = b.diagnostics.filter((x) => x.code === 'block_taller_than_page');
    expect(d.map((x) => x.blockId)).toEqual([id]);
    expect(d[0]!.message).toContain(id);
    const p = preflight(envelope, undefined, measure).filter(
      (x) => x.code === 'block_taller_than_page',
    );
    expect(p.map((x) => x.blockId)).toEqual([id]);
  });

  it('reports the same row from the preflight', () => {
    const w = preflight(envelope, undefined, measure).filter(
      (x) => x.code === 'row_taller_than_page',
    );
    expect(w.map((x) => x.blockId)).toEqual([tableId]);
  });
});
