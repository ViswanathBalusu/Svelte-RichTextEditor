/**
 * WASM-006: the kernel's shaping and measurement against HarfBuzz and behind the engine's
 * measurement interface. Node.js only; it reads the kernel's build (`pnpm --filter
 * @docedit/layout-kernel build:wasm`) and the harness's font files.
 *
 * 1. HarfBuzz's own WebAssembly build (harfbuzzjs 1.6.1) is the reference. For runs of text in the
 *    manifest's Noto Serif, the kernel's advance of every UTF-16 code unit equals what HarfBuzz's
 *    glyphs give, spread over their clusters, scaled to the size and rounded by the documented rule.
 * 2. The layout engine runs unchanged with each provider, through one `layoutFlow` call: the
 *    deterministic stub, the S10 harfbuzzjs provider, and the kernel's provider.
 */
import { loadDocument } from '@docedit/corpus';
import {
  firstFitBreaker,
  fixedWidthMeasurer,
  layoutFlow,
  toFlow,
  type BreakOpportunities,
  type CdmEnvelopeLike,
  type FontKey,
  type LayoutTree,
  type TextMeasurer,
} from '@docedit/layout';
import {
  KERNEL_FILES,
  createKernel,
  type KernelGlue,
  type LayoutKernel,
} from '../../layout-kernel/src/index.ts';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { kernelTextMeasurer } from '../../element/src/kernel-measure.ts';
import { fontManifest, resolveFace } from '../src/fonts.ts';
import { tsKernel } from '../src/kernel/ts-kernel.ts';
import { loadHarfbuzz } from '../src/shapers/harfbuzz.ts';
import { NO_KERN, NO_LIGA, type Shaper } from '../src/shapers/types.ts';
import { differences } from '../src/s5.ts';

const pkg = resolve(import.meta.dirname, '..');
const dist = resolve(pkg, '../layout-kernel/dist');
const built = existsSync(resolve(dist, KERNEL_FILES.wasm));

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** The editor's alias of a font file (FE-061): `de-font-<hash>`. */
const aliasOf = (file: string): string =>
  `de-font-${fontManifest.fonts.find((f) => f.file === file)!.sha256}`;
/** The manifest's path of a font by its file name. */
const fileOf = (name: string): string =>
  fontManifest.fonts.find((f) => f.file.endsWith(`/${name}`))!.file;

let kernel: LayoutKernel;
let hb: Shaper;

beforeAll(async () => {
  if (!built) return;
  const glue = (await import(
    `${pathToFileURL(resolve(dist, KERNEL_FILES.module)).href}?run=${Math.random()}`
  )) as KernelGlue;
  kernel = createKernel(glue, new Uint8Array(readFileSync(resolve(dist, KERNEL_FILES.wasm))));
  hb = (await loadHarfbuzz()).shaper;
  for (const f of fontManifest.fonts) {
    const bytes = new Uint8Array(readFileSync(join(pkg, 'fonts', f.file)));
    // The manifest's hash is what the kernel checks the file against.
    expect(sha256(bytes)).toBe(f.sha256);
    kernel.faces.load('', aliasOf(f.file), f.sha256, bytes);
    hb.loadFont(f.file, bytes);
  }
});

/** round half up of value * size * 64 / upem, in integers (the kernel's rule). */
function scaled(value: number, sizeTwips: number, upem: number): number {
  return Math.floor((2 * value * sizeTwips * 64 + upem) / (2 * upem));
}

/** What HarfBuzz gives, put on code units the way the kernel puts them. */
function reference(file: string, text: string, flags: number, sizeTwips: number): number[] {
  const units = new Array<number>(text.length).fill(0);
  for (const g of hb.shape(file, text, flags))
    units[Math.min(g.cluster, text.length - 1)]! += g.advance;
  const upem = hb.upem(file);
  return units.map((v) => scaled(v, sizeTwips, upem));
}

const TEXTS = [
  'The quick brown fox jumps over the lazy dog.',
  'AVATAR Typography To Ty Wa fi fl ffi office',
  'Zażółć gęślą jaźń — Příliš žluťoučký kůň úpěl ďábelské ódy',
  'Съешь ещё этих мягких французских булок, да выпей чаю',
  'Γρήγορη καφέ αλεπού πηδάει πάνω από το τεμπέλικο σκυλί',
  'é ä ô — combining marks, “quotes”, ‘single’ and … dots',
  '0123456789 +-×÷=  (spaces)  and\ttabs',
];

describe.skipIf(!built)('the kernel against HarfBuzz (WASM-006)', () => {
  it('gives HarfBuzz’s advance for every code unit of every run, at several sizes', () => {
    const file = fileOf('NotoSerif-Regular.ttf');
    for (const size of [120, 200, 240, 330, 800])
      for (const text of TEXTS) {
        const style = { alias: aliasOf(file), sizeTwips: size, language: '', features: '' };
        expect(Array.from(kernel.shaper.advances(style, text)), `${size} twips: ${text}`).toEqual(
          reference(file, text, 0, size),
        );
      }
  });

  it('follows HarfBuzz with kerning off and with ligatures off', () => {
    const file = fileOf('NotoSerif-Regular.ttf');
    for (const [features, flags] of [
      ['kern=0', NO_KERN],
      ['liga=0,clig=0', NO_LIGA],
      ['kern=0,liga=0,clig=0', NO_KERN | NO_LIGA],
    ] as const)
      for (const text of TEXTS.slice(0, 3)) {
        const style = { alias: aliasOf(file), sizeTwips: 240, language: '', features };
        expect(Array.from(kernel.shaper.advances(style, text)), `${features}: ${text}`).toEqual(
          reference(file, text, flags, 240),
        );
      }
  });

  it('follows HarfBuzz in the bold, italic and sans faces too', () => {
    for (const file of [
      fileOf('NotoSerif-Bold.ttf'),
      fileOf('NotoSerif-Italic.ttf'),
      fileOf('NotoSans-Regular.ttf'),
    ]) {
      const style = { alias: aliasOf(file), sizeTwips: 240, language: '', features: '' };
      for (const text of TEXTS.slice(0, 3))
        expect(Array.from(kernel.shaper.advances(style, text)), `${file}: ${text}`).toEqual(
          reference(file, text, 0, 240),
        );
    }
  });
});

describe.skipIf(!built)(
  'the engine runs unchanged with the kernel as its measurer (WASM-006)',
  () => {
    const afterSpace: BreakOpportunities = {
      opportunities(text) {
        const out: number[] = [];
        for (let i = 0; i + 1 < text.length; i++)
          if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
        return out;
      },
    };
    let envelope: CdmEnvelopeLike;
    let harfbuzz: TextMeasurer;
    let provider: TextMeasurer;
    const missing: string[] = [];

    beforeAll(async () => {
      if (!built) return;
      envelope = (await loadDocument('pages-20')).envelope as unknown as CdmEnvelopeLike;
      const ts = tsKernel(hb);
      for (const f of fontManifest.fonts)
        ts.loadFace(f.file, new Uint8Array(readFileSync(join(pkg, 'fonts', f.file))));
      harfbuzz = ts;
      // The corpus names families; the kernel's provider is given the alias of the face each run uses.
      const inner = kernelTextMeasurer(kernel, { onMissing: (a) => missing.push(a) });
      const alias = (font: FontKey): FontKey => ({
        ...font,
        family: aliasOf(resolveFace(font).file),
      });
      provider = {
        id: inner.id,
        advance: (font, text) => inner.advance(alias(font), text),
        advances: (font, text) => inner.advances(alias(font), text),
        lineMetrics: (font) => inner.lineMetrics(alias(font)),
      };
    });

    /** The one call every provider goes through. */
    const layout = (measurer: TextMeasurer): LayoutTree =>
      layoutFlow(toFlow(envelope), { measurer, breaks: afterSpace, lineBreaker: firstFitBreaker })
        .tree;
    const lineWidths = (tree: LayoutTree): number[] => {
      const out: number[] = [];
      for (const page of tree.pages)
        for (const f of page.fragments)
          if (f.kind === 'paragraph') for (const l of f.lines) out.push(l.width);
      return out;
    };

    it('lays the same document out with the stub, with harfbuzzjs and with the kernel', () => {
      for (const m of [fixedWidthMeasurer(), harfbuzz, provider]) {
        const tree = layout(m);
        expect(tree.measurer).toBe(m.id);
        expect(tree.pages.length).toBeGreaterThan(1);
        expect(lineWidths(tree).length).toBeGreaterThan(100);
      }
      expect(missing).toEqual([]);
    });

    it('measures every run the engine asks for as HarfBuzz does, to within a twentieth of a point', () => {
      const asked = new Map<string, { font: FontKey; text: string }>();
      const recording: TextMeasurer = {
        id: provider.id,
        advance(font, text) {
          asked.set(`${font.family}|${font.sizePt}|${font.bold}|${font.italic}|${text}`, {
            font,
            text,
          });
          return provider.advance(font, text);
        },
        ...(provider.advances ? { advances: provider.advances.bind(provider) } : {}),
        lineMetrics: (font) => provider.lineMetrics(font),
      };
      layout(recording);
      expect(asked.size).toBeGreaterThan(200);
      const a: number[] = [];
      const b: number[] = [];
      for (const { font, text } of asked.values()) {
        a.push(harfbuzz.advance(font, text));
        b.push(provider.advance(font, text));
      }
      expect(differences(a, b).maxAbs).toBeLessThan(0.05);
    });

    it('keeps the line count of the document within a line in a hundred of the harfbuzzjs provider', () => {
      // The kernel rounds each advance to 1/1280 pt, harfbuzzjs does not: a line that fits to within
      // that rounding may break one word earlier or later, so the counts agree closely, not exactly.
      const a = lineWidths(layout(harfbuzz)).length;
      const b = lineWidths(layout(provider)).length;
      expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.ceil(a / 100));
    });

    it('is the font files, not the stub: the widths differ from the stub’s', () => {
      const real = lineWidths(layout(provider));
      const stub = lineWidths(layout(fixedWidthMeasurer()));
      const n = Math.min(real.length, stub.length);
      expect(differences(real.slice(0, n), stub.slice(0, n)).overHalfPx).toBeGreaterThan(0);
    });

    it('answers a face it does not hold with the stub’s half em, and says which face', () => {
      const lonely = kernelTextMeasurer(kernel, { onMissing: (a) => missing.push(a) });
      const font = { family: 'de-font-not-loaded', sizePt: 10, bold: false, italic: false };
      expect(lonely.advance(font, 'abcd')).toBe(20);
      expect(lonely.advances(font, 'abcd')).toEqual([5, 5, 5, 5]);
      expect(lonely.lineMetrics(font).ascent).toBeCloseTo(8);
      expect(missing).toEqual(['de-font-not-loaded']);
      // Asked again: still told once.
      lonely.advance(font, 'x');
      expect(missing).toEqual(['de-font-not-loaded']);
    });

    it('measures in points: a space of Noto Serif at 12 pt is the font’s advance scaled', () => {
      const file = fileOf('NotoSerif-Regular.ttf');
      const font = { family: aliasOf(file), sizePt: 12, bold: false, italic: false };
      const m = kernelTextMeasurer(kernel);
      const upem = hb.upem(file);
      const fontUnits = hb.width(file, ' ');
      expect(m.advance(font, ' ')).toBe(scaled(fontUnits, 240, upem) / 1280);
      expect(m.advances(font, ' ')).toEqual([m.advance(font, ' ')]);
    });
  },
);
