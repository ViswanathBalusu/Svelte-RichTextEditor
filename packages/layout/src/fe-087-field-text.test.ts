/**
 * Page fields in headers and footers (FE-087, criterion 3), in Node.js: a story paragraph with a
 * `page` and a `pageCount` field shows the page's number and the document's page count, and the
 * line that holds them carries the text it was broken from (`LayoutLine.text`), so the painter can
 * draw it. Text is measured by the fixed-width stub at 11 points (5.5 points a character).
 */
import { describe, expect, it } from 'vitest';
import type { FlowDocument, FlowFont, FlowPage, FlowParagraph, FlowText } from './flow.ts';
import { firstFitBreaker, flowStoryResolver, paragraphItem, type ItemProviders } from './items.ts';
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

function text(t: string, offset: number, role: FlowText['role'] = 'text', ref?: string): FlowText {
  return {
    kind: 'text',
    role,
    text: t,
    font,
    offset,
    size: role === 'text' ? t.length : 0,
    ...(ref === undefined ? {} : { ref }),
  };
}

/** A header paragraph 'Page <page> of <pageCount>': the two fields are atoms with no CDM text. */
function headerParagraph(id = 'h1'): FlowParagraph {
  const inlines: FlowText[] = [
    text('Page ', 0),
    text('?', 0, 'field', 'page'),
    text(' of ', 0),
    text('?', 0, 'field', 'pageCount'),
  ];
  return {
    kind: 'paragraph',
    id,
    part: 0,
    start: 0,
    end: 5 + 4,
    generated: false,
    styleId: 'Header',
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
  };
}

describe('page fields in a story (FE-087, criterion 3)', () => {
  it('shows the page number and the page count in the line, as the layout computed them', () => {
    const item = paragraphItem(
      {
        ...headerParagraph(),
        inlines: [
          text('Page ', 0),
          text('3', 0, 'field', 'page'),
          text(' of ', 0),
          text('7', 0, 'field', 'pageCount'),
        ],
      },
      400,
      providers,
    );
    expect(item.fragment.lines).toHaveLength(1);
    expect(item.fragment.lines[0]!.text).toBe('Page 3 of 7');
  });

  it('gives a paragraph without a field no line text, so the painter keeps the CDM text', () => {
    const item = paragraphItem(
      {
        ...headerParagraph(),
        inlines: [text('Plain header', 0)],
        end: 12,
      },
      400,
      providers,
    );
    expect(item.fragment.lines[0]).not.toHaveProperty('text');
  });

  it('fills the fields of a story for each page through the story resolver', () => {
    const doc = {
      sections: [],
      stories: new Map([['hdr', [headerParagraph()]]]),
      notes: new Map(),
      defaultTabStop: 0,
    } as unknown as FlowDocument;
    const page = {
      width: 400,
      height: 600,
      marginLeft: 0,
      marginRight: 0,
    } as unknown as FlowPage;
    const resolve = flowStoryResolver(doc, providers);
    const factory = resolve('hdr', page);
    expect(factory).toBeDefined();
    const block = factory!({ number: 2, label: '2', pageCount: 5 });
    const frag = block.fragments[0];
    expect(frag?.kind).toBe('paragraph');
    if (frag?.kind !== 'paragraph') return;
    expect(frag.lines.map((l) => l.text)).toEqual(['Page 2 of 5']);
    // The same story at another page shows that page's number.
    const later = factory!({ number: 9, label: '9', pageCount: 12 });
    const laterFrag = later.fragments[0];
    if (laterFrag?.kind !== 'paragraph') throw new Error('expected a paragraph fragment');
    expect(laterFrag.lines[0]!.text).toBe('Page 9 of 12');
  });
});
