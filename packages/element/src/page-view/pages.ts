/**
 * The pages of the page view as the navigation pane's thumbnails need them (UX-021; 13 §2): which
 * page the view shows, where the text of a page starts, and a small drawing of one page.
 *
 * A thumbnail is the page itself, painted by the same painter from the same layout tree and scaled
 * down with a CSS transform. It is a picture for the eye: it holds no caret, no selection and no
 * control, and the shell hides it from assistive technology.
 */
import type { BlockPoint } from '@docedit/engine';
import type { LayoutFragment, LayoutPage, LayoutTree } from '../../../layout/src/tree.ts';
import { paintTree, type PaintOptions, type PaintSource } from '../../../painter/src/painter.ts';

const PX_PER_PT = 96 / 72;

/** What the page view offers about its pages. */
export interface PageViewPages {
  /** How many pages the last layout has, which one the view shows, and a number that grows with every layout. */
  info(): { readonly count: number; readonly current: number; readonly revision: number };
  /** The size of page `index` in points; null when there is no such page. */
  size(index: number): { readonly width: number; readonly height: number } | null;
  /** Draws page `index` into `target`, `width` CSS pixels wide; false when there is no such page. */
  paint(index: number, target: HTMLElement, width: number): boolean;
  /** Puts the caret at the start of the page's text and the page at the top of the view. */
  goTo(index: number): boolean;
  /** Called when the count, the page shown or the layout changed. Returns the function that unsubscribes. */
  subscribe(listener: () => void): () => void;
}

/**
 * The page the view shows: the one that takes the largest part of the viewport, the earlier of two
 * that take the same. `tops` and `heights` are the pages' places in the scroller, in the unit of
 * `scrollTop` and `viewport`. With nothing in the viewport (a view not yet laid out) it is the last
 * page that starts at or before the scroll position. 0 for no pages.
 */
export function mostVisiblePage(
  tops: readonly number[],
  heights: readonly number[],
  scrollTop: number,
  viewport: number,
): number {
  const count = Math.min(tops.length, heights.length);
  if (count === 0) return 0;
  const top = Number.isFinite(scrollTop) ? scrollTop : 0;
  const bottom = top + Math.max(0, Number.isFinite(viewport) ? viewport : 0);
  let best = -1;
  let bestShare = 0;
  let before = 0;
  for (let i = 0; i < count; i++) {
    const start = tops[i]!;
    if (start <= top) before = i;
    if (start >= bottom) break;
    const share = Math.min(start + heights[i]!, bottom) - Math.max(start, top);
    if (share > bestShare) {
      best = i;
      bestShare = share;
    }
  }
  return best >= 0 ? best : before;
}

/**
 * The places where the text of a page may start, in reading order: the first position of each
 * paragraph fragment of the page's body. The rows a table repeats at the top of a later page are
 * left out: their text is on the page the table starts on.
 */
export function* textStarts(page: LayoutPage): Generator<BlockPoint> {
  function* walk(fragments: readonly LayoutFragment[]): Generator<BlockPoint> {
    for (const f of fragments) {
      if (f.kind === 'paragraph') yield { blockId: f.blockId, offset: f.lines[0]?.from ?? f.from };
      else if (f.kind === 'table')
        for (const row of f.rows)
          if (!row.repeated) for (const cell of row.cells) yield* walk(cell.fragments);
    }
  }
  yield* walk(page.fragments);
}

/** What `paintThumbnail` last drew into an element, so that an unchanged page is not drawn twice. */
const drawn = new WeakMap<HTMLElement, { readonly page: LayoutPage; readonly width: number }>();

/**
 * Draws page `index` of `tree` into `target` as a thumbnail `width` CSS pixels wide, in place of
 * what `target` held. Nothing is done when `target` already shows this very page object at this
 * width: an unchanged page keeps its object from one layout to the next (FE-078 criterion 4).
 * False when the tree has no such page.
 */
export function paintThumbnail(
  target: HTMLElement,
  tree: LayoutTree,
  index: number,
  source: PaintSource,
  width: number,
  options: Pick<PaintOptions, 'justify'> = {},
): boolean {
  const page = tree.pages[index];
  if (!page || !(width > 0)) return false;
  const last = drawn.get(target);
  if (last && last.page === page && last.width === width && target.childElementCount > 0)
    return true;
  const holder = target.ownerDocument.createDocumentFragment();
  const painted = paintTree(
    holder,
    { engine: tree.engine, measurer: tree.measurer, pages: [page] },
    source,
    { ...options, pageGap: 0 },
  );
  const sheet = painted.pages[0];
  if (!sheet) return false;
  // Not the shell's `.de-page`, whose rules are for the sheet of the web view.
  sheet.className = 'de-thumb-sheet';
  sheet.removeAttribute('data-page');
  const style = sheet.style;
  style.position = 'absolute';
  style.left = '0';
  style.top = '0';
  style.margin = '0';
  style.transformOrigin = '0 0';
  style.transform = `scale(${width / (page.width * PX_PER_PT)})`;
  style.pointerEvents = 'none';
  target.replaceChildren(sheet);
  drawn.set(target, { page, width });
  return true;
}
