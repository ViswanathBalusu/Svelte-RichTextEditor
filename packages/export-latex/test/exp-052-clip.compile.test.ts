/**
 * EXP-052 criterion 5 (Podman, export worker sandbox, lane V-EXP-049-064), display equations only:
 * the class clips a display equation to its box, so nothing of it is painted outside the box.
 * Inline equations are not clipped (see the class and the story Notes), so this test has none.
 *
 * The converter's gate refuses the painting commands (EXP-050), so the test puts a painting command
 * in by hand: after conversion, the placeholder `QQQ` in the bundle's main.tex is replaced by TeX
 * that draws a 200 pt bar which starts left of the equation's box (a negative kern, then the bar).
 * The box is 0 pt wide, so a clipped bar is not visible. The PDF of that document is rasterised by
 * poppler's pdftoppm, and its dark pixels are compared with a document whose equations are empty.
 * A positive control keeps a 20 pt square inside the box, which must still be painted.
 *
 * Skipped when the sandbox or pdftoppm cannot run here.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.ts';
import { classFiles, compileBundle, imageFonts, sandboxReady } from './harness.ts';
import { doc, nid, para } from './docs.ts';

const PDFTOPPM = process.env['DOCEDIT_PDFTOPPM'] ?? 'pdftoppm';
const probe = spawnSync(PDFTOPPM, ['-v'], { encoding: 'utf8' });
const rasteriser = !probe.error;
const ready = rasteriser && (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const PLACEHOLDER = 'QQQ';

/** The full TeX log of a compile, kept in the temporary directory for a failed run to be read. */
function dumpLog(name: string, log: string): void {
  writeFileSync(join(tmpdir(), `docedit-v-exp-049-064-052-${name}.log`), log);
}

/** Dark pixels (grey below 128) of page 1, rendered at 72 dpi, from the PGM that pdftoppm writes. */
function darkPixels(pdf: Uint8Array): number {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-v-exp-049-064-clip-'));
  try {
    const input = join(dir, 'page.pdf');
    writeFileSync(input, pdf);
    const r = spawnSync(
      PDFTOPPM,
      ['-gray', '-r', '72', '-f', '1', '-l', '1', '-singlefile', input, join(dir, 'page')],
      {
        encoding: 'buffer',
      },
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
    let dark = 0;
    for (let i = 0; i < width * height; i++) if (bytes[pos + i]! < 128) dark++;
    return dark;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The document: one display equation with the placeholder, between two paragraphs. */
async function compiledWith(replacement: string) {
  const body = [
    para('Before the equation.', {}, []),
    { type: 'equation_block', attrs: { id: nid('env'), latex: PLACEHOLDER } },
    para('After the equation.', {}, []),
  ];
  const bundle = await convert(doc(body), {
    fonts: await imageFonts(),
    classFiles: classFiles(),
    profile: 'preview',
    title: 'exp-052-clip',
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
  } as never);
  const hits = Object.entries(bundle.files).filter(([, text]) => text.includes(PLACEHOLDER));
  expect(hits.map(([name]) => name)).toEqual(['main.tex']);
  writeFileSync(join(tmpdir(), 'docedit-v-exp-049-064-052-main.tex'), bundle.files['main.tex']!);
  bundle.files['main.tex'] = bundle.files['main.tex']!.split(PLACEHOLDER).join(replacement);
  return compileBundle(bundle, { maxPasses: 1, minPasses: 1 });
}

const OVERHANG = '\\kern-200pt\\hbox{\\vrule width200pt height3pt depth0pt}';
const INSIDE = '\\hbox{\\vrule width20pt height20pt depth0pt}';

describe.skipIf(!ready)('EXP-052 criterion 5: the class clips every equation to its box', () => {
  it('paints nothing of a bar that starts outside an equation, and keeps a square inside the box', async () => {
    const empty = await compiledWith('');
    dumpLog('empty', empty.compile.log);
    expect(empty.compile.ok).toBe(true);
    const baseline = darkPixels(empty.compile.pdf!);

    const clipped = await compiledWith(OVERHANG);
    dumpLog('clipped', clipped.compile.log);
    expect(clipped.compile.ok).toBe(true);
    const withBar = darkPixels(clipped.compile.pdf!);

    const inside = await compiledWith(INSIDE);
    dumpLog('inside', inside.compile.log);
    expect(inside.compile.ok).toBe(true);
    const withSquare = darkPixels(inside.compile.pdf!);

    // The control: a 20 pt square in each of two equations is about 800 dark pixels at 72 dpi.
    expect(withSquare - baseline).toBeGreaterThan(300);
    // The bar would add about 1200 dark pixels if it were painted; the clip leaves at most a few.
    expect(withBar - baseline).toBeLessThan(20);
  }, 900_000);
});
