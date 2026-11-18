/**
 * EXP-041 criterion 3, shading: the shading of a spanned cell covers the whole span once, and the
 * cell's content is drawn over it (Node.js only, local compile).
 *
 * colortbl paints a cell's colour in the cell's own row, and a row span hangs its content from the
 * first row, so colouring the covered rows with `\cellcolor` would hide the content. The converter
 * writes `\DErowfill` next to `\cellcolor`, and `class/docedit.lua` paints the covered rows when the
 * page is shipped out, from the first row's cell box and before the content. The tests render the
 * first page with `pdftoppm` (100 dpi) and take the height of each paragraph from the class's
 * layout report (`main.layout`):
 * - the colour is present at the height of every row the span covers and nowhere below it;
 * - it is one block, from the top of the span to the bottom of its last row;
 * - the span's text, drawn in black, is found inside that block (it is not hidden);
 * - a span in a header row whose covered row is also shaded by the table style keeps the span's
 *   colour in the covered row (the header's `\rowcolor` would paint over the content otherwise).
 *
 * `test/cdm-local-tex.ts` runs `lualatex` on this machine (TeX Live), as the other local compile
 * tests do; the tests skip when it does not start or the local fonts are missing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { compileLocal, convertLocal, lualatexAvailable } from '../test/cdm-local-tex.ts';

const ready = lualatexAvailable();
const DPI = 100;
const INSTANT = '2026-11-06T10:00:00.000Z';

interface Image {
  width: number;
  height: number;
  rgb: Uint8Array;
}

function readPpm(bytes: Uint8Array): Image {
  const fields: string[] = [];
  let i = 0;
  while (fields.length < 4) {
    while (i < bytes.length && /\s/.test(String.fromCharCode(bytes[i]!))) i++;
    let s = '';
    while (i < bytes.length && !/\s/.test(String.fromCharCode(bytes[i]!)))
      s += String.fromCharCode(bytes[i++]!);
    fields.push(s);
  }
  return { width: Number(fields[1]), height: Number(fields[2]), rgb: bytes.subarray(i + 1) };
}

function renderFirstPage(pdf: Uint8Array): Image {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-span-shade-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftoppm', ['-r', String(DPI), '-f', '1', '-l', '1', file, join(dir, 'p')], {
    timeout: 120_000,
  });
  if (r.error || r.status !== 0) throw new Error('pdftoppm is not installed or failed');
  const name = readdirSync(dir).find((n) => n.endsWith('.ppm'))!;
  return readPpm(readFileSync(join(dir, name)));
}

type Match = (r: number, g: number, b: number) => boolean;
const YELLOW: Match = (r, g, b) => r > 220 && g > 220 && b < 90;
const BLACK: Match = (r, g, b) => r < 80 && g < 80 && b < 80;

const px = (img: Image, x: number, y: number): [number, number, number] => {
  const k = (y * img.width + x) * 3;
  return [img.rgb[k]!, img.rgb[k + 1]!, img.rgb[k + 2]!];
};

/** The left edge and the width of the matching pixels of the whole page. */
function extentX(img: Image, match: Match): { x0: number; x1: number } {
  let x0 = img.width;
  let x1 = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (match(...px(img, x, y))) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
      }
  return { x0, x1 };
}

/** The pixel rows in which most of the columns `x0` to `x1` have the colour. */
function rowsWith(img: Image, x0: number, x1: number, match: Match): number[] {
  const out: number[] = [];
  for (let y = 0; y < img.height; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (match(...px(img, x, y))) n++;
    if (n > (x1 - x0) * 0.5) out.push(y);
  }
  return out;
}

function cell(content: J[] | string, attrs: J = {}): J {
  return {
    type: 'table_cell',
    attrs: { id: nid('c'), ...attrs },
    content: typeof content === 'string' ? [para(content)] : content,
  };
}
function row(...cells: J[]): J {
  return { type: 'table_row', attrs: { id: nid('r') }, content: cells };
}

interface Compiled {
  pdf: Uint8Array;
  /** The pixel row (100 dpi) of the paragraph `i`, in the order of the `\DEp` and `\DEcp` macros of main.tex. */
  y: (i: number) => number;
}

async function compile(
  tbl: J,
  name: string,
  parts: Parameters<typeof doc>[1] = {},
): Promise<Compiled> {
  const bundle = await convertLocal(
    doc([para('before'), tbl, para('after')], parts) as never,
    {
      profile: 'preview',
      title: name,
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
    } as never,
  );
  const c = compileLocal(bundle, name);
  if (!c.ok || !c.pdf || c.layout === null)
    throw new Error(`the compile failed:\n${c.log.slice(-1500)}`);
  const ids = [...bundle.files['main.tex']!.matchAll(/\\DEc?p\{(\d+)\}/g)].map((m) => Number(m[1]));
  const report = JSON.parse(c.layout) as { blocks: Record<string, [number, number, number]> };
  const y = (i: number): number => {
    const e = report.blocks[String(ids[i])];
    if (!e) throw new Error(`no block at position ${i}`);
    return Math.round((e[1] / 65781.76 / 72) * DPI);
  };
  return { pdf: c.pdf, y };
}

describe.skipIf(!ready)('EXP-041 criterion 3: the shading of a row span', () => {
  it('colours every row the span covers, once, under its content', async () => {
    const tall = [para('M1'), para('M2'), para('M3')];
    const tbl: J = {
      type: 'table',
      attrs: { id: nid('t'), grid: [2880, 2880] },
      content: [
        row(cell('SPANTEXT', { rowspan: 3, shading: { fill: '#FFFF00' } }), cell('B1')),
        // The middle row is taller, so the covered rows are not the same height.
        row(cell(tall)),
        row(cell('B3')),
        row(cell('A4'), cell('B4')),
      ],
    };
    const c = await compile(tbl, 'span-shade');
    const page = renderFirstPage(c.pdf);
    // Paragraphs in order: before, SPANTEXT, B1, M1, M2, M3, B3, A4, B4, after.
    const [spanText, b1, m1, m3, b3, a4] = [1, 2, 3, 5, 6, 7].map((i) => c.y(i)) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const { x0, x1 } = extentX(page, YELLOW);
    expect(x1 - x0, 'the span is one column wide').toBeGreaterThan(150);
    expect(x1 - x0).toBeLessThan(260);
    const yellow = rowsWith(page, x0 + 1, x0 + 4, YELLOW);
    const top = yellow[0]!;
    const bottom = yellow[yellow.length - 1]!;
    // One block: no gap between its first and its last pixel row.
    expect(bottom - top + 1, JSON.stringify([top, bottom, yellow.length])).toBe(yellow.length);
    // It starts at the span's first row and reaches the heights of every row it covers.
    expect(b1).toBeGreaterThanOrEqual(top);
    // Its first line stands level with the first line of the row's other cell.
    expect(Math.abs(spanText - b1), 'span text against B1').toBeLessThanOrEqual(2);
    expect(spanText).toBeGreaterThanOrEqual(top);
    for (const [name, y] of [
      ['M1', m1],
      ['M3', m3],
      ['B3', b3],
    ] as const) {
      expect(y, name).toBeGreaterThan(top);
      expect(y, name).toBeLessThanOrEqual(bottom);
    }
    // It ends with the last covered row: the next row's text lies just below the block.
    expect(a4).toBeGreaterThan(bottom - 4);
    expect(a4 - bottom).toBeLessThan(24);
    // The block is as tall as the three rows: from the first row's text to the last row's text and
    // more, and taller than three single lines (the middle row holds three).
    expect(bottom - top).toBeGreaterThan(b3 - b1);
    // The text is drawn over the colour: black pixels inside the block, at the span's first line.
    let ink = 0;
    for (let y = spanText - 14; y < spanText + 3; y++)
      for (let x = x0; x <= x1; x++) if (BLACK(...px(page, x, y))) ink++;
    expect(ink, 'the span text is drawn over its colour').toBeGreaterThan(20);
    // Nothing of the colour lies below the block, and outside the span's column.
    expect(rowsWith(page, x1 + 20, x1 + 60, YELLOW)).toHaveLength(0);
    expect(yellow.every((y) => y >= top && y <= bottom)).toBe(true);
  }, 300_000);

  it('keeps the span colour in a covered row that the header style also shades', async () => {
    const tbl: J = {
      type: 'table',
      attrs: { id: nid('t'), grid: [2880, 2880], headerRows: 2, style: 'Grid' },
      content: [
        row(cell('HEADSPAN', { rowspan: 2, shading: { fill: '#FFFF00' } }), cell('H1')),
        row(cell('H2')),
        row(cell('A3'), cell('B3')),
      ],
    };
    const grid: J = {
      type: 'style_def',
      attrs: {
        id: 'Grid',
        kind: 'table',
        name: 'Grid',
        headerRowShading: { fill: '#00C0FF' },
      },
    };
    const c = await compile(tbl, 'span-shade-header', { styles: [grid] });
    const page = renderFirstPage(c.pdf);
    // Paragraphs in order: before, HEADSPAN, H1, H2, A3, B3, after.
    const h2 = c.y(3);
    const { x0, x1 } = extentX(page, YELLOW);
    expect(x1 - x0).toBeGreaterThan(150);
    const yellow = rowsWith(page, x0 + 1, x0 + 4, YELLOW);
    expect(yellow.length).toBeGreaterThan(20);
    const top = yellow[0]!;
    const bottom = yellow[yellow.length - 1]!;
    expect(bottom - top + 1).toBe(yellow.length);
    expect(h2).toBeGreaterThan(top);
    expect(h2).toBeLessThanOrEqual(bottom);
    // The header colour is on the other column of the same rows.
    const BLUE: Match = (r, g, b) => r < 60 && g > 150 && b > 220;
    expect(rowsWith(page, x1 + 20, x1 + 60, BLUE).length).toBeGreaterThan(20);
  }, 300_000);
});
