/**
 * Table shading, cell margins, vertical alignment and table alignment, checked on the compiled PDF
 * (Node.js only, sandbox): EXP-038 criterion 4. Banded rows take one fixed light grey (owner
 * decision 50, 2026-11-15). The header row shading and the banded rows, which a table style sets,
 * have tests of their own in this file.
 *
 * The first page is rendered with `pdftoppm` at 100 dpi and the pixels of each fill colour are read;
 * word positions come from `pdftotext -bbox`.
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

/** The first page of a PDF as an image, by `pdftoppm` (poppler or xpdf). */
function renderFirstPage(pdf: Uint8Array): Image {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-shading-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync(
    'pdftoppm',
    ['-r', String(DPI), '-f', '1', '-l', '1', file, join(dir, 'page')],
    { timeout: 120_000 },
  );
  if (r.error || r.status !== 0) throw new Error('pdftoppm is not installed or failed');
  const name = readdirSync(dir)
    .filter((n) => n.endsWith('.ppm'))
    .sort()[0];
  if (!name) throw new Error('pdftoppm wrote no page');
  return readPpm(readFileSync(join(dir, name)));
}

type Match = (r: number, g: number, b: number) => boolean;
const BLUE: Match = (r, g, b) => b > 180 && r < 90 && g < 90;
const YELLOW: Match = (r, g, b) => r > 180 && g > 180 && b < 90;
const GREEN: Match = (r, g, b) => g > 140 && r < 90 && b < 90;
const RED: Match = (r, g, b) => r > 180 && g < 60 && b < 60;

/** The bounding box and the pixel count of one colour on a page. */
function extent(
  img: Image,
  match: Match,
): { minX: number; maxX: number; minY: number; maxY: number; count: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const k = (y * img.width + x) * 3;
      if (!match(img.rgb[k]!, img.rgb[k + 1]!, img.rgb[k + 2]!)) continue;
      count++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, minY, maxY, count };
}

interface Word {
  text: string;
  xMin: number;
  yMin: number;
}

/** The words of the first page with their top-left corners, in points, from `pdftotext -bbox`. */
function words(pdf: Uint8Array): Word[] {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-shading-bbox-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', ['-f', '1', '-l', '1', '-bbox', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
  const out: Word[] = [];
  const re = /<word xMin="([^"]*)" yMin="([^"]*)" xMax="[^"]*" yMax="[^"]*">([^<]*)<\/word>/g;
  for (const m of r.stdout.matchAll(re))
    out.push({ text: m[3]!, xMin: Number(m[1]), yMin: Number(m[2]) });
  return out;
}

const at = (ws: Word[], text: string): Word => {
  const w = ws.find((x) => x.text === text);
  if (!w) throw new Error(`the word ${text} is not on the first page`);
  return w;
};

function cell(text: string, attrs: J = {}): J {
  return { type: 'table_cell', attrs: { id: nid('c'), ...attrs }, content: [para(text)] };
}
function row(...cells: J[]): J {
  return { type: 'table_row', attrs: { id: nid('r') }, content: cells };
}
function table(attrs: J, rows: J[]): J {
  return { type: 'table', attrs: { id: nid('t'), ...attrs }, content: rows };
}

describe.skipIf(!ready)(
  'EXP-038 criterion 4: shading, cell margins, vertical alignment and table alignment in the PDF',
  () => {
    it('draws the cell shading, the table alignment, the cell margins and the vertical alignment', async () => {
      const twoCells = [2880, 2880];
      const fill = (text: string, colour: string): J => cell(text, { shading: { fill: colour } });
      // Three shaded tables, one per table alignment, each a single row of two shaded cells.
      const left = table({ grid: twoCells }, [
        row(fill('LEFTA', '#0000FF'), fill('LEFTB', '#0000FF')),
      ]);
      const centre = table({ grid: twoCells, align: 'center' }, [
        row(fill('CENTRA', '#FFFF00'), fill('CENTRB', '#FFFF00')),
      ]);
      const end = table({ grid: twoCells, align: 'end' }, [
        row(fill('RIGHTA', '#00C000'), fill('RIGHTB', '#00C000')),
      ]);
      // Cell margins: the same text at the default left margin and at 720 twips.
      const margin = table({ grid: [2880], cellMargins: { left: 720, right: 720 } }, [
        row(cell('MARGINWORD')),
      ]);
      const plainMargin = table({ grid: [2880] }, [row(cell('PLAINWORD'))]);
      // Vertical alignment: a tall cell in the third column sets the row height, the others are top,
      // centre and bottom aligned.
      const tall = Array.from({ length: 4 }, (_, i) => para(`T${i + 1}`));
      const valign = table({ grid: [1440, 1440, 1440, 1440] }, [
        row(
          cell('TOP', { vAlign: 'top' }),
          cell('MID', { vAlign: 'center' }),
          { type: 'table_cell', attrs: { id: nid('c') }, content: tall },
          cell('BOT', { vAlign: 'bottom' }),
        ),
      ]);
      const envelope = doc([
        para('before'),
        left,
        para('between'),
        centre,
        para('between'),
        end,
        para('between'),
        margin,
        para('between'),
        plainMargin,
        para('between'),
        valign,
      ]);
      const c = await convertAndCompile(envelope, {
        profile: 'preview',
        title: 'table-shading',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${firstError(c.compile.log)}`);
      expect(codes(c.bundle)).not.toContain('cell_borders');

      const page = renderFirstPage(c.compile.pdf);
      const blue = extent(page, BLUE);
      const yellow = extent(page, YELLOW);
      const green = extent(page, GREEN);
      // Each table is two cells of 200 px, a row of about one line or more: well over 1500 pixels.
      for (const [name, e] of [
        ['blue', blue],
        ['yellow', yellow],
        ['green', green],
      ] as const)
        expect(e.count, `${name} ${JSON.stringify(e)}`).toBeGreaterThan(1500);
      // Alignment: a left table starts at the text margin, a centred one further in, and an end
      // aligned one is at the right margin (so its right edge is further right than the others').
      expect(yellow.minX - blue.minX, `${JSON.stringify({ blue, yellow })}`).toBeGreaterThan(50);
      expect(green.minX - yellow.minX, `${JSON.stringify({ yellow, green })}`).toBeGreaterThan(50);
      expect(green.maxX).toBeGreaterThan(blue.maxX + 100);

      const ws = words(c.compile.pdf);
      // Cell margins: 720 twips is 36 pt, the default is 108 twips (5.4 pt); the text moves by 30.6 pt.
      const inset = at(ws, 'MARGINWORD').xMin - at(ws, 'PLAINWORD').xMin;
      expect(inset, `inset ${inset}`).toBeGreaterThan(25);
      expect(inset, `inset ${inset}`).toBeLessThan(36);
      // Vertical alignment: the top cell is level with the tall cell's first line, the bottom cell
      // with its last line, and the centred cell half way between the two (the tall cell has four
      // lines of one height, so its middle is the mean of its first and last lines).
      const first = at(ws, 'T1').yMin;
      const last = at(ws, 'T4').yMin;
      expect(last - first, 'the tall cell has four lines').toBeGreaterThan(30);
      const top = at(ws, 'TOP').yMin;
      const mid = at(ws, 'MID').yMin;
      const bot = at(ws, 'BOT').yMin;
      expect(Math.abs(top - first), `top ${top}, first line ${first}`).toBeLessThan(2);
      expect(Math.abs(bot - last), `bottom ${bot}, last line ${last}`).toBeLessThan(2);
      expect(Math.abs(mid - (first + last) / 2), `centre ${mid}`).toBeLessThan(2);
    }, 300_000);

    it('shades the header rows with the header row shading of the table style, and no other row', async () => {
      const style: J = {
        type: 'style_def',
        attrs: {
          id: 'Shaded',
          kind: 'table',
          name: 'Shaded',
          headerRowShading: { fill: '#D00000' },
        },
      };
      const shaded = table({ grid: [1440, 1440], style: 'Shaded', headerRows: 1 }, [
        row(cell('HEADA'), cell('HEADB')),
        row(cell('BODYA'), cell('BODYB')),
      ]);
      const c = await convertAndCompile(doc([para('before'), shaded], { styles: [style] }), {
        profile: 'preview',
        title: 'table-header-shading',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${firstError(c.compile.log)}`);

      const red = extent(renderFirstPage(c.compile.pdf), RED);
      const ws = words(c.compile.pdf);
      const px = (pt: number): number => (pt * DPI) / 72;
      // The fill is as wide as the two columns (2880 twips, 200 px) and one row high.
      expect(red.count, JSON.stringify(red)).toBeGreaterThan(1500);
      expect(red.maxX - red.minX).toBeGreaterThan(190);
      expect(red.maxX - red.minX).toBeLessThan(210);
      // It is behind the header row's words and above the body row's.
      for (const text of ['HEADA', 'HEADB']) {
        const w = at(ws, text);
        expect(px(w.yMin)).toBeGreaterThan(red.minY - 1);
        expect(px(w.yMin)).toBeLessThan(red.maxY);
        expect(px(w.xMin)).toBeGreaterThan(red.minX);
        expect(px(w.xMin)).toBeLessThan(red.maxX);
      }
      expect(px(at(ws, 'BODYA').yMin)).toBeGreaterThan(red.maxY);
    }, 300_000);

    it('shades every other body row with a light grey when the table style sets bandedRows (decision 50)', async () => {
      const style: J = {
        type: 'style_def',
        attrs: { id: 'Banded', kind: 'table', name: 'Banded', bandedRows: true },
      };
      const banded = table({ grid: [1440, 1440], style: 'Banded' }, [
        row(cell('ROWONE'), cell('XONE')),
        row(cell('ROWTWO'), cell('XTWO')),
        row(cell('ROWTHREE'), cell('XTHREE')),
        row(cell('ROWFOUR'), cell('XFOUR')),
      ]);
      const c = await convertAndCompile(doc([para('before'), banded], { styles: [style] }), {
        profile: 'preview',
        title: 'table-banded-rows',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${firstError(c.compile.log)}`);
      const img = renderFirstPage(c.compile.pdf);
      const ws = words(c.compile.pdf);
      const px = (pt: number): number => Math.round((pt * DPI) / 72);
      // The pixel just left of a word, inside its cell margin, on the middle of its line.
      const backdrop = (text: string): [number, number, number] => {
        const w = at(ws, text);
        const x = px(w.xMin) - 3;
        const y = px(w.yMin + 4);
        const k = (y * img.width + x) * 3;
        return [img.rgb[k]!, img.rgb[k + 1]!, img.rgb[k + 2]!];
      };
      const grey = (p: [number, number, number]): boolean => p.every((v) => v >= 238 && v <= 246);
      const white = (p: [number, number, number]): boolean => p.every((v) => v >= 253);
      expect(grey(backdrop('ROWONE')), JSON.stringify(backdrop('ROWONE'))).toBe(true);
      expect(white(backdrop('ROWTWO')), JSON.stringify(backdrop('ROWTWO'))).toBe(true);
      expect(grey(backdrop('ROWTHREE')), JSON.stringify(backdrop('ROWTHREE'))).toBe(true);
      expect(white(backdrop('ROWFOUR')), JSON.stringify(backdrop('ROWFOUR'))).toBe(true);
    }, 300_000);
  },
);
