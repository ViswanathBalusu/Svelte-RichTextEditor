/**
 * Line and page breaks stay the same while a field with a `width` is filled (FRW-080 criteria 1,
 * 2 and 3; 12 §3.2 `width`). The layout reads the field's box from `width`, or from the default of
 * its kind, and never from the value (flow.ts, `form_field`); the line breaker sets that box at exactly
 * its width (lines.ts, `BreakRun.width`). Node.js only: no DOM is needed. The PDF comparison of
 * criterion 5 is `packages/export-latex/src/frw-080-page-starts.compile.test.ts`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FIELD_DEFAULT_WIDTH, FIELD_KINDS } from '@docedit/model/definition';
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

/** The whole geometry of the tree: every line's offsets, position and size, and every page's fragments. */
function geometryOf(env: CdmEnvelopeLike): string {
  return JSON.stringify(layoutFlow(toFlow(env), providers).tree.pages);
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

  it('draws the box at exactly the width on the line, whatever the value (criteria 1 and 2, on the layout)', () => {
    // A paragraph that holds only the field: its one line is as wide as the box.
    const lineWidth = (f: CdmNode): number => {
      const tree = layoutFlow(toFlow(envelope([paragraph('p0', [f])])), providers).tree;
      const frag = tree.pages[0]!.fragments[0]!;
      if (frag.kind !== 'paragraph') throw new Error('not a paragraph');
      expect(frag.lines).toHaveLength(1);
      return frag.lines[0]!.width;
    };
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (value) => {
        expect(lineWidth(field({ width: WIDTH, value }))).toBe(WIDTH / 20);
      }),
      { numRuns: 100 },
    );
    const long = 'Mrs Alexandria Tenant-Hyphenated Longname '.repeat(20);
    expect(lineWidth(field({ width: WIDTH, value: long }))).toBe(WIDTH / 20);
  });

  it('keeps every line and fragment exactly where it is, not only the breaks (criterion 1, geometry)', () => {
    const empty = geometryOf(documentWith(field({ width: WIDTH, value: null })));
    const long = 'Mrs Alexandria Tenant-Hyphenated Longname '.repeat(20);
    expect(geometryOf(documentWith(field({ width: WIDTH, value: long })))).toBe(empty);
    expect(geometryOf(documentWith(field({ width: WIDTH, value: 'Ada' })))).toBe(empty);
  });

  it('gives a field with no width the fixed default of its kind, so the breaks hold too (criterion 3)', () => {
    for (const kind of FIELD_KINDS) {
      const empty = breaksWith(field({ kind, value: null }));
      const long = 'Mrs Alexandria Tenant-Hyphenated Longname '.repeat(20);
      expect(breaksWith(field({ kind, value: long })), kind).toBe(empty);
    }
    const lineWidth = (f: CdmNode): number => {
      const tree = layoutFlow(toFlow(envelope([paragraph('p0', [f])])), providers).tree;
      const frag = tree.pages[0]!.fragments[0]!;
      if (frag.kind !== 'paragraph') throw new Error('not a paragraph');
      return frag.lines[0]!.width;
    };
    for (const kind of FIELD_KINDS)
      expect(lineWidth(field({ kind, value: 'Ada' })), kind).toBe(FIELD_DEFAULT_WIDTH[kind] / 20);
  });

  it('is sensitive to the width, so the comparison would catch a reflow (control)', () => {
    // A wider box moves the breaks. If this stopped holding, the properties above would prove
    // nothing: the document would not be one in which a box can move a break.
    const narrow = geometryOf(documentWith(field({ width: 720 })));
    const wide = geometryOf(documentWith(field({ width: 7200 })));
    expect(wide).not.toBe(narrow);
  });
});
