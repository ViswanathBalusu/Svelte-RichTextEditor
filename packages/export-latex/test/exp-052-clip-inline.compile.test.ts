/**
 * EXP-052 criterion 5, inline equations (Podman, export worker sandbox): the class clips an inline
 * equation to its box (`clip_math` in docedit.lua), so nothing of it is painted outside the box.
 *
 * The method is that of `exp-052-clip.compile.test.ts`. The converter's gate refuses the painting
 * commands (EXP-050), so the test puts one in by hand: the placeholder `QQQ` in main.tex becomes a
 * bar that starts left of the equation's box. The PDF is rasterised with pdftoppm at 72 dpi and
 * its dark pixels are compared with a document whose equation is empty. A square inside the box
 * is the positive control. A last document has an equation that the line breaker breaks over
 * several lines; its dark pixels are compared with the same document under a `\DEmath` that does
 * not clip, so that the clip is shown not to cut the ink of the equation itself.
 *
 * Skipped when the sandbox or pdftoppm cannot run here.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.ts';
import { classFiles, compileBundle, imageFonts, sandboxReady } from './harness.ts';
import { doc, para } from './docs.ts';
import { darkPixels, differingPixels, rasteriserAvailable } from './raster.ts';

const ready = rasteriserAvailable() && (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const PLACEHOLDER = 'QQQ';

/** The unclipped `\DEmath` of class 0.2.10 (before the clip), to compare with. */
const UNCLIPPED =
  '\\makeatletter\\renewcommand\\DEmath[1]{\\gdef\\DE@mathsrc{#1}$#1$}\\makeatother\n\\begin{document}';

function dumpLog(name: string, log: string): void {
  writeFileSync(join(tmpdir(), `docedit-w2-exp-052-inline-${name}.log`), log);
}

async function compiledWith(
  latex: string,
  replacement: string,
  options: { unclipped?: boolean; before?: string } = {},
) {
  const body = [
    para('Before the equation.', {}, []),
    para(options.before ?? '', {}, [{ type: 'equation', attrs: { latex } }]),
    para('After the equation.', {}, []),
  ];
  const bundle = await convert(doc(body), {
    fonts: await imageFonts(),
    classFiles: classFiles(),
    profile: 'preview',
    title: 'exp-052-clip-inline',
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
  } as never);
  let main = bundle.files['main.tex']!;
  if (latex === PLACEHOLDER) {
    expect(main.split(PLACEHOLDER).length - 1).toBeGreaterThan(0);
    main = main.split(PLACEHOLDER).join(replacement);
  }
  if (options.unclipped) {
    expect(main.split('\\begin{document}').length).toBe(2);
    main = main.replace('\\begin{document}', () => UNCLIPPED);
  }
  bundle.files['main.tex'] = main;
  return compileBundle(bundle, { maxPasses: 1, minPasses: 1 });
}

const OVERHANG = '\\kern-200pt\\hbox{\\vrule width200pt height6pt depth0pt}';
const INSIDE = '\\hbox{\\vrule width20pt height10pt depth0pt}';

describe.skipIf(!ready)(
  'EXP-052 criterion 5: the class clips an inline equation to its box',
  () => {
    it('paints nothing of a bar that starts outside the equation, and keeps a square inside the box', async () => {
      const empty = await compiledWith(PLACEHOLDER, '\\hbox{}');
      dumpLog('empty', empty.compile.log);
      expect(empty.compile.ok).toBe(true);
      const baseline = darkPixels(empty.compile.pdf!);

      const bar = await compiledWith(PLACEHOLDER, OVERHANG);
      dumpLog('bar', bar.compile.log);
      expect(bar.compile.ok).toBe(true);
      const withBar = darkPixels(bar.compile.pdf!);

      // The negative control: the same bar under the unclipped `\DEmath` is painted, so the
      // method can tell a clip from no clip.
      const open = await compiledWith(PLACEHOLDER, OVERHANG, { unclipped: true });
      dumpLog('bar-unclipped', open.compile.log);
      expect(open.compile.ok).toBe(true);
      const withOpenBar = darkPixels(open.compile.pdf!);

      const square = await compiledWith(PLACEHOLDER, INSIDE);
      dumpLog('square', square.compile.log);
      expect(square.compile.ok).toBe(true);
      const withSquare = darkPixels(square.compile.pdf!);

      const numbers = `baseline ${baseline}, bar ${withBar}, bar unclipped ${withOpenBar}, square ${withSquare}`;
      writeFileSync(join(tmpdir(), 'docedit-w2-exp-052-inline-numbers.txt'), numbers);
      expect(withOpenBar - baseline, numbers).toBeGreaterThan(100);
      // The control: a 20 by 10 pt square is about 200 dark pixels at 72 dpi.
      expect(withSquare - baseline).toBeGreaterThan(100);
      // The bar would add 6 pt by the width of the margin if it were painted; the clip leaves a few.
      expect(withBar - baseline).toBeLessThan(20);
    }, 900_000);

    it('keeps the ink of an equation that the line breaker breaks over lines', async () => {
      const terms = Array.from({ length: 70 }, (_, i) => `x_{${i + 1}}`).join('+');
      const before = 'The sum is ';
      const clipped = await compiledWith(terms, '', { before });
      dumpLog('long-clipped', clipped.compile.log);
      expect(clipped.compile.ok).toBe(true);
      const unclipped = await compiledWith(terms, '', { before, unclipped: true });
      dumpLog('long-unclipped', unclipped.compile.log);
      expect(unclipped.compile.ok).toBe(true);
      const a = darkPixels(clipped.compile.pdf!);
      const b = darkPixels(unclipped.compile.pdf!);
      const differing = differingPixels(clipped.compile.pdf!, unclipped.compile.pdf!);
      writeFileSync(
        join(tmpdir(), 'docedit-w2-exp-052-inline-long.txt'),
        `clipped ${a} dark pixels, unclipped ${b}, differing ${differing}`,
      );
      expect(b).toBeGreaterThan(1000);
      // Nothing moves: the two pages are the same image, but for a pixel of an italic overhang. A
      // clip whose `Q` left the page's origin shifted would move every later line.
      expect(differing, `clipped ${a}, unclipped ${b}`).toBeLessThan(10);
    }, 900_000);
  },
);
