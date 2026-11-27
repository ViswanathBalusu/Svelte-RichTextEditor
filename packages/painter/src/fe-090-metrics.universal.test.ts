/**
 * FE-090, criterion 4: the painter's CSS uses the ligature and kerning settings that the measurer
 * measured with. The measurer is the element's default provider, `canvasTextMeasurer`
 * (packages/element/src/canvas-measure.ts), which sets canvas `fontKerning` to `normal` and leaves the
 * ligatures at their default; the painter's CSS is `font-kerning: normal` (owner decision 249). The
 * test runs that real measurer and compares its advances with the painted text, for ligature-rich and
 * kerning-heavy samples, in each browser (Chromium, Firefox and WebKit; `pnpm vitest run --project
 * browser packages/painter/src/fe-090-metrics.universal.test.ts`). In Node.js there is no DOM and the
 * suite is skipped.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { canvasTextMeasurer } from '../../element/src/canvas-measure.ts';
import type { LayoutTree, ParagraphFragment } from '../../layout/src/tree.ts';
import { PAINT_TEXT_PINS, paintTree, type PaintSource } from './painter.ts';

const SIZE_PT = 12;
const PX_PER_PT = 96 / 72;
const FAMILY = 'serif';
// The painted family is written as the measurer writes it (canvas-measure.ts): a quoted name, then
// the generic. On Linux a quoted `serif` is a font name that fontconfig resolves, and the bare
// generic is the browser's own serif, which can be another face (hosted CI: 94 px against 116 px).
const PAINT_FAMILY = `"${FAMILY}", serif`;

/** Ligature-rich (ffi, fi, fl, ffl) and kerning-heavy (AV, To, Wa, Ty, Yo) samples. */
const SAMPLES = [
  'office efficient',
  'final fi fl ffi ffl',
  'AVATAR Wave Yes',
  'AV To Wa Ty Yo',
  'Hello, world. 0123456789',
];
const hasDom = typeof document !== 'undefined';

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

  it('pins the painted font-kerning to normal, as the measurer does, and the ligatures', () => {
    expect(PAINT_TEXT_PINS.fontKerning).toBe('normal');
    const { tree: t, texts } = tree();
    const el = document.createElement('div');
    el.style.width = '600px';
    document.body.appendChild(el);
    host = el;
    const source: PaintSource = {
      lineText: (block, from, to) => texts[block]!.slice(from, to),
      fontFamily: PAINT_FAMILY,
      fontSizePt: SIZE_PT,
    };
    const { pages } = paintTree(el, t, source);
    const span = pages[0]!.querySelector<HTMLElement>('.de-text')!;
    const style = getComputedStyle(span);
    expect(style.fontKerning).toBe(PAINT_TEXT_PINS.fontKerning);
    expect(style.fontVariantLigatures).toBe(PAINT_TEXT_PINS.fontVariantLigatures);
    expect(style.textRendering.toLowerCase()).toBe(PAINT_TEXT_PINS.textRendering.toLowerCase());
  });

  it('paints each sample as wide as the real canvas measurer measures it', () => {
    const { tree: t, texts } = tree();
    const el = document.createElement('div');
    el.style.width = '600px';
    document.body.appendChild(el);
    host = el;
    const source: PaintSource = {
      lineText: (block, from, to) => texts[block]!.slice(from, to),
      fontFamily: PAINT_FAMILY,
      fontSizePt: SIZE_PT,
    };
    const { pages } = paintTree(el, t, source);
    const measurer = canvasTextMeasurer();
    const font = { family: FAMILY, sizePt: SIZE_PT, bold: false, italic: false };
    const spans = [...pages[0]!.querySelectorAll<HTMLElement>('.de-text')];
    expect(spans.length).toBe(SAMPLES.length);
    spans.forEach((span, i) => {
      const text = SAMPLES[i]!;
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
});
