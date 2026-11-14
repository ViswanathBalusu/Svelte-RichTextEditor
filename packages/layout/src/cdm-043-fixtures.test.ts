/**
 * CDM-043 criterion 5 on the layout side, for the two-paragraph cases of the shared fixture
 * `packages/model/fixtures/semantics/paragraph-spacing.json` (`pairs`). Each pair becomes a body of
 * two paragraphs with the fixture's styles and resolved values; `toFlow` applies contextual spacing
 * and the gap an engine adds is spaceAfter + spaceBefore, in twips. Pairs with a container edge, a
 * table or a footnote are not run here (they need the flow of containers and the footnote story).
 * Node.js only. Evidence: `pnpm exec vitest run packages/layout/src/cdm-043-fixtures.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode, type FlowBlock } from './flow.ts';

interface Side {
  readonly styleId: string;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  readonly contextualSpacing: boolean;
}
interface Pair {
  readonly id: string;
  readonly above: Side | null;
  readonly below: Side | null;
  readonly expected: number;
}
interface Fixture {
  readonly settings: Readonly<Record<string, unknown>>;
  readonly styles: readonly { readonly attrs: Readonly<Record<string, unknown>> }[];
  readonly pairs: readonly Pair[];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../model/fixtures/semantics/paragraph-spacing.json', import.meta.url),
    ),
    'utf8',
  ),
) as Fixture;

/** A paragraph node for one side of a pair: its style plus the resolved values as direct attributes. */
function paragraph(side: Side, n: number): CdmNode {
  return {
    type: 'paragraph',
    attrs: {
      id: `pSpc${String(n).padStart(11, '0')}`,
      style: side.styleId,
      spaceBefore: side.spaceBefore,
      spaceAfter: side.spaceAfter,
      contextualSpacing: side.contextualSpacing,
    },
    content: [{ type: 'text', text: 'Text.' }],
  };
}

/** The body of a pair as an envelope the layout reads. */
function envelopeOf(pair: Pair & { above: Side; below: Side }): CdmEnvelopeLike {
  const defs: CdmNode[] = [
    { type: 'settings', attrs: { ...FIXTURE.settings, defaultTabStop: 720 } },
    ...FIXTURE.styles.map((s) => ({ type: 'style_def', attrs: s.attrs })),
  ];
  return {
    doc: {
      type: 'doc',
      content: [
        { type: 'defs', content: defs },
        { type: 'body', content: [paragraph(pair.above, 1), paragraph(pair.below, 2)] },
      ],
    },
  };
}

/** The gap an engine adds between the two paragraphs of the body, in twips. */
function gapTwips(env: CdmEnvelopeLike): number {
  const blocks: readonly FlowBlock[] = toFlow(env).sections[0]!.blocks;
  const [a, b] = blocks;
  if (a?.kind !== 'paragraph' || b?.kind !== 'paragraph')
    throw new Error('expected two paragraphs');
  return Math.round((a.spaceAfter + b.spaceBefore) * 20);
}

const BODY_PAIRS = FIXTURE.pairs.filter(
  (p): p is Pair & { above: Side; below: Side } =>
    p.above !== null && p.below !== null && p.above.styleId !== 'FootnoteText',
);

describe('CDM-043 criterion 5, layout side: paragraph-spacing.json pairs', () => {
  it('runs every two-paragraph body pair of the fixture', () => {
    expect(BODY_PAIRS.map((p) => p.id)).toEqual([
      'larger-of-the-two',
      'larger-of-the-two-after-wins',
      'contextual-same-style',
      'contextual-different-styles',
      'contextual-only-above',
      'contextual-only-below',
    ]);
  });

  for (const pair of BODY_PAIRS) {
    it(`pair "${pair.id}" gives ${pair.expected} twips`, () => {
      expect(gapTwips(envelopeOf(pair))).toBe(pair.expected);
    });
  }
});
