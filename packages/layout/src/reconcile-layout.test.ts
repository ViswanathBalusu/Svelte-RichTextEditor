/**
 * Page-break reconciliation in the page pass (FE-100 criteria 2 and 3; 02 §9.7): `paginate` with
 * typeset page starts. A pinned page holds its content up to the next typeset start and may overflow
 * by up to the tolerance; beyond it the pin is dropped and the pages of its content are estimated.
 * The overflow is measured on the pass's own layout. The tolerance is one line unless the caller gives
 * a length (owner decision 248); the first tests pass their own lengths, the last ones use the line.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { validateLayoutJson } from './layout-json.ts';
import {
  paginate,
  type PageItem,
  type PageSetup,
  type ParagraphItem,
  type PaginatedPage,
} from './paginate.ts';
import { adoptablePins, type PagePin } from './reconcile.ts';
import type { ParagraphFragment } from './tree.ts';

/** A page whose body is `height` points: no margins. */
const page = (height: number): PageSetup => ({
  width: 80,
  height,
  margins: { top: 0, right: 0, bottom: 0, left: 0 },
});

/** A paragraph with one line of each height; line i covers offsets 10i to 10i + 10. */
function para(id: string, heights: readonly number[]): ParagraphItem {
  let y = 0;
  const lines = heights.map((height, i) => {
    const line = { from: 10 * i, to: 10 * i + 10, x: 0, y, width: 50, height };
    y += height;
    return line;
  });
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    blockId: id,
    from: 0,
    to: 10 * heights.length,
    x: 0,
    y: 0,
    width: 80,
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
  };
}

const pin = (n: number, blockId: string, offset = 0): PagePin => ({ page: n, blockId, offset });

/** Each page as the blocks and line offsets it holds, `A:0-50` for lines from 0 to 50 of A. */
const pagesOf = (pages: readonly PaginatedPage[]): string[][] =>
  pages.map((p) =>
    p.fragments.map((f) => (f.kind === 'paragraph' ? `${f.blockId}:${f.from}-${f.to}` : f.blockId)),
  );

/** How far the lowest fragment of a page runs below its body (no margins: the page height). */
const depth = (p: PaginatedPage): number =>
  Math.max(0, ...p.fragments.map((f) => f.y + f.height)) - p.height;

describe('a pinned page may overflow slightly (FE-100 criterion 2)', () => {
  // A is 105 points on a 100-point page: on its own the editor would move its last line on.
  const items: PageItem[] = [para('A', [20, 20, 20, 20, 20, 5]), para('B', [20, 20])];

  it('without pins the editor breaks where its own page is full', () => {
    expect(pagesOf(paginate(items, page(100)).pages)).toEqual([['A:0-50'], ['A:50-60', 'B:0-20']]);
  });

  it('keeps the typeset start of B and lets page 1 overflow within the tolerance', () => {
    const result = paginate(items, page(100), {
      pins: { pages: [pin(1, 'A'), pin(2, 'B')], tolerance: 10 },
    });
    expect(pagesOf(result.pages)).toEqual([['A:0-60'], ['B:0-20']]);
    expect(depth(result.pages[0]!)).toBeCloseTo(5, 6);
    expect(result.reconciliation!.judgements.map((j) => [j.decision, j.overflow])).toEqual([
      ['overflows', 5],
      ['fits', 0],
    ]);
    expect(result.reconciliation!.estimated).toEqual([]);
    expect(result.pages.some((p) => p.estimated)).toBe(false);
  });

  it('allows an overflow equal to the tolerance', () => {
    const result = paginate(items, page(100), {
      pins: { pages: [pin(1, 'A'), pin(2, 'B')], tolerance: 5 },
    });
    expect(result.reconciliation!.judgements[0]!.decision).toBe('overflows');
    expect(pagesOf(result.pages)).toEqual([['A:0-60'], ['B:0-20']]);
  });

  it('adopts a typeset start inside a paragraph: the page breaks at that line', () => {
    const result = paginate([para('A', [20, 20, 20])], page(100), {
      pins: { pages: [pin(1, 'A'), pin(2, 'A', 20)], tolerance: 0 },
    });
    expect(pagesOf(result.pages)).toEqual([['A:0-20'], ['A:20-30']]);
    expect(result.reconciliation!.judgements.map((j) => j.decision)).toEqual(['fits', 'fits']);
  });
});

describe('beyond the tolerance the pin is dropped and the page is estimated (FE-100 criterion 3)', () => {
  // A is 130 points: 30 over a 100-point page.
  const items: PageItem[] = [para('A', [20, 20, 20, 20, 20, 20, 10]), para('B', [20, 20])];

  it('drops the pin of the page that overflows too far, lays it out with the editor breaks, and marks it', () => {
    const result = paginate(items, page(100), {
      pins: { pages: [pin(1, 'A'), pin(2, 'B')], tolerance: 10 },
    });
    const r = result.reconciliation!;
    expect(r.judgements.map((j) => [j.pin.page, j.decision, j.overflow, j.estimated])).toEqual([
      [1, 'dropped', 30, true],
      [2, 'fits', 0, false],
    ]);
    // A flows as the editor lays it out; B keeps its typeset start on a page of its own.
    expect(pagesOf(result.pages)).toEqual([['A:0-50'], ['A:50-70'], ['B:0-20']]);
    expect(r.estimated).toEqual([0, 1]);
    expect(result.pages.map((p) => p.estimated === true)).toEqual([true, true, false]);
    // No page overflows once the pin is dropped.
    for (const p of result.pages) expect(depth(p)).toBeLessThanOrEqual(1e-6);
  });

  it('drops a pin just above the tolerance', () => {
    const result = paginate([para('A', [20, 20, 20, 20, 20, 5]), para('B', [10])], page(100), {
      pins: { pages: [pin(1, 'A'), pin(2, 'B')], tolerance: 4.999 },
    });
    expect(result.reconciliation!.judgements[0]!.decision).toBe('dropped');
    // A's last line moves on to a second page, which is estimated too; B keeps its start.
    expect(result.reconciliation!.estimated).toEqual([0, 1]);
    expect(pagesOf(result.pages)).toEqual([['A:0-50'], ['A:50-60'], ['B:0-10']]);
  });

  it('does not adopt a start whose block or line is not laid out', () => {
    const result = paginate(items, page(100), {
      pins: { pages: [pin(1, 'A'), pin(2, 'Z'), pin(3, 'B', 5)], tolerance: 10 },
    });
    expect(result.reconciliation!.unmatched).toEqual([pin(2, 'Z'), pin(3, 'B', 5)]);
    expect(result.reconciliation!.judgements.map((j) => j.pin.page)).toEqual([1]);
  });

  it('requires a tolerance that is a finite length of at least 0', () => {
    expect(() =>
      paginate(items, page(100), { pins: { pages: [pin(1, 'A')], tolerance: -1 } }),
    ).toThrow(RangeError);
  });
});

describe('from a validated layout.json to the pages (FE-100 criteria 2 and 3 with criterion 6)', () => {
  it('adopts the starts of unedited blocks, judges their pages and keeps the editor break for the rest', () => {
    const check = validateLayoutJson({
      seq: 12,
      classVersion: '1.3.0',
      granularity: 'block',
      pages: [
        { n: 1, setup: 'ps1', starts: { blockId: 'A', offset: 0 }, opensWith: 'text' },
        { n: 2, setup: 'ps1', starts: { blockId: 'B', offset: 0 }, opensWith: 'text' },
        { n: 3, setup: 'ps1', starts: { blockId: 'C', offset: 0 }, opensWith: 'text' },
      ],
      blocks: { A: { lineStarts: [0] }, B: { lineStarts: [0] }, C: { lineStarts: [0] } },
    });
    if (!check.ok) throw new Error(check.problems.join('; '));
    // C was edited since seq 12: its typeset start is not adopted.
    const pins = adoptablePins(check.layout, new Set(['C']), 'block');
    const items = [para('A', [40, 40, 25]), para('B', [30]), para('C', [30])];
    const result = paginate(items, page(100), { pins: { pages: pins.pages, tolerance: 10 } });
    expect(pagesOf(result.pages)).toEqual([['A:0-30'], ['B:0-10', 'C:0-10']]);
    expect(result.reconciliation!.judgements.map((j) => j.decision)).toEqual(['overflows', 'fits']);
  });
});

describe('pinned pagination ends and places every line once', () => {
  it('for random paragraphs, starts and tolerances', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 8 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(fc.tuple(fc.nat(7), fc.nat(7)), { maxLength: 6 }),
        fc.integer({ min: 0, max: 40 }),
        (paragraphs, starts, tolerance) => {
          const items = paragraphs.map((h, i) => para(`P${i}`, h));
          const pins = starts
            .filter(([b]) => b < paragraphs.length)
            .map(([b, l], n) => pin(n + 1, `P${b}`, 10 * Math.min(l, paragraphs[b]!.length - 1)));
          const result = paginate(items, page(100), { pins: { pages: pins, tolerance } });
          const placed = result.pages.flatMap((p) =>
            p.fragments.flatMap((f) =>
              f.kind === 'paragraph' ? f.lines.map((l) => `${f.blockId}:${l.from}`) : [],
            ),
          );
          const all = items.flatMap((it) =>
            it.fragment.lines.map((l) => `${it.fragment.blockId}:${l.from}`),
          );
          expect(placed).toEqual(all);
          // A kept pin's page overflows by no more than the tolerance.
          for (const j of result.reconciliation!.judgements)
            if (j.decision !== 'dropped') expect(j.overflow).toBeLessThanOrEqual(tolerance);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('the tolerance is one line unless a length is given (owner decision 248)', () => {
  it('keeps a pin whose page overflows by less than its tallest line, with no tolerance given', () => {
    // 5 points over a 100-point page, and the tallest line of the page is 20 points.
    const items: PageItem[] = [para('A', [20, 20, 20, 20, 20, 5]), para('B', [20, 20])];
    const result = paginate(items, page(100), { pins: { pages: [pin(1, 'A'), pin(2, 'B')] } });
    expect(result.reconciliation!.judgements.map((j) => j.decision)).toEqual(['overflows', 'fits']);
    expect(pagesOf(result.pages)).toEqual([['A:0-60'], ['B:0-20']]);
    expect(result.pages.some((p) => p.estimated)).toBe(false);
  });

  it('allows an overflow of exactly one line and drops a pin beyond it', () => {
    // 20 points over: exactly the tallest line, so the pin stays.
    const one: PageItem[] = [para('A', [20, 20, 20, 20, 20, 20]), para('B', [20, 20])];
    const kept = paginate(one, page(100), {
      pins: { pages: [pin(1, 'A'), pin(2, 'B')], tolerance: 'line' },
    });
    expect(kept.reconciliation!.judgements[0]!.decision).toBe('overflows');
    // 30 points over: more than one line, so the pin is dropped and the page is estimated.
    const two: PageItem[] = [para('A', [20, 20, 20, 20, 20, 20, 10]), para('B', [20, 20])];
    const dropped = paginate(two, page(100), { pins: { pages: [pin(1, 'A'), pin(2, 'B')] } });
    expect(dropped.reconciliation!.judgements.map((j) => j.decision)).toEqual(['dropped', 'fits']);
    expect(dropped.pages[0]!.estimated).toBe(true);
  });

  it('a length given by the caller still wins over the line', () => {
    const items: PageItem[] = [para('A', [20, 20, 20, 20, 20, 5]), para('B', [20, 20])];
    const result = paginate(items, page(100), {
      pins: { pages: [pin(1, 'A'), pin(2, 'B')], tolerance: 2 },
    });
    expect(result.reconciliation!.judgements[0]!.decision).toBe('dropped');
  });
});
