/**
 * Cell borders, checked on the compiled PDF (Node.js only, sandbox): EXP-038 criterion 4 (cell
 * borders are drawn) and EXP-041 criterion 3 (the borders of a spanned cell cover the span once).
 *
 * The table has no table borders, so every rule on the page is a cell border, and each bordered
 * cell has its own colour. The first page is rendered with `pdftoppm` at 100 dpi and the pixels of
 * each colour are read:
 * - a horizontal rule is a pixel row with a long run of the colour, a vertical rule a pixel column;
 *   rules next to each other (a few pixels, one rule) count once;
 * - a cell bordered all round has two horizontal and two vertical rules; a double border has four
 *   of each;
 * - a column span's top rule is about two columns long, and it has no rule between its columns;
 * - a row span has no rule between the rows it spans, and its side rules run from its top rule to
 *   its bottom rule.
 * A second compile check is that a boxed table (two-column section) and a repeated head with cell
 * borders typeset without error and print their colour.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codes, doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, firstError, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const DPI = 100;
/** One column of the grid: 2880 twips, 144 pt, 200 px at 100 dpi. */
const COLUMN_PX = (2880 / 1440) * DPI;

const border = (color: string, style = 'single', width = 20): J => ({ style, width, color });
const all = (b: J): J => ({ top: b, bottom: b, left: b, right: b });

function cell(text: string, attrs: J = {}): J {
  return { type: 'table_cell', attrs: { id: nid('c'), ...attrs }, content: [para(text)] };
}
function row(...cells: J[]): J {
  return { type: 'table_row', attrs: { id: nid('r') }, content: cells };
}

interface Image {
  width: number;
  height: number;
  rgb: Uint8Array;
}

/** A binary PPM (P6) file. */
function readPpm(bytes: Uint8Array): Image {
  const fields: string[] = [];
  let i = 0;
  while (fields.length < 4) {
    while (i < bytes.length && /\s/.test(String.fromCharCode(bytes[i]!))) i++;
    if (bytes[i] === 0x23) {
      while (i < bytes.length && bytes[i] !== 0x0a) i++;
      continue;
    }
    let s = '';
    while (i < bytes.length && !/\s/.test(String.fromCharCode(bytes[i]!)))
      s += String.fromCharCode(bytes[i++]!);
    fields.push(s);
  }
  if (fields[0] !== 'P6') throw new Error(`not a binary PPM: ${fields[0]}`);
  return { width: Number(fields[1]), height: Number(fields[2]), rgb: bytes.subarray(i + 1) };
}

/** Every page of a PDF as images, by `pdftoppm` (poppler or xpdf). */
function render(pdf: Uint8Array): Image[] {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-borders-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftoppm', ['-r', String(DPI), file, join(dir, 'page')], {
    timeout: 120_000,
  });
  if (r.error || r.status !== 0) throw new Error('pdftoppm is not installed or failed');
  return readdirSync(dir)
    .filter((n) => n.endsWith('.ppm'))
    .sort()
    .map((n) => readPpm(readFileSync(join(dir, n))));
}

type Match = (r: number, g: number, b: number) => boolean;
const RED: Match = (r, g, b) => r > 180 && g < 90 && b < 90;
const BLUE: Match = (r, g, b) => b > 180 && r < 90 && g < 90;
const GREEN: Match = (r, g, b) => g > 140 && r < 90 && b < 90;
const PURPLE: Match = (r, g, b) => r > 120 && b > 120 && g < 70;

/** The longest run of matching pixels in each pixel row (`horizontal`) or column. */
function runs(img: Image, match: Match, horizontal: boolean): number[] {
  const outer = horizontal ? img.height : img.width;
  const inner = horizontal ? img.width : img.height;
  const out: number[] = [];
  for (let a = 0; a < outer; a++) {
    let best = 0;
    let cur = 0;
    for (let b = 0; b < inner; b++) {
      const [x, y] = horizontal ? [b, a] : [a, b];
      const k = (y * img.width + x) * 3;
      if (match(img.rgb[k]!, img.rgb[k + 1]!, img.rgb[k + 2]!)) best = Math.max(best, ++cur);
      else cur = 0;
    }
    out.push(best);
  }
  return out;
}

/** Rules: groups of adjacent pixel rows (or columns) whose run is at least `min` long. */
function rules(
  img: Image,
  match: Match,
  horizontal: boolean,
  min: number,
): { at: number; length: number }[] {
  const r = runs(img, match, horizontal);
  const out: { at: number; length: number }[] = [];
  let start = -1;
  for (let i = 0; i <= r.length; i++) {
    const hit = i < r.length && r[i]! >= min;
    if (hit && start < 0) start = i;
    if (!hit && start >= 0) {
      out.push({ at: start, length: Math.max(...r.slice(start, i)) });
      start = -1;
    }
  }
  return out;
}

const pixels = (img: Image, match: Match): number => {
  let n = 0;
  for (let k = 0; k < img.rgb.length; k += 3)
    if (match(img.rgb[k]!, img.rgb[k + 1]!, img.rgb[k + 2]!)) n++;
  return n;
};

describe.skipIf(!ready)(
  'EXP-038 criterion 4 and EXP-041 criterion 3: cell borders in the PDF',
  () => {
    it('prints the borders of plain, double, column-spanned and row-spanned cells', async () => {
      const tbl: J = {
        type: 'table',
        attrs: { id: nid('t'), grid: [2880, 2880, 2880] },
        content: [
          // Plain rows sit between the bordered rows, so that no two bordered cells share an edge
          // (on a shared edge of equal width the earlier cell's border is drawn).
          row(cell('Red', { borders: all(border('#FF0000')) }), cell('B1'), cell('C1')),
          row(cell('A2'), cell('B2'), cell('C2')),
          row(cell('Blue span', { colspan: 2, borders: all(border('#0000FF')) }), cell('C3')),
          row(cell('A4'), cell('B4'), cell('C4')),
          row(
            cell('Green span', { rowspan: 2, borders: all(border('#00C000')) }),
            cell('B5'),
            cell('C5'),
          ),
          row(cell('B6'), cell('C6')),
          row(cell('A7'), cell('B7'), cell('C7')),
          row(
            cell('A8'),
            cell('B8'),
            cell('Twice', { borders: all(border('#C000C0', 'double', 20)) }),
          ),
          row(cell('A9'), cell('B9'), cell('C9')),
        ],
      };
      const c = await convertAndCompile(doc([tbl]), {
        profile: 'preview',
        title: 'cell-borders',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${firstError(c.compile.log)}`);
      expect(codes(c.bundle)).not.toContain('cell_borders');
      const page = render(c.compile.pdf)[0]!;
      const long = COLUMN_PX * 0.8;
      const tall = 8;

      const red = { h: rules(page, RED, true, long), v: rules(page, RED, false, tall) };
      expect(red.h, JSON.stringify(red)).toHaveLength(2);
      expect(red.v, JSON.stringify(red)).toHaveLength(2);
      expect(red.h[0]!.length).toBeLessThan(COLUMN_PX * 1.2);

      // The column span: one rule over two columns at the top and the bottom, sides at its edges only.
      const blue = { h: rules(page, BLUE, true, long), v: rules(page, BLUE, false, tall) };
      expect(blue.h, JSON.stringify(blue)).toHaveLength(2);
      for (const h of blue.h) expect(h.length).toBeGreaterThan(COLUMN_PX * 1.8);
      expect(blue.v, JSON.stringify(blue)).toHaveLength(2);
      expect(blue.v[1]!.at - blue.v[0]!.at).toBeGreaterThan(COLUMN_PX * 1.8);

      // The row span: a top and a bottom rule only, and sides that run from one to the other.
      const green = { h: rules(page, GREEN, true, long), v: rules(page, GREEN, false, tall) };
      expect(green.h, JSON.stringify(green)).toHaveLength(2);
      expect(green.v, JSON.stringify(green)).toHaveLength(2);
      const spanHeight = green.h[1]!.at - green.h[0]!.at;
      const redHeight = red.h[1]!.at - red.h[0]!.at;
      expect(spanHeight, JSON.stringify(green)).toBeGreaterThan(redHeight * 1.5);
      for (const v of green.v)
        expect(v.length, JSON.stringify(green)).toBeGreaterThanOrEqual(spanHeight - 3);

      // The double border: two lines on each side.
      const purple = { h: rules(page, PURPLE, true, long), v: rules(page, PURPLE, false, tall) };
      expect(purple.h, JSON.stringify(purple)).toHaveLength(4);
      expect(purple.v, JSON.stringify(purple)).toHaveLength(4);
    }, 300_000);

    it('typesets cell borders in a repeated head and in a boxed table', async () => {
      const head: J = {
        type: 'table',
        attrs: { id: nid('t'), grid: [4320], headerRows: 1 },
        content: [
          row(cell('HEAD', { borders: all(border('#FF0000')) })),
          ...Array.from({ length: 70 }, (_, i) => row(cell(`ROW${i}`))),
        ],
      };
      const boxed: J = {
        type: 'table',
        attrs: { id: nid('t'), grid: [2880] },
        content: [row(cell('BOXED', { borders: all(border('#0000FF', 'double', 20)) }))],
      };
      const c = await convertAndCompile(
        doc([head, { type: 'section_break', attrs: { id: nid('s'), pageSetup: 'ps2' } }, boxed], {
          pageSetups: [
            { type: 'page_setup', attrs: { id: 'ps1' } },
            { type: 'page_setup', attrs: { id: 'ps2', columns: 2 } },
          ],
        }),
        {
          profile: 'preview',
          title: 'cell-borders-head',
          instant: INSTANT,
          timeZone: 'Europe/London',
          suggestions: 'accept',
        } as never,
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${firstError(c.compile.log)}`);
      expect(c.bundle.files['main.tex']).toContain('\\DEboxtbl{');
      const pages = render(c.compile.pdf);
      expect(pages.length).toBeGreaterThan(1);
      // The head's red rules print on every page the table reaches (first page and the next one).
      expect(pixels(pages[0]!, RED)).toBeGreaterThan(0);
      expect(pixels(pages[1]!, RED)).toBeGreaterThan(0);
      expect(pages.reduce((n, p) => n + pixels(p, BLUE), 0)).toBeGreaterThan(0);
    }, 300_000);
  },
);
