/**
 * Page number start and format reach the page fields (FE-137 criterion 4), in Node.js. A CDM
 * envelope whose page setup has `pageNumberStart` and `pageNumberFormat` and whose header and footer
 * stories hold a `page` field is read through `toFlow` and laid out; the field of each page shows
 * the number counted from the start, written in the format. The page count stays a plain count.
 * Text is measured by the fixed-width stub.
 *
 * Run with `pnpm exec vitest run --project node packages/layout/src/fe-137-page-number-fields.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { layoutFlow } from './engine.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import type { ParagraphFragment } from './tree.ts';

const afterSpace: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    for (let i = 0; i + 1 < text.length; i++)
      if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
    return out;
  },
};

const text = (t: string): CdmNode => ({ type: 'text', text: t });
const paragraph = (id: string, content: CdmNode[]): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});

function envelope(setup: Record<string, unknown>): CdmEnvelopeLike {
  const body = Array.from({ length: 300 }, (_, i) =>
    paragraph(`p${i}`, [text(`Paragraph ${i} of the body, with some words.`)]),
  );
  const header: CdmNode = {
    type: 'story',
    attrs: { id: 'h1' },
    content: [paragraph('h1-p', [text('Page '), { type: 'field', attrs: { kind: 'page' } }])],
  };
  const footer: CdmNode = {
    type: 'story',
    attrs: { id: 'f1' },
    content: [
      paragraph('f1-p', [
        { type: 'field', attrs: { kind: 'page' } },
        text(' of '),
        { type: 'field', attrs: { kind: 'pageCount' } },
      ]),
    ],
  };
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
                headerDefault: 'h1',
                footerDefault: 'f1',
                headerDistance: 708,
                footerDistance: 708,
                ...setup,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
        header,
        footer,
      ],
    },
  };
}

function laidOut(setup: Record<string, unknown>) {
  const result = layoutFlow(toFlow(envelope(setup)), {
    measurer: fixedWidthMeasurer(),
    breaks: afterSpace,
    lineBreaker: firstFitBreaker,
  });
  const lineText = (fragments: readonly { kind: string }[]): string =>
    fragments
      .flatMap((f) => (f.kind === 'paragraph' ? (f as ParagraphFragment).lines : []))
      .map((l) => l.text ?? '')
      .join('');
  return {
    pages: result.tree.pages,
    headers: result.tree.pages.map((p) => lineText(p.header)),
    footers: result.tree.pages.map((p) => lineText(p.footer)),
  };
}

describe('page number start and format in the page fields (FE-137 criterion 4)', () => {
  it('counts from 1 in decimal when the page setup says nothing', () => {
    const { pages, headers } = laidOut({});
    expect(pages.length).toBeGreaterThanOrEqual(5);
    expect(headers.slice(0, 3)).toEqual(['Page 1', 'Page 2', 'Page 3']);
  });

  it('starts at the page number start', () => {
    const { headers, footers, pages } = laidOut({ pageNumberStart: 5 });
    expect(headers.slice(0, 3)).toEqual(['Page 5', 'Page 6', 'Page 7']);
    // The page count is the number of pages, not the last page number.
    expect(footers[0]).toBe(`5 of ${pages.length}`);
  });

  it('writes the number in the page number format', () => {
    const roman = laidOut({ pageNumberStart: 3, pageNumberFormat: 'lowerRoman' });
    expect(roman.headers.slice(0, 4)).toEqual(['Page iii', 'Page iv', 'Page v', 'Page vi']);
    const upper = laidOut({ pageNumberFormat: 'upperLetter' });
    expect(upper.headers.slice(0, 3)).toEqual(['Page A', 'Page B', 'Page C']);
  });
});
