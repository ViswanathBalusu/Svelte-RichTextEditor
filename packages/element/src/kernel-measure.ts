/**
 * The layout engine's text measurer over the kernel (WASM-006; 02 §9.1, §9.3; ADR 0016). It has the
 * shape of the engine's injected `TextMeasurer` (`id`, `advance`, `advances`, `lineMetrics`), as the
 * canvas measurer of ./canvas-measure.ts does, so switching from canvas to the font files changes no
 * layout code. It reads no browser global.
 *
 * The measurer is synchronous, so it runs where the kernel runs: in the layout worker, next to the
 * layout engine when the engine is moved there (02 §15), or in Node.js tests. A page that holds no
 * kernel asks the worker for the advances of whole blocks instead (`ElementKernel.measure`).
 *
 * Every length the engine sees is in points. The kernel's advances are whole numbers of 1/1280 pt,
 * rounded in integer arithmetic, so they are the same in every runtime; the division by 1280 here is
 * the only floating-point step. The engine's `FontKey.family` is the face's alias (FE-061), and the
 * face is the file under that alias: `bold` and `italic` select another alias, never a synthetic.
 *
 * A face the kernel does not hold yet is not an error: the measurer answers with half an em for each
 * code unit (the same stub that tests use), tells `onMissing` once for the alias so the caller can
 * load it, and the font epoch moves when it arrives, so no cache keeps the stub's answers.
 */
import { utf16Units, type LayoutKernel, type RunStyle } from '@docedit/layout-kernel';
import type { CanvasFontKey, CanvasLineMetrics } from './canvas-measure.ts';

/** The measurer's shape: the engine's `TextMeasurer`, with the optional `advances`. */
export interface KernelTextMeasurer {
  readonly id: string;
  advance(font: CanvasFontKey, text: string): number;
  advances(font: CanvasFontKey, text: string): readonly number[];
  lineMetrics(font: CanvasFontKey): CanvasLineMetrics;
}

export interface KernelMeasurerOptions {
  /** The language of the runs (BCP 47), or none. */
  language?: string;
  /** The OpenType features the painter uses, in HarfBuzz syntax (`kern=0`), or none. */
  features?: string;
  /** Called once for each alias the kernel does not hold, when a run asks for it. */
  onMissing?: (alias: string) => void;
}

/** The size of a run in whole twentieths of a point, at least 1. */
export function sizeInTwips(sizePt: number): number {
  return Math.max(1, Math.round(sizePt * 20));
}

/** The half em that stands in for a face that has not arrived, and the metrics of the same stub. */
const MISSING_EM = 0.5;
const MISSING_ASCENT = 0.8;
const MISSING_DESCENT = 0.2;

export function kernelTextMeasurer(
  kernel: LayoutKernel,
  options: KernelMeasurerOptions = {},
): KernelTextMeasurer {
  const language = options.language ?? '';
  const features = options.features ?? '';
  const perPoint = kernel.shaper.unitsPerPoint;
  const asked = new Set<string>();
  const style = (font: CanvasFontKey): RunStyle => ({
    alias: font.family,
    sizeTwips: sizeInTwips(font.sizePt),
    language,
    features,
  });
  /** True when the face is held; tells `onMissing` once when it is not. */
  const held = (alias: string): boolean => {
    if (kernel.faces.has(alias)) return true;
    if (!asked.has(alias)) {
      asked.add(alias);
      options.onMissing?.(alias);
    }
    return false;
  };
  return {
    id: `kernel/harfrust@${kernel.version}`,
    advance(font, text) {
      if (text.length === 0) return 0;
      if (!held(font.family)) return text.length * MISSING_EM * font.sizePt;
      return kernel.shaper.width(style(font), utf16Units(text)) / perPoint;
    },
    advances(font, text) {
      if (text.length === 0) return [];
      if (!held(font.family))
        return Array.from({ length: text.length }, () => MISSING_EM * font.sizePt);
      return Array.from(kernel.shaper.advances(style(font), utf16Units(text)), (v) => v / perPoint);
    },
    lineMetrics(font) {
      if (!held(font.family))
        return {
          ascent: MISSING_ASCENT * font.sizePt,
          descent: MISSING_DESCENT * font.sizePt,
          lineGap: 0,
        };
      const m = kernel.shaper.lineMetrics(font.family, sizeInTwips(font.sizePt));
      return {
        ascent: m.ascent / perPoint,
        descent: m.descent / perPoint,
        lineGap: m.lineGap / perPoint,
      };
    },
  };
}
