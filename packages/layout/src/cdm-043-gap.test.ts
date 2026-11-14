/**
 * CDM-043 criterion 1 on the layout side: the gap between two adjacent paragraphs is the larger of
 * the first one's spaceAfter and the second one's spaceBefore (03 §7). Engines add the two values,
 * so the flow must leave the sum equal to that larger value. Node.js only.
 * Evidence: `pnpm exec vitest run packages/layout/src/cdm-043-gap.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode, type FlowBlock } from './flow.ts';

/** A body of two paragraphs in the Normal style with the given direct attributes. */
function twoParagraphs(
  first: Readonly<Record<string, unknown>>,
  second: Readonly<Record<string, unknown>>,
): CdmEnvelopeLike {
  const doc: CdmNode = {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [{ type: 'settings', attrs: { lang: 'en-GB', defaultTabStop: 720 } }],
      },
      {
        type: 'body',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'pGapFirst0000001', style: 'Normal', ...first },
            content: [{ type: 'text', text: 'First.' }],
          },
          {
            type: 'paragraph',
            attrs: { id: 'pGapSecond000002', style: 'Normal', ...second },
            content: [{ type: 'text', text: 'Second.' }],
          },
        ],
      },
    ],
  };
  return { doc };
}

/** The two paragraph blocks of the body, in order. */
function paragraphBlocks(env: CdmEnvelopeLike): [FlowBlock, FlowBlock] {
  const blocks = toFlow(env).sections[0]!.blocks;
  const [a, b] = blocks;
  if (a?.kind !== 'paragraph' || b?.kind !== 'paragraph')
    throw new Error('expected two paragraphs');
  return [a, b];
}

/** The gap an engine adds between the two paragraphs, in points (twips / 20). */
function gapPt(env: CdmEnvelopeLike): number {
  const [a, b] = paragraphBlocks(env);
  if (a?.kind !== 'paragraph' || b?.kind !== 'paragraph') throw new Error('unreachable');
  return a.spaceAfter + b.spaceBefore;
}

describe('CDM-043 criterion 1 in the layout flow: the larger of spaceAfter and spaceBefore', () => {
  it('gives 240 twips (12 pt) for spaceAfter 160 and spaceBefore 240', () => {
    expect(gapPt(twoParagraphs({ spaceAfter: 160 }, { spaceBefore: 240 }))).toBe(12);
  });

  it('gives 240 twips (12 pt) for spaceAfter 240 and spaceBefore 160', () => {
    expect(gapPt(twoParagraphs({ spaceAfter: 240 }, { spaceBefore: 160 }))).toBe(12);
  });

  it('keeps each paragraph own spacing when the other side is zero', () => {
    expect(gapPt(twoParagraphs({ spaceAfter: 160 }, {}))).toBe(8);
    expect(gapPt(twoParagraphs({}, { spaceBefore: 240 }))).toBe(12);
  });

  it('leaves the lower paragraph spaceBefore as written', () => {
    const [, b] = paragraphBlocks(twoParagraphs({ spaceAfter: 160 }, { spaceBefore: 240 }));
    expect(b.kind === 'paragraph' && b.spaceBefore).toBe(12);
  });
});
