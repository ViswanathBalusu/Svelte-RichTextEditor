/**
 * Tables (Node.js only): EXP-038 criteria 1 and 2 (longtable with colortbl in the body flow, widths
 * from `grid`, also for width type `auto`), EXP-040 criteria 1 to 3 (a boxed tabular in a
 * multi-column section, reported as unable to span pages, with paragraphs, figures and equations in
 * its cells). Nothing here compiles: the tests read main.tex and map.json of the converter's bundle.
 * EXP-041 is covered in `tables.spans.test.ts` and `tables.rowspan.overflow.test.ts`, not here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { blockLines, codes, doc, nid, para, run, type J } from '../test/docs.ts';
import { preflight } from './preflight.ts';

const PNG_SHA = 'c'.repeat(64);
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const ASSETS = {
  pic1: { sha256: PNG_SHA, mediaType: 'image/png', status: 'ready' as const, bytes: PNG_BYTES },
};

/** Default left cell margin of the converter, in twips (`tables.ts`). */
const MARGIN_LR = 108;

/** The width in bp that the converter writes for a column of `twips` in `grid`. */
const widthBp = (twips: number): number => (twips - 2 * MARGIN_LR) / 20;

/** A table with one row per entry of `rows`, each row a list of cell contents. */
function table(grid: number[], rows: J[][], attrs: J = {}, id = nid('t')): J {
  return {
    type: 'table',
    attrs: { id, grid, ...attrs },
    content: rows.map((cells) => ({
      type: 'table_row',
      attrs: { id: nid('r') },
      content: cells.map((content) => ({ type: 'table_cell', attrs: { id: nid('c') }, content })),
    })),
  };
}

const oneCell = (grid: number[], attrs: J = {}, id?: string): J =>
  table(grid, [grid.map(() => [para('Cell.')])], attrs, id);

const PS_TWO_COLUMNS = { type: 'page_setup', attrs: { id: 'ps2', columns: 2 } };
const TWO_COLUMN_BREAK = { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'ps2' } };
const TWO_COLUMNS = { pageSetups: [{ type: 'page_setup', attrs: { id: 'ps1' } }, PS_TWO_COLUMNS] };

/** The 1-based line numbers of main.tex that hold a marker. */
function markerLines(main: string, marker: string): number[] {
  const out: number[] = [];
  main.split('\n').forEach((l, i) => {
    if (l.includes(marker)) out.push(i + 1);
  });
  return out;
}

describe('EXP-038 tables in the body flow (criteria 1 and 2)', () => {
  it('writes a single-column table with longtable, and the class loads colortbl for its cell colours', async () => {
    const real = readFileSync(
      fileURLToPath(new URL('../class/docedit.cls', import.meta.url)),
      'utf8',
    );
    expect(real).toMatch(/\\RequirePackage\{colortbl\}/);
    const shaded = oneCell([2880, 2880], { style: null }, nid('t'));
    const cell = (shaded.content as J[])[0]!.content as J[];
    (cell[0]!.attrs as J)['shading'] = { fill: '#ff0000' };
    const b = await run(doc([shaded]), {
      classFiles: { 'docedit.cls': real, 'docedit.lua': '-- lua\n' },
    });
    const main = b.files['main.tex']!;
    expect(main).toContain('\\begin{longtable}{');
    expect(main).toContain('\\DEtbl{');
    expect(main).not.toContain('\\DEboxtbl');
    expect(main).toMatch(/\\cellcolor\[HTML\]\{FF0000\}/);
    expect(codes(b)).not.toContain('table_cannot_span_pages');
  });

  it('takes the column widths from grid: each p column is the grid width less the cell margins', async () => {
    const b = await run(doc([oneCell([4000, 2000])]));
    const spec = b.files['main.tex']!.match(/\\begin\{longtable\}\{([^}]*\}[^}]*)\}/);
    expect(spec).not.toBeNull();
    expect(b.files['main.tex']).toContain(`p{${widthBp(4000)}bp}`);
    expect(b.files['main.tex']).toContain(`p{${widthBp(2000)}bp}`);
  });

  it('keeps the widths of a table of width type auto: they still come from the stored grid', async () => {
    const auto = await run(doc([oneCell([3000, 5000], { width: { type: 'auto' } })]));
    const fixed = await run(doc([oneCell([3000, 5000], { width: { type: 'pct', value: 5000 } })]));
    for (const w of [3000, 5000]) expect(auto.files['main.tex']).toContain(`p{${widthBp(w)}bp}`);
    const widths = (s: string): string[] => [...s.matchAll(/p\{([\d.]+)bp\}/g)].map((m) => m[1]!);
    expect(widths(auto.files['main.tex']!)).toEqual(widths(fixed.files['main.tex']!));
  });

  it('gives each column the width of its grid entry (property over random grids)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 300, max: 9000 }), { minLength: 1, maxLength: 5 }),
        async (grid) => {
          const b = await run(doc([oneCell(grid)]));
          const cols = [
            ...b.files['main.tex']!.matchAll(
              /\\begin\{longtable\}\{[^}]*?((?:\|?p\{[\d.]+bp\}\|?)+)\}/g,
            ),
          ];
          expect(cols).toHaveLength(1);
          const got = [...cols[0]![1]!.matchAll(/p\{([\d.]+)bp\}/g)].map((m) => Number(m[1]));
          expect(got).toHaveLength(grid.length);
          got.forEach((w, i) => expect(Math.abs(w - widthBp(grid[i]!))).toBeLessThanOrEqual(0.05));
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('EXP-040 tables in multi-column sections (criteria 1 and 2)', () => {
  it('writes a boxed tabular, not a longtable, for a table in a two-column section, and keeps the single-column one', async () => {
    const single = oneCell([2880], {}, nid('t'));
    const boxed = oneCell([2880], {}, nid('t'));
    const b = await run(doc([single, TWO_COLUMN_BREAK, boxed], TWO_COLUMNS));
    const main = b.files['main.tex']!;
    expect(main.split('\\begin{longtable}')).toHaveLength(2);
    expect(markerLines(main, '\\DEboxtbl{')).toHaveLength(1);
    expect(markerLines(main, '\\DEboxtblend')).toHaveLength(1);
    expect(markerLines(main, '\\DEtbl{')).toHaveLength(1);
  });

  it('reports a boxed table that cannot span pages, with its block, and the preflight reports it before export', async () => {
    const tid = nid('t');
    const rows = Array.from({ length: 60 }, () => [
      [para('A row of a table that is taller than the column.')],
    ]);
    const tall = table([2880], rows, {}, tid);
    const env = doc([TWO_COLUMN_BREAK, tall], TWO_COLUMNS);
    const b = await run(env);
    const found = b.diagnostics.filter((d) => d.code === 'table_cannot_span_pages');
    expect(found.map((d) => d.blockId)).toEqual([tid]);
    expect(found[0]!.severity).toBe('warning');
    expect(
      preflight(env)
        .filter((w) => w.code === 'table_cannot_span_pages')
        .map((w) => w.blockId),
    ).toEqual([tid]);
  });

  it('writes paragraphs, a figure and an equation of a boxed table cell inside the table', async () => {
    const tid = nid('t');
    const pid = nid('p');
    const fid = nid('f');
    const eid = nid('e');
    const cellContent: J[] = [
      para('Cell text.', { id: pid }),
      {
        type: 'figure',
        attrs: { id: fid, asset: 'pic1', width: 1440, height: 1440, alt: 'A picture' },
      },
      { type: 'equation_block', attrs: { id: eid, latex: 'x^2' } },
    ];
    const env = doc([TWO_COLUMN_BREAK, table([4320], [[cellContent]], {}, tid)], TWO_COLUMNS);
    const b = await run(env, { assets: ASSETS });
    const main = b.files['main.tex']!.split('\n');
    const start = markerLines(b.files['main.tex']!, '\\DEboxtbl{')[0]!;
    const end = markerLines(b.files['main.tex']!, '\\DEboxtblend')[0]!;
    expect(start).toBeLessThan(end);
    for (const id of [pid, fid, eid]) {
      expect(b.map.blocks).toContain(id);
      const n = b.map.blocks.indexOf(id);
      const ranges = b.map.lines.filter((r) => r.block === n);
      expect(ranges.length).toBeGreaterThan(0);
      for (const r of ranges) {
        expect(r.from).toBeGreaterThan(start);
        expect(r.to).toBeLessThan(end);
      }
    }
    expect(blockLines(b, pid).join('\n')).toContain('Cell text.');
    expect(main.slice(start - 1, end).some((l) => l.includes('\\DEfig'))).toBe(true);
    expect(
      main.slice(start - 1, end).some((l) => l.includes('\\DEeq') || l.includes('\\DEplaceholder')),
    ).toBe(true);
  });
});
