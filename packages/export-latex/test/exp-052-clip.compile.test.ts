/**
 * EXP-052 criterion 5 (Podman, export worker sandbox, lane V-EXP-049-064), display equations only:
 * the class clips a display equation to its box, so nothing of it is painted outside the box.
 * Inline equations are in `exp-052-clip-inline.compile.test.ts`.
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
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.ts';
import { darkPixels, differingPixels, rasteriserAvailable } from './raster.ts';
import { classFiles, compileBundle, imageFonts, sandboxReady } from './harness.ts';
import { doc, nid, para } from './docs.ts';

const rasteriser = rasteriserAvailable();
const ready = rasteriser && (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const PLACEHOLDER = 'QQQ';

/** The full TeX log of a compile, kept in the temporary directory for a failed run to be read. */
function dumpLog(name: string, log: string): void {
  writeFileSync(join(tmpdir(), `docedit-v-exp-049-064-052-${name}.log`), log);
}

/** The document: one display equation with the placeholder, between two paragraphs. */
async function compiledWith(replacement: string, unclipped = false) {
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
  if (unclipped) {
    // The display equation as the class set it before the clip: the box, without the clip path.
    bundle.files['main.tex'] = bundle.files['main.tex']!.replace(
      '\\begin{document}',
      () =>
        '\\makeatletter\\renewcommand\\DE@clipmath[1]{\\setbox\\DE@cbox=\\hbox{$\\displaystyle#1$}\\box\\DE@cbox}\\makeatother\n\\begin{document}',
    );
  }
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

  it('moves nothing after a display equation that has a width', async () => {
    const clipped = await compiledWith('a+b+c+d+e+f+g+h', false);
    expect(clipped.compile.ok).toBe(true);
    const unclipped = await compiledWith('a+b+c+d+e+f+g+h', true);
    expect(unclipped.compile.ok).toBe(true);
    const dark = darkPixels(unclipped.compile.pdf!);
    expect(dark).toBeGreaterThan(300);
    const differing = differingPixels(clipped.compile.pdf!, unclipped.compile.pdf!);
    writeFileSync(
      join(tmpdir(), 'docedit-w2-exp-052-display-shift.txt'),
      `dark ${dark}, differing ${differing}`,
    );
    expect(differing).toBeLessThan(10);
  }, 900_000);
});
