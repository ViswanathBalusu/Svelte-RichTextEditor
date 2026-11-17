/**
 * CDM-043 criterion 5 on the layout side, for the `flows` of the shared fixture
 * `packages/model/fixtures/semantics/paragraph-spacing.json`: whole documents with regions, tables
 * and their cells, a table style, a section break, a figure and an equation, a footnote and a
 * header story. `toFlow` builds the flow; the gap an engine adds between two blocks is the upper
 * block's `spaceAfter` plus the lower block's `spaceBefore`, and at the edge of a container it is
 * the one that is there. Every gap of every container the fixture lists is compared, in twips.
 * Node.js only. Evidence: `pnpm exec vitest run --project node packages/layout/src/cdm-043-flows.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import spacingFile from '../../model/fixtures/semantics/paragraph-spacing.json' with { type: 'json' };
import { toFlow, type CdmEnvelopeLike, type FlowBlock, type FlowDocument } from './flow.ts';

type J = Record<string, unknown>;

interface Gap {
  above: string | null;
  below: string | null;
  gap: number;
}
interface Flow {
  id: string;
  description: string;
  styles?: J[];
  stories?: J[];
  body: J[];
  expected: { container: string; gaps: Gap[] }[];
}
interface Fixture {
  settings: J;
  styles: J[];
  numberings: J[];
  flows: Flow[];
}

const FIXTURE = spacingFile as unknown as Fixture;

function mergeById(base: readonly J[], extra: readonly J[] = []): J[] {
  const out = [...base];
  for (const n of extra) {
    const id = (n['attrs'] as J | undefined)?.['id'];
    const i = out.findIndex((m) => (m['attrs'] as J | undefined)?.['id'] === id);
    if (i >= 0) out[i] = n;
    else out.push(n);
  }
  return out;
}

function envelopeOf(flow: Flow): CdmEnvelopeLike {
  return {
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: FIXTURE.settings },
            ...mergeById(FIXTURE.styles, flow.styles),
            ...FIXTURE.numberings,
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        ...(flow.stories ?? []),
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: flow.body },
      ],
    },
  } as unknown as CdmEnvelopeLike;
}

const twips = (points: number): number => Math.round(points * 20);

/**
 * The gaps of one container, in flow order. Blocks that share an identifier are one block of the
 * document (a figure and its caption, the parts of a split paragraph): the space between them is
 * not a gap between blocks.
 */
function gapsOf(blocks: readonly FlowBlock[]): Gap[] {
  const units: { id: string; before: number; after: number }[] = [];
  for (const b of blocks) {
    if (b.kind === 'pageBreak' || b.kind === 'columnBreak') continue;
    const before = b.kind === 'paragraph' ? b.spaceBefore : 0;
    const after = b.kind === 'paragraph' ? b.spaceAfter : 0;
    const last = units[units.length - 1];
    if (last && last.id === b.id) last.after = after;
    else units.push({ id: b.id, before, after });
  }
  const out: Gap[] = [];
  units.forEach((u, i) => {
    const prev = units[i - 1];
    out.push({ above: prev?.id ?? null, below: u.id, gap: twips((prev?.after ?? 0) + u.before) });
  });
  const last = units[units.length - 1];
  if (last) out.push({ above: last.id, below: null, gap: twips(last.after) });
  return out;
}

/** The blocks of a container: the body, a table cell, a story or a footnote, by identifier. */
function containerBlocks(flow: FlowDocument, container: string): readonly FlowBlock[] {
  const body = flow.sections.flatMap((s) => s.blocks);
  if (container === 'body') return body;
  const story = flow.stories.get(container);
  if (story) return story;
  const note = flow.notes.get(container);
  if (note) return note.blocks;
  const find = (blocks: readonly FlowBlock[]): readonly FlowBlock[] | null => {
    for (const b of blocks) {
      if (b.kind !== 'table') continue;
      for (const row of b.rows)
        for (const cell of row.cells) {
          if (cell.id === container) return cell.blocks;
          const inner = find(cell.blocks);
          if (inner) return inner;
        }
    }
    return null;
  };
  const cell = find(body);
  if (!cell) throw new Error(`the flow has no container ${container}`);
  return cell;
}

describe('CDM-043 criterion 5, layout side: paragraph-spacing.json flows', () => {
  it('runs every flow of the fixture', () => {
    expect(FIXTURE.flows.map((f) => f.id)).toEqual([
      'region-is-transparent',
      'table-and-its-cells',
      'table-style-in-cells',
      'section-break-is-transparent',
      'figure-and-equation',
      'footnote-edges',
      'story-edges',
    ]);
  });

  for (const flow of FIXTURE.flows)
    it(`flow "${flow.id}": ${flow.description}`, () => {
      const made = toFlow(envelopeOf(flow));
      for (const expected of flow.expected)
        expect(gapsOf(containerBlocks(made, expected.container)), expected.container).toEqual(
          expected.gaps,
        );
    });
});
