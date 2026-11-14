/**
 * Headers and footers (FE-087) and columns (FE-085), in Node.js. Paragraphs are built from their
 * line heights, as in `paginate.test.ts`. The stories are paragraph fragments whose block identifier
 * spells the text they show, so a test reads the page's header or footer by its identifier. The
 * random sweep uses a seeded generator, so every run is repeatable.
 */
import { describe, expect, it } from 'vitest';
import {
  paginate,
  type PageItem,
  type PageMargins,
  type PageSetup,
  type ParagraphItem,
  type StoryFactory,
} from './paginate.ts';
import type { LayoutFragment, ParagraphFragment } from './tree.ts';

const EPS = 1e-6;
const NO_MARGINS: PageMargins = { top: 0, right: 0, bottom: 0, left: 0 };

const body = (height: number, over: Partial<PageSetup> = {}): PageSetup => ({
  width: 80,
  height,
  margins: NO_MARGINS,
  ...over,
});

function para(
  id: string,
  heights: readonly number[],
  over: Partial<Omit<ParagraphItem, 'kind' | 'fragment'>> = {},
): ParagraphItem {
  let y = 0;
  let offset = 0;
  const lines = heights.map((height) => {
    const line = { from: offset, to: offset + 10, x: 0, y, width: 50, height };
    y += height;
    offset += 10;
    return line;
  });
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    blockId: id,
    from: 0,
    to: offset,
    x: 0,
    y: 0,
    width: 100,
    height: y,
    lines,
  };
  return {
    kind: 'paragraph',
    fragment,
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: false,
    keepLines: false,
    pageBreakBefore: false,
    widowControl: false,
    ...over,
  };
}

/** A story of one paragraph of height `height` whose block identifier is `text`. */
const story =
  (text: string, height: number): StoryFactory =>
  () => ({
    height,
    fragments: [
      {
        kind: 'paragraph',
        blockId: text,
        from: 0,
        to: 0,
        x: 0,
        y: 0,
        width: 10,
        height,
        lines: [],
      } satisfies ParagraphFragment,
    ],
  });

/** The block identifier of the story fragments on a page. */
const storyText = (fragments: readonly LayoutFragment[]): string[] =>
  fragments.map((f) => f.blockId);

const pieceCount = (
  pages: ReadonlyArray<{ fragments: readonly LayoutFragment[] }>,
  id: string,
): number =>
  pages.reduce(
    (n, p) => n + p.fragments.filter((f) => f.kind === 'paragraph' && f.blockId === id).length,
    0,
  );

/** Many one-line paragraphs, enough for `pages` pages of a 100-point body with 10-point lines. */
const filler = (count: number): PageItem[] =>
  Array.from({ length: count }, (_, i) => para(`f${i}`, [10, 10, 10, 10, 10, 10, 10, 10, 10, 10]));

describe('headers and footers (FE-087)', () => {
  it('uses the variant each page names from the default, first and even stories of 03 §4.1 (criterion 1)', () => {
    // The CDM page setup has no odd story: odd pages after the first take the default one.
    const setup = body(100, {
      margins: { top: 20, right: 0, bottom: 20, left: 0 },
      differentFirstPage: true,
      differentOddEven: true,
      headers: {
        default: story('default', 10),
        first: story('first', 10),
        even: story('even', 10),
      },
      footers: {
        default: story('foot', 10),
        first: story('foot-first', 10),
        even: story('foot-even', 10),
      },
    });
    const { pages, pageCountSettled } = paginate(filler(12), setup);
    expect(pages.length).toBeGreaterThanOrEqual(4);
    expect(pageCountSettled).toBe(true);
    expect(storyText(pages[0]!.header)).toEqual(['first']);
    expect(storyText(pages[0]!.footer)).toEqual(['foot-first']);
    for (const p of pages.slice(1)) {
      const even = p.number % 2 === 0;
      expect(storyText(p.header)).toEqual([even ? 'even' : 'default']);
      expect(storyText(p.footer)).toEqual([even ? 'foot-even' : 'foot']);
    }
    // The odd pages after the first are there, so the default story is really used.
    expect(pages.slice(1).some((p) => p.number % 2 === 1)).toBe(true);
  });

  it('uses the even story only under differentOddEven, and the first story only under differentFirstPage', () => {
    const stories = {
      default: story('default', 10),
      first: story('first', 10),
      even: story('even', 10),
    };
    const margins = { top: 20, right: 0, bottom: 20, left: 0 };
    const plain = paginate(filler(12), body(100, { margins, headers: stories }));
    expect(plain.pages.every((p) => storyText(p.header).join() === 'default')).toBe(true);
    const oddEven = paginate(
      filler(12),
      body(100, { margins, differentOddEven: true, headers: stories }),
    );
    oddEven.pages.forEach((p) =>
      expect(storyText(p.header)).toEqual([p.number % 2 === 0 ? 'even' : 'default']),
    );
  });

  it('leaves even pages bare when differentOddEven is set and there is no even story', () => {
    const setup = body(100, {
      margins: { top: 20, right: 0, bottom: 20, left: 0 },
      differentOddEven: true,
      headers: { default: story('default', 10) },
    });
    const { pages } = paginate(filler(12), setup);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    pages.forEach((p) =>
      expect(storyText(p.header)).toEqual(p.number % 2 === 0 ? [] : ['default']),
    );
  });

  it('uses the default header when no variant is set, and leaves the page bare when the variant is missing', () => {
    const plain = body(100, {
      margins: { top: 20, right: 0, bottom: 20, left: 0 },
      headers: { default: story('default', 10) },
    });
    const a = paginate(filler(12), plain);
    expect(a.pages.every((p) => storyText(p.header).join() === 'default')).toBe(true);

    // The first page of a section with a different first page and no first header has none.
    const missing = body(100, {
      margins: { top: 20, right: 0, bottom: 20, left: 0 },
      differentFirstPage: true,
      headers: { default: story('default', 10) },
    });
    const b = paginate(filler(12), missing);
    expect(b.pages[0]!.header).toEqual([]);
    expect(storyText(b.pages[1]!.header)).toEqual(['default']);
  });

  it('pushes the body down when a header is taller than the space its page setup gives it (criterion 2)', () => {
    // Top margin 10 and header distance 5: the header ends at 35, so the body starts there.
    const setup = body(100, {
      margins: { top: 10, right: 0, bottom: 10, left: 0 },
      headerDistance: 5,
      headers: { default: story('tall', 30) },
    });
    const { pages } = paginate([para('a', [10])], setup);
    const a = pages[0]!.fragments[0] as ParagraphFragment;
    expect(a.y).toBe(35);
  });

  it('keeps a short header inside the top margin, so the body does not move', () => {
    const setup = body(100, {
      margins: { top: 10, right: 0, bottom: 10, left: 0 },
      headerDistance: 5,
      headers: { default: story('short', 2) },
    });
    const { pages } = paginate([para('a', [10])], setup);
    expect((pages[0]!.fragments[0] as ParagraphFragment).y).toBe(10);
  });

  it('pushes the body up from a tall footer and leaves room for the footer distance', () => {
    // Bottom margin 10 and footer distance 5 with a 20-point footer: the body ends at 75.
    const setup = body(100, {
      margins: { top: 0, right: 0, bottom: 10, left: 0 },
      footerDistance: 5,
      footers: { default: story('foot', 20) },
    });
    // The body runs from 0 to 75: five lines of 10 stay on one page.
    const five = paginate([para('a', [10, 10, 10, 10, 10])], setup);
    expect(five.pages).toHaveLength(1);
    // Eight lines do not: seven fit between 0 and 75, and the eighth moves to the next page.
    const eight = paginate([para('a', [10, 10, 10, 10, 10, 10, 10, 10])], setup);
    expect(
      eight.pages.map((p) => p.fragments.map((f) => (f as ParagraphFragment).lines.length)),
    ).toEqual([[7], [1]]);
  });

  it('places headers and footers at their distances from the page edges (criterion 4)', () => {
    const setup = body(100, {
      margins: { top: 30, right: 0, bottom: 30, left: 7 },
      headerDistance: 6,
      footerDistance: 9,
      headers: { default: story('h', 4) },
      footers: { default: story('f', 5) },
    });
    const page = paginate([para('a', [10])], setup).pages[0]!;
    const header = page.header[0] as ParagraphFragment;
    const footer = page.footer[0] as ParagraphFragment;
    expect(header.y).toBe(6);
    expect(footer.y + footer.height).toBeCloseTo(100 - 9, 9);
    expect(header.x).toBe(7);
  });

  it('gives the story fields the page number and the document page count (criterion 3, layout side)', () => {
    const footer: StoryFactory = (ctx) => ({
      height: 10,
      fragments: [
        {
          kind: 'paragraph',
          blockId: `${ctx.label} of ${ctx.pageCount}`,
          from: 0,
          to: 0,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          lines: [],
        } satisfies ParagraphFragment,
      ],
    });
    const setup = body(100, { footers: { default: footer } });
    const { pages, pageCountSettled } = paginate(filler(6), setup);
    expect(pageCountSettled).toBe(true);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((p, i) => expect(storyText(p.footer)).toEqual([`${i + 1} of ${pages.length}`]));
  });

  it('reports an unsettled page count instead of looping (bounded passes)', () => {
    // Three one-line-high pages with a 90-point footer; a count of 3 drops the footer and gives one
    // page; a count of 1 brings the footer back and gives three pages. The count never agrees.
    const footer: StoryFactory = (ctx) => ({ height: ctx.pageCount === 3 ? 0 : 90, fragments: [] });
    const setup = body(100, { footers: { default: footer } });
    const result = paginate([para('a', [10, 10, 10])], setup);
    expect(result.pageCountSettled).toBe(false);
    expect(Object.isFrozen(result.pages)).toBe(true);
  });

  it('shows the document page count on every page of a settled result (property)', () => {
    let s = 9;
    const next = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    let settled = 0;
    for (let trial = 0; trial < 200; trial++) {
      const footerHeight = Math.floor(next() * 25);
      const footer: StoryFactory = (ctx) => ({
        height: footerHeight,
        fragments: [
          {
            kind: 'paragraph',
            blockId: `${ctx.label}/${ctx.pageCount}`,
            from: 0,
            to: 0,
            x: 0,
            y: 0,
            width: 10,
            height: 0,
            lines: [],
          } satisfies ParagraphFragment,
        ],
      });
      const setup = body(100, { footers: { default: footer } });
      const items: PageItem[] = Array.from({ length: 1 + Math.floor(next() * 10) }, (_, i) =>
        para(
          `p${i}`,
          Array.from({ length: 1 + Math.floor(next() * 6) }, () => 10),
        ),
      );
      const result = paginate(items, setup);
      if (!result.pageCountSettled) continue;
      settled++;
      result.pages.forEach((p) =>
        expect(storyText(p.footer)).toEqual([`${p.label}/${result.pages.length}`]),
      );
    }
    expect(settled).toBeGreaterThan(150);
  });

  it('is deterministic for the same stories and items', () => {
    const setup = body(100, {
      margins: { top: 20, right: 0, bottom: 20, left: 0 },
      headers: { default: story('h', 10) },
      footers: { default: story('f', 10) },
    });
    expect(paginate(filler(9), setup)).toEqual(paginate(filler(9), setup));
  });
});

describe('columns (FE-085)', () => {
  // Two columns of 35 points with a 10-point gap on an 80-point page: the second starts at x = 45.
  const two = (over: Partial<PageSetup> = {}): PageSetup =>
    body(100, { columns: 2, columnGap: 10, ...over });

  it('flows the text through the columns in order (criterion 1)', () => {
    const heights = Array.from({ length: 12 }, () => 10);
    const { pages } = paginate([para('a', heights)], two());
    expect(pages).toHaveLength(1);
    const pieces = pages[0]!.fragments as ParagraphFragment[];
    expect(pieces.map((p) => [p.x, p.lines.length])).toEqual([
      [0, 10],
      [45, 2],
    ]);
  });

  it('starts the next column after a column break (criterion 2)', () => {
    const { pages } = paginate(
      [para('a', [10, 10]), { kind: 'columnBreak' }, para('b', [10])],
      two(),
    );
    expect(pages).toHaveLength(1);
    const frags = pages[0]!.fragments as ParagraphFragment[];
    expect(frags.map((f) => [f.blockId, f.x, f.y])).toEqual([
      ['a', 0, 0],
      ['b', 45, 0],
    ]);
  });

  it('starts a new page after the last column, and a column break there breaks the page', () => {
    const { pages } = paginate(
      [
        para('a', [10, 10]),
        { kind: 'columnBreak' },
        para('b', [10]),
        { kind: 'columnBreak' },
        para('c', [10]),
      ],
      body(100, { columns: 2, columnGap: 10, height: 100 }),
    );
    // Two columns hold a and b; the second column break at the end of the page moves c on.
    expect(pages.map((p) => p.fragments.map((f) => f.blockId))).toEqual([['a', 'b'], ['c']]);
  });

  it('balances a run of columns that ends at a continuous break (criterion 3)', () => {
    // Five ten-point lines in two columns: three in the first and two in the second.
    const items: PageItem[] = [
      { kind: 'sectionBreak', start: 'nextPage', page: two() },
      para('run', [10, 10, 10, 10, 10]),
      { kind: 'sectionBreak', start: 'continuous', page: body(100) },
      para('after', [10]),
    ];
    const { pages } = paginate(items, body(100));
    expect(pages).toHaveLength(1);
    const frags = pages[0]!.fragments as ParagraphFragment[];
    const run = frags.filter((f) => f.blockId === 'run');
    expect(run.map((f) => [f.x, f.lines.length, f.height])).toEqual([
      [0, 3, 30],
      [45, 2, 20],
    ]);
    // Content after the continuous break starts below the balanced block, in one column.
    const after = frags.find((f) => f.blockId === 'after')!;
    expect([after.x, after.y]).toEqual([0, 30]);
  });

  /** The pieces of `id` on a page as [x, y, line count, height]. */
  const pieces = (frags: readonly LayoutFragment[], id: string): number[][] =>
    (frags.filter((f) => f.blockId === id) as ParagraphFragment[]).map((f) => [
      f.x,
      f.y,
      f.lines.length,
      f.height,
    ]);

  it('balances the first section when a continuous break ends it (criterion 3)', () => {
    const items: PageItem[] = [
      para('run', [10, 10, 10, 10, 10]),
      { kind: 'sectionBreak', start: 'continuous', page: body(100) },
      para('after', [10]),
    ];
    const { pages } = paginate(items, two());
    expect(pages).toHaveLength(1);
    expect(pieces(pages[0]!.fragments, 'run')).toEqual([
      [0, 0, 3, 30],
      [45, 0, 2, 20],
    ]);
    expect(pieces(pages[0]!.fragments, 'after')).toEqual([[0, 30, 1, 10]]);
  });

  it('balances a run that a continuous break starts on an empty page (criterion 3)', () => {
    const items: PageItem[] = [
      { kind: 'sectionBreak', start: 'continuous', page: two() },
      para('run', [10, 10, 10, 10, 10]),
      { kind: 'sectionBreak', start: 'continuous', page: body(100) },
      para('after', [10]),
    ];
    const { pages } = paginate(items, body(100));
    expect(pages).toHaveLength(1);
    expect(pieces(pages[0]!.fragments, 'run')).toEqual([
      [0, 0, 3, 30],
      [45, 0, 2, 20],
    ]);
    expect(pieces(pages[0]!.fragments, 'after')).toEqual([[0, 30, 1, 10]]);
  });

  it('balances a run that starts mid-page, from the top of the run (criterion 3)', () => {
    // One line of single-column text, then a two-column run of five lines: both columns start at
    // y = 10, below the intro, and hold three and two lines.
    const items: PageItem[] = [
      para('intro', [10]),
      { kind: 'sectionBreak', start: 'continuous', page: two() },
      para('run', [10, 10, 10, 10, 10]),
      { kind: 'sectionBreak', start: 'continuous', page: body(100) },
      para('after', [10]),
    ];
    const { pages } = paginate(items, body(100));
    expect(pages).toHaveLength(1);
    expect(pieces(pages[0]!.fragments, 'intro')).toEqual([[0, 0, 1, 10]]);
    expect(pieces(pages[0]!.fragments, 'run')).toEqual([
      [0, 10, 3, 30],
      [45, 10, 2, 20],
    ]);
    expect(pieces(pages[0]!.fragments, 'after')).toEqual([[0, 40, 1, 10]]);
  });

  it('starts every column of a mid-page run below the earlier content, also when the run is not balanced', () => {
    // The run ends at a next-page break, so it is not balanced: it fills its first column from
    // y = 30 to the bottom (seven lines), and the second column starts at y = 30 too.
    const items: PageItem[] = [
      para('intro', [10, 10, 10]),
      { kind: 'sectionBreak', start: 'continuous', page: two() },
      para(
        'run',
        Array.from({ length: 9 }, () => 10),
      ),
      { kind: 'sectionBreak', start: 'nextPage', page: body(100) },
      para('after', [10]),
    ];
    const { pages } = paginate(items, body(100));
    expect(pieces(pages[0]!.fragments, 'run')).toEqual([
      [0, 30, 7, 70],
      [45, 30, 2, 20],
    ]);
  });

  it('balances the last page of a run longer than a page (criterion 3)', () => {
    // 25 lines in two 100-point columns: page 1 takes 20, and the 5 on page 2 are balanced.
    const items: PageItem[] = [
      { kind: 'sectionBreak', start: 'nextPage', page: two() },
      para(
        'run',
        Array.from({ length: 25 }, () => 10),
      ),
      { kind: 'sectionBreak', start: 'continuous', page: body(100) },
      para('after', [10]),
    ];
    const { pages } = paginate(items, body(100));
    expect(pages).toHaveLength(2);
    expect(pieces(pages[0]!.fragments, 'run')).toEqual([
      [0, 0, 10, 100],
      [45, 0, 10, 100],
    ]);
    expect(pieces(pages[1]!.fragments, 'run')).toEqual([
      [0, 0, 3, 30],
      [45, 0, 2, 20],
    ]);
    expect(pieces(pages[1]!.fragments, 'after')).toEqual([[0, 30, 1, 10]]);
  });

  it('balances runs of several paragraphs, boxes and starts, keeping every line once and nothing overlapping (property)', () => {
    let s = 4242;
    const next = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const starts = ['nextPage', 'continuous'] as const;
    let balancedPages = 0;
    for (let trial = 0; trial < 200; trial++) {
      const cols = 2 + Math.floor(next() * 2);
      const multi = body(100, { columns: cols, columnGap: 5, width: 120 });
      const single = body(100, { width: 120 });
      const items: PageItem[] = [];
      if (next() < 0.5)
        items.push(
          para(
            'intro',
            Array.from({ length: Math.floor(next() * 6) }, () => 10),
          ),
        );
      items.push({ kind: 'sectionBreak', start: starts[Math.floor(next() * 2)]!, page: multi });
      const count = 1 + Math.floor(next() * 5);
      for (let i = 0; i < count; i++) {
        if (next() < 0.15)
          items.push({
            kind: 'box',
            blockId: `b${i}`,
            width: 10,
            height: 5 + Math.floor(next() * 20),
            keepNext: false,
          });
        else
          items.push(
            para(
              `r${i}`,
              Array.from({ length: 1 + Math.floor(next() * 12) }, () => 6 + Math.floor(next() * 8)),
              { widowControl: next() < 0.5 },
            ),
          );
      }
      items.push({ kind: 'sectionBreak', start: 'continuous', page: single }, para('after', [10]));
      const { pages } = paginate(items, single);

      // Every line once, in order.
      for (const item of items) {
        if (item.kind !== 'paragraph') continue;
        let at = 0;
        for (const p of pages)
          for (const f of p.fragments)
            if (f.kind === 'paragraph' && f.blockId === item.fragment.blockId)
              for (const l of f.lines) {
                expect(l.from).toBe(at);
                at = l.to;
              }
        expect(at).toBe(item.fragment.to);
      }
      // Nothing overlaps on a page.
      for (const p of pages) {
        const fs = p.fragments;
        for (let a = 0; a < fs.length; a++)
          for (let b = a + 1; b < fs.length; b++) {
            const A = fs[a]!;
            const B = fs[b]!;
            const xOverlap = A.x < B.x + 30 - EPS && B.x < A.x + 30 - EPS;
            const yOverlap = A.y < B.y + B.height - EPS && B.y < A.y + A.height - EPS;
            expect(xOverlap && yOverlap).toBe(false);
          }
      }
      // The page of the continuous break: the content after it starts at the bottom of the run's
      // tallest column, and that bottom is never lower than the same run filled column by column
      // (the run ended by a next-page break instead, which is not balanced).
      const runBottom = (ps: typeof pages): { page: number; bottom: number } => {
        const page =
          ps.length -
          1 -
          [...ps]
            .reverse()
            .findIndex((p) =>
              p.fragments.some((f) => f.blockId !== 'after' && f.blockId !== 'intro'),
            );
        const frags = ps[page]!.fragments.filter(
          (f) => f.blockId !== 'after' && f.blockId !== 'intro',
        );
        return { page, bottom: Math.max(...frags.map((f) => f.y + f.height)) };
      };
      const balanced = runBottom(pages);
      const after = pages[balanced.page]!.fragments.find((f) => f.blockId === 'after');
      if (after) expect(after.y).toBeCloseTo(balanced.bottom, 6);
      const filled = paginate(
        items.map((it, k): PageItem =>
          k === items.length - 2 ? { kind: 'sectionBreak', start: 'nextPage', page: single } : it,
        ),
        single,
      );
      const unbalanced = runBottom(filled.pages);
      expect(balanced.page).toBe(unbalanced.page);
      expect(balanced.bottom).toBeLessThanOrEqual(unbalanced.bottom + EPS);
      if (balanced.bottom < unbalanced.bottom - EPS) balancedPages++;
    }
    expect(balancedPages).toBeGreaterThan(50);
  });

  it('does not balance a run that ends with a page break, and fills its first column first', () => {
    const items: PageItem[] = [
      { kind: 'sectionBreak', start: 'nextPage', page: two() },
      para('run', [10, 10, 10, 10, 10]),
      { kind: 'sectionBreak', start: 'nextPage', page: body(100) },
      para('after', [10]),
    ];
    const { pages } = paginate(items, body(100));
    const frags = pages[0]!.fragments as ParagraphFragment[];
    expect(frags.filter((f) => f.blockId === 'run').map((f) => f.lines.length)).toEqual([5]);
  });

  it('keeps every line once, in order, inside the column and the body, for 300 random runs', () => {
    let s = 77;
    const next = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    for (let trial = 0; trial < 300; trial++) {
      const cols = 2 + Math.floor(next() * 2);
      const gap = Math.floor(next() * 8);
      const height = 40 + Math.floor(next() * 60);
      const setup = body(height, { columns: cols, columnGap: gap, width: 120 });
      const items: PageItem[] = [];
      const count = 1 + Math.floor(next() * 8);
      for (let i = 0; i < count; i++) {
        if (next() < 0.15) items.push({ kind: 'columnBreak' });
        else
          items.push(
            para(
              `p${i}`,
              Array.from({ length: 1 + Math.floor(next() * 5) }, () => 8 + Math.floor(next() * 7)),
            ),
          );
      }
      const { pages } = paginate(items, setup);
      const colW = (120 - gap * (cols - 1)) / cols;
      const xs = Array.from({ length: cols }, (_, c) => c * (colW + gap));
      for (const page of pages)
        for (const f of page.fragments) {
          expect(xs.some((x) => Math.abs(x - f.x) < EPS)).toBe(true);
          expect(f.y + f.height).toBeLessThanOrEqual(height + EPS);
        }
      for (const item of items) {
        if (item.kind !== 'paragraph') continue;
        const pieces = pages
          .flatMap((p) => p.fragments)
          .filter(
            (f): f is ParagraphFragment =>
              f.kind === 'paragraph' && f.blockId === item.fragment.blockId,
          );
        let at = 0;
        let lines = 0;
        for (const p of pieces)
          for (const l of p.lines) {
            expect(l.from).toBe(at);
            at = l.to;
            lines++;
          }
        expect(lines).toBe(item.fragment.lines.length);
        expect(at).toBe(item.fragment.to);
      }
    }
  });

  it('honours a page break and a column break item between two items of one block', () => {
    // The shape a break inside a paragraph takes once converted; the conversion itself, from a CDM
    // paragraph through the flow, is tested in `items.test.ts` (FE-082 criterion 5).
    const pageSplit = paginate(
      [para('x', [10]), { kind: 'pageBreak' }, para('x', [10])],
      body(100),
    );
    expect(pageSplit.pages.map((p) => p.fragments.map((f) => f.blockId))).toEqual([['x'], ['x']]);
    const colSplit = paginate(
      [para('x', [10]), { kind: 'columnBreak' }, para('x', [10])],
      body(100, { columns: 2, columnGap: 10 }),
    );
    expect(colSplit.pages).toHaveLength(1);
    expect(colSplit.pages[0]!.fragments.map((f) => f.x)).toEqual([0, 45]);
  });

  it('keeps a paragraph of many pages in one column order, without a gap', () => {
    expect(
      pieceCount(
        paginate(
          [
            para(
              'x',
              Array.from({ length: 30 }, () => 10),
            ),
          ],
          two(),
        ).pages,
        'x',
      ),
    ).toBeGreaterThan(1);
  });
});
