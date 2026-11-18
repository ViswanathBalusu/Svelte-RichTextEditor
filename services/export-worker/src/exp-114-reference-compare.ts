/**
 * EXP-114 criterion 2: compares an export with its stored reference PDF, by the positions of the
 * extracted text and by rendered pixels, with stated tolerances, and says what differs.
 *
 * - Text: the lines of `pdftotext -bbox-layout` (exp-078-pdftotext.ts), compared by
 *   `diffText` of exp-078-reference-diff.ts. A line is moved when its position differs by more than
 *   `TOLERANCES.textPoints`.
 * - Pixels: each page is rendered with poppler's `pdftoppm -gray` at `TOLERANCES.dpi`. A pixel
 *   differs when its grey level differs by more than `TOLERANCES.level` (of 255). A page differs
 *   when more than `TOLERANCES.pixelFraction` of its pixels differ, or its size differs. The report
 *   gives the count, the share and the bounding box of the differing pixels of every page that
 *   differs, so that a reviewer knows where to look.
 *
 * The tolerances are settings of this tool, stated here and in the report. They are provisional:
 * the same bundle compiled twice under the same instant and `SOURCE_DATE_EPOCH` gives no differing
 * pixel on the machine where the references were made (see the story's Evidence), so they leave
 * room for another poppler or another machine, and nothing more has been measured.
 *
 * `pdftoppm` is named by DOCEDIT_PDFTOPPM, or looked up on the PATH.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { diffText, type TextDiff } from './exp-078-reference-diff.ts';
import { pdfTextPositions } from './exp-078-pdftotext.ts';

const run = promisify(execFile);

/** The tolerances of the comparison (see the module comment). */
export const TOLERANCES = {
  /** Position of a text line, in PDF points. */
  textPoints: 0.5,
  /** Resolution of the rendered pages, dots per inch. */
  dpi: 72,
  /** Grey levels (0 to 255) that two pixels may differ by and still count as equal. */
  level: 32,
  /** The share of a page's pixels that may differ before the page counts as different. */
  pixelFraction: 0.001,
} as const;

export type Tolerances = { -readonly [K in keyof typeof TOLERANCES]: number };

/** A page rendered to grey levels, row by row. */
export interface GreyPage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface PageDifference {
  page: number;
  /** The page has another size than the reference's. */
  sizeDiffers: boolean;
  /** Pixels whose grey level differs by more than the tolerance. */
  pixels: number;
  /** `pixels` as a share of the page. */
  fraction: number;
  /** The smallest box that holds the differing pixels, in pixels; null when none differ. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** True when the page is outside the tolerance. */
  differs: boolean;
}

export interface PixelDiff {
  pageCount: { ref: number; cand: number };
  pages: PageDifference[];
  differs: boolean;
}

export function pdftoppmCli(): string {
  return process.env['DOCEDIT_PDFTOPPM'] ?? 'pdftoppm';
}

/** Reads a binary PGM (`P5`, 8 bits) as written by `pdftoppm -gray`. */
export function parsePgm(bytes: Uint8Array): GreyPage {
  let at = 0;
  const token = (): string => {
    // Skips white space and comment lines, then reads one token.
    for (;;) {
      while (at < bytes.length && /\s/.test(String.fromCharCode(bytes[at]!))) at++;
      if (bytes[at] === 0x23) {
        while (at < bytes.length && bytes[at] !== 0x0a) at++;
        continue;
      }
      break;
    }
    const start = at;
    while (at < bytes.length && !/\s/.test(String.fromCharCode(bytes[at]!))) at++;
    return String.fromCharCode(...bytes.subarray(start, at));
  };
  if (token() !== 'P5') throw new Error('pdftoppm did not write a binary PGM');
  const width = Number(token());
  const height = Number(token());
  if (Number(token()) !== 255) throw new Error('the PGM is not 8 bits');
  at++; // the single white space before the pixels
  const pixels = bytes.subarray(at, at + width * height);
  if (!(width > 0 && height > 0) || pixels.length !== width * height)
    throw new Error('the PGM is cut short');
  return { width, height, pixels };
}

/** Renders every page of a PDF to grey levels at `dpi`. */
export async function renderPages(pdf: Uint8Array, dpi: number): Promise<GreyPage[]> {
  const dir = await mkdtemp(join(tmpdir(), 'docedit-exp-114-'));
  try {
    await writeFile(join(dir, 'in.pdf'), pdf);
    await run(pdftoppmCli(), ['-gray', '-r', String(dpi), join(dir, 'in.pdf'), join(dir, 'page')], {
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    // Names are page-1.pgm, page-01.pgm and so on, by the page count's width: sort by number.
    const names = (await readdir(dir))
      .filter((n) => /^page-\d+\.pgm$/.test(n))
      .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
    return await Promise.all(names.map(async (n) => parsePgm(await readFile(join(dir, n)))));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Compares rendered pages of a reference and a candidate. Pure. */
export function diffPixels(
  ref: readonly GreyPage[],
  cand: readonly GreyPage[],
  tol: Pick<Tolerances, 'level' | 'pixelFraction'> = TOLERANCES,
): PixelDiff {
  const pages: PageDifference[] = [];
  const count = Math.max(ref.length, cand.length);
  for (let p = 0; p < count; p++) {
    const r = ref[p];
    const c = cand[p];
    if (!r || !c) {
      pages.push({
        page: p + 1,
        sizeDiffers: false,
        pixels: 0,
        fraction: 1,
        box: null,
        differs: true,
      });
      continue;
    }
    if (r.width !== c.width || r.height !== c.height) {
      pages.push({
        page: p + 1,
        sizeDiffers: true,
        pixels: 0,
        fraction: 1,
        box: null,
        differs: true,
      });
      continue;
    }
    let pixels = 0;
    let x0 = r.width;
    let y0 = r.height;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < r.width; x++) {
        const i = y * r.width + x;
        if (Math.abs(r.pixels[i]! - c.pixels[i]!) > tol.level) {
          pixels++;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    const fraction = pixels / (r.width * r.height);
    pages.push({
      page: p + 1,
      sizeDiffers: false,
      pixels,
      fraction,
      box: pixels ? { x0, y0, x1, y1 } : null,
      differs: fraction > tol.pixelFraction,
    });
  }
  const pageCount = { ref: ref.length, cand: cand.length };
  return {
    pageCount,
    pages,
    differs: pageCount.ref !== pageCount.cand || pages.some((q) => q.differs),
  };
}

export interface Comparison {
  text: TextDiff;
  pixels: PixelDiff;
  /** True when the text positions or the pixels are outside the tolerances. */
  differs: boolean;
  tolerances: Tolerances;
  /** What differs, one line each; empty when nothing does. */
  report: string;
}

/** The lines that say what differs, with the tolerances at the head. */
export function formatComparison(
  name: string,
  text: TextDiff,
  pixels: PixelDiff,
  tol: Tolerances,
): string {
  const out: string[] = [];
  if (text.pageCount.ref !== text.pageCount.cand)
    out.push(`${name}: ${text.pageCount.ref} pages in the reference, ${text.pageCount.cand} now`);
  for (const m of text.moved)
    out.push(
      `${name}: page ${m.page}, line "${m.text}" moved from (${m.refX.toFixed(2)}, ${m.refY.toFixed(2)}) to (${m.candX.toFixed(2)}, ${m.candY.toFixed(2)}) points`,
    );
  for (const c of text.changed)
    out.push(
      `${name}: page ${c.page}, line ${c.index + 1} was "${c.refText}" and is "${c.candText}"`,
    );
  for (const b of text.breaks)
    out.push(
      `${name}: page ${b.page} began with "${b.refFirst}" and now begins with "${b.candFirst}"`,
    );
  for (const p of pixels.pages) {
    if (!p.differs) continue;
    if (p.sizeDiffers) out.push(`${name}: page ${p.page} has another size than the reference`);
    else if (p.box)
      out.push(
        `${name}: page ${p.page}, ${p.pixels} pixels differ (${(p.fraction * 100).toFixed(3)} %), inside x ${p.box.x0} to ${p.box.x1}, y ${p.box.y0} to ${p.box.y1} at ${tol.dpi} dpi`,
      );
    else out.push(`${name}: page ${p.page} is missing on one side`);
  }
  if (!out.length) return '';
  return [
    `Tolerances: text ${tol.textPoints} points; pixels ${tol.dpi} dpi, grey level ${tol.level} of 255, ${tol.pixelFraction * 100} % of a page.`,
    ...out,
  ].join('\n');
}

/** Compares an export with its reference, by text positions and by pixels. */
export async function compareWithReference(
  name: string,
  candidate: Uint8Array,
  reference: Uint8Array,
  tolerances: Partial<Tolerances> = {},
): Promise<Comparison> {
  const tol: Tolerances = { ...TOLERANCES, ...tolerances };
  const [refText, candText] = [
    await pdfTextPositions(reference),
    await pdfTextPositions(candidate),
  ];
  const text = diffText(refText, candText, tol.textPoints);
  const [refPages, candPages] = [
    await renderPages(reference, tol.dpi),
    await renderPages(candidate, tol.dpi),
  ];
  const pixels = diffPixels(refPages, candPages, tol);
  return {
    text,
    pixels,
    differs: text.differs || pixels.differs,
    tolerances: tol,
    report: formatComparison(name, text, pixels, tol),
  };
}
