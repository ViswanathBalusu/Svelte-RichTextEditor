/**
 * EXP-041 criterion 2 (Node.js only): a cell that spans rows and holds content is reported with its
 * block identifier. The converter does not measure heights, so the report is raised for every
 * row-spanned cell with content, which includes every one that is taller than the rows it spans
 * (a superset; see the story Notes). Nothing is compiled here.
 */
import { describe, expect, it } from 'vitest';
import { codes, doc, nid, para, run, type J } from '../test/docs.ts';

const CODE = 'span_taller_than_rows';

function cell(content: J[], attrs: J, id: string): J {
  return { type: 'table_cell', attrs: { id, ...attrs }, content };
}

function table(grid: number[], rows: J[][], id = nid('t')): J {
  return {
    type: 'table',
    attrs: { id, grid },
    content: rows.map((cells) => ({ type: 'table_row', attrs: { id: nid('r') }, content: cells })),
  };
}

describe('EXP-041 criterion 2: spanned content taller than its rows is reported with its block', () => {
  it('reports a row-spanned cell with content, with that cell as the block', async () => {
    const tall = nid('c');
    const t = table(
      [1440, 1440],
      [
        [
          cell(
            [para('A tall paragraph of text that runs over several lines of the spanned rows.')],
            { rowspan: 2 },
            tall,
          ),
          cell([para('A.')], {}, nid('c')),
        ],
        [cell([para('B.')], {}, nid('c'))],
      ],
    );
    const b = await run(doc([t]));
    const found = b.diagnostics.filter((d) => d.code === CODE);
    expect(found.map((d) => d.blockId)).toEqual([tall]);
    expect(found[0]!.severity).toBe('warning');
  });

  it('reports each row-spanned cell with content once, and reports nothing for a cell without a row span', async () => {
    const a = nid('c');
    const c = nid('c');
    const t = table(
      [1440, 1440, 1440],
      [
        [
          cell([para('Span A.')], { rowspan: 2 }, a),
          cell([para('Span C.')], { rowspan: 2 }, c),
          cell([para('Plain.')], {}, nid('c')),
        ],
        [cell([para('Under.')], {}, nid('c'))],
      ],
    );
    const b = await run(doc([t]));
    expect(b.diagnostics.filter((d) => d.code === CODE).map((d) => d.blockId)).toEqual([a, c]);
  });

  it('reports nothing for a spanned cell with no content, and nothing for a table without spans', async () => {
    const empty = table(
      [1440, 1440],
      [
        [cell([], { rowspan: 2 }, nid('c')), cell([para('A.')], {}, nid('c'))],
        [cell([para('B.')], {}, nid('c'))],
      ],
    );
    const plain = table(
      [1440, 1440],
      [[cell([para('A.')], {}, nid('c')), cell([para('B.')], {}, nid('c'))]],
    );
    expect(codes(await run(doc([empty])))).not.toContain(CODE);
    expect(codes(await run(doc([plain])))).not.toContain(CODE);
  });

  it('reports a column-spanned cell with content nowhere (its height is the height of one row)', async () => {
    const t = table([1440, 1440], [[cell([para('Wide.')], { colspan: 2 }, nid('c'))]]);
    expect(codes(await run(doc([t])))).not.toContain(CODE);
  });
});
