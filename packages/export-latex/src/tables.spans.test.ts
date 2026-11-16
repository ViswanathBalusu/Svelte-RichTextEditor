/**
 * Row and column spans (Node.js only): EXP-041 criterion 1. A spanned cell is written with the
 * class's own cell macros (`\DEcolspan` around `\multicolumn`, `\DErowspan`), and `multirow` is
 * not used. The tests read the converter's main.tex and the class file; nothing is compiled, so the
 * printed spans are not inspected. EXP-041 criterion 3 is checked on the converter output for the
 * shading of a span and the table's own borders (the cell's own `borders` are in
 * `tables.borders.test.ts`); criterion 4
 * (tagging) stays open.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, run, type J } from '../test/docs.ts';

const CLASS = readFileSync(fileURLToPath(new URL('../class/docedit.cls', import.meta.url)), 'utf8');
const LUA = '-- lua\n';

/** A table whose rows are lists of cells; each cell is `[content, attrs]`. */
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

async function main(t: J): Promise<string> {
  const b = await run(doc([t]), { classFiles: { 'docedit.cls': CLASS, 'docedit.lua': LUA } });
  return b.files['main.tex']!;
}

const count = (s: string, needle: string): number => s.split(needle).length - 1;

describe('EXP-041 criterion 1: spans use the class cell macros, not multirow', () => {
  it('defines \\DEcolspan in the class, as the class cell macro around \\multicolumn', () => {
    expect(CLASS).toMatch(/\\newcommand\\DEcolspan\[3\]\{\\multicolumn\{#1\}\{#2\}\{#3\}\}/);
    expect(CLASS).not.toMatch(/\\(?:RequirePackage|usepackage)\{multirow\}/);
  });

  it('writes a column span with \\DEcolspan and no \\multicolumn for the span', async () => {
    const main_ = await main(
      table(
        [1440, 1440, 1440],
        [
          [
            ['Wide.', { colspan: 2 }],
            ['End.', {}],
          ],
        ],
      ),
    );
    expect(count(main_, '\\DEcolspan{2}{')).toBe(1);
    expect(main_).not.toContain('\\multicolumn{2}');
    expect(main_).not.toContain('\\multicolumn{3}');
  });

  it('writes a row span with \\DErowspan and never multirow', async () => {
    const main_ = await main(
      table(
        [1440, 1440],
        [
          [
            ['Tall.', { rowspan: 2 }],
            ['A.', {}],
          ],
          [['B.', {}]],
        ],
      ),
    );
    expect(main_).toContain('\\DErowspan{2}{%');
    expect(main_).not.toMatch(/multirow/);
  });

  it('writes the covered positions of a row and column span with \\DEcolspan too (no multicolumn for a span)', async () => {
    // Row 0: a 2 by 2 cell and one cell; row 1: one cell under the one of row 0, covered by the span.
    const main_ = await main(
      table(
        [1440, 1440, 1440],
        [
          [
            ['Block.', { colspan: 2, rowspan: 2 }],
            ['Right top.', {}],
          ],
          [['Right bottom.', {}]],
        ],
      ),
    );
    expect(count(main_, '\\DEcolspan{2}{')).toBe(2);
    expect(main_).not.toContain('\\multicolumn{2}');
    expect(main_).not.toMatch(/multirow/);
  });

  it('keeps \\multicolumn for a single column whose own border needs it (not a span)', async () => {
    const main_ = await main(
      table(
        [1440, 1440],
        [
          [
            ['One.', { borders: { left: { style: 'single', width: 16, color: 'FF0000' } } }],
            ['Two.', {}],
          ],
        ],
      ),
    );
    expect(main_).not.toContain('\\DEcolspan');
    expect(main_).toContain('\\multicolumn{1}{');
  });
});

// EXP-041 criterion 3: the border and the shading of a spanned cell cover its span once.
const RULE = { style: 'single', width: 8, color: '000000' };

describe('EXP-041 criterion 3: borders and shading of a spanned cell cover its span once', () => {
  it('writes the shading of a column span once, on the line that opens the span', async () => {
    const main_ = await main(
      table(
        [1440, 1440, 1440],
        [
          [
            ['Wide.', { colspan: 2, shading: { fill: '#AABBCC' } }],
            ['End.', {}],
          ],
        ],
      ),
    );
    const lines = main_.split('\n');
    expect(count(main_, '\\cellcolor[HTML]{AABBCC}')).toBe(1);
    const open = lines.findIndex((l) => l.includes('\\DEcolspan{2}{'));
    expect(open).toBeGreaterThanOrEqual(0);
    expect(lines[open + 1]).toBe('\\cellcolor[HTML]{AABBCC}%');
  });

  it('writes the shading of a row span once, and none for the positions the span covers', async () => {
    const main_ = await main(
      table(
        [1440, 1440],
        [
          [
            ['Tall.', { rowspan: 2, shading: { fill: '#112233' } }],
            ['A.', {}],
          ],
          [['B.', {}]],
        ],
      ),
    );
    expect(count(main_, '\\cellcolor[HTML]{112233}')).toBe(1);
  });

  it('draws the vertical borders of a column span at its two edges only, not between the columns it covers', async () => {
    const main_ = await main(
      table(
        [1440, 1440, 1440],
        [
          [
            ['Wide.', { colspan: 2 }],
            ['End.', {}],
          ],
        ],
        {
          borders: { left: RULE, insideV: RULE, right: RULE },
        },
      ),
    );
    const open = main_.split('\n').find((l) => l.includes('\\DEcolspan{2}{'));
    expect(open).toBeDefined();
    // The span's column specification: left edge, one p column, right edge; no rule inside the span.
    expect(open!.startsWith('\\DEcolspan{2}{|p{')).toBe(true);
    expect(open!.endsWith('}|}{%')).toBe(true);
    expect(count(open!, '|')).toBe(2);
  });

  it('draws the horizontal rule under a row span only in the columns the span does not cover', async () => {
    const main_ = await main(
      table(
        [1440, 1440],
        [
          [
            ['Tall.', { rowspan: 2 }],
            ['A.', {}],
          ],
          [['B.', {}]],
        ],
        { borders: { insideH: RULE } },
      ),
    );
    expect(count(main_, '\\cline{2-2}')).toBe(1);
    expect(main_).not.toContain('\\hline');
  });
});
