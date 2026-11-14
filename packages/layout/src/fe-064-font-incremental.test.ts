/**
 * FE-064 criterion 3 (Node.js, fake faces): when a font arrives, the epoch advances, and the next
 * pass of `IncrementalFontLayout` re-measures the blocks that use that font with the arrived face's
 * widths and leaves every other block as the earlier pass laid it out. The measurer here gives a
 * family one width while its face is not loaded (the fallback) and another once it is, as a canvas
 * measurer does, and counts its calls per family.
 */
import { describe, expect, it } from 'vitest';
import { layoutFlow, type LayoutResult } from './engine.ts';
import { faceArrivals, type LoadableFaceLike } from './font-arrivals.ts';
import { IncrementalFontLayout } from './font-incremental.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import type { FontKey, TextMeasurer } from './measure.ts';
import type { LayoutFragment, ParagraphFragment } from './tree.ts';

/** A face whose load the test finishes, like a FontFace loaded by the browser. */
function fakeFace(family: string, status = 'unloaded') {
  let settle!: () => void;
  const face = {
    family,
    status,
    loaded: new Promise<void>((resolve) => {
      settle = () => {
        face.status = 'loaded';
        resolve();
      };
    }),
    load() {
      return face.loaded;
    },
    finish() {
      settle();
    },
  };
  if (status === 'loaded') settle();
  return face;
}

type Face = ReturnType<typeof fakeFace>;

/**
 * Widths in points: 0.5 em per character with the fallback, 0.8 em once the family's face is
 * loaded. `calls` counts the measurements per family.
 */
function faceMeasurer(faces: readonly Face[]) {
  const calls = new Map<string, number>();
  const loaded = (family: string): boolean =>
    faces.some((face) => face.family === family && face.status === 'loaded');
  const count = (font: FontKey): void => {
    calls.set(font.family, (calls.get(font.family) ?? 0) + 1);
  };
  const em = (font: FontKey): number => (loaded(font.family) ? 0.8 : 0.5) * font.sizePt;
  const measurer: TextMeasurer = {
    id: 'face-measurer',
    advance(font, text) {
      count(font);
      return em(font) * text.length;
    },
    lineMetrics(font) {
      count(font);
      return { ascent: 0.8 * font.sizePt, descent: 0.2 * font.sizePt, lineGap: 0 };
    },
  };
  return { measurer, calls };
}

const afterSpace: BreakOpportunities = {
  opportunities: (text) => [...text.matchAll(/ (?=\S)/g)].map((m) => m.index + 1),
};

const plain = (t: string): CdmNode => ({ type: 'text', text: t });
const inFamily = (t: string, family: string): CdmNode => ({
  type: 'text',
  text: t,
  marks: [{ type: 'fontFamily', attrs: { value: family } }],
});
const paragraph = (id: string, content: CdmNode[]): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});

/** Four paragraphs: one in the Normal font (Serif), one in Alpha, one mixed, one in Beta. */
function docWithFonts() {
  const envelope: CdmEnvelopeLike = {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            {
              type: 'style_def',
              attrs: {
                id: 'Normal',
                kind: 'paragraph',
                name: 'Normal',
                builtIn: true,
                fontFamily: 'Serif',
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
            paragraph('p-serif-1', [plain('The first paragraph is in the Normal font.')]),
            paragraph('p-alpha', [inFamily('Every word here is in Alpha.', 'Alpha')]),
            paragraph('p-serif-2', [
              plain('Mostly Normal, with one run '),
              inFamily('in Alpha', 'Alpha'),
              plain(' inside it.'),
            ]),
            paragraph('p-beta', [inFamily('Beta only, nothing from Alpha.', 'Beta')]),
          ],
        },
      ],
    },
  };
  return toFlow(envelope);
}

/** The body paragraph fragments of a result, by block identifier. */
function paragraphs(result: LayoutResult): Map<string, ParagraphFragment> {
  const out = new Map<string, ParagraphFragment>();
  const visit = (fragments: readonly LayoutFragment[]): void => {
    for (const f of fragments) if (f.kind === 'paragraph') out.set(f.blockId, f);
  };
  for (const page of result.tree.pages) visit(page.fragments);
  return out;
}

const widthOf = (f: ParagraphFragment | undefined): number[] =>
  (f?.lines ?? []).map((line) => line.width);

function setUp() {
  const faces = [fakeFace('Serif', 'loaded'), fakeFace('Alpha'), fakeFace('Beta', 'loaded')];
  const alpha = faces[1] as Face;
  const { measurer, calls } = faceMeasurer(faces);
  const layout = new IncrementalFontLayout({
    measurer,
    arrivals: faceArrivals(() => faces as readonly LoadableFaceLike[]),
    breaks: afterSpace,
    lineBreaker: firstFitBreaker,
  });
  return { faces, alpha, measurer, calls, layout };
}

describe('IncrementalFontLayout: only the blocks that use an arrived font are re-measured (FE-064 criterion 3)', () => {
  it('re-measures the Alpha blocks with the arrived widths and leaves the others as they were', async () => {
    const { alpha, measurer, calls, layout } = setUp();
    const doc = docWithFonts();

    const first = layout.layout(doc);
    expect(first.epoch).toBe(0);
    expect([...first.stats.measured].sort()).toEqual([
      'p-alpha',
      'p-beta',
      'p-serif-1',
      'p-serif-2',
    ]);
    const before = paragraphs(first.result);

    // Alpha loads after the pass, by a route the pass did not start.
    alpha.finish();
    await expect(first.fonts).resolves.toBe(true);
    expect(layout.epoch.value).toBe(1);

    calls.clear();
    const second = layout.layout(doc);
    expect(second.epoch).toBe(1);
    expect([...second.arrived]).toEqual(['Alpha']);
    expect([...second.dirty].sort()).toEqual(['p-alpha', 'p-serif-2']);
    expect([...second.stats.measured].sort()).toEqual(['p-alpha', 'p-serif-2']);
    expect(second.stats.reused).toBe(2);
    expect(second.result.tree.measurer).toBe(layout.measurer().id);
    expect(second.result.tree.measurer).not.toBe(first.result.tree.measurer);

    // No measurement in Beta: its block was not measured again.
    expect(calls.get('Beta') ?? 0).toBe(0);
    expect(calls.get('Alpha') ?? 0).toBeGreaterThan(0);

    const after = paragraphs(second.result);
    // A fresh layout with Alpha loaded is what the dirty blocks must now show.
    const fresh = paragraphs(
      layoutFlow(doc, { measurer, breaks: afterSpace, lineBreaker: firstFitBreaker }),
    );
    for (const id of ['p-alpha', 'p-serif-2']) {
      expect(widthOf(after.get(id))).toEqual(widthOf(fresh.get(id)));
      expect(widthOf(after.get(id))).not.toEqual(widthOf(before.get(id)));
    }
    // The other blocks keep the lines of the earlier pass: the same fragment, not rebuilt.
    for (const id of ['p-serif-1', 'p-beta']) {
      expect(after.get(id)).toEqual(before.get(id));
      expect(widthOf(after.get(id))).toEqual(widthOf(fresh.get(id)));
    }
    await expect(second.fonts).resolves.toBe(false);
  });

  it('without an arrival, the next pass measures nothing and keeps every block', async () => {
    const { calls, layout } = setUp();
    const doc = docWithFonts();
    const first = layout.layout(doc);
    const before = paragraphs(first.result);
    calls.clear();
    const second = layout.layout(doc);
    expect(second.arrived.size).toBe(0);
    expect(second.dirty.size).toBe(0);
    expect(second.stats.measured).toEqual([]);
    expect(second.stats.reused).toBe(4);
    expect(calls.size).toBe(0);
    expect(paragraphs(second.result)).toEqual(before);
    expect(widthOf(paragraphs(second.result).get('p-alpha'))).toEqual(
      widthOf(before.get('p-alpha')),
    );
  });

  it('takes each arrival once: the pass after the re-measure reuses every block', async () => {
    const { alpha, layout } = setUp();
    const doc = docWithFonts();
    const first = layout.layout(doc);
    alpha.finish();
    await first.fonts;
    layout.layout(doc);
    const third = layout.layout(doc);
    expect(third.arrived.size).toBe(0);
    expect(third.stats.measured).toEqual([]);
    expect(third.stats.reused).toBe(4);
    expect(layout.epoch.value).toBe(1);
  });

  it('adds the blocks the caller names to the dirty set', async () => {
    const { alpha, layout } = setUp();
    const doc = docWithFonts();
    const first = layout.layout(doc);
    alpha.finish();
    await first.fonts;
    const second = layout.layout(doc, ['p-beta']);
    expect([...second.dirty].sort()).toEqual(['p-alpha', 'p-beta', 'p-serif-2']);
    expect([...second.stats.measured].sort()).toEqual(['p-alpha', 'p-beta', 'p-serif-2']);
    expect(second.stats.reused).toBe(1);
  });
});
