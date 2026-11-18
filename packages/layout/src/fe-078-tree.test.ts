/**
 * FE-078 criteria 2 and 4. Criterion 2: every node of the layout tree records the block it belongs
 * to and the CDM offsets it covers, for pages, paragraph fragments and lines, tables, rows and
 * cells, and boxes. Criterion 4: a tree from the incremental layout shares the previous tree's
 * objects wherever nothing changed, so that a painter can tell by identity what to skip (FE-092).
 */
import { describe, expect, it } from 'vitest';
import { layoutFlow } from './engine.ts';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import { incrementalLayout } from './incremental.ts';
import { firstFitBreaker, type BreakOpportunities, type ItemProviders } from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import { shareSubtrees } from './tree-share.ts';
import type { LayoutFragment, LayoutTree, ParagraphFragment } from './tree.ts';

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

/** A 200 x 160 pt page with no margins, so that the blocks below fill several pages. */
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
                width: 4000,
                height: 3200,
                marginTop: 0,
                marginRight: 0,
                marginBottom: 0,
                marginLeft: 0,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

const cell = (id: string, text: string): CdmNode => ({
  type: 'table_cell',
  attrs: { id },
  content: [para(`${id}p`, text)],
});
const row = (id: string, texts: string[]): CdmNode => ({
  type: 'table_row',
  attrs: { id },
  content: texts.map((t, i) => cell(`${id}c${i}`, t)),
});
const table = (id: string, rows: number): CdmNode => ({
  type: 'table',
  attrs: { id, grid: [2000, 2000] },
  content: Array.from({ length: rows }, (_, r) => row(`${id}r${r}`, [`left ${r}`, `right ${r}`])),
});

const mixedBody = (): CdmNode[] => [
  ...Array.from({ length: 6 }, (_, i) => para(`pa${i}`, `before ${i} words to wrap onto lines`)),
  table('tbl', 14),
  { type: 'equation_block', attrs: { id: 'eq1', latex: 'x' } },
  {
    type: 'figure',
    attrs: { id: 'fig1', width: 1600, height: 1600 },
    content: [{ type: 'caption', content: [{ type: 'text', text: 'Figure' }] }],
  },
  ...Array.from({ length: 6 }, (_, i) => para(`pz${i}`, `after ${i} words to wrap onto lines`)),
];

/** Every fragment of a list, with the fragments of the cells under it. */
function* allFragments(fragments: readonly LayoutFragment[]): Generator<LayoutFragment> {
  for (const f of fragments) {
    yield f;
    if (f.kind === 'table')
      for (const r of f.rows) for (const c of r.cells) yield* allFragments(c.fragments);
  }
}

describe('every node records its block and offsets (FE-078 criterion 2)', () => {
  const { tree } = layoutFlow(toFlow(envelope(mixedBody())), providers);

  it('lays the document out on several pages, with a table split across them', () => {
    expect(tree.pages.length).toBeGreaterThan(2);
    const tablePages = tree.pages.filter((p) => p.fragments.some((f) => f.kind === 'table'));
    expect(tablePages.length).toBeGreaterThan(1);
  });

  it('gives each page the place where its body starts and ends', () => {
    for (const page of tree.pages) {
      expect(page.start, `page ${page.index}`).toBeTruthy();
      expect(page.end, `page ${page.index}`).toBeTruthy();
      expect(page.start?.blockId).toBe(page.fragments[0]!.blockId);
      expect(page.end?.blockId).toBe(page.fragments[page.fragments.length - 1]!.blockId);
      expect(Number.isInteger(page.start?.offset)).toBe(true);
      expect(Number.isInteger(page.end?.offset)).toBe(true);
    }
    expect(tree.pages[0]!.start).toEqual({ blockId: 'pa0', offset: 0 });
    expect(tree.pages[tree.pages.length - 1]!.end?.blockId).toBe('pz5');
  });

  it('gives every fragment, row, cell and line a block identifier and a range', () => {
    let tables = 0;
    let rows = 0;
    let boxes = 0;
    for (const page of tree.pages)
      for (const f of allFragments(page.fragments)) {
        expect(f.blockId).toMatch(/\S/);
        expect(Number.isInteger(f.from), `${f.kind} ${f.blockId} from`).toBe(true);
        expect(Number.isInteger(f.to), `${f.kind} ${f.blockId} to`).toBe(true);
        expect(f.from! <= f.to!).toBe(true);
        if (f.kind === 'paragraph') {
          for (const line of f.lines) expect(line.from >= f.from && line.to <= f.to).toBe(true);
        } else if (f.kind === 'box') {
          boxes++;
        } else {
          tables++;
          for (const r of f.rows) {
            rows++;
            expect(Number.isInteger(r.from) && Number.isInteger(r.to), r.rowId).toBe(true);
            expect(r.from! >= f.from! && r.to! <= f.to!).toBe(true);
            for (const c of r.cells) {
              expect(Number.isInteger(c.from) && Number.isInteger(c.to), c.cellId).toBe(true);
              expect(c.from! >= r.from! && c.to! <= r.to!).toBe(true);
            }
          }
        }
      }
    expect(tables).toBeGreaterThan(1);
    expect(rows).toBeGreaterThanOrEqual(14);
    expect(boxes).toBeGreaterThanOrEqual(2);
  });

  it('covers a table, by the ranges of its fragments, from its first position to its end', () => {
    const pieces = tree.pages.flatMap((p) => p.fragments).filter((f) => f.blockId === 'tbl');
    // A row is 2 positions and two cells; a cell is 2 positions and one paragraph of 2 + text.
    const rowSize = (r: number): number => 2 + 2 * (2 + 2 + `left ${r}`.length) + 0;
    let size = 0;
    for (let r = 0; r < 14; r++)
      size += 2 + (2 + 2 + `left ${r}`.length) + (2 + 2 + `right ${r}`.length);
    expect(rowSize(0)).toBeGreaterThan(0);
    const first = pieces[0]!;
    const last = pieces[pieces.length - 1]!;
    expect(first.kind === 'table' && first.from).toBe(0);
    expect(last.kind === 'table' && last.to).toBe(size);
    // The rows of the pieces, header copies aside, are in order and meet without a gap.
    const laid = pieces.flatMap((p) => (p.kind === 'table' ? p.rows : []));
    for (let i = 1; i < laid.length; i++) {
      const [a, b] = [laid[i - 1]!, laid[i]!];
      if (b.repeated) continue;
      expect(b.from === a.to || b.rowId === a.rowId, `${a.rowId} to ${b.rowId}`).toBe(true);
    }
  });

  it('records the range of a box as 0 to its content size, or 1 for an atom', () => {
    const boxes = tree.pages.flatMap((p) => p.fragments).filter((f) => f.kind === 'box');
    const eq = boxes.find((b) => b.blockId === 'eq1');
    expect([eq?.from, eq?.to]).toEqual([0, 1]);
    const fig = boxes.find((b) => b.blockId === 'fig1');
    expect(fig?.from).toBe(0);
    expect(fig?.to).toBe(2 + 'Figure'.length);
  });

  it('is part of the stable serialisation', () => {
    const again = layoutFlow(toFlow(envelope(mixedBody())), providers).tree;
    expect(JSON.stringify(again.pages)).toBe(JSON.stringify(tree.pages));
    expect(JSON.stringify(tree.pages[0])).toContain('"start":{"blockId":"pa0","offset":0}');
  });
});

describe('a tree shares what did not change with the one before (FE-078 criterion 4)', () => {
  const paragraphs = (n: number, edit?: { at: number; text: string }): CdmNode[] =>
    Array.from({ length: n }, (_, i) =>
      para(`p${i}`, edit && edit.at === i ? edit.text : `paragraph ${i} with some words to set`),
    );
  const fragmentOf = (tree: LayoutTree, id: string): ParagraphFragment => {
    for (const page of tree.pages)
      for (const f of page.fragments) if (f.kind === 'paragraph' && f.blockId === id) return f;
    throw new Error(`no fragment ${id}`);
  };

  it('returns the same objects for a document that did not change', () => {
    const layout = incrementalLayout(providers);
    const first = layout.update(toFlow(envelope(paragraphs(40))));
    const second = layout.update(toFlow(envelope(paragraphs(40))));
    expect(second.tree).toBe(first.tree);
    expect(second.tree.pages).toBe(first.tree.pages);
  });

  it('keeps the objects before an edit and the lines of blocks that only moved', () => {
    const layout = incrementalLayout(providers);
    const first = layout.update(toFlow(envelope(paragraphs(40)))).tree;
    // A paragraph in the middle grows by lines; the ones before it are untouched.
    const long = 'edited '.repeat(30);
    const second = layout.update(
      toFlow(envelope(paragraphs(40, { at: 20, text: long }))),
      new Set(['p20']),
    ).tree;
    expect(first.pages.length).toBeGreaterThan(2);
    expect(second.pages[0]).toBe(first.pages[0]);
    for (let i = 0; i < 20; i++)
      expect(fragmentOf(second, `p${i}`)).toBe(fragmentOf(first, `p${i}`));
    expect(fragmentOf(second, 'p20')).not.toBe(fragmentOf(first, 'p20'));
    // A paragraph after the edit moved: its fragment is a new object, and its lines are the old ones.
    const before = fragmentOf(first, 'p30');
    const after = fragmentOf(second, 'p30');
    expect(after).not.toBe(before);
    expect(after.lines).toBe(before.lines);
    expect(second).not.toBe(first);
  });

  it('takes nothing from no previous tree, and does not change either input', () => {
    const { tree } = layoutFlow(toFlow(envelope(paragraphs(10))), providers);
    expect(shareSubtrees(null, tree)).toEqual(tree);
    const other = layoutFlow(
      toFlow(envelope(paragraphs(10, { at: 3, text: 'x' }))),
      providers,
    ).tree;
    const before = JSON.stringify(tree.pages);
    const shared = shareSubtrees(tree, other);
    expect(JSON.stringify(tree.pages)).toBe(before);
    expect(JSON.stringify(shared.pages)).toBe(JSON.stringify(other.pages));
    expect(Object.isFrozen(shared)).toBe(true);
  });
});
