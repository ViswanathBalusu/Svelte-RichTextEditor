/**
 * CDM-043 criterion 2 on the layout side: contextual spacing is per side (ADR 0032), as
 * `paragraphGap` in `@docedit/model` computes it. Two paragraphs of one style that both have
 * contextualSpacing have no gap; if only one has it, the other keeps its own space; for different
 * styles the larger-of rule applies. Node.js only.
 * Evidence: `pnpm exec vitest run packages/layout/src/cdm-043-contextual.test.ts`.
 */
import { paragraphGap } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode, type FlowParagraph } from './flow.ts';

type Attrs = Readonly<Record<string, unknown>>;

/** A body of paragraphs with the given direct attributes; each needs its own `style`. */
function body(...paragraphs: Attrs[]): CdmEnvelopeLike {
  const doc: CdmNode = {
    type: 'doc',
    content: [
      {
        type: 'defs',
        content: [
          {
            type: 'settings',
            attrs: { lang: 'en-GB', defaultTabStop: 720, defaultParagraphStyle: 'Normal' },
          },
          { type: 'style_def', attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal' } },
          {
            type: 'style_def',
            attrs: { id: 'Quote', kind: 'paragraph', name: 'Quote', basedOn: 'Normal' },
          },
        ],
      },
      {
        type: 'body',
        content: paragraphs.map((attrs, i) => ({
          type: 'paragraph',
          attrs: { id: `pCtxGap${String(i).padStart(9, '0')}`, ...attrs },
          content: [{ type: 'text', text: `Paragraph ${i}.` }],
        })),
      },
    ],
  };
  return { doc };
}

function paragraphs(env: CdmEnvelopeLike): FlowParagraph[] {
  return toFlow(env).sections[0]!.blocks.filter((b): b is FlowParagraph => b.kind === 'paragraph');
}

/** The gaps an engine adds between neighbours, in twips (points times 20). */
function gaps(env: CdmEnvelopeLike): number[] {
  const ps = paragraphs(env);
  return ps.slice(1).map((b, i) => Math.round((ps[i]!.spaceAfter + b.spaceBefore) * 20));
}

/** The gap `paragraphGap` gives for two direct-attribute paragraphs, in twips. */
function modelGap(a: Attrs, b: Attrs): number {
  const side = (p: Attrs) => ({
    styleId: String(p['style']),
    spaceBefore: Number(p['spaceBefore'] ?? 0),
    spaceAfter: Number(p['spaceAfter'] ?? 0),
    contextualSpacing: p['contextualSpacing'] === true,
  });
  return paragraphGap(side(a), side(b));
}

const cases: [string, Attrs, Attrs][] = [
  [
    'same style, both contextual',
    { style: 'Normal', spaceAfter: 160, contextualSpacing: true },
    { style: 'Normal', spaceBefore: 240, contextualSpacing: true },
  ],
  [
    'same style, only the upper one contextual',
    { style: 'Normal', spaceAfter: 160, contextualSpacing: true },
    { style: 'Normal', spaceBefore: 240 },
  ],
  [
    'same style, only the lower one contextual',
    { style: 'Normal', spaceAfter: 160 },
    { style: 'Normal', spaceBefore: 240, contextualSpacing: true },
  ],
  [
    'different styles, both contextual',
    { style: 'Normal', spaceAfter: 160, contextualSpacing: true },
    { style: 'Quote', spaceBefore: 240, contextualSpacing: true },
  ],
];

describe('CDM-043 criterion 2 in the layout flow: contextual spacing per side', () => {
  it.each(cases)('%s matches paragraphGap', (_name, a, b) => {
    expect(gaps(body(a, b))).toEqual([modelGap(a, b)]);
  });

  it('gives zero for two paragraphs of one style that both have it', () => {
    expect(gaps(body(cases[0]![1], cases[0]![2]))).toEqual([0]);
  });

  it('keeps the lower spaceBefore when only the upper one has it', () => {
    expect(gaps(body(cases[1]![1], cases[1]![2]))).toEqual([240]);
  });

  it('keeps the upper spaceAfter when only the lower one has it', () => {
    expect(gaps(body(cases[2]![1], cases[2]![2]))).toEqual([160]);
  });

  it('uses the larger-of rule for different styles', () => {
    expect(gaps(body(cases[3]![1], cases[3]![2]))).toEqual([240]);
  });

  it('collapses a run of three contextual paragraphs of one style', () => {
    const p = { style: 'Normal', spaceBefore: 120, spaceAfter: 200, contextualSpacing: true };
    const ps = paragraphs(body(p, p, p));
    expect(gaps(body(p, p, p))).toEqual([0, 0]);
    // The container edges keep their spacing (ADR 0032).
    expect(ps[0]!.spaceBefore).toBe(6);
    expect(ps[2]!.spaceAfter).toBe(10);
  });
});
