/**
 * The flow of a field with a `width` is a box of exactly that width, whatever the value is (FRW-080
 * criterion 1, box part; 12 §3.2 `width`). flow.ts (`form_field`) reads the box from `width` alone and
 * does not carry the value into the inline box, so the value cannot change what the layout measures.
 * This test is at the flow level: the layout tree does not expose the width of an inline box, so the
 * exact width of the drawn box on the page is not asserted here. Node.js only.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  toFlow,
  type CdmEnvelopeLike,
  type CdmNode,
  type FlowBlock,
  type FlowInline,
} from './flow.ts';

const WIDTH_TWIPS = 2880; // two inches
const WIDTH_PT = WIDTH_TWIPS / 20; // 144 points

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

const field = (attrs: Record<string, unknown>): CdmNode => ({
  type: 'form_field',
  attrs: { id: 'f1', kind: 'text', label: 'Tenant name', ...attrs },
});

/** The inlines of the paragraph with the given block identifier, from the flow. */
function inlinesOf(blockId: string, field: CdmNode): readonly FlowInline[] {
  const body = [
    paragraph('p0', [text('Before the field ')]),
    paragraph('p1', [text('Before the field '), field, text(' and after it.')]),
  ];
  const flow = toFlow(envelope(body));
  const blocks: readonly FlowBlock[] = flow.sections.flatMap((s) => s.blocks);
  for (const b of blocks) if (b.kind === 'paragraph' && b.id === blockId) return b.inlines;
  throw new Error(`no paragraph ${blockId} in the flow`);
}

describe('a field with a width is a box of that width whatever its value (FRW-080)', () => {
  it('draws one preserved inline box of exactly the width, with a value (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (value) => {
        const boxes = inlinesOf('p1', field({ width: WIDTH_TWIPS, value })).filter(
          (i) => i.kind === 'box',
        );
        expect(boxes).toHaveLength(1);
        const box = boxes[0];
        expect(box).toMatchObject({ kind: 'box', what: 'preserved', width: WIDTH_PT });
      }),
      { numRuns: 100 },
    );
  });

  it('gives the same inlines for every value, so the value cannot change what is measured (property)', () => {
    const empty = inlinesOf('p1', field({ width: WIDTH_TWIPS, value: null }));
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (value) => {
        expect(inlinesOf('p1', field({ width: WIDTH_TWIPS, value }))).toEqual(empty);
      }),
      { numRuns: 100 },
    );
  });

  it('carries the value as text when there is no width (control)', () => {
    // Without a width the value is laid out as text. If this stopped holding, the properties above
    // would prove nothing about the value being left out.
    const withValue = inlinesOf('p1', field({ value: 'Ada-Lovelace' }));
    const texts = withValue.flatMap((i) => (i.kind === 'text' ? [i.text] : []));
    expect(texts.join('')).toContain('Ada-Lovelace');
    expect(withValue.some((i) => i.kind === 'box')).toBe(false);
  });
});
