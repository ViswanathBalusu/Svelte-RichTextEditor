/**
 * CDM-043, open items of the layout side (ADR 0032): (a) the gap rule also applies to paragraphs in
 * table cells and stories, not only to a section's top-level blocks; (b) section breaks are
 * transparent, so spacing runs across them. Node.js only.
 * Evidence: `pnpm exec vitest run packages/layout/src/cdm-043-containers.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode, type FlowParagraph } from './flow.ts';

type Attrs = Readonly<Record<string, unknown>>;

/** Two paragraphs of style Normal with the given spaces: spaceAfter 160, spaceBefore 240. */
const upper: Attrs = { style: 'Normal', spaceAfter: 160 };
const lower: Attrs = { style: 'Normal', spaceBefore: 240 };

function para(id: string, attrs: Attrs, text: string): CdmNode {
  return { type: 'paragraph', attrs: { id, ...attrs }, content: [{ type: 'text', text }] };
}

function envelope(body: CdmNode[], stories: CdmNode[] = []): CdmEnvelopeLike {
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
            { type: 'style_def', attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal' } },
          ],
        },
        { type: 'body', content: body },
        ...stories,
      ],
    },
  };
}

/** The gap an engine adds between two neighbours, in twips (points times 20). */
function gap(a: FlowParagraph, b: FlowParagraph): number {
  return Math.round((a.spaceAfter + b.spaceBefore) * 20);
}

describe('CDM-043 pass (a): paragraphs in table cells follow the gap rule', () => {
  it('gives the larger of spaceAfter and spaceBefore between two paragraphs in one cell', () => {
    const table: CdmNode = {
      type: 'table',
      attrs: { id: 'tCell1', grid: [4000] },
      content: [
        {
          type: 'table_row',
          attrs: {},
          content: [
            {
              type: 'table_cell',
              attrs: {},
              content: [para('cA', upper, 'First.'), para('cB', lower, 'Second.')],
            },
          ],
        },
      ],
    };
    const flow = toFlow(envelope([table]));
    const t = flow.sections[0]!.blocks[0];
    expect(t?.kind).toBe('table');
    if (t?.kind !== 'table') return;
    const cell = t.rows[0]!.cells[0]!.blocks.filter(
      (b): b is FlowParagraph => b.kind === 'paragraph',
    );
    expect(cell).toHaveLength(2);
    expect(gap(cell[0]!, cell[1]!)).toBe(240);
  });
});

describe('CDM-043 pass (a): paragraphs in a story follow the gap rule', () => {
  it('gives the larger of spaceAfter and spaceBefore between two paragraphs in a story', () => {
    const story: CdmNode = {
      type: 'story',
      attrs: { id: 'hdrA' },
      content: [para('sA', upper, 'Header line.'), para('sB', lower, 'Second line.')],
    };
    const flow = toFlow(envelope([para('bodyP', {}, 'Body.')], [story]));
    const blocks = flow.stories.get('hdrA') ?? [];
    const ps = blocks.filter((b): b is FlowParagraph => b.kind === 'paragraph');
    expect(ps).toHaveLength(2);
    expect(gap(ps[0]!, ps[1]!)).toBe(240);
  });
});

describe('CDM-043 pass (b): section breaks are transparent', () => {
  it('gives the larger-of gap across a continuous section break', () => {
    const flow = toFlow(
      envelope([
        para('sec1', upper, 'Before the break.'),
        { type: 'section_break', attrs: { id: 'brk1', start: 'continuous' } },
        para('sec2', lower, 'After the break.'),
      ]),
    );
    const before = flow.sections[0]!.blocks.filter(
      (b): b is FlowParagraph => b.kind === 'paragraph',
    );
    const after = flow.sections[1]!.blocks.filter(
      (b): b is FlowParagraph => b.kind === 'paragraph',
    );
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(gap(before[0]!, after[0]!)).toBe(240);
  });

  it('gives the same gap across a next-page section break as without the break', () => {
    const withBreak = toFlow(
      envelope([
        para('nA', upper, 'One.'),
        { type: 'section_break', attrs: { id: 'brk2', start: 'nextPage' } },
        para('nB', lower, 'Two.'),
      ]),
    );
    const without = toFlow(envelope([para('nA', upper, 'One.'), para('nB', lower, 'Two.')]));
    const a = withBreak.sections[0]!.blocks.filter(
      (b): b is FlowParagraph => b.kind === 'paragraph',
    )[0]!;
    const b = withBreak.sections[1]!.blocks.filter(
      (x): x is FlowParagraph => x.kind === 'paragraph',
    )[0]!;
    const flat = without.sections[0]!.blocks.filter(
      (x): x is FlowParagraph => x.kind === 'paragraph',
    );
    expect(gap(a, b)).toBe(gap(flat[0]!, flat[1]!));
    expect(gap(a, b)).toBe(240);
  });
});
