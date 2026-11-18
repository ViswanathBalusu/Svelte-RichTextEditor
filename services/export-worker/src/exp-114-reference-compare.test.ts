/**
 * EXP-114 criterion 2: the comparison of an export with its stored reference (text positions and
 * pixels, with stated tolerances). The pure parts run anywhere; the parts that read PDFs need
 * poppler's `pdftotext` and `pdftoppm` and skip with a reason in the title without them. The
 * compile of a corpus document against its reference is `exp-114-compare.compile.test.ts` in
 * `packages/export-latex`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pdftotextCli } from './exp-078-pdftotext.ts';
import {
  compareWithReference,
  diffPixels,
  parsePgm,
  pdftoppmCli,
  TOLERANCES,
  type GreyPage,
} from './exp-114-reference-compare.ts';

const page = (w: number, h: number, fill = 255): GreyPage => ({
  width: w,
  height: h,
  pixels: new Uint8Array(w * h).fill(fill),
});

describe('EXP-114 criterion 2: the pixel comparison', () => {
  it('reads a binary PGM', () => {
    const head = new TextEncoder().encode('P5\n# a comment\n3 2\n255\n');
    const bytes = new Uint8Array(head.length + 6);
    bytes.set(head);
    bytes.set([1, 2, 3, 4, 5, 6], head.length);
    expect(parsePgm(bytes)).toMatchObject({ width: 3, height: 2 });
    expect([...parsePgm(bytes).pixels]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(() => parsePgm(new TextEncoder().encode('P6\n1 1\n255\n\0\0\0'))).toThrow();
  });

  it('finds no difference in equal pages and none within the grey tolerance', () => {
    const a = page(40, 40);
    const near = page(40, 40, 255 - TOLERANCES.level);
    expect(diffPixels([a], [page(40, 40)]).differs).toBe(false);
    expect(diffPixels([a], [near]).differs).toBe(false);
  });

  it('names the page, the count and the box of the pixels that differ', () => {
    const ref = page(100, 100);
    const cand = page(100, 100);
    for (let y = 10; y < 14; y++) for (let x = 20; x < 30; x++) cand.pixels[y * 100 + x] = 0;
    const d = diffPixels([ref, page(10, 10)], [cand, page(10, 10)]);
    expect(d.differs).toBe(true);
    expect(d.pages[0]).toMatchObject({
      page: 1,
      pixels: 40,
      box: { x0: 20, y0: 10, x1: 29, y1: 13 },
      differs: true,
    });
    expect(d.pages[1]).toMatchObject({ pixels: 0, differs: false });
  });

  it('allows a few pixels up to the stated share of the page, and no more', () => {
    const ref = page(100, 100);
    const few = page(100, 100);
    for (let i = 0; i < 10; i++) few.pixels[i] = 0;
    expect(10 / 10_000).toBeLessThanOrEqual(TOLERANCES.pixelFraction);
    expect(diffPixels([ref], [few]).differs).toBe(false);
    const many = page(100, 100);
    for (let i = 0; i < 11; i++) many.pixels[i] = 0;
    expect(diffPixels([ref], [many]).differs).toBe(true);
  });

  it('reports a page count that differs and a page of another size', () => {
    expect(diffPixels([page(10, 10)], [page(10, 10), page(10, 10)])).toMatchObject({
      differs: true,
      pageCount: { ref: 1, cand: 2 },
    });
    expect(diffPixels([page(10, 10)], [page(10, 12)]).pages[0]).toMatchObject({
      sizeDiffers: true,
      differs: true,
    });
  });
});

function popplerAbsence(): string | null {
  for (const cli of [pdftotextCli(), pdftoppmCli()]) {
    const r = spawnSync(cli, ['-v'], { windowsHide: true, timeout: 20_000 });
    if (r.error) return `${cli} is not installed`;
  }
  return null;
}

const absent = popplerAbsence();
const refDir = fileURLToPath(
  new URL('../../../packages/export-latex/test/references/', import.meta.url),
);
const sample = (): Uint8Array =>
  new Uint8Array(readFileSync(refDir + 'exp-114-sample-ua2-a4f.pdf'));
const s4 = (): Uint8Array => new Uint8Array(readFileSync(refDir + 'exp-114-s4-01p-ua2-a4f.pdf'));

describe.skipIf(absent !== null)(
  `EXP-114 criterion 2: a stored reference against output${absent ? ` (skipped: ${absent})` : ''}`,
  () => {
    it('finds the same PDF equal to itself, by text positions and by pixels', async () => {
      const c = await compareWithReference('sample', sample(), sample());
      expect(c.differs).toBe(false);
      expect(c.report).toBe('');
      expect(c.pixels.pages.length).toBeGreaterThan(0);
      expect(c.pixels.pages.every((p) => p.pixels === 0)).toBe(true);
    }, 120_000);

    it('shows what differs between two documents, with the tolerances at the head', async () => {
      const c = await compareWithReference('s4-01p', s4(), sample());
      expect(c.differs).toBe(true);
      expect(c.text.differs).toBe(true);
      expect(c.pixels.differs).toBe(true);
      expect(c.report).toMatch(/^Tolerances: text 0\.5 points; pixels 72 dpi/);
      expect(c.report).toMatch(/s4-01p: page 1, line \d+ was ".*" and is "/);
      expect(c.report).toMatch(/pixels differ \(/);
    }, 120_000);

    it('takes tolerances from the caller and reports them', async () => {
      // A text tolerance that no position can exceed and a pixel share of 1 leave only the lines
      // whose text changed, and no page that differs.
      const c = await compareWithReference('s4-01p', s4(), sample(), {
        textPoints: 1e6,
        pixelFraction: 1,
      });
      expect(c.pixels.differs).toBe(c.pixels.pageCount.ref !== c.pixels.pageCount.cand);
      expect(c.tolerances).toMatchObject({ textPoints: 1e6, pixelFraction: 1, dpi: 72 });
    }, 120_000);
  },
);
