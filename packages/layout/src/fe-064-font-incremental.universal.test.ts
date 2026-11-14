// FE-064 criterion 3 on a real page: a real FontFace on the page's font set (the NotoSans file) is
// registered but not loaded, and one paragraph of two uses its alias. The first pass of
// `IncrementalFontLayout` measures that paragraph with the fallback face. The face is then loaded
// outside the pass; the epoch advances, and the next pass re-measures only that paragraph, with the
// loaded face's width, while the other paragraph is not measured and keeps its lines. Runs in the
// browser projects (`*.universal.test.ts`); skipped where there is no FontFace.
import { afterEach, describe, expect, it } from 'vitest';
import { layoutFlow, type LayoutResult } from './engine.ts';
import { faceArrivals, type LoadableFaceLike } from './font-arrivals.ts';
import { IncrementalFontLayout } from './font-incremental.ts';
import { toFlow, type CdmEnvelopeLike, type FlowDocument } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import type { FontKey, TextMeasurer } from './measure.ts';
import type { ParagraphFragment } from './tree.ts';

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
const ARRIVING = `de-font-${'7'.repeat(64)}`;
const OTHER = `de-font-${'8'.repeat(64)}`;

/** A canvas measurer, as the element's; `calls` counts its measurements per family. */
function canvasMeasurer(calls = new Map<string, number>()): TextMeasurer {
  const ctx = g.document!.createElement('canvas').getContext('2d')!;
  const css = (f: FontKey) => `${f.sizePt * PX_PER_PT}px "${f.family}", serif`;
  const count = (f: FontKey) => calls.set(f.family, (calls.get(f.family) ?? 0) + 1);
  return {
    id: 'test-canvas',
    advance(f: FontKey, text: string) {
      count(f);
      ctx.font = css(f);
      return ctx.measureText(text).width / PX_PER_PT;
    },
    lineMetrics: (f: FontKey) => {
      count(f);
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

/** Two paragraphs: p-arrive in the arriving alias, p-other in an alias the page holds no face for. */
function twoFonts(): FlowDocument {
  const inFamily = (id: string, family: string) => ({
    type: 'paragraph',
    attrs: { id, style: 'Normal' },
    content: [
      { type: 'text', text: SAMPLE, marks: [{ type: 'fontFamily', attrs: { value: family } }] },
    ],
  });
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
                fontFamily: OTHER,
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
          content: [inFamily('p-arrive', ARRIVING), inFamily('p-other', OTHER)],
        },
      ],
    },
  };
  return toFlow(envelope);
}

function paragraph(result: LayoutResult, id: string): ParagraphFragment {
  for (const page of result.tree.pages)
    for (const fragment of page.fragments)
      if (fragment.kind === 'paragraph' && fragment.blockId === id) return fragment;
  throw new Error(`no fragment for ${id}`);
}

const firstLineWidth = (f: ParagraphFragment): number => f.lines[0]?.width ?? Number.NaN;

describe.skipIf(!isBrowser)(
  'IncrementalFontLayout re-measures only the block whose real face arrived (FE-064 criterion 3)',
  () => {
    const added: PageFace[] = [];
    afterEach(() => {
      for (const face of added.splice(0)) g.document!.fonts.delete(face);
    });

    it('takes the loaded width for the block that uses the face and leaves the other block', async () => {
      const face = new g.FontFace!(ARRIVING, `url("${sansUrl}")`, {
        style: 'normal',
        weight: '400',
      });
      g.document!.fonts.add(face);
      added.push(face);
      expect(face.status).toBe('unloaded');

      const calls = new Map<string, number>();
      const layout = new IncrementalFontLayout({
        measurer: canvasMeasurer(calls),
        arrivals: faceArrivals(() => g.document!.fonts),
        breaks: afterSpace,
        lineBreaker: firstFitBreaker,
      });
      const doc = twoFonts();

      const first = layout.layout(doc);
      expect([...first.stats.measured].sort()).toEqual(['p-arrive', 'p-other']);
      const fallbackArrive = firstLineWidth(paragraph(first.result, 'p-arrive'));
      const otherBefore = paragraph(first.result, 'p-other');

      // The face loads outside the pass and outside `track`.
      await face.load();
      await expect(first.fonts).resolves.toBe(true);
      expect(layout.epoch.value).toBe(1);

      calls.clear();
      const second = layout.layout(doc);
      expect([...second.arrived]).toEqual([ARRIVING]);
      expect([...second.dirty]).toEqual(['p-arrive']);
      expect(second.stats.measured).toEqual(['p-arrive']);
      expect(second.stats.reused).toBe(1);
      expect(calls.get(OTHER) ?? 0).toBe(0);
      expect(calls.get(ARRIVING) ?? 0).toBeGreaterThan(0);

      // The re-measured block has the loaded face's width; the other block keeps its lines.
      const loaded = layoutFlow(doc, {
        measurer: canvasMeasurer(),
        breaks: afterSpace,
        lineBreaker: firstFitBreaker,
      });
      const arriveAfter = firstLineWidth(paragraph(second.result, 'p-arrive'));
      expect(arriveAfter).toBe(firstLineWidth(paragraph(loaded, 'p-arrive')));
      expect(arriveAfter).not.toBeCloseTo(fallbackArrive, 3);
      expect(paragraph(second.result, 'p-other')).toEqual(otherBefore);

      await expect(second.fonts).resolves.toBe(false);
    });
  },
);
