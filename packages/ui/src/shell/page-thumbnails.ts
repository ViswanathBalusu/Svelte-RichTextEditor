/**
 * The geometry of the navigation pane's page thumbnails (UX-021; 13 §2): where each thumbnail sits
 * in the list, which thumbnails a scroll position needs, and where a key moves. Only the thumbnails
 * near what is visible are in the DOM; the others are a height in the list and nothing else, so a
 * document of a thousand pages costs the pane a handful of drawings (FE-102 criterion 3).
 *
 * No DOM here. The lengths are CSS pixels. The figures below are the pane's own layout, not
 * measurements: a thumbnail is as wide as `THUMB_WIDTH` and as tall as its page's proportions make
 * it, with the page number on a line under it.
 */

/** The inline size of a thumbnail's page. */
export const THUMB_WIDTH = 120;
/** The block size of the line under a thumbnail that holds the page number. */
export const THUMB_LABEL = 24;
/** The space between two thumbnails. */
export const THUMB_GAP = 12;
/** The space before the first thumbnail and after the last, so that a frame around one is not cut. */
export const THUMB_PAD = 6;
/** How many thumbnails are kept in the DOM on each side of the visible ones. */
export const THUMB_OVERSCAN = 2;

/** The proportions used for a page whose size is not known: A4, upright. */
const DEFAULT_RATIO = 841.89 / 595.28;
/** A page is drawn no flatter and no taller than this, whatever its size says. */
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;

export interface PageSize {
  readonly width: number;
  readonly height: number;
}

export interface ThumbLayout {
  /** Where each item starts in the list. */
  readonly tops: readonly number[];
  /** The block size of each item's page, without the line under it. */
  readonly heights: readonly number[];
  /** The block size of the whole list. */
  readonly total: number;
}

/** The block size of the page of a thumbnail `width` wide. */
export function thumbHeight(size: PageSize | null, width = THUMB_WIDTH): number {
  const ratio =
    size && size.width > 0 && size.height > 0 && Number.isFinite(size.height / size.width)
      ? size.height / size.width
      : DEFAULT_RATIO;
  return Math.round(width * Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)));
}

/** Lays `count` thumbnails out one under the other. */
export function thumbLayout(
  count: number,
  sizeOf: (index: number) => PageSize | null,
  width = THUMB_WIDTH,
): ThumbLayout {
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  const tops: number[] = [];
  const heights: number[] = [];
  let y = THUMB_PAD;
  for (let i = 0; i < n; i++) {
    const h = thumbHeight(sizeOf(i), width);
    tops.push(y);
    heights.push(h);
    y += h + THUMB_LABEL + THUMB_GAP;
  }
  return { tops, heights, total: n > 0 ? y - THUMB_GAP + THUMB_PAD : 0 };
}

/** Where item `index` ends in the list, the line under its page included. */
export function thumbBottom(layout: ThumbLayout, index: number): number {
  return (layout.tops[index] ?? 0) + (layout.heights[index] ?? 0) + THUMB_LABEL;
}

/**
 * The items a scroll position needs: those that are at least partly inside `[scrollTop, scrollTop +
 * viewport)`, and `overscan` more on each side. Null for an empty list. A list that has no size yet
 * (a viewport of 0) gets its first items, so that something is drawn when it is first shown.
 */
export function thumbWindow(
  layout: ThumbLayout,
  scrollTop: number,
  viewport: number,
  overscan = THUMB_OVERSCAN,
): { readonly first: number; readonly last: number } | null {
  const count = layout.tops.length;
  if (count === 0) return null;
  const top = Math.max(0, Number.isFinite(scrollTop) ? scrollTop : 0);
  const bottom = top + Math.max(0, Number.isFinite(viewport) ? viewport : 0);
  // The first item that ends after the top edge, by bisection: the tops grow with the index.
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (thumbBottom(layout, mid) > top) hi = mid;
    else lo = mid + 1;
  }
  const firstVisible = lo;
  let lastVisible = firstVisible;
  while (lastVisible + 1 < count && (layout.tops[lastVisible + 1] ?? 0) < bottom) lastVisible++;
  const extra = Math.max(0, Math.floor(overscan));
  return {
    first: Math.max(0, firstVisible - extra),
    last: Math.min(count - 1, lastVisible + extra),
  };
}

/**
 * The scroll position that shows item `index` whole, with the space around it (`THUMB_PAD`), while
 * moving as little as possible: unchanged when the item is already inside the viewport, else with
 * the item at the nearer edge. An item taller than the viewport is shown from its start.
 */
export function revealScroll(
  layout: ThumbLayout,
  index: number,
  scrollTop: number,
  viewport: number,
): number {
  const itemTop = layout.tops[index];
  if (itemTop === undefined) return scrollTop;
  const top = itemTop - THUMB_PAD;
  const bottom = thumbBottom(layout, index) + THUMB_PAD;
  const max = Math.max(0, layout.total - viewport);
  let next = scrollTop;
  if (top < scrollTop || bottom - top > viewport) next = top;
  else if (bottom > scrollTop + viewport) next = bottom - viewport;
  return Math.min(max, Math.max(0, next));
}

/** How many items a Page Up or Page Down key moves by: those that fit in the viewport, at least one. */
export function pageStep(layout: ThumbLayout, index: number, viewport: number): number {
  const height = (layout.heights[index] ?? thumbHeight(null)) + THUMB_LABEL + THUMB_GAP;
  return Math.max(1, Math.floor(viewport / height));
}

/**
 * The item a key moves to from `active`, or null for a key the list does not take. The list is one
 * column, so the keys are the vertical ones of the listbox pattern; they stop at the ends.
 */
export function thumbKey(key: string, active: number, count: number, step = 1): number | null {
  if (count <= 0) return null;
  const clamp = (i: number): number => Math.min(count - 1, Math.max(0, i));
  switch (key) {
    case 'ArrowDown':
      return clamp(active + 1);
    case 'ArrowUp':
      return clamp(active - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return clamp(active + Math.max(1, step));
    case 'PageUp':
      return clamp(active - Math.max(1, step));
    default:
      return null;
  }
}
