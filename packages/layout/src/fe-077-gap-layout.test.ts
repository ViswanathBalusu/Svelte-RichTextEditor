/**
 * FE-077 criterion 3 through the whole engine: the distance between two consecutive paragraphs on
 * a page is the larger of the first one's `spaceAfter` and the second one's `spaceBefore`, and zero
 * between paragraphs of one style that have `contextualSpacing` (03 §7). `cdm-043-*.test.ts` check
 * the flow values; this file reads the gap off the layout tree that `layoutFlow` returns, where
 * `paginate.ts` adds the two values.
 */
import { describe, expect, it } from 'vitest';
import { layoutFlow } from './engine.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';

const noBreaks: BreakOpportunities = { opportunities: () => [] };

const para = (id: string, attrs: Record<string, unknown>): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal', ...attrs },
  content: [{ type: 'text', text: id }],
});

function envelope(body: CdmNode[]): CdmEnvelopeLike {
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
                fontFamily: 'Noto Serif',
                fontSize: 200,
              },
            },
            {
              type: 'page_setup',
              attrs: {
                id: 'ps1',
                width: 12000,
                height: 16000,
                marginTop: 0,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

/** The distance between the bottom of the first paragraph and the top of the second, in points. */
function gap(first: Record<string, unknown>, second: Record<string, unknown>): number {
  const { tree } = layoutFlow(toFlow(envelope([para('A', first), para('B', second)])), {
    measurer: fixedWidthMeasurer(),
    breaks: noBreaks,
    lineBreaker: firstFitBreaker,
  });
  const [a, b] = tree.pages[0]!.fragments;
  return b!.y - (a!.y + a!.height);
}

describe('the gap between two paragraphs in the layout tree (FE-077 criterion 3)', () => {
  it('is the larger of the first one spaceAfter and the second one spaceBefore', () => {
    // 160 twips are 8 pt, 240 twips are 12 pt.
    expect(gap({ spaceAfter: 160 }, { spaceBefore: 240 })).toBeCloseTo(12, 6);
    expect(gap({ spaceAfter: 240 }, { spaceBefore: 160 })).toBeCloseTo(12, 6);
    expect(gap({ spaceAfter: 200 }, { spaceBefore: 200 })).toBeCloseTo(10, 6);
  });

  it('is the one value when only one side sets one', () => {
    expect(gap({ spaceAfter: 160 }, {})).toBeCloseTo(8, 6);
    expect(gap({}, { spaceBefore: 240 })).toBeCloseTo(12, 6);
  });

  it('is zero between paragraphs of one style that both have contextualSpacing', () => {
    expect(
      gap(
        { spaceAfter: 160, contextualSpacing: true },
        { spaceBefore: 240, contextualSpacing: true },
      ),
    ).toBeCloseTo(0, 6);
  });

  it('keeps the larger-of rule when only one of the two has contextualSpacing', () => {
    expect(gap({ spaceAfter: 160, contextualSpacing: true }, { spaceBefore: 240 })).toBeCloseTo(
      12,
      6,
    );
  });
});
