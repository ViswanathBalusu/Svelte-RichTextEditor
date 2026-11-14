// FE-064 criterion 1 on a real page (fixer U-SYN-037-053, round 7): a real FontFace on the page's
// font set is registered but not loaded, and the document's Normal style names its alias. The pass
// entry point `FontAwareLayout.layoutWhenReady` reads the alias from the flow document, waits for
// the face (the arrivals source starts the load), and only then measures: every measurement it takes
// sees the face loaded, its line width equals the width a pass takes once the face is loaded, it
// differs from the fallback width, and the pass sees no arrival afterwards. Runs in the browser
// projects (`*.universal.test.ts`); skipped where there is no FontFace.
import { afterEach, describe, expect, it } from 'vitest';
import { layoutFlow } from './engine.ts';
import { faceArrivals, type LoadableFaceLike } from './font-arrivals.ts';
import { FontAwareLayout, flowFontAliases } from './font-pass.ts';
import { toFlow, type CdmEnvelopeLike, type FlowDocument } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import type { FontKey, TextMeasurer } from './measure.ts';
import type { LayoutTree } from './tree.ts';

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

/** A canvas measurer, as the element's; `onMeasure` sees each measurement as it is taken. */
function canvasMeasurer(onMeasure: (font: FontKey) => void = () => {}): TextMeasurer {
  const ctx = g.document!.createElement('canvas').getContext('2d')!;
  const css = (f: FontKey) => `${f.sizePt * PX_PER_PT}px "${f.family}", serif`;
  return {
    id: 'test-canvas',
    advance(f: FontKey, text: string) {
      onMeasure(f);
      ctx.font = css(f);
      return ctx.measureText(text).width / PX_PER_PT;
    },
    lineMetrics: (f: FontKey) => {
      onMeasure(f);
      return { ascent: f.sizePt * 0.8, descent: f.sizePt * 0.2, lineGap: 0 };
    },
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
const providers = { breaks: afterSpace, lineBreaker: firstFitBreaker };

/** One short paragraph in the Normal style, whose font is `alias`. */
function flowIn(alias: string): FlowDocument {
  const envelope: CdmEnvelopeLike = {
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
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'p1', style: 'Normal' },
              content: [{ type: 'text', text: SAMPLE }],
            },
          ],
        },
      ],
    },
  };
  return toFlow(envelope);
}

/** The width of the first line of paragraph p1. */
function firstLineWidth(tree: LayoutTree): number {
  for (const page of tree.pages)
    for (const fragment of page.fragments)
      if (fragment.kind === 'paragraph' && fragment.blockId === 'p1') {
        const line = fragment.lines[0];
        if (line) return line.width;
      }
  throw new Error('no line for p1');
}

describe.skipIf(!isBrowser)(
  'layoutWhenReady waits for an unloaded face (FE-064 criterion 1)',
  () => {
    const added: PageFace[] = [];
    afterEach(() => {
      for (const face of added.splice(0)) g.document!.fonts.delete(face);
    });

    it('reads the alias from the document, waits for the face, then measures the loaded width', async () => {
      const alias = `de-font-${'4'.repeat(64)}`;
      const doc = flowIn(alias);
      expect(flowFontAliases(doc)).toEqual([alias]);

      // The fallback width: the same text in an alias the page holds no face for.
      const fallbackWidth = firstLineWidth(
        layoutFlow(flowIn(`de-font-${'3'.repeat(64)}`), {
          ...providers,
          measurer: canvasMeasurer(),
        }).tree,
      );

      const face = new g.FontFace!(alias, `url("${sansUrl}")`, { style: 'normal', weight: '400' });
      g.document!.fonts.add(face);
      added.push(face);
      expect(face.status).toBe('unloaded');

      const statuses: string[] = [];
      const layout = new FontAwareLayout({
        measurer: canvasMeasurer((font) => {
          if (font.family === alias) statuses.push(face.status);
        }),
        arrivals: faceArrivals(() => g.document!.fonts, { load: true }),
      });
      const pass = await layout.layoutWhenReady(doc, providers);

      // The pass measured only after the face had loaded, under the epoch the wait advanced to.
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.every((status) => status === 'loaded')).toBe(true);
      expect(face.status).toBe('loaded');
      expect(pass.epoch).toBe(1);
      expect(pass.aliases.has(alias)).toBe(true);

      // The width the pass measured is the loaded face's: a fresh pass now gives the same width.
      const passWidth = firstLineWidth(pass.result.tree);
      const loadedWidth = firstLineWidth(
        layoutFlow(doc, { ...providers, measurer: canvasMeasurer() }).tree,
      );
      expect(passWidth).toBe(loadedWidth);
      expect(passWidth).not.toBeCloseTo(fallbackWidth, 3);

      // No arrival after the pass: the epoch stays where the wait left it.
      await expect(pass.fonts).resolves.toBe(false);
      expect(layout.epoch.value).toBe(1);
    });
  },
);
