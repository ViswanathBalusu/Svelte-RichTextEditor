/**
 * Spike S7 (SPK-020): the same candidates driven by a browser measurer. In Chromium, Firefox and
 * WebKit (Playwright, through Vitest's browser mode), a `TextMeasurer` backed by canvas
 * `measureText` is injected; in Node.js, which has no canvas, the tests are skipped.
 *
 * Two font set-ups: every run in one font file loaded with `FontFace` (KaTeX Main, MIT, from the
 * workspace's installed `katex` package), so that the browsers measure the same file; and the
 * document's own families, which these browsers do not have, so that each falls back to a system
 * face. The results are logged, not asserted; S5 (SPK-018) owns the measurement comparison.
 */
import { loadDocument } from '@docedit/corpus';
import { describe, expect, it } from 'vitest';
import {
  checkCoverage,
  layoutWithDocen,
  summarise,
  toFlow,
  treeDigest,
  type CdmEnvelopeLike,
  type FontKey,
  type TextMeasurer,
} from './index.ts';
import { layoutWithEigenpal } from './eigenpal.ts';

interface Metrics {
  width: number;
  fontBoundingBoxAscent?: number;
  fontBoundingBoxDescent?: number;
}
interface Context2D {
  font: string;
  measureText(text: string): Metrics;
}
interface CanvasLike {
  getContext(kind: '2d'): Context2D | null;
}
interface Browser {
  OffscreenCanvas?: new (w: number, h: number) => CanvasLike;
  FontFace?: new (family: string, source: string) => { load(): Promise<unknown> };
  document?: {
    fonts: { add(face: unknown): void; ready: Promise<unknown> };
    createElement(tag: 'canvas'): CanvasLike;
  };
  navigator?: { userAgent: string };
}

const g = globalThis as unknown as Browser;
// Taken before the Docen adapter installs its forwarding `OffscreenCanvas` on first use. WebKit's
// Playwright build for Windows has no OffscreenCanvas, so a DOM canvas stands in there.
const RealCanvas = g.OffscreenCanvas;
const newCanvas = (): CanvasLike | null =>
  RealCanvas ? new RealCanvas(1, 1) : (g.document?.createElement('canvas') ?? null);
const inBrowser = g.document !== undefined;
const PINNED = 'S7 KaTeX Main';
const FONT_URL =
  '/node_modules/.pnpm/katex@0.19.1/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2';

/** A measurer on canvas `measureText`; `alias` replaces every family when set. */
function canvasMeasurer(alias: string | null): TextMeasurer {
  const ctx = newCanvas()?.getContext('2d') ?? null;
  if (!ctx) throw new Error('no canvas');
  const css = (font: FontKey): string =>
    `${font.italic ? 'italic ' : ''}${font.bold ? 'bold ' : ''}${(font.sizePt * 4) / 3}px "${alias ?? font.family}", serif`;
  return {
    id: `canvas/${alias ?? 'document-families'}`,
    advance(font, text) {
      ctx.font = css(font);
      return (ctx.measureText(text).width * 3) / 4;
    },
    lineMetrics(font) {
      ctx.font = css(font);
      const m = ctx.measureText('Hg');
      const ascent = ((m.fontBoundingBoxAscent ?? font.sizePt * 1.07) * 3) / 4;
      const descent = ((m.fontBoundingBoxDescent ?? font.sizePt * 0.27) * 3) / 4;
      return { ascent, descent, lineGap: 0 };
    },
  };
}

async function loadPinnedFont(): Promise<boolean> {
  if (!g.FontFace || !g.document) return false;
  try {
    const face = new g.FontFace(PINNED, `url(${FONT_URL})`);
    await face.load();
    g.document.fonts.add(face);
    await g.document.fonts.ready;
    return true;
  } catch {
    return false;
  }
}

describe.runIf(inBrowser)('a browser measurer injected into both candidates', () => {
  const ua = g.navigator?.userAgent ?? 'unknown';

  it.each(['pages-1', 'pages-20'])(
    'lays out %s with canvas measurement',
    { timeout: 120_000 },
    async (name) => {
      const pinned = await loadPinnedFont();
      const flow = toFlow((await loadDocument(name)).envelope as unknown as CdmEnvelopeLike);
      const runs: [string, () => Promise<ReturnType<typeof layoutWithDocen>>][] = [
        [
          'docen+injected-pinned',
          () => Promise.resolve(layoutWithDocen(flow, { measurer: canvasMeasurer(PINNED) })),
        ],
        [
          'eigenpal+injected-pinned',
          async () => (await layoutWithEigenpal(flow, canvasMeasurer(PINNED))).tree,
        ],
        [
          'docen+injected-document-families',
          () => Promise.resolve(layoutWithDocen(flow, { measurer: canvasMeasurer(null) })),
        ],
        [
          'eigenpal+injected-document-families',
          async () => (await layoutWithEigenpal(flow, canvasMeasurer(null))).tree,
        ],
        [
          'docen+own-canvas',
          () =>
            Promise.resolve(
              layoutWithDocen(flow, {
                measurer: null,
                canvas: () => newCanvas()!.getContext('2d')!,
              }),
            ),
        ],
      ];
      for (const [label, run] of runs) {
        const started = performance.now();
        const tree = await run();
        const ms = performance.now() - started;
        expect(checkCoverage(flow, tree)).toEqual([]);
        const s = summarise(tree);
        console.info(
          `[S7-CANVAS] ${ua} ${name} ${label} pinnedFont=${pinned}: ${JSON.stringify({ pages: s.pages, lines: s.bodyLines, digest: treeDigest(tree), ms: Math.round(ms) })}`,
        );
      }
    },
  );
});

describe.skipIf(inBrowser)('without a browser', () => {
  it('has no canvas to measure with', () => {
    expect(newCanvas()).toBeNull();
  });
});
