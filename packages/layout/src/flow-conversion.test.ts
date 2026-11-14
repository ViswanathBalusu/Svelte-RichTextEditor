/**
 * FE-077 criteria 4 and 5: line spacing and tab stops are carried as 03 §7 defines them, and tables,
 * figures, equations and a table of contents each become flow blocks. Node.js only.
 */
import kitchenSink from '@docedit/model/fixtures/kitchen-sink.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode, type FlowBlock } from './flow.ts';

/** A one-paragraph document with the given direct paragraph attributes. */
function oneParagraph(attrs: Readonly<Record<string, unknown>>): CdmEnvelopeLike {
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
            attrs: { id: 'pSpacing0000000a', style: 'Normal', ...attrs },
            content: [{ type: 'text', text: 'Text.' }],
          },
        ],
      },
    ],
  };
  return { doc };
}

/** The first body paragraph of a one-paragraph document, as a flow block. */
function firstParagraph(attrs: Readonly<Record<string, unknown>>) {
  const block = toFlow(oneParagraph(attrs)).sections[0]!.blocks[0];
  if (block?.kind !== 'paragraph') throw new Error('expected a paragraph block');
  return block;
}

/** Every block of a flow, with the blocks inside table cells, depth first. */
function allBlocks(blocks: readonly FlowBlock[]): FlowBlock[] {
  return blocks.flatMap((b) => {
    if (b.kind !== 'table') return [b];
    return [b, ...b.rows.flatMap((r) => r.cells.flatMap((c) => allBlocks(c.blocks)))];
  });
}

describe('FE-077 criterion 4: line spacing as 03 §7 defines it', () => {
  it('reads a multiple rule as a factor of thousandths (1000 is single spacing)', () => {
    expect(firstParagraph({ lineSpacing: 1500, lineRule: 'multiple' }).line).toEqual({
      rule: 'multiple',
      factor: 1.5,
    });
  });

  it('reads an exact rule and an atLeast rule in twips, as points', () => {
    expect(firstParagraph({ lineSpacing: 360, lineRule: 'exact' }).line).toEqual({
      rule: 'exact',
      pt: 18,
    });
    expect(firstParagraph({ lineSpacing: 300, lineRule: 'atLeast' }).line).toEqual({
      rule: 'atLeast',
      pt: 15,
    });
  });
});

describe('FE-077 criterion 4: tab stops as 03 §7 defines them', () => {
  it('carries left, centre, right and decimal stops with their leaders, sorted by position', () => {
    const p = firstParagraph({
      tabs: [
        { position: 4320, align: 'decimal', leader: 'dot' },
        { position: 720, align: 'left', leader: 'none' },
        { position: 2160, align: 'center', leader: 'underscore' },
        { position: 8640, align: 'right', leader: 'heavy' },
        { position: 5040, align: 'left', leader: 'hyphen' },
        { position: 6480, align: 'left', leader: 'middleDot' },
      ],
    });
    expect(p.tabs).toEqual([
      { position: 36, align: 'left', leader: 'none' },
      { position: 108, align: 'center', leader: 'underscore' },
      { position: 216, align: 'decimal', leader: 'dot' },
      { position: 252, align: 'left', leader: 'hyphen' },
      { position: 324, align: 'left', leader: 'middleDot' },
      { position: 432, align: 'right', leader: 'heavy' },
    ]);
  });

  it('carries the decimal stop with a dot leader from the kitchen-sink fixture', () => {
    const flow = toFlow(kitchenSink as CdmEnvelopeLike);
    const stops = flow.sections
      .flatMap((s) => allBlocks(s.blocks))
      .flatMap((b) => (b.kind === 'paragraph' ? b.tabs : []));
    expect(stops).toContainEqual({ position: 216, align: 'decimal', leader: 'dot' });
  });
});

describe('FE-077 criterion 5: tables, figures, equations and contents become flow blocks', () => {
  const blocks = toFlow(kitchenSink as CdmEnvelopeLike).sections.flatMap((s) =>
    allBlocks(s.blocks),
  );

  it('converts a table into a table block with rows and cells', () => {
    const table = blocks.find((b) => b.kind === 'table');
    if (table?.kind !== 'table') throw new Error('expected a table block');
    expect(table.rows.length).toBeGreaterThan(0);
    const cells = table.rows.flatMap((r) => r.cells);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.some((c) => c.blocks.length > 0)).toBe(true);
  });

  it('converts a figure and a display equation into box blocks', () => {
    const boxes = blocks.flatMap((b) => (b.kind === 'box' ? [b.what] : []));
    expect(boxes).toContain('figure');
    expect(boxes).toContain('equation');
  });

  it('replaces the contents placeholder by generated entry paragraphs', () => {
    const generated = blocks.filter((b) => b.kind === 'paragraph' && b.generated);
    expect(generated.length).toBeGreaterThan(0);
    const placeholder = blocks.some(
      (b) => b.kind === 'box' && b.what === 'extension' && b.id.startsWith('tocMain'),
    );
    expect(placeholder).toBe(false);
  });
});
