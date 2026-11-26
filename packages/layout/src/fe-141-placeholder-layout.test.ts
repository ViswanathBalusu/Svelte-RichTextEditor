/**
 * FE-141 criterion 1, the page view's half: a `hidden_region` of a projection is one fixed-size box
 * in the layout, as wide as the column, whatever its title; it is one position (an atom), so a
 * selection holds it whole, and the selection paints it whole (`selectionBoxRects`). Node.js; the
 * painted result in real browsers is in `packages/element/src/fe-141-page-placeholder.universal.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { selectionBoxRects } from './caret.ts';
import { layoutFlow } from './engine.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { firstFitBreaker, type BreakOpportunities, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import type { BoxFragment, LayoutFragment } from './tree.ts';

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

const para = (id: string, text: string): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content: [{ type: 'text', text }],
});

const region = (id: string, title: string | null): CdmNode => ({
  type: 'hidden_region',
  attrs: { id, title },
});

/** A 400 x 320 pt page with 20 pt margins and a 10 pt Normal style. */
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
                width: 8000,
                height: 6400,
                marginTop: 400,
                marginRight: 400,
                marginBottom: 400,
                marginLeft: 400,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

const boxes = (fragments: readonly LayoutFragment[]): BoxFragment[] =>
  fragments.filter((f): f is BoxFragment => f.kind === 'box');

describe('the placeholder of a hidden region in the layout (FE-141 criterion 1)', () => {
  const body = [
    para('pa', 'before the region'),
    region('r1', null),
    region('r2', 'Payroll'),
    region('r3', 'A very long title that would not fit on one line of the column at all, however wide'),
    para('pz', 'after the region'),
  ];
  const flow = toFlow(envelope(body));
  const { tree } = layoutFlow(flow, providers);
  const placed = boxes(tree.pages[0]!.fragments);

  it('makes one placeholder box for each region, with its title', () => {
    const blocks = flow.sections[0]!.blocks.filter((b) => b.kind === 'box');
    expect(blocks.map((b) => (b.kind === 'box' ? [b.id, b.what, b.title] : null))).toEqual([
      ['r1', 'placeholder', null],
      ['r2', 'placeholder', 'Payroll'],
      ['r3', 'placeholder', expect.stringContaining('A very long title')],
    ]);
  });

  it('gives all of them one fixed size, 2.5 times the font size by the column, whatever the title', () => {
    expect(placed.map((b) => b.blockId)).toEqual(['r1', 'r2', 'r3']);
    for (const b of placed) {
      expect(b.height).toBeCloseTo(25, 5);
      expect(b.width).toBeCloseTo(360, 5);
    }
  });

  it('puts them between the paragraphs, in document order, and counts each as one position', () => {
    const order = tree.pages[0]!.fragments.map((f) => f.blockId);
    expect(order).toEqual(['pa', 'r1', 'r2', 'r3', 'pz']);
    for (const b of placed) expect([b.from, b.to]).toEqual([0, 1]);
  });

  it('paints a selection that runs across them as holding them whole, and no other selection', () => {
    const across = selectionBoxRects(tree, { blockId: 'pa', offset: 2 }, { blockId: 'pz', offset: 3 });
    expect(across).toHaveLength(3);
    expect(across.map((r) => r.y)).toEqual(placed.map((b) => b.y));
    // The same selection, taken from the other end.
    expect(
      selectionBoxRects(tree, { blockId: 'pz', offset: 3 }, { blockId: 'pa', offset: 2 }),
    ).toEqual(across);
    // A selection inside one paragraph holds none; one that ends in the paragraph before holds none.
    expect(
      selectionBoxRects(tree, { blockId: 'pa', offset: 1 }, { blockId: 'pa', offset: 5 }),
    ).toEqual([]);
    expect(
      selectionBoxRects(tree, { blockId: 'pz', offset: 1 }, { blockId: 'pz', offset: 5 }),
    ).toEqual([]);
  });
});
