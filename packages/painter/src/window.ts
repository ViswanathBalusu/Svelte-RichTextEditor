/**
 * Virtualised page window (02 §9.5; FE-092 criteria 1 and 3). Only the pages the scroll position
 * needs, with an overscan on each side, are mounted in the scroller. Every page keeps its height in
 * the height store (`pageHeights`), mounted or not, so the stacked pages keep their place while the
 * others are unmounted.
 *
 * The page heights and the scroll position are in points (the layout's unit); the scroller is in
 * CSS pixels, so the window converts at 72/96 points per pixel. The window reads the scroller's
 * `scrollTop` and `clientHeight`, and repaints on the scroller's `scroll` event and on `update()`.
 */
import { pageHeights, visiblePages } from '../../layout/src/page-heights.ts';
import type { LayoutTree } from '../../layout/src/tree.ts';
import { paintTree, type PaintOptions, type PaintSource } from './painter.ts';

const PT_PER_PX = 72 / 96;

export interface WindowOptions extends PaintOptions {
  /** Pages mounted on each side of the viewport. Defaults to 1. */
  readonly overscan?: number;
}

export interface PageWindow {
  /** Mounts the pages the scroll position needs and unmounts the rest. Returns the mounted range. */
  update(): { readonly first: number; readonly last: number } | null;
  /** The indices of the mounted pages, in order. */
  mountedPages(): number[];
  /** The height of page `index` in points: computed from the tree. */
  heightOf(index: number): number;
  /** The height of the stacked pages, gaps included, in points. */
  readonly totalHeight: number;
  /** Removes the window and its listener from the scroller. */
  dispose(): void;
}

/** Mounts a page window over `tree` in `scroller`, an element with a fixed height and scrolling. */
export function mountPageWindow(
  scroller: HTMLElement,
  tree: LayoutTree,
  source: PaintSource,
  options: WindowOptions = {},
): PageWindow {
  const doc = scroller.ownerDocument;
  const gap = options.pageGap ?? 12;
  const overscan = options.overscan ?? 1;
  const pageCount = tree.pages.length;

  const heights = pageHeights(tree.pages[0]?.height ?? 0);
  tree.pages.forEach((page, i) => heights.setComputed(i, page.height));
  const tops: number[] = [];
  let y = 0;
  for (let i = 0; i < pageCount; i++) {
    tops.push(y);
    y += heights.heightOf(i).height + gap;
  }
  const totalHeight = pageCount > 0 ? y - gap : 0;

  const spacer = doc.createElement('div');
  spacer.className = 'de-window';
  spacer.style.position = 'relative';
  spacer.style.width = '100%';
  spacer.style.height = `${totalHeight}pt`;
  scroller.appendChild(spacer);

  const mounted = new Map<number, HTMLElement>();

  const update = (): { readonly first: number; readonly last: number } | null => {
    const vis = visiblePages(
      heights,
      pageCount,
      scroller.scrollTop * PT_PER_PX,
      scroller.clientHeight * PT_PER_PX,
      overscan,
      gap,
    );
    if (vis === null) {
      for (const el of mounted.values()) el.remove();
      mounted.clear();
      return null;
    }
    for (const [i, el] of mounted) {
      if (i < vis.first || i > vis.last) {
        el.remove();
        mounted.delete(i);
      }
    }
    for (let i = vis.first; i <= vis.last; i++) {
      if (mounted.has(i)) continue;
      const fragment = doc.createDocumentFragment();
      const one = paintTree(
        fragment,
        { engine: tree.engine, measurer: tree.measurer, pages: [tree.pages[i]!] },
        source,
        options,
      );
      const el = one.pages[0]!;
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.right = '0';
      el.style.top = `${tops[i]}pt`;
      el.style.margin = '0 auto';
      spacer.appendChild(el);
      mounted.set(i, el);
    }
    return { first: vis.first, last: vis.last };
  };

  const onScroll = (): void => {
    update();
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  update();

  return {
    update,
    mountedPages: () => [...mounted.keys()].sort((a, b) => a - b),
    heightOf: (index) => heights.heightOf(index).height,
    totalHeight,
    dispose(): void {
      scroller.removeEventListener('scroll', onScroll);
      spacer.remove();
      mounted.clear();
    },
  };
}
