/**
 * Page heights for background pagination and page virtualisation (02 §9.5; FE-089 criterion 2,
 * FE-092). A page that has not been computed yet has an estimated height, and a computed height
 * replaces the estimate. The store keeps the heights of all pages, whether or not the painter has
 * mounted them, so a page that leaves the mounted window and comes back keeps its height.
 *
 * The estimate is a proposed default, recorded in docs/adr/0135-layout-2-backlog-batch.md (item 1):
 * the mean of the computed heights so far, or `fallbackHeight` (the body height of the page setup)
 * while no page is computed. 02 §9.5 does not say how the estimate is formed.
 *
 * `visiblePages` answers which pages a scroll position needs, with an overscan on each side. It is
 * the engine's half of FE-092 criterion 1: the painter mounts those pages. It takes a linear scan
 * over the page heights, which is fine for the page counts this phase targets; it is not cached.
 *
 * Universal: no DOM and no Node.js API (FND-004). Lengths are in points.
 */

export interface PageHeight {
  /** The height of the page in points. */
  readonly height: number;
  /** True while the height is an estimate; false once the page has been computed. */
  readonly estimated: boolean;
}

export interface PageHeights {
  /** Records the computed height of page `index` (0-based). It replaces any estimate. */
  setComputed(index: number, height: number): void;
  /** Forgets the computed heights of page `from` and later. Those pages are estimates again. */
  invalidateFrom(from: number): void;
  /** The height of page `index`: computed when known, otherwise an estimate. */
  heightOf(index: number): PageHeight;
  /** The number of pages with a computed height. */
  readonly computedCount: number;
}

function checkIndex(index: number): void {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new RangeError(`page index must be a non-negative integer, got ${index}`);
}

function checkLength(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError(`${name} must be a finite length of at least 0, got ${value}`);
}

/** A height store for a document whose pages are computed in any order. */
export function pageHeights(fallbackHeight: number): PageHeights {
  checkLength('fallbackHeight', fallbackHeight);
  const computed = new Map<number, number>();
  let sum = 0;

  const estimate = (): number => (computed.size === 0 ? fallbackHeight : sum / computed.size);

  return {
    setComputed(index, height) {
      checkIndex(index);
      checkLength('height', height);
      const old = computed.get(index);
      if (old !== undefined) sum -= old;
      computed.set(index, height);
      sum += height;
    },
    invalidateFrom(from) {
      checkIndex(from);
      for (const [index, height] of [...computed]) {
        if (index >= from) {
          computed.delete(index);
          sum -= height;
        }
      }
      // Recompute from the survivors, so that rounding from earlier updates does not persist.
      sum = 0;
      for (const height of computed.values()) sum += height;
    },
    heightOf(index) {
      checkIndex(index);
      const known = computed.get(index);
      if (known !== undefined) return Object.freeze({ height: known, estimated: false });
      return Object.freeze({ height: estimate(), estimated: true });
    },
    get computedCount() {
      return computed.size;
    },
  };
}

export interface VisiblePages {
  /** First page to mount (inclusive), after the overscan. */
  readonly first: number;
  /** Last page to mount (inclusive), after the overscan. */
  readonly last: number;
}

/**
 * The pages a viewport needs: those whose vertical extent meets the viewport, widened by
 * `overscan` pages on each side and clamped to the document. Pages are stacked with `gap` points
 * between them, starting at 0. Returns `null` for a document with no pages.
 */
export function visiblePages(
  heights: PageHeights,
  pageCount: number,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
  gap: number,
): VisiblePages | null {
  if (!Number.isSafeInteger(pageCount) || pageCount < 0)
    throw new RangeError(`pageCount must be a non-negative integer, got ${pageCount}`);
  checkLength('scrollTop', scrollTop);
  checkLength('viewportHeight', viewportHeight);
  checkLength('gap', gap);
  if (!Number.isSafeInteger(overscan) || overscan < 0)
    throw new RangeError(`overscan must be a non-negative integer, got ${overscan}`);
  if (pageCount === 0) return null;

  const bottom = scrollTop + viewportHeight;
  let top = 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < pageCount; i++) {
    const h = heights.heightOf(i).height;
    const end = top + h;
    if (first < 0 && end > scrollTop) first = i;
    if (top < bottom) last = i;
    top = end + gap;
    if (top >= bottom && first >= 0) break;
  }
  // A scroll position past the last page mounts the last page only.
  if (first < 0) first = pageCount - 1;
  if (last < first) last = first;
  return {
    first: Math.max(0, first - overscan),
    last: Math.min(pageCount - 1, last + overscan),
  };
}
