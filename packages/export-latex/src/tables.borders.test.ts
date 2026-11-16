/**
 * Cell borders (Node.js only): EXP-038 criterion 4 (cell borders) and EXP-041 criterion 3 (the
 * borders of a spanned cell cover the span once). The tests read the converter's main.tex and the
 * class file. The printed rules are checked by `tables.borders.compile.test.ts`.
 *
 * Widths are in twips: 20 twips is 1 bp, so a border of width 20 is written `1bp`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codes, doc, nid, para, run, type J } from '../test/docs.ts';

const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');
const LUA = '-- lua\n';

const RED = { style: 'single', width: 20, color: '#FF0000' };
const BLUE = { style: 'single', width: 40, color: '#0000FF' };
const GRID_RULE = { style: 'single', width: 8, color: '#000000' };
const NONE = { style: 'none' };
const ALL = (b: J): J => ({ top: b, bottom: b, left: b, right: b });

/** A table whose rows are lists of cells; each cell is `[text, attrs]`. */
function table(grid: number[], rows: [string, J][][], tableAttrs: J = {}): J {
  return {
    type: 'table',
    attrs: { id: nid('t'), grid, ...tableAttrs },
    content: rows.map((cells) => ({
      type: 'table_row',
      attrs: { id: nid('r') },
      content: cells.map(([text, attrs]) => ({
        type: 'table_cell',
        attrs: { id: nid('c'), ...attrs },
        content: [para(text)],
      })),
    })),
  };
}

async function convert(
  t: J,
  parts: Parameters<typeof doc>[1] = {},
): Promise<{ main: string; codes: string[] }> {
  const b = await run(doc([t], parts), {
    classFiles: { 'docedit.cls': CLASS, 'docedit.lua': LUA },
  });
  return { main: b.files['main.tex']!, codes: codes(b) };
}

const count = (s: string, needle: string): number => s.split(needle).length - 1;
const linesOf = (s: string): string[] => s.split('\n');

describe('EXP-038 criterion 4: cell borders are drawn', () => {
  it('defines the class macros for cell borders', () => {
    expect(CLASS).toContain('\\protected\\def\\DEvrule#1#2{');
    expect(CLASS).toMatch(/\\newcommand\*\\DEcline\[3\]\{\\noalign\{/);
    expect(CLASS).toContain('\\newcommand*\\DEclinegap[1]');
    expect(CLASS).toContain('\\newcommand*\\DEclineend{');
  });

  it('draws the four borders of a cell in its own width and colour, and no longer warns cell_borders', async () => {
    const { main, codes: c } = await convert(
      table(
        [1440, 1440],
        [
          [
            ['Red.', { borders: ALL(RED) }],
            ['Plain.', {}],
          ],
        ],
      ),
    );
    expect(c).not.toContain('cell_borders');
    // Left and right edges: the cell's column specification carries them as !{} separators.
    const open = linesOf(main).find((l) =>
      l.startsWith('\\multicolumn{1}{!{\\DEvrule{1bp}{FF0000}}p{'),
    );
    expect(open, main).toBeDefined();
    expect(open!.endsWith('}!{\\DEvrule{1bp}{FF0000}}}{%')).toBe(true);
    // Top and bottom: one \DEcline over the first column each, then the table's rule comes back.
    expect(count(main, '\\DEcline{1-1}{1bp}{FF0000}')).toBe(2);
    expect(count(main, '\\DEclineend')).toBe(2);
    expect(main).not.toContain('\\hline');
  });

  it('keeps a table without cell borders as it was (table rules only)', async () => {
    const { main } = await convert(
      table(
        [1440, 1440],
        [
          [
            ['A.', {}],
            ['B.', {}],
          ],
          [
            ['C.', {}],
            ['D.', {}],
          ],
        ],
        {
          borders: {
            top: GRID_RULE,
            bottom: GRID_RULE,
            left: GRID_RULE,
            right: GRID_RULE,
            insideH: GRID_RULE,
            insideV: GRID_RULE,
          },
        },
      ),
    );
    expect(main).not.toContain('\\DEcline');
    expect(main).not.toContain('\\DEvrule');
    expect(count(main, '\\hline')).toBe(3);
  });

  it('removes a table border on the outer edge where the cell sets style none', async () => {
    const { main } = await convert(
      table(
        [1440, 1440],
        [
          [
            ['Open.', { borders: { left: NONE, top: NONE } }],
            ['B.', {}],
          ],
        ],
        {
          borders: { top: GRID_RULE, bottom: GRID_RULE, left: GRID_RULE, right: GRID_RULE },
        },
      ),
    );
    // The first cell's spec has no leading rule; the top rule is drawn over the second column only.
    expect(linesOf(main).some((l) => l.startsWith('\\multicolumn{1}{p{'))).toBe(true);
    expect(main).toContain('\\DEcline{2-2}');
  });

  it('keeps an inside edge when only one of the two cells sets none (the other side is drawn)', async () => {
    const { main } = await convert(
      table(
        [1440, 1440],
        [
          [
            ['A.', { borders: { right: NONE } }],
            ['B.', {}],
          ],
        ],
        { borders: { insideV: GRID_RULE } },
      ),
    );
    expect(main).not.toContain('\\DEvrule');
    expect(main).not.toContain('\\multicolumn');
  });

  it('draws the wider of two borders on a shared edge', async () => {
    const { main } = await convert(
      table(
        [1440, 1440],
        [
          [
            ['A.', { borders: { right: RED } }],
            ['B.', { borders: { left: BLUE } }],
          ],
        ],
      ),
    );
    expect(main).toContain('!{\\DEvrule{2bp}{0000FF}}');
    expect(main).not.toContain('{FF0000}');
  });

  it("draws the earlier cell's border on a tie, and resolves a horizontal edge the same way", async () => {
    const SAME_BLUE = { ...BLUE, width: 20 };
    const { main } = await convert(
      table(
        [1440],
        [[['Above.', { borders: { bottom: RED } }]], [['Below.', { borders: { top: SAME_BLUE } }]]],
      ),
    );
    expect(count(main, '\\DEcline{1-1}{1bp}{FF0000}')).toBe(1);
    expect(main).not.toContain('0000FF');
  });

  it('writes a double border as two lines with a gap, and a double vertical edge as two rules', async () => {
    const DOUBLE = { style: 'double', width: 8, color: '#00AA00' };
    const { main } = await convert(table([1440], [[['Twice.', { borders: ALL(DOUBLE) }]]]));
    const rule = '\\DEcline{1-1}{0.4bp}{00AA00}';
    expect(count(main, rule)).toBe(4);
    expect(count(main, '\\DEclinegap{0.4bp}')).toBe(2);
    expect(main).toContain(
      '!{\\DEvrule{0.4bp}{00AA00}\\hskip\\doublerulesep\\DEvrule{0.4bp}{00AA00}}',
    );
  });

  it('draws the cell borders of a header row again in the repeated head', async () => {
    const { main } = await convert(
      table([1440], [[['Head.', { borders: { top: RED } }]], [['Body.', {}]]], { headerRows: 1 }),
    );
    expect(count(main, '\\DEcline{1-1}{1bp}{FF0000}')).toBe(2);
    const head = main.indexOf('\\endfirsthead');
    expect(main.indexOf('\\DEcline{1-1}{1bp}{FF0000}', head)).toBeGreaterThan(head);
  });

  it('draws cell borders in a boxed table too', async () => {
    const PS_TWO = { type: 'page_setup', attrs: { id: 'ps2', columns: 2 } };
    const b = await run(
      doc(
        [
          { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'ps2' } },
          table([1440], [[['Boxed.', { borders: ALL(RED) }]]]),
        ],
        {
          pageSetups: [{ type: 'page_setup', attrs: { id: 'ps1' } }, PS_TWO],
        },
      ),
      { classFiles: { 'docedit.cls': CLASS, 'docedit.lua': LUA } },
    );
    const main = b.files['main.tex']!;
    expect(main).toContain('\\DEboxtbl{');
    expect(count(main, '\\DEcline{1-1}{1bp}{FF0000}')).toBe(2);
    expect(main).toContain('!{\\DEvrule{1bp}{FF0000}}');
  });
});

describe('EXP-038 criterion 4: the other table properties in the converter output', () => {
  it('writes vAlign as a mark at the end of the cell, align as the table position and cell margins as padding', async () => {
    const { main } = await convert(
      table(
        [1440, 1440, 1440],
        [
          [
            ['Mid.', { vAlign: 'center' }],
            ['Low.', { vAlign: 'bottom', margins: { top: 100, bottom: 60 } }],
            ['Top.', {}],
          ],
        ],
        {
          align: 'center',
        },
      ),
    );
    // Every cell is a `p` column; a centred cell ends with \DEva{1} and a bottom-aligned one with
    // \DEva{2}, after its bottom padding (the class moves the cell when the page is shipped out).
    expect(main).not.toMatch(/\{[mb]\{[\d.]+bp\}/);
    expect([...main.matchAll(/\\DEva\{(\d)\}%/g)].map((m) => m[1])).toEqual(['1', '2']);
    expect(main).toMatch(/\\DEcellpad\{3bp\}%\n\\DEva\{2\}%/);
    expect(main).toMatch(/\\DEtbl\{\d+\}\{0\}\{1\}/);
    expect(main).toContain('\\DEcellpad{5bp}%');
    expect(main).toContain('\\DEcellpad{3bp}%');
  });

  it('shades the header rows from the table style, and warns that banded rows are not shaded', async () => {
    const style = {
      type: 'style_def',
      attrs: {
        id: 'Banded',
        kind: 'table',
        name: 'Banded',
        headerRowShading: { fill: '#DDEEFF' },
        bandedRows: true,
      },
    };
    const { main, codes: c } = await convert(
      table([1440], [[['Head.', {}]], [['Body.', {}]]], { style: 'Banded', headerRows: 1 }),
      {
        styles: [style],
      },
    );
    expect(main).toContain('\\rowcolor[HTML]{DDEEFF}');
    // banded rows have no colour in 03 §4.3 (ADR 0143, question 19)
    expect(c).toContain('banded_rows');
  });
});

describe('EXP-041 criterion 3: the borders of a spanned cell cover the span once', () => {
  it('draws the top and bottom of a column span as one rule over its columns, and its sides at its edges only', async () => {
    const { main } = await convert(
      table(
        [1440, 1440, 1440],
        [
          [
            ['Wide.', { colspan: 2, borders: ALL(RED) }],
            ['End.', {}],
          ],
        ],
      ),
    );
    expect(count(main, '\\DEcline{1-2}{1bp}{FF0000}')).toBe(2);
    expect(main).not.toContain('\\DEcline{1-1}');
    expect(main).not.toContain('\\DEcline{2-2}');
    const open = linesOf(main).find((l) => l.includes('\\DEcolspan{2}{'));
    expect(open).toBeDefined();
    expect(count(open!, '\\DEvrule')).toBe(2);
  });

  it('draws the sides of a row span in every row it covers, its top above the first row and its bottom under the last', async () => {
    const { main } = await convert(
      table(
        [1440, 1440],
        [
          [
            ['Tall.', { rowspan: 2, borders: ALL(RED) }],
            ['A.', {}],
          ],
          [['B.', {}]],
          [
            ['C.', {}],
            ['D.', {}],
          ],
        ],
      ),
    );
    const lines = linesOf(main);
    // The left and right rules of the span: on the span's own cell and on the position it covers.
    const sides = lines.filter(
      (l) =>
        l.startsWith('\\multicolumn{1}{!{\\DEvrule{1bp}{FF0000}}p{') &&
        l.endsWith('}!{\\DEvrule{1bp}{FF0000}}}{%'),
    );
    expect(sides).toHaveLength(2);
    // One rule above the span and one under its last row, both over the first column; none between
    // the two rows it spans.
    expect(count(main, '\\DEcline{1-1}{1bp}{FF0000}')).toBe(2);
    const rows = main.split('\\\\\n');
    expect(rows[0]).toContain('\\DEcline{1-1}{1bp}{FF0000}');
    expect(rows[1]).not.toContain('\\DEcline');
    expect(rows[2]).toContain('\\DEcline{1-1}{1bp}{FF0000}');
  });
});
