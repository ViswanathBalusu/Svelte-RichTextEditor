/**
 * Pagination (FE-082) and section page setups (FE-086), in Node.js. The paragraphs are built from
 * line heights directly, so each case states its heights. The random sweep uses a seeded generator
 * (mulberry32), so every run is repeatable.
 */
import { describe, expect, it } from 'vitest';
import {
  paginate,
  type PageItem,
  type PageMargins,
  type PageSetup,
  type ParagraphItem,
  type BoxItem,
} from './paginate.ts';
import type { LayoutFragment, ParagraphFragment } from './tree.ts';

const EPS = 1e-6;
const NO_MARGINS: PageMargins = { top: 0, right: 0, bottom: 0, left: 0 };

/** A page of the given body height, with no margins, so that the body equals the page. */
const body = (height: number, over: Partial<PageSetup> = {}): PageSetup => ({
  width: 80,
  height,
  margins: NO_MARGINS,
  ...over,
});

/** A paragraph with one line of each height; line i covers ten offsets of the block. */
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

const box = (blockId: string, height: number, keepNext = false): BoxItem => ({
  kind: 'box',
  blockId,
  width: 50,
  height,
  keepNext,
});

/** The paragraph pieces of one block, in document order, with the page they sit on. */
function piecesOf(
  pages: readonly { index: number; fragments: readonly LayoutFragment[] }[],
  id: string,
): Array<{ page: number; fragment: ParagraphFragment; position: number }> {
  const out: Array<{ page: number; fragment: ParagraphFragment; position: number }> = [];
  for (const page of pages)
    page.fragments.forEach((f, position) => {
      if (f.kind === 'paragraph' && f.blockId === id)
        out.push({ page: page.index, fragment: f, position });
    });
  return out;
}

/** The fragment ids of a page, in order. */
const idsOn = (
  pages: ReadonlyArray<{ fragments: readonly LayoutFragment[] }>,
  n: number,
): string[] => pages[n]!.fragments.map((f) => f.blockId);

describe('pagination: breaks and the order of rules (FE-082)', () => {
  it('returns a frozen tree: a change to a page or a fragment throws (FE-078)', () => {
    const { pages } = paginate([para('a', [10])], body(100));
    expect(Object.isFrozen(pages)).toBe(true);
    expect(() => {
      (pages[0] as { index: number }).index = 9;
    }).toThrow(TypeError);
    expect(() => {
      (pages[0]!.fragments[0] as { y: number }).y = 9;
    }).toThrow(TypeError);
  });

  it('places a short paragraph at the top of the page with its lines relative to it', () => {
    const { pages, overflowed } = paginate(
      [para('a', [10, 12, 10])],
      body(100, { margins: { top: 7, right: 0, bottom: 0, left: 5 } }),
    );
    expect(overflowed).toEqual([]);
    expect(pages).toHaveLength(1);
    const f = pages[0]!.fragments[0] as ParagraphFragment;
    expect(f.x).toBe(5);
    expect(f.y).toBe(7);
    expect(f.lines.map((l) => l.y)).toEqual([0, 10, 22]);
  });

  it('splits a block taller than the page, and the pieces cover its range without gap or overlap', () => {
    const heights = Array.from({ length: 25 }, () => 10);
    const { pages } = paginate([para('long', heights)], body(100));
    expect(pages.map((p) => p.fragments.length)).toEqual([1, 1, 1]);
    const pieces = piecesOf(pages, 'long');
    expect(pieces.map((p) => p.fragment.lines.length)).toEqual([10, 10, 5]);
    let at = 0;
    for (const p of pieces) {
      expect(p.fragment.from).toBe(at);
      for (let i = 1; i < p.fragment.lines.length; i++)
        expect(p.fragment.lines[i]!.from).toBe(p.fragment.lines[i - 1]!.to);
      at = p.fragment.to;
    }
    expect(at).toBe(250);
  });

  it('honours an explicit page break between paragraphs', () => {
    const { pages } = paginate(
      [para('a', [10]), { kind: 'pageBreak' }, para('b', [10])],
      body(100),
    );
    expect(pages).toHaveLength(2);
    expect(idsOn(pages, 0)).toEqual(['a']);
    expect(idsOn(pages, 1)).toEqual(['b']);
  });

  it('makes no blank page for a page break at the top of a page, and one page for two breaks', () => {
    expect(paginate([{ kind: 'pageBreak' }, para('a', [10])], body(100)).pages).toHaveLength(1);
    const twice = paginate(
      [para('a', [10]), { kind: 'pageBreak' }, { kind: 'pageBreak' }, para('b', [10])],
      body(100),
    );
    expect(twice.pages).toHaveLength(2);
    expect(idsOn(twice.pages, 1)).toEqual(['b']);
  });

  it('starts a paragraph with pageBreakBefore on a new page, and keeps it on the page when nothing precedes it', () => {
    const broken = paginate(
      [para('a', [10]), para('b', [10], { pageBreakBefore: true })],
      body(100),
    );
    expect(idsOn(broken.pages, 0)).toEqual(['a']);
    expect(idsOn(broken.pages, 1)).toEqual(['b']);
    const first = paginate([para('b', [10], { pageBreakBefore: true })], body(100));
    expect(first.pages).toHaveLength(1);
  });

  it('keeps a heading with the first line of the paragraph after it (keepNext)', () => {
    // 85 used; the heading (10) fits, but the heading and the next first line (20) do not.
    const items: PageItem[] = [
      para('filler', [85]),
      para('heading', [10], { keepNext: true }),
      para('next', [10]),
    ];
    const { pages } = paginate(items, body(100));
    expect(idsOn(pages, 0)).toEqual(['filler']);
    expect(idsOn(pages, 1)).toEqual(['heading', 'next']);
  });

  it('without keepNext, the same heading stays on the page it fits', () => {
    const items: PageItem[] = [para('filler', [85]), para('heading', [10]), para('next', [10])];
    const { pages } = paginate(items, body(100));
    expect(idsOn(pages, 0)).toEqual(['filler', 'heading']);
  });

  it('breaks a keepNext chain longer than the page, and still terminates', () => {
    const items: PageItem[] = Array.from({ length: 6 }, (_, i) =>
      para(`p${i}`, [30], { keepNext: true }),
    );
    const { pages } = paginate(items, body(100));
    // The first three fit together; the chain from p0 needs 180 and cannot be kept, so the
    // chain from p3 (90 needed, 90 fits from the top) is the one that moves.
    expect(pages.length).toBeGreaterThanOrEqual(2);
    expect(idsOn(pages, 0)).toEqual(['p0', 'p1', 'p2']);
    expect(idsOn(pages, 1)).toEqual(['p3', 'p4', 'p5']);
  });

  it('moves a paragraph that keeps its lines together to the next page, and splits it otherwise', () => {
    const filler = para('filler', [70]);
    const kept = paginate([filler, para('p', [10, 10, 10, 10], { keepLines: true })], body(100));
    expect(piecesOf(kept.pages, 'p')).toHaveLength(1);
    expect(piecesOf(kept.pages, 'p')[0]!.page).toBe(1);
    const split = paginate([filler, para('p', [10, 10, 10, 10])], body(100));
    expect(piecesOf(split.pages, 'p').map((p) => p.fragment.lines.length)).toEqual([3, 1]);
  });

  it('applies widow control: no single line is left at the top or the bottom of a page', () => {
    const five = [10, 10, 10, 10, 10];
    // 80 used: room for two lines leaves three behind, which is allowed.
    const two = paginate(
      [para('filler', [80]), para('p', five, { widowControl: true })],
      body(100),
    );
    expect(piecesOf(two.pages, 'p').map((p) => p.fragment.lines.length)).toEqual([2, 3]);
    // 60 used: room for four lines would leave one behind, so three go on the first page.
    const three = paginate(
      [para('filler', [60]), para('p', five, { widowControl: true })],
      body(100),
    );
    expect(piecesOf(three.pages, 'p').map((p) => p.fragment.lines.length)).toEqual([3, 2]);
    // 90 used: one line would fit and be alone, so the paragraph moves whole.
    const whole = paginate(
      [para('filler', [90]), para('p', five, { widowControl: true })],
      body(100),
    );
    expect(piecesOf(whole.pages, 'p').map((p) => p.fragment.lines.length)).toEqual([5]);
    // Without widow control the same paragraph takes the one line at the bottom.
    const loose = paginate([para('filler', [60]), para('p', five)], body(100));
    expect(piecesOf(loose.pages, 'p').map((p) => p.fragment.lines.length)).toEqual([4, 1]);
  });

  it('places a box taller than the room on the next page, and reports one taller than the page', () => {
    const moved = paginate([para('a', [10]), box('figure', 95)], body(100));
    expect(idsOn(moved.pages, 1)).toEqual(['figure']);
    expect(moved.overflowed).toEqual([]);
    const tall = paginate([box('poster', 150)], body(100));
    expect(tall.overflowed).toEqual(['poster']);
    expect(tall.pages).toHaveLength(1);
  });

  it('gives a block with lines taller than the page the page of its own, and reports it', () => {
    const { pages, overflowed } = paginate([para('tall', [150])], body(100));
    expect(overflowed).toEqual(['tall']);
    expect(pages).toHaveLength(1);
  });

  it('pages a document of many blocks the same way twice (determinism)', () => {
    const items: PageItem[] = [
      para('a', [10, 10, 10]),
      box('img', 40, true),
      para('b', [12, 12], { keepNext: true, widowControl: true }),
      para('c', [10, 10, 10, 10, 10, 10], { keepLines: true }),
    ];
    expect(paginate(items, body(100))).toEqual(paginate(items, body(100)));
  });
});

describe('section page setups (FE-086)', () => {
  it('starts the next section on the next page with its own size, orientation and margins', () => {
    const landscape: PageSetup = {
      width: 300,
      height: 100,
      margins: { top: 5, right: 5, bottom: 5, left: 9 },
    };
    const { pages } = paginate(
      [
        para('a', [10]),
        { kind: 'sectionBreak', start: 'nextPage', page: landscape },
        para('b', [10]),
      ],
      body(100),
    );
    expect(pages.map((p) => [p.section, p.orientation, p.width, p.height])).toEqual([
      [0, 'portrait', 80, 100],
      [1, 'landscape', 300, 100],
    ]);
    const b = pages[1]!.fragments[0] as ParagraphFragment;
    expect(b.x).toBe(9);
    expect(b.y).toBe(5);
    expect(pages[1]!.margins).toEqual(landscape.margins);
  });

  it('starts an evenPage or oddPage section on a page with that number, with a blank page when needed', () => {
    const next = body(100);
    // On page 1 (odd), an even-page section starts on page 2.
    const even = paginate(
      [para('a', [10]), { kind: 'sectionBreak', start: 'evenPage', page: next }, para('b', [10])],
      body(100),
    );
    expect(even.pages.map((p) => p.number)).toEqual([1, 2]);
    expect(idsOn(even.pages, 1)).toEqual(['b']);
    // An odd-page section after page 1 would start on page 2, which is even: page 2 stays blank.
    const odd = paginate(
      [para('a', [10]), { kind: 'sectionBreak', start: 'oddPage', page: next }, para('b', [10])],
      body(100),
    );
    expect(odd.pages.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(odd.pages[1]!.fragments).toEqual([]);
    expect(idsOn(odd.pages, 2)).toEqual(['b']);
  });

  it('keeps a continuous section on the same page, and applies its setup from the next page', () => {
    const wide = body(100, { width: 300 });
    const same = paginate(
      [para('a', [10]), { kind: 'sectionBreak', start: 'continuous', page: wide }, para('b', [10])],
      body(100),
    );
    expect(same.pages).toHaveLength(1);
    expect(idsOn(same.pages, 0)).toEqual(['a', 'b']);
    const next = paginate(
      [
        para('a', [10]),
        { kind: 'sectionBreak', start: 'continuous', page: wide },
        { kind: 'pageBreak' },
        para('c', [10]),
      ],
      body(100),
    );
    expect(next.pages.map((p) => p.width)).toEqual([80, 300]);
    expect(next.pages[1]!.section).toBe(1);
  });

  it('numbers the pages of each section from its own start and in its own format', () => {
    const roman = body(100, { pageNumberStart: 5, pageNumberFormat: 'lowerRoman' });
    const { pages } = paginate(
      [
        para('a', [10]),
        { kind: 'sectionBreak', start: 'nextPage', page: roman },
        para('b', [10]),
        { kind: 'sectionBreak', start: 'nextPage', page: body(100) },
        para('c', [10]),
      ],
      body(100),
    );
    // The third section gives no start, so its numbering continues from the page before it.
    expect(pages.map((p) => [p.number, p.label])).toEqual([
      [1, '1'],
      [5, 'v'],
      [6, '6'],
    ]);
  });

  it('continues numbering when a section gives no start', () => {
    const { pages } = paginate(
      [
        para('a', [10]),
        { kind: 'sectionBreak', start: 'nextPage', page: body(100) },
        para('b', [10]),
      ],
      body(100),
    );
    expect(pages.map((p) => p.number)).toEqual([1, 2]);
  });
});

/** Random items, with every rule of FE-082 switched on at random (seeded, so repeatable). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomItems(next: () => number, setup: PageSetup): PageItem[] {
  const pick = (n: number): number => Math.floor(next() * n);
  const count = 1 + pick(14);
  const items: PageItem[] = [];
  for (let i = 0; i < count; i++) {
    const r = next();
    if (r < 0.1) items.push({ kind: 'pageBreak' });
    else if (r < 0.14)
      items.push({
        kind: 'sectionBreak',
        start: (['nextPage', 'continuous', 'evenPage', 'oddPage'] as const)[pick(4)]!,
        page: setup,
      });
    else if (r < 0.24) items.push(box(`b${i}`, 5 + pick(46), next() < 0.3));
    else {
      const lines = Array.from({ length: 1 + pick(6) }, () => 8 + pick(7));
      items.push(
        para(`p${i}`, lines, {
          spaceBefore: pick(6),
          spaceAfter: pick(6),
          keepNext: next() < 0.25,
          keepLines: next() < 0.25,
          pageBreakBefore: next() < 0.1,
          widowControl: next() < 0.5,
        }),
      );
    }
  }
  return items;
}

describe('pagination invariants over random documents (FE-082)', () => {
  it('lays out every line once, in order, within the page body, for 400 random documents', () => {
    const next = rng(20261113);
    for (let trial = 0; trial < 400; trial++) {
      // A body of at least three of the tallest lines, so that widow control can always apply.
      const height = 45 + Math.floor(next() * 75);
      const setup = body(height);
      const items = randomItems(next, setup);
      const { pages, overflowed } = paginate(items, setup);
      const overflow = new Set(overflowed);

      // Every fragment lies within the body of its page.
      for (const page of pages)
        for (const f of page.fragments) {
          // A box taller than the body is placed alone and reported (see paginate.ts).
          if (f.kind === 'box' && overflow.has(f.blockId)) continue;
          expect(f.y).toBeGreaterThanOrEqual(-EPS);
          expect(f.y + f.height).toBeLessThanOrEqual(height + EPS);
        }

      for (const item of items) {
        if (item.kind === 'box') {
          const placed = pages
            .flatMap((p) => p.fragments)
            .filter((f) => f.blockId === item.blockId);
          expect(placed).toHaveLength(1);
          if (item.height <= height) expect(overflow.has(item.blockId)).toBe(false);
          continue;
        }
        if (item.kind !== 'paragraph') continue;
        const id = item.fragment.blockId;
        const pieces = piecesOf(pages, id);

        // Coverage: the pieces meet without gap or overlap, and cover the whole block.
        let at = 0;
        let lineCount = 0;
        for (const p of pieces) {
          for (const line of p.fragment.lines) {
            expect(line.from).toBe(at);
            at = line.to;
            lineCount++;
          }
        }
        expect(lineCount).toBe(item.fragment.lines.length);
        expect(at).toBe(item.fragment.to);

        // pageBreakBefore: the block's first piece is the first fragment on its page.
        if (item.pageBreakBefore && pieces.length > 0) expect(pieces[0]!.position).toBe(0);

        // Widow control, unless a keepNext chain has put this paragraph's first line first.
        const prev = items[items.indexOf(item) - 1];
        const chained =
          prev !== undefined &&
          prev.kind !== 'pageBreak' &&
          prev.kind !== 'sectionBreak' &&
          prev.kind !== 'columnBreak' &&
          prev.kind !== 'table' &&
          prev.keepNext;
        if (item.widowControl && !chained && pieces.length > 1)
          for (const p of pieces) expect(p.fragment.lines.length).toBeGreaterThanOrEqual(2);

        // keepLines: a paragraph that fits on a page is not split unless a chain has placed it.
        const whole = item.spaceBefore + item.fragment.height;
        if (item.keepLines && whole <= height && !chained) expect(pieces).toHaveLength(1);
      }
    }
  });

  it('keeps a keepNext paragraph and the first line of the next paragraph on one page when that fits', () => {
    const next = rng(4242);
    let checked = 0;
    for (let trial = 0; trial < 300; trial++) {
      const height = 45 + Math.floor(next() * 75);
      const setup = body(height);
      // Paragraphs only, with keepNext on some: each keepNext item is followed by one plain paragraph.
      const items: PageItem[] = [];
      const count = 2 + Math.floor(next() * 8);
      for (let i = 0; i < count; i++) {
        const lines = Array.from(
          { length: 1 + Math.floor(next() * 4) },
          () => 8 + Math.floor(next() * 7),
        );
        items.push(
          para(`p${i}`, lines, { keepNext: next() < 0.4, spaceBefore: Math.floor(next() * 4) }),
        );
      }
      // A keepNext item needs the next one to be a plain paragraph for the chain to be one step.
      const { pages } = paginate(items, setup);
      for (let i = 0; i + 1 < items.length; i++) {
        const a = items[i] as ParagraphItem;
        const b = items[i + 1] as ParagraphItem;
        if (!a.keepNext || b.keepNext) continue;
        const need =
          a.spaceBefore +
          a.fragment.height +
          a.spaceAfter +
          b.spaceBefore +
          (b.fragment.lines[0]?.height ?? 0);
        if (need > height) continue;
        const pa = piecesOf(pages, a.fragment.blockId);
        const pb = piecesOf(pages, b.fragment.blockId);
        expect(pa).toHaveLength(1);
        expect(pb[0]!.page).toBe(pa[0]!.page);
        checked++;
      }
    }
    // The guard must let real pairs through, or the property holds vacuously.
    expect(checked).toBeGreaterThan(100);
  });
});
