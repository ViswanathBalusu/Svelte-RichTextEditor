// FE-064 criterion 1 on a real page (lane U-FE-049-064, round 7): a real FontFace on the page's font
// set is registered but not loaded. `FontAwareLayout.ready` waits for it (the arrivals source starts
// the load), so a pass that follows measures the loaded face: its width differs from the fallback
// width the old cache kept, and the pass sees no further arrival. Runs in the browser projects
// (`*.universal.test.ts`); skipped where there is no FontFace.
import { afterEach, describe, expect, it } from 'vitest';
import { faceArrivals, type LoadableFaceLike } from './font-arrivals.ts';
import { FontAwareLayout } from './font-pass.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import type { FontKey, TextMeasurer } from './measure.ts';

type PageFace = LoadableFaceLike & { readonly status: string };
type PageFontSet = Iterable<PageFace> & {
  add(face: unknown): unknown;
  delete(face: unknown): unknown;
};
interface Context2D {
  font: string;
  measureText(text: string): { width: number };
}
type Global = {
  document?: {
    fonts: PageFontSet;
    createElement(tag: 'canvas'): { getContext(kind: '2d'): Context2D | null };
  };
  FontFace?: new (
    family: string,
    source: string,
    descriptors?: { style?: string; weight?: string },
  ) => PageFace;
};
const g = globalThis as unknown as Global;
const isBrowser = typeof g.document !== 'undefined' && typeof g.FontFace === 'function';

// The test server serves the repository, so the font file resolves next to this module.
const sansUrl = new URL('../../perf/fonts/files/NotoSans-Regular.ttf', import.meta.url).href;
const SAMPLE = 'Hamburgefonstiv quick brown fox';
const PX_PER_PT = 4 / 3;

/** A canvas measurer whose widths are the page's font for the alias, as the element's measurer. */
function canvasMeasurer(): TextMeasurer {
  const ctx = g.document!.createElement('canvas').getContext('2d')!;
  const css = (f: FontKey) => `${f.sizePt * PX_PER_PT}px "${f.family}", serif`;
  return {
    id: 'test-canvas',
    advance(f: FontKey, text: string) {
      ctx.font = css(f);
      return ctx.measureText(text).width / PX_PER_PT;
    },
    lineMetrics: (f: FontKey) => ({ ascent: f.sizePt * 0.8, descent: f.sizePt * 0.2, lineGap: 0 }),
  };
}

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

function envelope(alias: string): CdmEnvelopeLike {
  const paragraph = (id: string, text: string): CdmNode => ({
    type: 'paragraph',
    attrs: { id, style: 'Normal' },
    content: [{ type: 'text', text }],
  });
  return {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'settings',
              attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
            },
            {
              type: 'style_def',
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontFamily: alias,
                fontSize: 220,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 11906,
                height: 16838,
                marginTop: 1440,
                marginRight: 1440,
                marginBottom: 1440,
                marginLeft: 1440,
              },
            },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [paragraph('p1', SAMPLE), paragraph('p2', `${SAMPLE} again`)],
        },
      ],
    },
  };
}

const providers = { breaks: afterSpace, lineBreaker: firstFitBreaker };

describe.skipIf(!isBrowser)('a layout pass waits for an unloaded face (FE-064 criterion 1)', () => {
  const added: PageFace[] = [];
  const pageFaces = () => g.document!.fonts;
  afterEach(() => {
    for (const face of added.splice(0)) g.document!.fonts.delete(face);
  });

  it('waits for the face before measuring, then measures the loaded width and sees no arrival', async () => {
    const alias = `de-font-${'9'.repeat(64)}`;
    const face = new g.FontFace!(alias, `url("${sansUrl}")`, { style: 'normal', weight: '400' });
    g.document!.fonts.add(face);
    added.push(face);
    expect(face.status).toBe('unloaded');

    const key: FontKey = { family: alias, sizePt: 11, bold: false, italic: false };
    const layout = new FontAwareLayout({
      measurer: canvasMeasurer(),
      arrivals: faceArrivals(pageFaces, { load: true }),
    });
    // The fallback width, taken before the wait: the cache of epoch 0 keeps it.
    const fallbackWidth = layout.measurer().advance(key, SAMPLE);

    await expect(layout.ready([alias])).resolves.toBe(true);
    expect(face.status).toBe('loaded');
    expect(layout.epoch.value).toBe(1);

    // The measurer handed out now is the epoch-1 cache: its width is the loaded face's.
    const loadedWidth = layout.measurer().advance(key, SAMPLE);
    expect(loadedWidth).not.toBeCloseTo(fallbackWidth, 3);

    const pass = layout.layout(toFlow(envelope(alias)), providers);
    expect(pass.epoch).toBe(1);
    expect(pass.result.tree.pages.length).toBeGreaterThan(0);
    await expect(pass.fonts).resolves.toBe(false);
    expect(layout.epoch.value).toBe(1);
  });
});
