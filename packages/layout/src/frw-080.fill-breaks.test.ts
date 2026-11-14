/**
 * Line and page breaks stay the same while a field with a `width` is filled (FRW-080 criteria 1,
 * 2 and 5-in-layout; 12 §3.2 `width`). The layout reads the field's box from `width` alone (flow.ts,
 * `form_field`), so the value cannot change the surrounding breaks. Node.js only: no DOM is needed.
 * Criterion 3 (a default width) and the PDF comparison of criterion 5 (EXP-033) are not met here.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { layoutFlow } from './engine.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import type { LayoutTree } from './tree.ts';

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

const text = (t: string): CdmNode => ({ type: 'text', text: t });
const paragraph = (id: string, content: CdmNode[]): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
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
}

/**
 * A body of sixty paragraphs over several pages. Paragraph 3 holds a field in the middle of its
 * text; `field` is the field node, so the same document is laid out with an empty or a filled field.
 */
function documentWith(field: CdmNode): CdmEnvelopeLike {
  const body: CdmNode[] = [];
  for (let i = 0; i < 60; i++) {
    const words = Array.from({ length: 4 + (i % 7) }, (_, w) => `word${i}x${w}`).join(' ');
    if (i === 3)
      body.push(
        paragraph(`p${i}`, [
          text(`Before the field ${words} `),
          field,
          text(' and the words that follow it on the same line and further on.'),
        ]),
      );
    else body.push(paragraph(`p${i}`, [text(words)]));
  }
  return envelope(body);
}

const field = (attrs: Record<string, unknown>): CdmNode => ({
  type: 'form_field',
  attrs: { id: 'f1', kind: 'text', label: 'Tenant name', ...attrs },
});

/**
 * Every line and every page start of the tree, as text: `page|block|from-to,...`. Two trees with the
 * same breaks give the same string, so an equality check compares the breaks, not the text.
 */
function breaksOf(tree: LayoutTree): string {
  return tree.pages
    .map((page, index) =>
      page.fragments
        .map((f) =>
          f.kind === 'paragraph'
            ? `${index}|${f.blockId}|${f.lines.map((l) => `${l.from}-${l.to}`).join(',')}`
            : `${index}|${f.kind}`,
        )
        .join(';'),
    )
    .join('\n');
}

const breaksWith = (node: CdmNode): string =>
  breaksOf(layoutFlow(toFlow(documentWith(node)), providers).tree);

describe('a field with a width keeps the breaks while it is filled (FRW-080)', () => {
  const WIDTH = 2880; // twips: two inches, the box of every field below.

  it('lays out more than one page, so that a page break can move (criterion 1)', () => {
    const tree = layoutFlow(toFlow(documentWith(field({ width: WIDTH }))), providers).tree;
    expect(tree.pages.length).toBeGreaterThan(1);
  });

  it('keeps the line and page breaks identical whatever the value is (criteria 1 and 2, property)', () => {
    const empty = breaksWith(field({ width: WIDTH, value: null }));
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (value) => {
        expect(breaksWith(field({ width: WIDTH, value }))).toBe(empty);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps the breaks for a value far longer than the box (criterion 2)', () => {
    const empty = breaksWith(field({ width: WIDTH, value: null }));
    const long = 'Mrs Alexandria Tenant-Hyphenated Longname '.repeat(20);
    expect(breaksWith(field({ width: WIDTH, value: long }))).toBe(empty);
  });

  it('is sensitive to the value when there is no width, so the test would catch a reflow (control)', () => {
    // Without a width the value is laid out as text, so a long value moves the breaks. If this
    // stopped holding, the property above would prove nothing.
    const empty = breaksWith(field({ value: null }));
    const long = 'Mrs Alexandria Tenant-Hyphenated Longname '.repeat(20);
    expect(breaksWith(field({ value: long }))).not.toBe(empty);
  });
});
