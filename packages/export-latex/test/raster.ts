/**
 * Rasterising a PDF page for the clip tests (Node.js only): poppler's pdftoppm at 72 dpi, and the
 * dark pixels of the grey image. Used by the compile tests of EXP-052 criterion 5.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';

export const PDFTOPPM = process.env['DOCEDIT_PDFTOPPM'] ?? 'pdftoppm';

/** Whether pdftoppm can be run here. */
export function rasteriserAvailable(): boolean {
  return !spawnSync(PDFTOPPM, ['-v'], { encoding: 'utf8' }).error;
}

/** The grey raster of page 1, rendered at 72 dpi, from the PGM that pdftoppm writes. */
export function greyPage(pdf: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-exp-052-clip-'));
  try {
    const input = join(dir, 'page.pdf');
    writeFileSync(input, pdf);
    const r = spawnSync(
      PDFTOPPM,
      ['-gray', '-r', '72', '-f', '1', '-l', '1', '-singlefile', input, join(dir, 'page')],
      { encoding: 'buffer' },
    );
    if (r.status !== 0) throw new Error(`pdftoppm failed: ${String(r.stderr)}`);
    const bytes = readFileSync(join(dir, 'page.pgm'));
    // PGM header: P5, width, height, maxval, each followed by whitespace; then the raster.
    let pos = 0;
    const token = (): string => {
      while (pos < bytes.length && /\s/.test(String.fromCharCode(bytes[pos]!))) pos++;
      const start = pos;
      while (pos < bytes.length && !/\s/.test(String.fromCharCode(bytes[pos]!))) pos++;
      return bytes.subarray(start, pos).toString('latin1');
    };
    expect(token()).toBe('P5');
    const width = Number(token());
    const height = Number(token());
    token();
    pos++; // the single whitespace byte before the raster
    return { width, height, pixels: Uint8Array.from(bytes.subarray(pos, pos + width * height)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Dark pixels (grey below 128) of page 1. */
export function darkPixels(pdf: Uint8Array): number {
  let dark = 0;
  for (const v of greyPage(pdf).pixels) if (v < 128) dark++;
  return dark;
}

/** The number of pixels of page 1 whose grey differs by more than 64 between two PDFs. */
export function differingPixels(a: Uint8Array, b: Uint8Array): number {
  const x = greyPage(a);
  const y = greyPage(b);
  expect([x.width, x.height]).toEqual([y.width, y.height]);
  let n = 0;
  for (let i = 0; i < x.pixels.length; i++) if (Math.abs(x.pixels[i]! - y.pixels[i]!) > 64) n++;
  return n;
}
