/**
 * UX-021 (lane w3, 2026-11-21): what the page view tells the navigation pane about its pages, in
 * Node.js. The page the view shows (criterion 2), where the text of a page starts (the caret goes
 * there when a thumbnail is chosen), and the service the shell reads, which has pages only while a
 * view with pages is shown (criterion 3). The pane and the drawing run in the browsers
 * (packages/element/e2e/ux-021-page-thumbnails.spec.ts).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LayoutFragment, LayoutPage } from '../../layout/src/tree.ts';
import { pagesBridge } from '../src/page-thumbnails.ts';
import { mostVisiblePage, textStarts, type PageViewPages } from '../src/page-view/pages.ts';

/** Pages of one height with a gap between them: their tops. */
function stack(count: number, height: number, gap: number): { tops: number[]; heights: number[] } {
  const tops: number[] = [];
  const heights: number[] = [];
  for (let i = 0; i < count; i++) {
    tops.push(i * (height + gap));
    heights.push(height);
  }
  return { tops, heights };
}

describe('UX-021 criterion 2: the page the view shows', () => {
  const { tops, heights } = stack(5, 842, 12);

  it('is the first page at the top of the document', () => {
    expect(mostVisiblePage(tops, heights, 0, 600)).toBe(0);
  });

  it('is the page that takes most of the viewport', () => {
    // The last 100 points of page 1 and the first 488 of page 2.
    expect(mostVisiblePage(tops, heights, 742, 600)).toBe(1);
    // The last 100 points of page 2 and the first 488 of page 3.
    expect(mostVisiblePage(tops, heights, 842 + 12 + 742, 600)).toBe(2);
    expect(mostVisiblePage(tops, heights, tops[4]!, 600)).toBe(4);
  });

  it('is the earlier of two pages that take the same share', () => {
    // 294 points of each page and the gap of 12 between them.
    expect(mostVisiblePage(tops, heights, 842 - 294, 600)).toBe(0);
  });

  it('is the page a viewport taller than a page holds whole', () => {
    // 300 points of page 1, then the whole of page 2.
    expect(mostVisiblePage(tops, heights, 842 - 300, 1400)).toBe(1);
  });

  it('is the last page that starts at or before the position, when the viewport has no size', () => {
    expect(mostVisiblePage(tops, heights, 0, 0)).toBe(0);
    expect(mostVisiblePage(tops, heights, tops[3]! + 5, 0)).toBe(3);
    expect(mostVisiblePage(tops, heights, 1e9, 0)).toBe(4);
  });

  it('is 0 for no pages', () => {
    expect(mostVisiblePage([], [], 100, 600)).toBe(0);
  });

  it('is a page whose share of the viewport no other page exceeds (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 50, max: 2000 }), { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 0, max: 40 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 3000 }),
        (hs, gap, where, viewport) => {
          const ts: number[] = [];
          let y = 0;
          for (const h of hs) {
            ts.push(y);
            y += h + gap;
          }
          const scrollTop = where * Math.max(0, y - gap - viewport);
          const share = (i: number): number =>
            Math.max(
              0,
              Math.min(ts[i]! + hs[i]!, scrollTop + viewport) - Math.max(ts[i]!, scrollTop),
            );
          const shown = mostVisiblePage(ts, hs, scrollTop, viewport);
          expect(shown).toBeGreaterThanOrEqual(0);
          expect(shown).toBeLessThan(hs.length);
          for (let i = 0; i < hs.length; i++) expect(share(i)).toBeLessThanOrEqual(share(shown));
          // And the earliest of those with that share. A viewport that lies in the gap between two
          // pages shows none of them: the page is then the one that starts before it.
          if (share(shown) > 0)
            for (let i = 0; i < shown; i++) expect(share(i)).toBeLessThan(share(shown));
          else expect(ts[shown]!).toBeLessThanOrEqual(scrollTop);
        },
      ),
    );
  });
});

const line = (from: number, to: number) => ({ from, to, x: 0, y: 0, width: 10, height: 12 });
const paragraph = (blockId: string, from: number, to: number): LayoutFragment => ({
  kind: 'paragraph',
  blockId,
  from,
  to,
  x: 72,
  y: 72,
  width: 400,
  height: 12,
  lines: [line(from, to)],
});
const pageOf = (fragments: LayoutFragment[]): LayoutPage => ({
  index: 0,
  section: 0,
  width: 595,
  height: 842,
  fragments,
  header: [paragraph('header', 0, 6)],
  footer: [],
  footnotes: [],
});

describe('UX-021 criterion 2: where the text of a page starts', () => {
  it('is the first position of the first line on the page, also in the middle of a block', () => {
    expect([...textStarts(pageOf([paragraph('p1', 120, 180), paragraph('p2', 0, 40)]))]).toEqual([
      { blockId: 'p1', offset: 120 },
      { blockId: 'p2', offset: 0 },
    ]);
  });

  it('passes over the header rows a table repeats, and takes the text of its cells', () => {
    const table: LayoutFragment = {
      kind: 'table',
      blockId: 't1',
      x: 72,
      y: 72,
      width: 400,
      height: 60,
      rows: [
        {
          rowId: 'head',
          repeated: true,
          y: 0,
          height: 20,
          cells: [{ cellId: 'h', x: 0, width: 400, fragments: [paragraph('pHead', 0, 4)] }],
        },
        {
          rowId: 'r7',
          repeated: false,
          y: 20,
          height: 20,
          cells: [
            { cellId: 'a', x: 0, width: 200, fragments: [paragraph('pA', 0, 3)] },
            { cellId: 'b', x: 200, width: 200, fragments: [paragraph('pB', 0, 5)] },
          ],
        },
      ],
    };
    expect([...textStarts(pageOf([table, paragraph('after', 0, 9)]))]).toEqual([
      { blockId: 'pA', offset: 0 },
      { blockId: 'pB', offset: 0 },
      { blockId: 'after', offset: 0 },
    ]);
  });

  it('is nowhere on a page that holds a figure alone, and never in a header or footer', () => {
    const box: LayoutFragment = {
      kind: 'box',
      blockId: 'fig',
      x: 72,
      y: 72,
      width: 300,
      height: 200,
    };
    expect([...textStarts(pageOf([box]))]).toEqual([]);
  });
});

/** A page source a test moves by hand. */
function fakeSource(start: { count: number; current: number; revision: number }) {
  let info = start;
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const source: PageViewPages = {
    info: () => info,
    size: (index) => (index < info.count ? { width: 595, height: 842 } : null),
    paint: (index) => {
      calls.push(`paint ${index}`);
      return index < info.count;
    },
    goTo: (index) => {
      calls.push(`goTo ${index}`);
      return index < info.count;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    calls,
    listeners,
    move(next: Partial<typeof info>): void {
      info = { ...info, ...next };
      for (const listener of [...listeners]) listener();
    },
  };
}

describe('UX-021 criterion 3: the service has pages only while a view with pages is shown', () => {
  it('has none before any view gave its pages, and offers nothing then', () => {
    const bridge = pagesBridge();
    expect(bridge.service.state.get()).toBeNull();
    expect(bridge.service.size(0)).toBeNull();
    expect(bridge.service.goTo(0)).toBe(false);
    expect(bridge.service.paint(0, {} as HTMLElement, 120)).toBe(false);
  });

  it('follows the view that has the pages, and tells its readers of each change once', () => {
    const bridge = pagesBridge();
    let told = 0;
    bridge.service.state.subscribe(() => told++);
    const view = fakeSource({ count: 12, current: 0, revision: 1 });
    bridge.set(view.source);
    expect(told).toBe(1);
    expect(bridge.service.state.get()).toEqual({ count: 12, current: 0, revision: 1 });

    // The same values again are no change: the reader keeps the object it has.
    const before = bridge.service.state.get();
    view.move({});
    expect(told).toBe(1);
    expect(bridge.service.state.get()).toBe(before);

    view.move({ current: 4 });
    view.move({ count: 13, revision: 2 });
    expect(told).toBe(3);
    expect(bridge.service.state.get()).toEqual({ count: 13, current: 4, revision: 2 });
  });

  it('hands the drawing and the move to the view', () => {
    const bridge = pagesBridge();
    const view = fakeSource({ count: 3, current: 0, revision: 1 });
    bridge.set(view.source);
    expect(bridge.service.size(2)).toEqual({ width: 595, height: 842 });
    expect(bridge.service.size(3)).toBeNull();
    expect(bridge.service.goTo(2)).toBe(true);
    expect(bridge.service.goTo(7)).toBe(false);
    expect(bridge.service.paint(1, {} as HTMLElement, 120)).toBe(true);
    expect(view.calls).toEqual(['goTo 2', 'goTo 7', 'paint 1']);
  });

  it('has none again when the web view is shown, and stops listening to the view that went', () => {
    const bridge = pagesBridge();
    let told = 0;
    bridge.service.state.subscribe(() => told++);
    const view = fakeSource({ count: 5, current: 2, revision: 1 });
    bridge.set(view.source);
    bridge.set(null);
    expect(told).toBe(2);
    expect(bridge.service.state.get()).toBeNull();
    expect(view.listeners.size).toBe(0);
    view.move({ current: 3 });
    expect(told).toBe(2);
    expect(bridge.service.goTo(1)).toBe(false);
    expect(view.calls).toEqual([]);
  });

  it('has none for a view that has stopped and reports no page', () => {
    const bridge = pagesBridge();
    const view = fakeSource({ count: 5, current: 2, revision: 1 });
    bridge.set(view.source);
    view.move({ count: 0 });
    expect(bridge.service.state.get()).toBeNull();
  });

  it('takes the pages of the next view in place of the last one', () => {
    const bridge = pagesBridge();
    const first = fakeSource({ count: 5, current: 2, revision: 1 });
    const second = fakeSource({ count: 9, current: 0, revision: 1 });
    bridge.set(first.source);
    bridge.set(second.source);
    expect(first.listeners.size).toBe(0);
    expect(bridge.service.state.get()).toEqual({ count: 9, current: 0, revision: 1 });
  });
});
