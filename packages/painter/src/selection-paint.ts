/**
 * Caret and selection drawing for the page view (FE-096 criteria 3, 4 and 5; FE-019 for system
 * colours). The geometry comes from the layout tree (`caretGeometry`, `selectionRects` in
 * `packages/layout/src/caret.ts`); this module only turns it into absolutely positioned boxes in the
 * page elements that `paintTree` returned.
 *
 * Colours are system colour keywords. Each box sets `forced-color-adjust: none`, because forced
 * colours mode would otherwise replace its background with the canvas colour and hide the caret.
 * Outside forced colours the keywords still resolve to the system colours, so nothing changes there.
 *
 * This is a DOM module (`packages/painter`, 01 §6): it uses the document it is given.
 */
import type { LayoutTree } from '../../layout/src/tree.ts';
import {
  caretGeometry,
  selectionRects,
  type DocPosition,
  type SpanWidth,
} from '../../layout/src/caret.ts';

/** The caret's width in page points. */
export const CARET_WIDTH_PT = 1;

/** A selection: the anchor and the head, in either order. Equal positions draw a caret. */
export interface SelectionPaint {
  readonly anchor: DocPosition;
  readonly head: DocPosition;
}

/** What was drawn: one caret or one box per selection rectangle. */
export interface SelectionPaintResult {
  readonly caretCount: number;
  readonly rectCount: number;
}

const NOTHING: SelectionPaintResult = { caretCount: 0, rectCount: 0 };

/**
 * Draws the caret or the selection into the page elements `pages` (the ones `paintTree` returned, in
 * the same order as `tree.pages`). The selection boxes go first in their page, under the text; the
 * caret goes last, over it. Positions the tree does not hold draw nothing.
 */
export function paintSelection(
  doc: Document,
  pages: readonly HTMLElement[],
  tree: LayoutTree,
  span: SpanWidth,
  selection: SelectionPaint,
): SelectionPaintResult {
  const same =
    selection.anchor.blockId === selection.head.blockId &&
    selection.anchor.offset === selection.head.offset;

  const box = (
    page: HTMLElement,
    className: string,
    x: number,
    y: number,
    width: number,
    height: number,
    background: string,
    first: boolean,
  ): void => {
    const el = doc.createElement('div');
    el.className = className;
    el.setAttribute('aria-hidden', 'true');
    const style = el.style;
    style.position = 'absolute';
    style.left = `${x}pt`;
    style.top = `${y}pt`;
    style.width = `${width}pt`;
    style.height = `${height}pt`;
    style.background = background;
    style.forcedColorAdjust = 'none';
    style.pointerEvents = 'none';
    if (first) page.insertBefore(el, page.querySelector('.de-line') ?? page.firstChild);
    else page.appendChild(el);
  };

  if (same) {
    const c = caretGeometry(tree, selection.head, span);
    if (!c) return NOTHING;
    const page = pages[c.page];
    if (!page) return NOTHING;
    box(page, 'de-caret', c.x, c.y, CARET_WIDTH_PT, c.height, 'CanvasText', false);
    return { caretCount: 1, rectCount: 0 };
  }

  let rectCount = 0;
  for (const r of selectionRects(tree, selection.anchor, selection.head, span)) {
    const page = pages[r.page];
    if (!page) continue;
    box(page, 'de-selection', r.x, r.y, r.width, r.height, 'Highlight', true);
    rectCount++;
  }
  return { caretCount: 0, rectCount };
}
