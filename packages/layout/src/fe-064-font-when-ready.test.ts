/**
 * FE-064 criterion 1 in Node.js, with fake faces: `FontAwareLayout.layoutWhenReady` reads the font
 * aliases from the flow document (resolved from its style definitions and direct formatting), waits
 * for their faces, and only then measures. The browser run with a real FontFace is
 * `fe-064-font-when-ready.universal.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { faceArrivals, type LoadableFaceLike } from './font-arrivals.ts';
import { FontAwareLayout, flowFontAliases } from './font-pass.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import { fixedWidthMeasurer, type FontKey, type TextMeasurer } from './measure.ts';

/** A face that a test finishes loading, as a FontFace loaded elsewhere would. */
function pendingFace(family: string) {
  let finish!: () => void;
  const loaded = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const face = {
    family,
    status: 'unloaded' as string,
    loads: 0,
    loaded,
    load() {
      face.loads += 1;
      return loaded;
    },
    finishLoading() {
      face.status = 'loaded';
      finish();
    },
  };
  return face;
}

const STYLE_FONT = `de-font-${'5'.repeat(64)}`;
const MARK_FONT = `de-font-${'6'.repeat(64)}`;
const HEADER_FONT = `de-font-${'8'.repeat(64)}`;

const afterSpace: BreakOpportunities = {
  opportunities: (text) => [...text.matchAll(/ (?=\S)/g)].map((m) => m.index + 1),
};
const providers = { breaks: afterSpace, lineBreaker: firstFitBreaker };

const paragraph = (id: string, style: string, content: CdmNode[]): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style },
  content,
});

/** Body text in the Normal style's font, one run with a direct font mark, a table and a header. */
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
              fontFamily: STYLE_FONT,
              fontSize: 220,
            },
          },
          {
            type: 'style_def',
            attrs: {
              id: 'Header',
              kind: 'paragraph',
              name: 'Header',
              fontFamily: HEADER_FONT,
              fontSize: 200,
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
              headerDefault: 'h1',
            },
          },
        ],
      },
      {
        type: 'story',
        attrs: { id: 'h1' },
        content: [paragraph('hp1', 'Header', [{ type: 'text', text: 'Running head' }])],
      },
      {
        type: 'body',
        attrs: { pageSetup: 'ps1' },
        content: [
          paragraph('p1', 'Normal', [
            { type: 'text', text: 'Alpha ' },
            {
              type: 'text',
              text: 'beta',
              marks: [{ type: 'fontFamily', attrs: { value: MARK_FONT } }],
            },
          ]),
        ],
      },
    ],
  },
};

/** A measurer that records the status of `face` at every measurement it takes. */
function watching(face: { status: string }, seen: string[]): TextMeasurer {
  const inner = fixedWidthMeasurer();
  return {
    id: inner.id,
    advance(font: FontKey, text: string) {
      seen.push(face.status);
      return inner.advance(font, text);
    },
    lineMetrics(font: FontKey) {
      seen.push(face.status);
      return inner.lineMetrics(font);
    },
  };
}

describe('flowFontAliases: the aliases a pass needs, from the document', () => {
  it('reads the style font, a direct font mark and the header story font', () => {
    const aliases = flowFontAliases(toFlow(envelope));
    expect(aliases).toContain(STYLE_FONT);
    expect(aliases).toContain(MARK_FONT);
    expect(toFlow(envelope).stories.has('h1')).toBe(true);
    expect(aliases).toContain(HEADER_FONT);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('holds every alias the pass itself measures with', () => {
    const flow = toFlow(envelope);
    const layout = new FontAwareLayout({
      measurer: fixedWidthMeasurer(),
      arrivals: faceArrivals(() => []),
    });
    const pass = layout.layout(flow, providers);
    const needed = new Set(flowFontAliases(flow));
    for (const alias of pass.aliases) expect(needed.has(alias)).toBe(true);
  });
});

describe('FontAwareLayout.layoutWhenReady: a pass waits for its fonts (FE-064 criterion 1)', () => {
  it('measures nothing until the face of a style font loads, then measures under the new epoch', async () => {
    const face = pendingFace(STYLE_FONT);
    const seen: string[] = [];
    const layout = new FontAwareLayout({
      measurer: watching(face, seen),
      arrivals: faceArrivals(() => [face as LoadableFaceLike], { load: true }),
    });

    const passing = layout.layoutWhenReady(toFlow(envelope), providers);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(face.loads).toBe(1); // the source starts the load the pass waits for
    expect(seen).toEqual([]); // the pass has not measured anything yet

    face.finishLoading();
    const pass = await passing;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((status) => status === 'loaded')).toBe(true);
    expect(pass.epoch).toBe(1);
    expect(pass.aliases.has(STYLE_FONT)).toBe(true);
    await expect(pass.fonts).resolves.toBe(false);
    expect(layout.epoch.value).toBe(1);
  });

  it('measures at once under the same epoch when the faces are already loaded', async () => {
    const face = pendingFace(STYLE_FONT);
    face.finishLoading();
    const layout = new FontAwareLayout({
      measurer: fixedWidthMeasurer(),
      arrivals: faceArrivals(() => [face as LoadableFaceLike], { load: true }),
    });
    const pass = await layout.layoutWhenReady(toFlow(envelope), providers);
    expect(face.loads).toBe(0);
    expect(pass.epoch).toBe(0);
    await expect(pass.fonts).resolves.toBe(false);
  });

  it('measures the fallback when a face fails to load, with no advance', async () => {
    const face = {
      family: STYLE_FONT,
      status: 'unloaded',
      load: () => Promise.reject(new Error('network')),
    };
    const layout = new FontAwareLayout({
      measurer: fixedWidthMeasurer(),
      arrivals: faceArrivals(() => [face], { load: true }),
    });
    const pass = await layout.layoutWhenReady(toFlow(envelope), providers);
    expect(pass.epoch).toBe(0);
    expect(pass.result.tree.pages.length).toBeGreaterThan(0);
  });
});
