/**
 * EXP-053 criterion 2, painting half (Node.js only, Podman sandbox, poppler's pdftoppm): for every
 * value the gate accepts, nothing is painted outside the equation's box, as a display equation and
 * as an inline equation.
 *
 * Method. One document holds each accepted value as a display equation between two
 * paragraphs, and, where the gate allows it inline, in a paragraph too. It is compiled three times:
 * - A: as the class sets it (the equation clipped to its box);
 * - B: the equations set in white (the same nodes, boxes and clip, nothing visible);
 * - D: as B, with a class in which the clip path of an equation (`re W n`, in `docedit.cls` and
 *   `docedit.lua`) fills the rectangle instead of clipping to it: the box, painted black, under the
 *   white equation (the white glyphs leave holes of a pixel or two, which the growing below closes).
 * The pages are rasterised at 72 dpi. The ink the equations add is the dark pixels of A that are
 * light in B. Each must lie in the box, which is the dark pixels of D that are light in B, grown by
 * 2 pixels for the anti-aliasing of the box's edge. A spill of more than 2 pt fails the test.
 *
 * Negative control: the placeholder `QQQ` is replaced by `x` and a 60 pt bar that starts at the
 * box's right edge (`\rlap`; the gate refuses it, EXP-050). Under the class's clip the bar does not
 * show (no spill); under a `\DE@clipmath` and a `\DEmath` that do not clip, it does.
 *
 * What this does not prove: a spill of 2 pt or less. The variants must have the same number of
 * pages and the same page size, which the test checks.
 * Skipped when the sandbox or pdftoppm cannot run here.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.ts';
import { mathGate } from '../src/math/gate.ts';
import { classFiles, compileBundle, imageFonts, sandboxReady } from './harness.ts';
import { doc, nid, para, type J } from './docs.ts';
import { ACCEPTED } from './exp-053-values.ts';
import { PDFTOPPM, rasteriserAvailable } from './raster.ts';

const ready = rasteriserAvailable() && (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const PLACEHOLDER = 'QQQ';

/** TeX with single backslashes. */
const tx = String.raw;

/** The variants of the class's equation macros, written before `\begin{document}`. */
const PRE = tx`\makeatletter`;
const POST = tx`\makeatother` + '\n';
const INVISIBLE =
  PRE +
  tx`\renewcommand\DE@clipmath[1]{\setbox\DE@cbox=\hbox{\color{white}$\displaystyle#1$}\DE@clipout}` +
  tx`\renewcommand\DEmath[1]{\gdef\DE@mathsrc{#1}\begingroup\DE@attr@mclip=1\relax\color{white}$#1$\endgroup}` +
  POST;
const UNCLIPPED =
  PRE +
  tx`\renewcommand\DE@clipmath[1]{\setbox\DE@cbox=\hbox{$\displaystyle#1$}\box\DE@cbox}` +
  tx`\renewcommand\DEmath[1]{\gdef\DE@mathsrc{#1}\begingroup$#1$\endgroup}` +
  POST;

function body(values: readonly string[]): J[] {
  const out: J[] = [];
  values.forEach((v, i) => {
    out.push(para(`Before display ${i}.`, {}, []));
    out.push({ type: 'equation_block', attrs: { id: nid('env'), latex: v } });
    // The environments of display math (`aligned`, `cases`, matrices) are refused inline by the gate,
    // so those values have no inline equation.
    const inline = mathGate(v, false).ok;
    out.push({
      type: 'paragraph',
      attrs: { id: nid('p') },
      content: [
        { type: 'text', text: `Inline ${i}: ` },
        ...(inline ? [{ type: 'equation', attrs: { latex: v } }] : []),
        { type: 'text', text: ' and after.' },
      ],
    });
  });
  return out;
}

/** Converts the body and compiles it, with `pre` before `\begin{document}` and `swap` applied to main.tex. */
async function compiled(
  values: readonly string[],
  pre: string,
  options: { swap?: (main: string) => string; fill?: boolean } = {},
) {
  const { swap, fill } = options;
  const files = classFiles();
  if (fill)
    for (const name of ['docedit.cls', 'docedit.lua']) {
      const text = files[name]!;
      if (!text.includes('re W n')) throw new Error(`${name} has no clip path`);
      files[name] = text.split('re W n').join('re f');
    }
  const bundle = await convert(doc(body(values)), {
    fonts: await imageFonts(),
    classFiles: files,
    profile: 'preview',
    title: 'exp-053-paint',
    instant: INSTANT,
    timeZone: 'Europe/London',
    suggestions: 'accept',
  } as never);
  let main = bundle.files['main.tex']!;
  if (swap) main = swap(main);
  const begin = tx`\begin{document}`;
  bundle.files['main.tex'] = main.replace(begin, () => `${pre}${begin}`);
  const out = await compileBundle(bundle, { maxPasses: 1, minPasses: 1 });
  if (!out.compile.ok || !out.compile.pdf)
    throw new Error(`the compile failed:\n${out.compile.log.slice(-1500)}`);
  return out.compile.pdf;
}

interface Page {
  width: number;
  height: number;
  pixels: Uint8Array;
}

/** Every page of a PDF as a grey raster at 72 dpi. */
function greyPages(pdf: Uint8Array): Page[] {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-exp-053-paint-'));
  try {
    writeFileSync(join(dir, 'doc.pdf'), pdf);
    const r = spawnSync(PDFTOPPM, ['-gray', '-r', '72', join(dir, 'doc.pdf'), join(dir, 'p')], {
      encoding: 'buffer',
    });
    if (r.status !== 0) throw new Error(`pdftoppm failed: ${String(r.stderr)}`);
    return readdirSync(dir)
      .filter((n) => n.endsWith('.pgm'))
      .sort()
      .map((n) => {
        const bytes = readFileSync(join(dir, n));
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
        pos++;
        return {
          width,
          height,
          pixels: Uint8Array.from(bytes.subarray(pos, pos + width * height)),
        };
      });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The pixels the equations paint outside their boxes: dark in `ink` and light in `ghost`, and not
 * within `grow` pixels of a pixel that is dark in `solid` and light in `ghost`.
 */
function spill(
  ink: Uint8Array,
  ghost: Uint8Array,
  solid: Uint8Array,
  grow = 2,
): { count: number; first: string[] } {
  const pa = greyPages(ink);
  const pb = greyPages(ghost);
  const pd = greyPages(solid);
  expect([pb.length, pd.length], 'the variants have the same number of pages').toEqual([
    pa.length,
    pa.length,
  ]);
  let bad = 0;
  const first: string[] = [];
  pa.forEach((a, k) => {
    const b = pb[k]!;
    const d = pd[k]!;
    expect([b.width, b.height, d.width, d.height]).toEqual([a.width, a.height, a.width, a.height]);
    const inBox = (x: number, y: number): boolean => {
      for (let dy = -grow; dy <= grow; dy++)
        for (let dx = -grow; dx <= grow; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= a.width || yy >= a.height) continue;
          const i = yy * a.width + xx;
          if (d.pixels[i]! < 128 && b.pixels[i]! > 192) return true;
        }
      return false;
    };
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < a.width; x++) {
        const i = y * a.width + x;
        if (a.pixels[i]! < 128 && b.pixels[i]! > 192 && !inBox(x, y)) {
          bad++;
          if (first.length < 12) first.push(`p${k + 1}(${x},${y})`);
        }
      }
  });
  return { count: bad, first };
}

/** The ink that the equations add, so that a test cannot pass on blank pages. */
function added(ink: Uint8Array, ghost: Uint8Array): number {
  const pa = greyPages(ink);
  const pb = greyPages(ghost);
  let n = 0;
  pa.forEach((a, k) => {
    for (let i = 0; i < a.pixels.length; i++)
      if (a.pixels[i]! < 128 && pb[k]!.pixels[i]! > 192) n++;
  });
  return n;
}

describe('EXP-053 criterion 2 (painting half): the accepted values', () => {
  it('are accepted by the gate as display math, and most of them as inline math', () => {
    expect(ACCEPTED.length).toBeGreaterThanOrEqual(12);
    for (const v of ACCEPTED) {
      expect(mathGate(v, true).ok, v).toBe(true);
    }
    expect(ACCEPTED.filter((v) => mathGate(v, false).ok).length).toBeGreaterThanOrEqual(8);
  });
});

describe.skipIf(!ready)('EXP-053 criterion 2 (painting half): compiled', () => {
  it('paints nothing of an accepted value outside its box, displayed or inline', async () => {
    const a = await compiled(ACCEPTED, '');
    const b = await compiled(ACCEPTED, INVISIBLE);
    const d = await compiled(ACCEPTED, INVISIBLE, { fill: true });
    // The equations paint something (so the check is not vacuous), and none of it is outside.
    expect(added(a, b)).toBeGreaterThan(500);
    const s = spill(a, b, d);
    expect(s.count, s.first.join(' ')).toBe(0);
  }, 1_800_000);

  it('negative control: a bar outside the box is hidden by the class and shows without the clip', async () => {
    const bar = tx`x\rlap{\vrule width 60pt height 8pt depth 0pt}`;
    const swap = (main: string): string => main.split(PLACEHOLDER).join(bar);
    const values = [PLACEHOLDER, PLACEHOLDER];
    const a = await compiled(values, '', { swap });
    const u = await compiled(values, UNCLIPPED, { swap });
    const b = await compiled(values, INVISIBLE, { swap });
    const d = await compiled(values, INVISIBLE, { swap, fill: true });
    expect(spill(a, b, d).count, 'clipped').toBe(0);
    expect(spill(u, b, d).count, 'unclipped').toBeGreaterThan(100);
  }, 1_800_000);
});
