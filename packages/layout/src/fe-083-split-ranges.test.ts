/**
 * FE-083 criterion 5: a table with spanning cells, borders and shading, split across pages, where
 * every fragment, row and cell records the block identifier and the CDM offsets it covers (FE-078).
 * The layout draws no borders or shading (the painter does); the test checks that carrying them in
 * the document changes neither the split nor the ranges.
 */
import { describe, expect, it } from 'vitest';
import { layoutFlow } from './engine.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import type { LayoutFragment, LayoutRow, TableFragment } from './tree.ts';

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

/** The size of a node in CDM positions: text by length, a node by its content plus two. */
function size(n: CdmNode): number {
  if (n.type === 'text') return (n as { text?: string }).text?.length ?? 0;
  return 2 + (n.content ?? []).reduce((sum, c) => sum + size(c), 0);
}

const SINGLE = { style: 'single', width: 4, color: null, space: 0 };
const cell = (id: string, text: string, extra: Record<string, unknown> = {}): CdmNode => ({
  type: 'table_cell',
  attrs: { id, ...extra },
  content: [para(`${id}p`, text)],
});

/** Header row, then rows of three cells; every third row has a cell spanning two columns. */
function rowsOf(count: number): CdmNode[] {
  const rows: CdmNode[] = [
    {
      type: 'table_row',
      attrs: { id: 'r0' },
      content: [
        cell('r0c0', 'Name', { shading: { fill: 'D9D9D9' } }),
        cell('r0c1', 'Value', { shading: { fill: 'D9D9D9' } }),
        cell('r0c2', 'Note', { shading: { fill: 'D9D9D9' } }),
      ],
    },
  ];
  for (let r = 1; r <= count; r++) {
    const spanning = r % 3 === 0;
    rows.push({
      type: 'table_row',
      attrs: { id: `r${r}` },
      content: spanning
        ? [
            cell(`r${r}c0`, `row ${r} spans two columns`, {
              colspan: 2,
              borders: { top: SINGLE, bottom: SINGLE, left: null, right: null },
            }),
            cell(`r${r}c1`, `end ${r}`, { shading: { fill: 'FFF2CC' } }),
          ]
        : [
            cell(`r${r}c0`, `a ${r}`),
            cell(`r${r}c1`, `b ${r}`, { shading: { fill: 'FFF2CC' } }),
            cell(`r${r}c2`, `c ${r}`),
          ],
    });
  }
  return rows;
}

const table: CdmNode = {
  type: 'table',
  attrs: {
    id: 'tbl',
    grid: [1000, 1500, 1500],
    headerRows: 1,
    borders: {
      top: SINGLE,
      bottom: SINGLE,
      left: SINGLE,
      right: SINGLE,
      insideH: SINGLE,
      insideV: SINGLE,
    },
  },
  content: rowsOf(20),
};

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
                width: 4000,
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

const { tree } = layoutFlow(toFlow(envelope([para('before', 'Text before the table'), table])), providers);
const pieces: TableFragment[] = tree.pages
  .flatMap((p) => p.fragments)
  .filter((f: LayoutFragment): f is TableFragment => f.kind === 'table');

describe('a split table records the block and the offsets of every fragment (FE-083 criterion 5)', () => {
  it('splits the table over several pages', () => {
    expect(pieces.length).toBeGreaterThan(1);
    expect(new Set(pieces.map((p) => p.blockId))).toEqual(new Set(['tbl']));
  });

  it('records a range on every fragment, row and cell, each inside the one that holds it', () => {
    for (const f of pieces) {
      expect(Number.isInteger(f.from) && Number.isInteger(f.to), 'fragment').toBe(true);
      for (const r of f.rows) {
        expect(Number.isInteger(r.from) && Number.isInteger(r.to), r.rowId).toBe(true);
        expect(r.from! >= f.from! && r.to! <= f.to!, r.rowId).toBe(true);
        for (const c of r.cells) {
          expect(Number.isInteger(c.from) && Number.isInteger(c.to), c.cellId).toBe(true);
          expect(c.from! >= r.from! && c.to! <= r.to!, c.cellId).toBe(true);
        }
      }
    }
  });

  it('covers the table from 0 to its size, and the rows meet without a gap', () => {
    expect(pieces[0]!.from).toBe(0);
    expect(pieces[pieces.length - 1]!.to).toBe(size(table) - 2);
    const laid: LayoutRow[] = pieces.flatMap((p) => p.rows).filter((r) => !r.repeated);
    expect(laid).toHaveLength(21);
    for (let i = 1; i < laid.length; i++) expect(laid[i]!.from, laid[i]!.rowId).toBe(laid[i - 1]!.to);
  });

  it('records the offsets of each cell as the model counts them', () => {
    const laid = pieces.flatMap((p) => p.rows).filter((r) => !r.repeated);
    let at = 0;
    for (const [i, node] of (table.content ?? []).entries()) {
      const row = laid[i]!;
      expect(row.rowId).toBe(node.attrs?.['id']);
      expect([row.from, row.to]).toEqual([at, at + size(node)]);
      let cellAt = at + 1;
      for (const [j, c] of (node.content ?? []).entries()) {
        expect([row.cells[j]!.from, row.cells[j]!.to], row.cells[j]!.cellId).toEqual([
          cellAt,
          cellAt + size(c),
        ]);
        cellAt += size(c);
      }
      at += size(node);
    }
  });

  it('keeps a spanning cell as wide as its columns, and repeats the header on each piece', () => {
    const spanning = pieces.flatMap((p) => p.rows).find((r) => r.rowId === 'r3')!;
    expect(spanning.cells[0]!.width).toBeCloseTo(125, 6);
    expect(spanning.cells[1]!.width).toBeCloseTo(75, 6);
    for (const f of pieces.slice(1)) {
      expect(f.rows[0]!.rowId).toBe('r0');
      expect(f.rows[0]!.repeated).toBe(true);
    }
  });

  it('splits the same way when the borders and shading are taken away', () => {
    const plain = JSON.parse(JSON.stringify(table), (k, v: unknown) =>
      k === 'borders' || k === 'shading' ? undefined : v,
    ) as CdmNode;
    const again = layoutFlow(toFlow(envelope([para('before', 'Text before the table'), plain])), providers)
      .tree;
    const shape = (t: typeof tree): unknown =>
      t.pages.map((p) =>
        p.fragments.map((f) =>
          f.kind === 'table' ? [f.blockId, f.from, f.to, f.rows.map((r) => [r.rowId, r.from, r.to])] : f.blockId,
        ),
      );
    expect(shape(again)).toEqual(shape(tree));
  });
});
