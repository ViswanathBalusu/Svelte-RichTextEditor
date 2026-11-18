/**
 * Keyboard movement and selection extension in the page view (FE-097 criteria 2 and 5, FE-096
 * criterion 6), in Node.js. The trees are built by hand with five points per offset, as in
 * `caret-page.test.ts`; a seeded generator drives the invariants over random key sequences.
 */
import { describe, expect, it } from 'vitest';
import { hitTest, selectionRects, type DocPosition, type SpanWidth } from './caret.ts';
import {
  applyPageKey,
  bodyEdges,
  clampHead,
  pageKeyOf,
  type PageKey,
  type PageSelection,
  type RegionOf,
} from './page-keys.ts';
import type {
  LayoutFragment,
  LayoutLine,
  LayoutPage,
  LayoutTree,
  ParagraphFragment,
} from './tree.ts';

const perOffset: SpanWidth = (_block, from, to) => (to - from) * 5;

function paragraph(
  blockId: string,
  x: number,
  y: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): ParagraphFragment {
  const lineHeight = 12;
  const lines: LayoutLine[] = ranges.map(([from, to], i) => ({
    from,
    to,
    x: 0,
    y: i * lineHeight,
    width: (to - from) * 5,
    height: lineHeight,
  }));
  return {
    kind: 'paragraph',
    blockId,
    from: ranges[0]![0],
    to: ranges[ranges.length - 1]![1],
    x,
    y,
    width: 200,
    height: ranges.length * lineHeight,
    lines,
  };
}

function page(
  index: number,
  fragments: LayoutFragment[],
  extra: Partial<Pick<LayoutPage, 'header' | 'footer' | 'footnotes'>> = {},
): LayoutPage {
  return {
    index,
    section: 0,
    width: 200,
    height: 300,
    fragments,
    header: extra.header ?? [],
    footer: extra.footer ?? [],
    footnotes: extra.footnotes ?? [],
  };
}

/**
 * Page 0: header 'hd'; body 'a' (one line), 'r1' (two lines) and 'r2' (one line), both in region R,
 * then 'b'; footnote 'fn'. Page 1: body 'c' and a footer 'ft'.
 */
const tree = (): LayoutTree => ({
  engine: 'test',
  measurer: 'test',
  pages: [
    page(
      0,
      [
        paragraph('a', 10, 100, [[0, 8]]),
        paragraph('r1', 10, 130, [
          [0, 4],
          [4, 10],
        ]),
        paragraph('r2', 10, 170, [[0, 6]]),
        paragraph('b', 10, 200, [[0, 5]]),
      ],
      {
        header: [paragraph('hd', 10, 20, [[0, 6]])],
        footnotes: [paragraph('fn', 10, 260, [[0, 4]])],
      },
    ),
    page(1, [paragraph('c', 10, 100, [[0, 5]])], { footer: [paragraph('ft', 10, 280, [[0, 3]])] }),
  ],
});

const regionOf: RegionOf = (id) => (id === 'r1' || id === 'r2' ? 'R' : null);
const at = (blockId: string, offset: number): DocPosition => ({ blockId, offset });
const caret = (blockId: string, offset: number): PageSelection => ({
  anchor: at(blockId, offset),
  head: at(blockId, offset),
  goalX: undefined,
});

describe('Home and End (FE-097 criterion 2)', () => {
  it('moves the caret to the start and the end of the painted line', () => {
    const t = tree();
    expect(applyPageKey(t, caret('r1', 6), 'Home', false, perOffset).head).toEqual(at('r1', 4));
    // The last line of its block ends at `to`.
    expect(applyPageKey(t, caret('r1', 6), 'End', false, perOffset).head).toEqual(at('r1', 10));
    // A wrapped line ends before the character at the wrap, so the caret stays on that line.
    expect(applyPageKey(t, caret('r1', 2), 'End', false, perOffset).head).toEqual(at('r1', 3));
    expect(applyPageKey(t, caret('r1', 2), 'Home', false, perOffset).head).toEqual(at('r1', 0));
  });

  it('collapses the selection without Shift and forgets the goal x', () => {
    const t = tree();
    const sel: PageSelection = { anchor: at('a', 1), head: at('r1', 6), goalX: 40 };
    const out = applyPageKey(t, sel, 'Home', false, perOffset);
    expect(out).toEqual({ anchor: at('r1', 4), head: at('r1', 4), goalX: undefined });
  });

  it('extends the selection with Shift, keeping the anchor, in both directions', () => {
    const t = tree();
    const home = applyPageKey(t, caret('b', 3), 'Home', true, perOffset);
    expect(home.anchor).toEqual(at('b', 3));
    expect(home.head).toEqual(at('b', 0));
    expect(selectionRects(t, home.anchor, home.head, perOffset)).toEqual([
      { page: 0, x: 10, y: 200, width: 15, height: 12 },
    ]);
    const end = applyPageKey(t, home, 'End', true, perOffset);
    expect(end.anchor).toEqual(at('b', 3));
    expect(end.head).toEqual(at('b', 5));
    // A second End on the same line does not move the head.
    expect(applyPageKey(t, end, 'End', true, perOffset)).toEqual(end);
  });

  it('extends from the head, not from the anchor, when the selection already runs over lines', () => {
    const t = tree();
    const down = applyPageKey(t, caret('r1', 1), 'ArrowDown', true, perOffset);
    expect(down.head.blockId).toBe('r1');
    expect(down.head.offset).toBeGreaterThanOrEqual(4);
    const end = applyPageKey(t, down, 'End', true, perOffset);
    expect(end.anchor).toEqual(at('r1', 1));
    expect(end.head).toEqual(at('r1', 10));
  });

  it('leaves the selection alone for a block with no painted line', () => {
    const t = tree();
    const sel = caret('ghost', 2);
    expect(applyPageKey(t, sel, 'Home', false, perOffset)).toEqual(sel);
  });
});

describe('the start and the end of the document stay in the body (FE-097 criterion 5)', () => {
  it('goes to the first and the last body position, never to a header, footer or footnote', () => {
    const t = tree();
    expect(bodyEdges(t)).toEqual({ start: at('a', 0), end: at('c', 5) });
    expect(applyPageKey(t, caret('r2', 3), 'DocumentStart', false, perOffset).head).toEqual(
      at('a', 0),
    );
    expect(applyPageKey(t, caret('r2', 3), 'DocumentEnd', false, perOffset).head).toEqual(
      at('c', 5),
    );
  });

  it('stays put at the first and the last body position', () => {
    const t = tree();
    expect(applyPageKey(t, caret('a', 0), 'DocumentStart', false, perOffset).head).toEqual(
      at('a', 0),
    );
    expect(applyPageKey(t, caret('c', 5), 'DocumentEnd', false, perOffset).head).toEqual(
      at('c', 5),
    );
    expect(applyPageKey(t, caret('a', 0), 'ArrowUp', false, perOffset).head).toEqual(at('a', 0));
    expect(applyPageKey(t, caret('c', 5), 'ArrowDown', false, perOffset).head).toEqual(at('c', 5));
    expect(applyPageKey(t, caret('a', 0), 'PageUp', false, perOffset).head).toEqual(at('a', 0));
  });

  it('extends to the edges of the body with Shift', () => {
    const t = tree();
    const sel = applyPageKey(t, caret('r2', 3), 'DocumentEnd', true, perOffset);
    expect(sel.anchor).toEqual(at('r2', 3));
    expect(sel.head).toEqual(at('c', 5));
    const back = applyPageKey(t, sel, 'DocumentStart', true, perOffset);
    expect(back.head).toEqual(at('a', 0));
  });

  it('has no edges for a tree with no body line', () => {
    const empty: LayoutTree = { engine: 'test', measurer: 'test', pages: [page(0, [])] };
    expect(bodyEdges(empty)).toBeNull();
    expect(applyPageKey(empty, caret('a', 0), 'DocumentEnd', false, perOffset).head).toEqual(
      at('a', 0),
    );
  });
});

describe('a selection that starts in a region stops at its edge (FE-096 criterion 6)', () => {
  it('stops at the last position of the region when extended down past it', () => {
    const t = tree();
    let sel = caret('r1', 6);
    sel = applyPageKey(t, sel, 'ArrowDown', true, perOffset, regionOf);
    expect(sel.head.blockId).toBe('r2');
    sel = applyPageKey(t, sel, 'ArrowDown', true, perOffset, regionOf);
    expect(sel.head).toEqual(at('r2', 6));
    expect(sel.anchor).toEqual(at('r1', 6));
    // Further presses stay at the edge.
    expect(applyPageKey(t, sel, 'ArrowDown', true, perOffset, regionOf).head).toEqual(at('r2', 6));
  });

  it('stops at the first position of the region when extended up past it', () => {
    const t = tree();
    const sel = applyPageKey(t, caret('r1', 2), 'ArrowUp', true, perOffset, regionOf);
    expect(sel.head).toEqual(at('r1', 0));
  });

  it('clamps Page Down, Page Up and the document commands', () => {
    const t = tree();
    expect(applyPageKey(t, caret('r1', 6), 'PageDown', true, perOffset, regionOf).head).toEqual(
      at('r2', 6),
    );
    expect(applyPageKey(t, caret('r2', 3), 'PageUp', true, perOffset, regionOf).head).toEqual(
      at('r1', 0),
    );
    expect(applyPageKey(t, caret('r2', 3), 'DocumentEnd', true, perOffset, regionOf).head).toEqual(
      at('r2', 6),
    );
    expect(
      applyPageKey(t, caret('r2', 3), 'DocumentStart', true, perOffset, regionOf).head,
    ).toEqual(at('r1', 0));
  });

  it('does not clamp a selection that starts outside the region and runs into it', () => {
    const t = tree();
    let sel = caret('a', 2);
    sel = applyPageKey(t, sel, 'ArrowDown', true, perOffset, regionOf);
    expect(sel.head.blockId).toBe('r1');
    sel = applyPageKey(t, sel, 'DocumentEnd', true, perOffset, regionOf);
    expect(sel.head).toEqual(at('c', 5));
  });

  it('does not clamp a collapsed caret: it crosses the boundary', () => {
    const t = tree();
    expect(
      applyPageKey(t, caret('r2', 3), 'ArrowDown', false, perOffset, regionOf).head.blockId,
    ).toBe('b');
    expect(
      applyPageKey(t, caret('r1', 1), 'ArrowUp', false, perOffset, regionOf).head.blockId,
    ).toBe('a');
  });

  it('does not clamp when no region provider is given', () => {
    const t = tree();
    expect(applyPageKey(t, caret('r2', 3), 'DocumentEnd', true, perOffset).head).toEqual(
      at('c', 5),
    );
  });

  it('clamps the head of a pointer drag the same way', () => {
    const t = tree();
    // A point on 'b' (page 0, y 205) is outside the region.
    const dragged = hitTest(t, 0, 20, 205, perOffset)!;
    expect(dragged.blockId).toBe('b');
    expect(clampHead(t, at('r1', 6), dragged, regionOf)).toEqual(at('r2', 6));
    // A point above the region, on 'a'.
    const above = hitTest(t, 0, 20, 102, perOffset)!;
    expect(clampHead(t, at('r2', 2), above, regionOf)).toEqual(at('r1', 0));
    // Inside the region, or from outside it, the head is not changed.
    const inside = hitTest(t, 0, 20, 172, perOffset)!;
    expect(clampHead(t, at('r1', 6), inside, regionOf)).toEqual(inside);
    expect(clampHead(t, at('a', 1), dragged, regionOf)).toEqual(dragged);
    // An empty selection is not clamped.
    expect(clampHead(t, at('r1', 6), at('r1', 6), regionOf)).toEqual(at('r1', 6));
  });

  it('draws the clamped selection from the tree: it ends with the region', () => {
    const t = tree();
    const sel = applyPageKey(t, caret('r1', 6), 'DocumentEnd', true, perOffset, regionOf);
    const rects = selectionRects(t, sel.anchor, sel.head, perOffset);
    expect(rects.map((r) => r.y)).toEqual([142, 170]);
    expect(Math.max(...rects.map((r) => r.y))).toBeLessThan(200);
  });
});

describe('vertical moves carry the goal x through the selection', () => {
  it('keeps the goal x over several presses, with or without Shift', () => {
    const t = tree();
    const first = applyPageKey(t, caret('a', 4), 'ArrowDown', true, perOffset, regionOf);
    expect(first.goalX).toBe(30);
    const second = applyPageKey(t, first, 'ArrowDown', true, perOffset, regionOf);
    expect(second.goalX).toBe(30);
    expect(applyPageKey(t, second, 'Home', true, perOffset, regionOf).goalX).toBeUndefined();
  });
});

describe('key events', () => {
  const ev = (
    key: string,
    mods: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey', boolean>> = {},
  ) => pageKeyOf({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...mods });

  it('maps the movement keys, and Shift to extension', () => {
    expect(ev('Home')).toEqual({ key: 'Home', extend: false });
    expect(ev('End', { shiftKey: true })).toEqual({ key: 'End', extend: true });
    expect(ev('PageDown')).toEqual({ key: 'PageDown', extend: false });
    expect(ev('ArrowUp', { shiftKey: true })).toEqual({ key: 'ArrowUp', extend: true });
  });

  it('maps Ctrl+Home and Ctrl+End to the document commands', () => {
    expect(ev('Home', { ctrlKey: true })).toEqual({ key: 'DocumentStart', extend: false });
    expect(ev('End', { ctrlKey: true, shiftKey: true })).toEqual({
      key: 'DocumentEnd',
      extend: true,
    });
  });

  it('leaves other keys and Alt or Meta chords to the bridge', () => {
    expect(ev('a')).toBeNull();
    expect(ev('ArrowLeft')).toBeNull();
    expect(ev('Home', { altKey: true })).toBeNull();
    expect(ev('End', { metaKey: true })).toBeNull();
    expect(ev('ArrowUp', { ctrlKey: true })).toBeNull();
  });
});

describe('invariants over random key sequences', () => {
  function mulberry32(seed: number): () => number {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const keys: PageKey[] = [
    'ArrowUp',
    'ArrowDown',
    'PageUp',
    'PageDown',
    'Home',
    'End',
    'DocumentStart',
    'DocumentEnd',
  ];
  const bodyBlocks = new Set(['a', 'r1', 'r2', 'b', 'c']);

  it('never leaves the body, and never leaves the region of a selection that starts in it', () => {
    const t = tree();
    const rand = mulberry32(2026);
    for (let run = 0; run < 200; run++) {
      const startBlock = ['a', 'r1', 'r2', 'b', 'c'][Math.floor(rand() * 5)]!;
      let sel = caret(startBlock, 0);
      let extending = false;
      for (let step = 0; step < 12; step++) {
        const key = keys[Math.floor(rand() * keys.length)]!;
        const extend = rand() < 0.5;
        if (!extend) extending = false;
        else if (!extending) {
          // The selection's anchor is where the head is when extension starts.
          sel = { ...sel, anchor: sel.head };
          extending = true;
        }
        sel = applyPageKey(t, sel, key, extend, perOffset, regionOf);
        expect(bodyBlocks.has(sel.head.blockId)).toBe(true);
        if (extending && regionOf(sel.anchor.blockId) === 'R') {
          expect(regionOf(sel.head.blockId)).toBe('R');
        }
      }
    }
  });
});
