/**
 * Paragraph borders and shading on the compiled PDF (Node.js only, sandbox): EXP-020 criterion 2.
 *
 * The first page is rendered with `pdftoppm` at 100 dpi and the pixels of each colour are read;
 * word positions come from `pdftotext -bbox`. A second test compiles a shaded, bordered paragraph
 * as a tagged PDF and runs veraPDF on it (PDF/UA-2): the drawing is an artifact.
 *
 * The tests skip when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codes, doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, firstError, sandboxReady, validatePdf } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const DPI = 100;
const px = (pt: number): number => (pt * DPI) / 72;

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

/** The first page of a PDF as an image, by `pdftoppm` (poppler or xpdf), without anti-aliasing. */
function renderFirstPage(pdf: Uint8Array): Image {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-parshade-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync(
    'pdftoppm',
    [
      '-r',
      String(DPI),
      '-f',
      '1',
      '-l',
      '1',
      '-aa',
      'no',
      '-aaVector',
      'no',
      file,
      join(dir, 'page'),
    ],
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
const YELLOW: Match = (r, g, b) => r > 180 && g > 180 && b < 90;
const RED: Match = (r, g, b) => r > 180 && g < 60 && b < 60;
const BLUE: Match = (r, g, b) => b > 180 && r < 90 && g < 90;
const GREEN: Match = (r, g, b) => g > 140 && r < 90 && b < 90;

interface Extent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  count: number;
}

/** The bounding box and the pixel count of one colour on a page. */
function extent(img: Image, match: Match): Extent {
  const e: Extent = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, count: 0 };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const k = (y * img.width + x) * 3;
      if (!match(img.rgb[k]!, img.rgb[k + 1]!, img.rgb[k + 2]!)) continue;
      e.count++;
      e.minX = Math.min(e.minX, x);
      e.maxX = Math.max(e.maxX, x);
      e.minY = Math.min(e.minY, y);
      e.maxY = Math.max(e.maxY, y);
    }
  }
  return e;
}

/** How many pixels of a colour are in one row, and in one column. */
const inRow = (img: Image, match: Match, y: number): number => {
  let n = 0;
  for (let x = 0; x < img.width; x++) {
    const k = (y * img.width + x) * 3;
    if (match(img.rgb[k]!, img.rgb[k + 1]!, img.rgb[k + 2]!)) n++;
  }
  return n;
};
const inColumn = (img: Image, match: Match, x: number): number => {
  let n = 0;
  for (let y = 0; y < img.height; y++) {
    const k = (y * img.width + x) * 3;
    if (match(img.rgb[k]!, img.rgb[k + 1]!, img.rgb[k + 2]!)) n++;
  }
  return n;
};

interface Word {
  text: string;
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

/** The words of the first page with their boxes, in points, from `pdftotext -bbox`. */
function words(pdf: Uint8Array): Word[] {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-parshade-bbox-'));
  const file = join(dir, 'main.pdf');
  writeFileSync(file, pdf);
  const r = spawnSync('pdftotext', ['-f', '1', '-l', '1', '-bbox', file, '-'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
  const out: Word[] = [];
  const re = /<word xMin="([^"]*)" yMin="([^"]*)" xMax="([^"]*)" yMax="([^"]*)">([^<]*)<\/word>/g;
  for (const m of r.stdout.matchAll(re))
    out.push({
      text: m[5]!,
      xMin: Number(m[1]),
      yMin: Number(m[2]),
      xMax: Number(m[3]),
      yMax: Number(m[4]),
    });
  return out;
}

const at = (ws: Word[], text: string): Word => {
  const w = ws.find((x) => x.text === text);
  if (!w) throw new Error(`the word ${text} is not on the first page`);
  return w;
};

const style = (id: string, attrs: J): J => ({
  type: 'style_def',
  attrs: { id, kind: 'paragraph', name: id, ...attrs },
});
const red: J = { style: 'single', width: 40, color: '#FF0000', space: 80 };
const BOXED = style('Boxed', {
  shading: { fill: '#FFFF00' },
  borders: { top: red, bottom: red, left: red, right: red },
  indentLeft: 1440,
  indentRight: 1440,
});

const options = (title: string): never =>
  ({
    profile: 'preview',
    title,
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
  }) as never;

describe.skipIf(!ready)('EXP-020 criterion 2: paragraph borders and shading in the PDF', () => {
  it('draws the shading behind the paragraph and the four borders around it', async () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const envelope = doc(
      [
        para('BEFOREWORD'),
        para('BOXEDWORD in a box.', { style: 'Boxed' }),
        para('MIDDLEWORD'),
        // direct shading with no border, over several lines
        para(`BLUEFIRST ${long} BLUELAST`, { shading: { fill: '#0000FF' }, color: '#FFFFFF' }),
        para('AFTERWORD'),
        // a border on two sides only
        para('GREENWORD', {
          borders: {
            left: { style: 'single', width: 60, color: '#00C000' },
            bottom: { style: 'single', width: 60, color: '#00C000' },
          },
        }),
      ],
      { styles: [BOXED] },
    );
    const c = await convertAndCompile(envelope, options('paragraph-borders-shading'));
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(`the compile failed:\n${firstError(c.compile.log)}`);
    expect(codes(c.bundle)).not.toContain('paragraph_shading');
    expect(codes(c.bundle)).not.toContain('paragraph_borders');

    const page = renderFirstPage(c.compile.pdf);
    const ws = words(c.compile.pdf);
    const yellow = extent(page, YELLOW);
    const redBox = extent(page, RED);
    const blue = extent(page, BLUE);
    const green = extent(page, GREEN);
    const ctx = JSON.stringify({ yellow, redBox, blue, green });

    // The shading is behind the boxed paragraph's words, and nothing else is yellow.
    const boxed = at(ws, 'BOXEDWORD');
    expect(yellow.count, ctx).toBeGreaterThan(1000);
    expect(px(boxed.xMin), ctx).toBeGreaterThan(yellow.minX);
    expect(px(boxed.yMin), ctx).toBeGreaterThan(yellow.minY - 1);
    expect(px(boxed.yMax), ctx).toBeLessThan(yellow.maxY + 1);
    // It starts one border space (80 twips, 4 pt) left of the text, which is at the left indent.
    const inset = px(boxed.xMin) - yellow.minX;
    expect(inset, ctx).toBeGreaterThan(px(4) - 2);
    expect(inset, ctx).toBeLessThan(px(4) + 3);
    // The text is indented by 1440 twips (72 pt) from the unindented paragraphs.
    expect(boxed.xMin - at(ws, 'BEFOREWORD').xMin).toBeGreaterThan(71);
    expect(boxed.xMin - at(ws, 'BEFOREWORD').xMin).toBeLessThan(73);

    // The four borders are around the shading: a red frame just outside the yellow box.
    for (const [gap, name] of [
      [yellow.minX - redBox.minX, 'left'],
      [redBox.maxX - yellow.maxX, 'right'],
      [yellow.minY - redBox.minY, 'top'],
      [redBox.maxY - yellow.maxY, 'bottom'],
    ] as const) {
      // 40 twips is 2 pt, 2.8 px
      expect(gap, `${name} ${ctx}`).toBeGreaterThanOrEqual(1);
      expect(gap, `${name} ${ctx}`).toBeLessThanOrEqual(5);
    }
    const frameWidth = redBox.maxX - redBox.minX + 1;
    const frameHeight = redBox.maxY - redBox.minY + 1;
    // Each side is a full line: the top and bottom rows and the left and right columns are red.
    expect(inRow(page, RED, redBox.minY + 1), ctx).toBeGreaterThan(frameWidth - 3);
    expect(inRow(page, RED, redBox.maxY - 1), ctx).toBeGreaterThan(frameWidth - 3);
    expect(inColumn(page, RED, redBox.minX + 1), ctx).toBeGreaterThan(frameHeight - 3);
    expect(inColumn(page, RED, redBox.maxX - 1), ctx).toBeGreaterThan(frameHeight - 3);
    // The box takes its own room: the paragraphs before and after are outside the frame.
    expect(px(at(ws, 'BEFOREWORD').yMax) - 3, ctx).toBeLessThan(redBox.minY);
    expect(px(at(ws, 'MIDDLEWORD').yMin) + 3, ctx).toBeGreaterThan(redBox.maxY);

    // Direct shading covers every line of a paragraph of several lines, from margin to margin.
    const first = at(ws, 'BLUEFIRST');
    const last = at(ws, 'BLUELAST');
    expect(last.yMin - first.yMin, 'the blue paragraph has several lines').toBeGreaterThan(20);
    expect(blue.minY, ctx).toBeLessThan(px(first.yMin) + 1);
    // the word box of pdftotext reaches below the line's depth, so the baseline region is checked
    expect(blue.maxY, ctx).toBeGreaterThan(px(last.yMax) - 5);
    expect(Math.abs(blue.minX - px(first.xMin)), ctx).toBeLessThan(2);
    // no gap between the lines: the column at the right edge, where no glyph is, is blue from top
    // to bottom
    expect(inColumn(page, BLUE, blue.maxX - 1), ctx).toBe(blue.maxY - blue.minY + 1);
    expect(px(at(ws, 'MIDDLEWORD').yMax) - 3, ctx).toBeLessThan(blue.minY);
    expect(px(at(ws, 'AFTERWORD').yMin) + 3, ctx).toBeGreaterThan(blue.maxY);

    // Two sides only: a left and a bottom border, and no top or right one.
    const g = at(ws, 'GREENWORD');
    expect(green.count, ctx).toBeGreaterThan(200);
    expect(green.minX, ctx).toBeLessThan(px(g.xMin));
    expect(green.maxY, ctx).toBeGreaterThan(px(g.yMax) - 2);
    expect(inRow(page, GREEN, green.minY), 'no top border').toBeLessThan(8);
    expect(inColumn(page, GREEN, green.maxX), 'no right border').toBeLessThan(8);
    expect(inRow(page, GREEN, green.maxY - 1), ctx).toBeGreaterThan(green.maxX - green.minX - 3);
    expect(inColumn(page, GREEN, green.minX + 1), ctx).toBeGreaterThan(green.maxY - green.minY - 3);
  }, 300_000);

  it('keeps a tagged PDF valid: the drawing is an artifact (veraPDF, PDF/UA-2)', async () => {
    const envelope = doc(
      [para('Before the box.'), para('In a box.', { style: 'Boxed' }), para('After the box.')],
      { styles: [BOXED] },
    );
    const c = await convertAndCompile(envelope, {
      profile: 'final',
      title: 'paragraph-borders-tagged',
      instant: INSTANT,
      timeZone: 'Europe/London',
      suggestions: 'accept',
      layout: 'block',
      tagging: 'on',
      pdfStandard: 'ua-2+a-4f',
    } as never);
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(`the compile failed:\n${firstError(c.compile.log)}`);
    expect(extent(renderFirstPage(c.compile.pdf), YELLOW).count).toBeGreaterThan(1000);
    const ua2 = await validatePdf(c.compile.pdf, 'ua2');
    expect(ua2.error, 'the validator output parses').toBeUndefined();
    expect(ua2.failures, 'no PDF/UA-2 rule fails').toEqual([]);
    expect(ua2.compliant).toBe(true);
  }, 600_000);
});
