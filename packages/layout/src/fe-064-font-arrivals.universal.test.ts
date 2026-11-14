// FE-064 criterion 2 on a real page (lane U-FE-049-064, fixer round 6): a real FontFace on the page's
// font set is registered but not loaded; a layout pass (`FontAwareLayout.layout`, font-pass.ts)
// measures text in its alias with a canvas measurer, so the widths are the fallback's. The face is
// then loaded by another route (`face.load()`, outside the pass and outside `track`). The epoch
// advances once, the cache of the old epoch no longer hits, and the next pass measures the real
// face's width. Runs in the browser projects (`*.universal.test.ts`); skipped where there is no
// FontFace.
import { afterEach, describe, expect, it } from 'vitest';
import { faceArrivals, type LoadableFaceLike } from './font-arrivals.ts';
import { FontEpoch } from './font-epoch.ts';
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

// The test server serves the repository, so the font file resolves next to this module (the
// universal package has no `vite/client` types for a `?url` import).
const sansUrl = new URL('../../perf/fonts/files/NotoSans-Regular.ttf', import.meta.url).href;
const SAMPLE = 'Hamburgefonstiv quick brown fox';
const PX_PER_PT = 4 / 3;

/** A canvas measurer that counts its calls (the element's measurer has the same CSS font form). */
function canvasMeasurer(): TextMeasurer & { calls: number } {
  const ctx = g.document!.createElement('canvas').getContext('2d')!;
  const css = (f: FontKey) => `${f.sizePt * PX_PER_PT}px "${f.family}", serif`;
  const m = {
    id: 'test-canvas',
    calls: 0,
    advance(f: FontKey, text: string) {
      m.calls += 1;
      ctx.font = css(f);
      return ctx.measureText(text).width / PX_PER_PT;
    },
    lineMetrics: (f: FontKey) => ({ ascent: f.sizePt * 0.8, descent: f.sizePt * 0.2, lineGap: 0 }),
  };
  return m;
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

describe.skipIf(!isBrowser)(
  'a font that loads after layout advances the epoch (FE-064 criterion 2)',
  () => {
    const added: PageFace[] = [];
    const register = (alias: string): PageFace => {
      const face = new g.FontFace!(alias, `url("${sansUrl}")`, { style: 'normal', weight: '400' });
      g.document!.fonts.add(face);
      added.push(face);
      return face;
    };
    const pageFaces = () => g.document!.fonts;
    afterEach(() => {
      for (const face of added.splice(0)) g.document!.fonts.delete(face);
    });

    it('advances once when the face is loaded by another route after the pass, and the next pass re-measures', async () => {
      const alias = `de-font-${'e'.repeat(64)}`;
      const face = register(alias);
      expect(face.status).toBe('unloaded');
      const inner = canvasMeasurer();
      const layout = new FontAwareLayout({ measurer: inner, arrivals: faceArrivals(pageFaces) });
      const key: FontKey = { family: alias, sizePt: 11, bold: false, italic: false };

      const first = layout.layout(toFlow(envelope(alias)), providers);
      expect(first.epoch).toBe(0);
      expect([...first.aliases]).toContain(alias);
      expect(first.result.tree.pages.length).toBeGreaterThan(0);
      const oldCache = layout.measurer();
      const fallbackWidth = oldCache.advance(key, SAMPLE);
      const callsBefore = inner.calls;
      expect(oldCache.advance(key, SAMPLE)).toBe(fallbackWidth);
      expect(inner.calls).toBe(callsBefore); // a hit under epoch 0

      // Another route loads the face: not the pass, not `track`.
      await face.load();
      expect(face.status).toBe('loaded');
      await expect(first.fonts).resolves.toBe(true);
      expect(layout.epoch.value).toBe(1);

      // The cache of epoch 0 is not the one the layout hands out now: the next lookup misses and
      // measures the loaded face, whose width differs from the fallback's.
      const newCache = layout.measurer();
      expect(newCache.id).not.toBe(oldCache.id);
      const loadedWidth = newCache.advance(key, SAMPLE);
      expect(inner.calls).toBe(callsBefore + 1);
      expect(loadedWidth).not.toBeCloseTo(fallbackWidth, 3);

      // The next pass measures the loaded face and sees no new arrival.
      const second = layout.layout(toFlow(envelope(alias)), providers);
      expect(second.epoch).toBe(1);
      await expect(second.fonts).resolves.toBe(false);
      expect(layout.epoch.value).toBe(1);
    });

    it('advances once when the face finished loading before track was asked, since the pass noted it unloaded', async () => {
      const alias = `de-font-${'d'.repeat(64)}`;
      const face = register(alias);
      const arrivals = faceArrivals(pageFaces);
      const epoch = new FontEpoch(0);
      arrivals.note(alias); // the pass measures under the alias while the face is not loaded
      await face.load(); // loaded by another route, and finished
      await epoch.track(arrivals, [alias]);
      expect(epoch.value).toBe(1);
      // Asked again, or by two tracks at once, the arrival is not counted twice.
      await Promise.all([epoch.track(arrivals, [alias]), epoch.track(arrivals, [alias])]);
      expect(epoch.value).toBe(1);
    });

    it('counts one arrival when two tracks wait on the same face', async () => {
      const alias = `de-font-${'c'.repeat(64)}`;
      const face = register(alias);
      const arrivals = faceArrivals(pageFaces);
      const epoch = new FontEpoch(0);
      arrivals.note(alias);
      const both = Promise.all([epoch.track(arrivals, [alias]), epoch.track(arrivals, [alias])]);
      await face.load();
      await both;
      expect(epoch.value).toBe(1);
    });

    it('starts the load itself when asked to, and advances once', async () => {
      const alias = `de-font-${'b'.repeat(64)}`;
      const face = register(alias);
      const epoch = new FontEpoch(0);
      await epoch.track(faceArrivals(pageFaces, { load: true }), [alias]);
      expect(face.status).toBe('loaded');
      expect(epoch.value).toBe(1);
    });

    it('does not advance for an alias the page does not hold, or for a face loaded before the pass', async () => {
      const epoch = new FontEpoch(0);
      await epoch.track(faceArrivals(pageFaces), [`de-font-${'f'.repeat(64)}`]);
      expect(epoch.value).toBe(0);

      const alias = `de-font-${'a'.repeat(64)}`;
      await register(alias).load();
      const layout = new FontAwareLayout({
        measurer: canvasMeasurer(),
        arrivals: faceArrivals(pageFaces),
        epoch,
      });
      const pass = layout.layout(toFlow(envelope(alias)), providers);
      await expect(pass.fonts).resolves.toBe(false);
      expect(epoch.value).toBe(0);
    });
  },
);
