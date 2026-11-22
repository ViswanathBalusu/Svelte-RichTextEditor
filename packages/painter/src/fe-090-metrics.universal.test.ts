/**
 * FE-090, criterion 4: the painter's CSS uses the ligature and kerning settings that the measurer
 * measured with. The measurer is the element's default provider, `canvasTextMeasurer`
 * (packages/element/src/canvas-measure.ts), which measures with canvas `measureText` at the
 * default `fontKerning` (`auto`) and the default ligatures. The test runs that real measurer and
 * compares its advances with the painted text, for ligature-rich and kerning-heavy samples, in
 * each browser (Chromium, Firefox and WebKit; `pnpm vitest run --project browser
 * packages/painter/src/fe-090-metrics.universal.test.ts`). In Chromium the kerning-heavy samples
 * are left out: no CSS value paints canvas `auto` kerning there (FE-090 Notes). In Node.js there
 * is no DOM and the suite is skipped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canvasTextMeasurer } from '../../element/src/canvas-measure.ts';
import type { LayoutTree, ParagraphFragment } from '../../layout/src/tree.ts';
import { PAINT_TEXT_PINS, paintTree, type PaintSource } from './painter.ts';

const SIZE_PT = 12;
const PX_PER_PT = 96 / 72;
const FAMILY = 'serif';

/** Ligature-rich (ffi, fi, fl, ffl) and kerning-heavy (AV, To, Wa, Ty, Yo) samples. */
const SAMPLES = [
  'office efficient',
  'final fi fl ffi ffl',
  'AVATAR Wave Yes',
  'AV To Wa Ty Yo',
  'Hello, world. 0123456789',
];
/** The samples whose width depends on pair kerning. */
const KERNED = new Set(['AVATAR Wave Yes', 'AV To Wa Ty Yo']);

const hasDom = typeof document !== 'undefined';
/** Chromium (and Edge): canvas `auto` kerning matches no CSS `font-kerning` value there. */
const chromium = hasDom && /Chrome\//.test(navigator.userAgent);

function tree(): { tree: LayoutTree; texts: Record<string, string> } {
  const texts: Record<string, string> = {};
  const fragments: ParagraphFragment[] = SAMPLES.map((text, i) => {
    const blockId = `b${i}`;
    texts[blockId] = text;
    return {
      kind: 'paragraph',
      blockId,
      from: 0,
      to: text.length,
      x: 0,
      y: i * 20,
      width: 400,
      height: 14,
      lines: [{ from: 0, to: text.length, x: 0, y: 0, width: 0, height: 14 }],
    };
  });
  return {
    texts,
    tree: {
      engine: 'test',
      measurer: 'canvas',
      pages: [
        {
          index: 0,
          section: 0,
          width: 500,
          height: 200,
          fragments,
          header: [],
          footer: [],
          footnotes: [],
        },
      ],
    },
  };
}

describe.skipIf(!hasDom)('painter metrics match the measurer (FE-090, criterion 4)', () => {
  let host: HTMLElement | null = null;

  afterEach(() => {
    host?.remove();
    host = null;
  });

  it('pins the painted font-kerning and font-variant-ligatures to the canvas defaults', () => {
    // The canvas defaults the measurer leaves in place (it sets only `font`).
    const ctx = document.createElement('canvas').getContext('2d')!;
    expect(ctx.fontKerning).toBe(PAINT_TEXT_PINS.fontKerning);
    const { tree: t, texts } = tree();
    const el = document.createElement('div');
    el.style.width = '600px';
    document.body.appendChild(el);
    host = el;
    const source: PaintSource = {
      lineText: (block, from, to) => texts[block]!.slice(from, to),
      fontFamily: FAMILY,
      fontSizePt: SIZE_PT,
    };
    const { pages } = paintTree(el, t, source);
    const span = pages[0]!.querySelector<HTMLElement>('.de-text')!;
    const style = getComputedStyle(span);
    expect(style.fontKerning).toBe(PAINT_TEXT_PINS.fontKerning);
    expect(style.fontVariantLigatures).toBe(PAINT_TEXT_PINS.fontVariantLigatures);
    expect(style.textRendering).toBe(PAINT_TEXT_PINS.textRendering);
  });

  it('paints each sample as wide as the real canvas measurer measures it', () => {
    const { tree: t, texts } = tree();
    const el = document.createElement('div');
    el.style.width = '600px';
    document.body.appendChild(el);
    host = el;
    const source: PaintSource = {
      lineText: (block, from, to) => texts[block]!.slice(from, to),
      fontFamily: FAMILY,
      fontSizePt: SIZE_PT,
    };
    const { pages } = paintTree(el, t, source);
    const measurer = canvasTextMeasurer();
    const font = { family: FAMILY, sizePt: SIZE_PT, bold: false, italic: false };
    const spans = [...pages[0]!.querySelectorAll<HTMLElement>('.de-text')];
    expect(spans.length).toBe(SAMPLES.length);
    spans.forEach((span, i) => {
      const text = SAMPLES[i]!;
      if (chromium && KERNED.has(text)) return;
      const painted = span.getBoundingClientRect().width;
      // The measurer answers in points; the painted width is in CSS pixels.
      const measured = measurer.advance(font, text) * PX_PER_PT;
      // Half a pixel is the tolerance (FE-090 criterion 4 and the FE-094 target).
      expect(
        Math.abs(painted - measured),
        `"${text}": painted ${painted}px, measured ${measured}px`,
      ).toBeLessThanOrEqual(0.5);
    });
  });

  // The open problem, kept visible: in Chromium the kerned samples paint narrower than canvas
  // `auto` measures them. When this fails, the gap has closed and FE-090's Notes need revisiting.
  it.runIf(chromium)('in Chromium, kerned text still paints off the canvas measure', () => {
    const { tree: t, texts } = tree();
    const el = document.createElement('div');
    el.style.width = '600px';
    document.body.appendChild(el);
    host = el;
    const { pages } = paintTree(el, t, {
      lineText: (block, from, to) => texts[block]!.slice(from, to),
      fontFamily: FAMILY,
      fontSizePt: SIZE_PT,
    });
    const measurer = canvasTextMeasurer();
    const font = { family: FAMILY, sizePt: SIZE_PT, bold: false, italic: false };
    const spans = [...pages[0]!.querySelectorAll<HTMLElement>('.de-text')];
    const gaps = SAMPLES.map((text, i) => ({
      text,
      gap: Math.abs(
        spans[i]!.getBoundingClientRect().width - measurer.advance(font, text) * PX_PER_PT,
      ),
    })).filter((g) => KERNED.has(g.text));
    expect(
      gaps.some((g) => g.gap > 0.5),
      JSON.stringify(gaps),
    ).toBe(true);
  });
});
