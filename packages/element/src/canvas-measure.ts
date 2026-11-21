/**
 * The element's canvas text measurer: canvas `measureText` (FE-079, criterion 1). Spike S5 makes the
 * font files the default measurement (`chooseMeasurementProvider`, ./kernel-fallback.ts), so this is the
 * fallback for Chromium, Edge and WebKit when the kernel cannot start. It satisfies the
 * layout engine's injected `TextMeasurer` by shape (`id`, `advance`, `lineMetrics`), so the
 * universal layout package does not import it and needs no new dependency here. It runs only where
 * a canvas exists: a page's main thread, or a worker with `OffscreenCanvas`.
 *
 * Every length the caller sees is in points. Canvas works in CSS pixels at 96 per inch, so one point
 * is 4/3 pixel. A family is a font alias (FE-061), never a CSS list of families; the generic `serif`
 * is appended only as the browser's own fallback for an alias that is not loaded.
 */

/** The face and size a run is measured in (the same shape as the layout engine's `FontKey`). */
export interface CanvasFontKey {
  readonly family: string;
  readonly sizePt: number;
  readonly bold: boolean;
  readonly italic: boolean;
}

export interface CanvasLineMetrics {
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
}

export interface CanvasTextMeasurer {
  readonly id: string;
  advance(font: CanvasFontKey, text: string): number;
  lineMetrics(font: CanvasFontKey): CanvasLineMetrics;
}

const PX_PER_PT = 4 / 3;

interface Metrics {
  readonly width: number;
  readonly fontBoundingBoxAscent?: number;
  readonly fontBoundingBoxDescent?: number;
}

interface Context2D {
  font: string;
  measureText(text: string): Metrics;
}

/** An `OffscreenCanvas` context where one exists, else a context of a detached DOM canvas. */
function newContext(): Context2D | null {
  const g = globalThis as unknown as {
    OffscreenCanvas?: new (w: number, h: number) => { getContext(kind: '2d'): Context2D | null };
    document?: { createElement(tag: 'canvas'): { getContext(kind: '2d'): Context2D | null } };
  };
  if (typeof g.OffscreenCanvas === 'function') {
    const ctx = new g.OffscreenCanvas(1, 1).getContext('2d');
    if (ctx) return ctx;
  }
  return g.document?.createElement('canvas').getContext('2d') ?? null;
}

/** Whether this place has a canvas to measure with. */
export function canvasMeasurerAvailable(): boolean {
  return newContext() !== null;
}

/**
 * A canvas-backed measurer. Throws when no canvas exists, so a caller learns of it at construction
 * rather than at the first measurement. Font bounding boxes that the browser does not report are
 * returned as 0; the layout then has no ascent for that face and the caller must not rely on it.
 */
export function canvasTextMeasurer(): CanvasTextMeasurer {
  const ctx = newContext();
  if (!ctx) throw new Error('canvasTextMeasurer: no canvas is available here');
  const css = (font: CanvasFontKey): string => {
    const family = font.family.replace(/["\\]/g, '');
    const style = `${font.italic ? 'italic ' : ''}${font.bold ? 'bold ' : ''}`;
    return `${style}${font.sizePt * PX_PER_PT}px "${family}", serif`;
  };
  return {
    id: 'canvas/measure-text',
    advance(font, text) {
      ctx.font = css(font);
      return ctx.measureText(text).width / PX_PER_PT;
    },
    lineMetrics(font) {
      ctx.font = css(font);
      const m = ctx.measureText('Hg');
      return {
        ascent: (m.fontBoundingBoxAscent ?? 0) / PX_PER_PT,
        descent: (m.fontBoundingBoxDescent ?? 0) / PX_PER_PT,
        lineGap: 0,
      };
    },
  };
}
