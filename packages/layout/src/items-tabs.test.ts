/**
 * Tab stops in the item adapter (FE-081 criterion 3), in Node.js: a tab moves to the paragraph's
 * stops, to the document's default spacing past the last stop, and a numbering label's tab goes to
 * the hanging indent. Text is measured by the fixed-width stub at 11 points: 0.5 em, so each
 * character is 5.5 points wide and the expected widths below are counted by hand.
 */
import { describe, expect, it } from 'vitest';
import {
  toFlow,
  type CdmEnvelopeLike,
  type CdmNode,
  type FlowFont,
  type FlowParagraph,
  type FlowTab,
  type FlowText,
} from './flow.ts';
import { documentItems, firstFitBreaker, paragraphItem, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import type { BreakOpportunities } from './lines.ts';

const noBreaks: BreakOpportunities = { opportunities: () => [] };
const providers: ItemProviders = {
  measurer: fixedWidthMeasurer(),
  breaks: noBreaks,
  lineBreaker: firstFitBreaker,
};

const font: FlowFont = {
  family: 'Noto Serif',
  sizePt: 11,
  bold: false,
  italic: false,
  color: null,
  underline: false,
  strike: false,
  vertAlign: null,
};

function textInline(t: string, offset: number, role: FlowText['role'] = 'text'): FlowText {
  return { kind: 'text', role, text: t, font, offset, size: role === 'text' ? t.length : 0 };
}

function tabInline(offset: number, toPt?: number): FlowTab {
  return {
    kind: 'tab',
    font,
    offset,
    size: toPt === undefined ? 1 : 0,
    ...(toPt === undefined ? {} : { toPt }),
  };
}

/** A flow paragraph for the adapter, with the given inlines and the fields the test varies. */
function paragraph(
  inlines: FlowParagraph['inlines'],
  over: Partial<FlowParagraph> = {},
): FlowParagraph {
  const end = inlines.reduce((sum, i) => sum + i.size, 0);
  return {
    kind: 'paragraph',
    id: 'p1',
    part: 0,
    start: 0,
    end,
    generated: false,
    styleId: 'Normal',
    outlineLevel: null,
    align: 'left',
    indentLeft: 0,
    indentRight: 0,
    indentFirstLine: 0,
    spaceBefore: 0,
    spaceAfter: 0,
    line: { rule: 'multiple', factor: 1 },
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: false,
    tabs: [],
    markFont: font,
    inlines,
    regionId: null,
    ...over,
  };
}

describe('tab stops in the item adapter (FE-081 criterion 3)', () => {
  it('moves a tab to the left stop of the paragraph and counts the stop in the line width', () => {
    // 'a' is 5.5 points, the tab moves to the stop at 100, and 'bcd' (16.5 points) ends at 116.5.
    const p = paragraph([textInline('a', 0), tabInline(1), textInline('bcd', 2)], {
      tabs: [{ position: 100, align: 'left', leader: 'none' }],
    });
    const item = paragraphItem(p, 400, providers);
    expect(item.fragment.lines).toHaveLength(1);
    expect(item.fragment.lines[0]!.width).toBeCloseTo(116.5, 6);
  });

  it('uses the default spacing past the last stop when the paragraph has none', () => {
    // With no stop, a tab goes to the next multiple of 36 points, so 'bcd' ends at 36 + 16.5.
    const p = paragraph([textInline('a', 0), tabInline(1), textInline('bcd', 2)]);
    const item = paragraphItem(p, 400, providers, 36);
    expect(item.fragment.lines[0]!.width).toBeCloseTo(52.5, 6);
  });

  it("takes a numbering label's tab to the hanging indent", () => {
    // The label '1.' is 11 points wide and its tab goes to the hanging indent at 36 points, where
    // 'abc' starts and ends at 52.5 (the first line starts at 0 and the rest at 36).
    const p = paragraph([textInline('1.', 0, 'label'), tabInline(0, 36), textInline('abc', 0)], {
      indentLeft: 36,
      indentFirstLine: -36,
    });
    const item = paragraphItem(p, 400, providers, 720);
    expect(item.fragment.lines[0]!.width).toBeCloseTo(52.5, 6);
  });

  it('reads the default spacing from the document settings through toFlow and documentItems', () => {
    // A CDM tab in a paragraph with no tab stops: with the schema's default of 720 twips (36
    // points), the text after the tab starts at 36 and 'bcd' ends at 52.5.
    const body: CdmNode[] = [
      {
        type: 'paragraph',
        attrs: { id: 'p1', style: 'Normal' },
        content: [{ type: 'text', text: 'a' }, { type: 'tab' }, { type: 'text', text: 'bcd' }],
      },
    ];
    const env: CdmEnvelopeLike = {
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
          { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
        ],
      },
    };
    const { items, unplaced } = documentItems(toFlow(env), providers);
    expect(unplaced).toEqual([]);
    const first = items[0];
    expect(first?.kind).toBe('paragraph');
    if (first?.kind !== 'paragraph') return;
    expect(first.fragment.lines[0]!.width).toBeCloseTo(52.5, 6);
  });
});
