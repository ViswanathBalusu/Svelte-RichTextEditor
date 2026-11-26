/**
 * EXP-039: the heights of table rows and of the paragraphs in their cells, read from the editor's
 * own layout (owner decision 114). The page is small so that a row of a few paragraphs is taller
 * than its body.
 */
import { describe, expect, it } from 'vitest';
import type { CdmEnvelopeLike, CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import { measureTables } from './table-measure.ts';

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

const para = (id: string, text: string): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content: [{ type: 'text', text }],
});
const cell = (id: string, paras: number): CdmNode => ({
  type: 'table_cell',
  attrs: { id },
  content: Array.from({ length: paras }, (_, i) => para(`${id}p${i}`, `text ${id} ${i}`)),
});
const row = (id: string, paras: number): CdmNode => ({
  type: 'table_row',
  attrs: { id },
  content: [cell(`${id}a`, paras), cell(`${id}b`, 1)],
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
                fontSize: 200,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 6000,
                height: 3200,
                marginTop: 0,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

const table = (rows: CdmNode[]): CdmNode => ({
  type: 'table',
  attrs: { id: 'tbl', grid: [2000, 2000] },
  content: rows,
});

describe('measureTables (EXP-039; owner decision 114)', () => {
  const measure = measureTables(envelope([table([row('short', 1), row('tall', 40)])]), providers);
  const t = measure.tables.find((x) => x.tableId === 'tbl')!;

  it('gives the page body height and every row of the table', () => {
    expect(t.body).toBe(160);
    expect(t.rows.map((r) => r.rowId)).toEqual(['short', 'tall']);
  });

  it('measures a row taller than the body as taller, though the layout cut it over pages', () => {
    const short = t.rows[0]!;
    const tall = t.rows[1]!;
    expect(short.height).toBeLessThan(t.body);
    expect(tall.height).toBeGreaterThan(t.body);
  });

  it('gives the height of each paragraph of a cell, in order', () => {
    const tall = t.rows[1]!;
    const a = tall.cells.find((c) => c.cellId === 'talla')!;
    expect(a.blocks.map((b) => b.blockId).slice(0, 2)).toEqual(['tallap0', 'tallap1']);
    expect(a.blocks).toHaveLength(40);
    expect(a.blocks.every((b) => b.height > 0)).toBe(true);
    expect(tall.overhead).toBeGreaterThanOrEqual(0);
  });

  it('records the engine and the measurer', () => {
    expect(measure.engine).toMatch(/^@docedit\/layout@/);
    expect(measure.measurer.length).toBeGreaterThan(0);
  });
});
