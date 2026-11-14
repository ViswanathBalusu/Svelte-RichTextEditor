/**
 * FE-064 criterion 3 (Node.js): when a font arrives, the font epoch advances once, and the next
 * layout pass re-measures and re-breaks the paragraphs that use that font and no others. The
 * arrival is taken from `FontEpoch.track` with a fake arrivals source, the dirty set from
 * `blocksUsingFonts`, and the pass is the incremental layout, whose stats name the measured blocks.
 */
import { describe, expect, it } from 'vitest';
import { flowFontAliases } from './font-pass.ts';
import { FontEpoch, type FontArrivals } from './font-epoch.ts';
import { blocksUsingFonts } from './font-dirty.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { incrementalLayout } from './incremental.ts';
import { firstFitBreaker, type BreakOpportunities, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

const providers: ItemProviders = {
  measurer: fixedWidthMeasurer(),
  breaks: afterSpace,
  lineBreaker: firstFitBreaker,
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

/** Four paragraphs: two in the document's Normal font, one in "Alpha" and one in "Normal" text with an "Alpha" run. */
function docWithFonts() {
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
                fontFamily: 'Noto Serif',
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

/** Arrivals that report `arrived` for the aliases in `arriving` and nothing else. */
function arrivalsOf(arriving: readonly string[]): FontArrivals {
  return {
    arrived: async (alias) => arriving.includes(alias),
  };
}

describe('FE-064 criterion 3: only the blocks that use an arrived font are re-measured', () => {
  it('the arrival advances the epoch once and names the arrived alias', async () => {
    const doc = docWithFonts();
    const epoch = new FontEpoch();
    await epoch.track(arrivalsOf(['Alpha']), flowFontAliases(doc));
    expect(epoch.value).toBe(1);
    expect([...epoch.takeArrived()]).toEqual(['Alpha']);
    expect(epoch.takeArrived().size).toBe(0);
  });

  it('the next pass re-measures exactly the paragraphs that use the arrived font', async () => {
    const doc = docWithFonts();
    const layout = incrementalLayout(providers);
    layout.update(doc);
    expect(layout.lastStats.measured.length).toBe(4);

    const epoch = new FontEpoch();
    await epoch.track(arrivalsOf(['Alpha']), flowFontAliases(doc));
    const dirty = blocksUsingFonts(doc, epoch.takeArrived());
    expect([...dirty].sort()).toEqual(['p-alpha', 'p-serif-2']);

    layout.update(doc, dirty);
    expect([...layout.lastStats.measured].sort()).toEqual(['p-alpha', 'p-serif-2']);
    expect(layout.lastStats.reused).toBe(2);
  });

  it('without the marks, the pass reuses every paragraph (why the dirty set is needed)', () => {
    const doc = docWithFonts();
    const layout = incrementalLayout(providers);
    layout.update(doc);
    layout.update(doc);
    expect(layout.lastStats.measured).toEqual([]);
    expect(layout.lastStats.reused).toBe(4);
  });

  it('a font no paragraph uses dirties nothing', async () => {
    const doc = docWithFonts();
    const epoch = new FontEpoch();
    await epoch.track(arrivalsOf(['Gamma']), flowFontAliases(doc));
    expect(epoch.value).toBe(0);
    expect(blocksUsingFonts(doc, epoch.takeArrived()).size).toBe(0);
  });
});
