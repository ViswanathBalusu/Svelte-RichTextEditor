/**
 * A `break` inside a paragraph, from the CDM through the flow (`toFlow`), the item adapter
 * (`documentItems`) and pagination (`paginate`), in Node.js (FE-082 criterion 5).
 *
 * The break opportunities are a test stand-in: a line may end after a space. They are not the
 * Unicode line breaking algorithm, which FE-080 owns. Text is measured by the fixed-width stub
 * (5.5 points a character at 11 points). The random sweep uses a seeded generator.
 */
import { describe, expect, it } from 'vitest';
import { toFlow, type CdmEnvelopeLike, type CdmNode } from './flow.ts';
import {
  documentItems,
  firstFitBreaker,
  type BreakOpportunities,
  type ItemProviders,
} from './items.ts';
import { fixedWidthMeasurer } from './measure.ts';
import { paginate, type PaginatedPage } from './paginate.ts';
import type { ParagraphFragment } from './tree.ts';

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

/** An envelope with one A4 page setup (columns as given) and the body blocks given. */
function envelope(body: CdmNode[], pageAttrs: Record<string, unknown> = {}): CdmEnvelopeLike {
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
                ...pageAttrs,
              },
            },
          ],
        },
        { type: 'body', attrs: { pageSetup: 'ps1' }, content: body },
      ],
    },
  };
}

const text = (t: string): CdmNode => ({ type: 'text', text: t });
const brk = (kind: 'line' | 'page' | 'column'): CdmNode => ({ type: 'break', attrs: { kind } });
const paragraph = (id: string, content: CdmNode[]): CdmNode => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});

/** The pieces of block `id`, in page and fragment order, with the page index of each. */
function piecesOf(
  pages: readonly PaginatedPage[],
  id: string,
): { page: number; frag: ParagraphFragment }[] {
  return pages.flatMap((p, page) =>
    p.fragments
      .filter((f): f is ParagraphFragment => f.kind === 'paragraph' && f.blockId === id)
      .map((frag) => ({ page, frag })),
  );
}

/** The pieces' lines, checked to cover [0, size) in order without gap or overlap. */
function expectContiguous(pieces: readonly { frag: ParagraphFragment }[], size: number): void {
  let at = 0;
  for (const { frag } of pieces) {
    expect(frag.from).toBe(at);
    for (const l of frag.lines) {
      expect(l.from).toBe(at);
      at = l.to;
    }
    expect(frag.to).toBe(at);
  }
  expect(at).toBe(size);
}

function layout(env: CdmEnvelopeLike): PaginatedPage[] {
  const { first, items, unplaced } = documentItems(toFlow(env), providers);
  expect(unplaced).toEqual([]);
  return [...paginate(items, first).pages];
}

describe('a break inside a paragraph, through the flow to pagination (FE-082 criterion 5)', () => {
  it('starts a new page at a page break inside a paragraph', () => {
    // "Before the break." is 17 positions, the break is position 17, and "After it." is 18 to 27.
    const env = envelope([
      paragraph('intro', [text('An opening paragraph.')]),
      paragraph('split', [text('Before the break.'), brk('page'), text('After it.')]),
    ]);
    const pages = layout(env);
    expect(pages).toHaveLength(2);
    const pieces = piecesOf(pages, 'split');
    expect(pieces.map((p) => [p.page, p.frag.from, p.frag.to])).toEqual([
      [0, 0, 18],
      [1, 18, 27],
    ]);
    expectContiguous(pieces, 27);
    // The second piece starts at the top of the body of page 2 (72-point margin).
    expect(pieces[1]!.frag.y).toBe(72);
    // Control: the same text without the break stays on one page.
    const plain = layout(
      envelope([
        paragraph('intro', [text('An opening paragraph.')]),
        paragraph('split', [text('Before the break.After it.')]),
      ]),
    );
    expect(plain).toHaveLength(1);
  });

  it('starts the next column at a column break inside a paragraph', () => {
    // Two columns with a 36-point gap: (451.3 - 36) / 2 = 207.65 points each.
    const env = envelope(
      [paragraph('split', [text('Left column text.'), brk('column'), text('Right column text.')])],
      { columns: 2, columnGap: 720 },
    );
    const pages = layout(env);
    expect(pages).toHaveLength(1);
    const pieces = piecesOf(pages, 'split');
    expect(pieces).toHaveLength(2);
    expect(pieces[0]!.frag.x).toBeCloseTo(72, 9);
    expect(pieces[1]!.frag.x).toBeCloseTo(72 + 207.65 + 36, 9);
    expect(pieces.map((p) => p.frag.y)).toEqual([72, 72]);
    expectContiguous(pieces, 17 + 1 + 18);
  });

  it('keeps a line break inside the paragraph on the same page', () => {
    const pages = layout(
      envelope([paragraph('split', [text('One line.'), brk('line'), text('Next line.')])]),
    );
    expect(pages).toHaveLength(1);
    const pieces = piecesOf(pages, 'split');
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.frag.lines.map((l) => [l.from, l.to])).toEqual([
      [0, 10],
      [10, 20],
    ]);
  });

  it('honours every page and column break of random paragraphs, and the pieces cover each block (property)', () => {
    let s = 8128;
    const next = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    let pageBreaks = 0;
    let columnBreaks = 0;
    for (let trial = 0; trial < 60; trial++) {
      const columns = 1 + Math.floor(next() * 2);
      const blocks: CdmNode[] = [];
      const plans: {
        id: string;
        size: number;
        breaks: { kind: 'page' | 'column'; at: number }[];
      }[] = [];
      const count = 1 + Math.floor(next() * 6);
      for (let b = 0; b < count; b++) {
        const content: CdmNode[] = [];
        const breaks: { kind: 'page' | 'column'; at: number }[] = [];
        let size = 0;
        const parts = 1 + Math.floor(next() * 4);
        for (let k = 0; k < parts; k++) {
          const t =
            Array.from(
              { length: 1 + Math.floor(next() * 120) },
              () => words[Math.floor(next() * words.length)],
            ).join(' ') + ' ';
          content.push(text(t));
          size += t.length;
          if (k + 1 < parts) {
            const kind = next() < 0.5 ? 'page' : 'column';
            content.push(brk(kind));
            size += 1;
            breaks.push({ kind, at: size });
          }
        }
        const id = `p${b}`;
        blocks.push(paragraph(id, content));
        plans.push({ id, size, breaks });
      }
      const pages = layout(envelope(blocks, { columns, columnGap: 720 }));
      for (const plan of plans) {
        const pieces = piecesOf(pages, plan.id);
        expectContiguous(pieces, plan.size);
        for (const b of plan.breaks) {
          // The piece that ends at the break and the one that starts after it.
          const before = pieces.findLast((p) => p.frag.to === b.at)!;
          const after = pieces.find((p) => p.frag.from === b.at)!;
          expect(before).toBeDefined();
          expect(after).toBeDefined();
          const lastColumn = columns === 1 || before.frag.x > 72;
          if (b.kind === 'page' || lastColumn) {
            expect(after.page).toBeGreaterThan(before.page);
            expect(after.frag.y).toBe(72);
            expect(after.frag.x).toBe(72);
          } else {
            expect(after.page).toBe(before.page);
            expect(after.frag.x).toBeGreaterThan(before.frag.x);
            expect(after.frag.y).toBe(72);
          }
          if (b.kind === 'page') pageBreaks++;
          else columnBreaks++;
        }
      }
    }
    expect(pageBreaks).toBeGreaterThan(20);
    expect(columnBreaks).toBeGreaterThan(20);
  });
});
