/**
 * The resize handle of a figure or an inline image in the web view (FE-132 criterion 2; 03 §4.3,
 * §4.4). It is a keyboard-operable slider drawn in the picture's corner, and it changes the size
 * through `resizeFigure` (figure-layout.ts), so the stored `width` and `height` are twips (twentieths
 * of a point) and every rule of that command applies: the size range, the scope check and the
 * aspect ratio.
 *
 * - Drag: the width follows the pointer and the height follows the width, keeping the aspect ratio.
 *   With Shift held when the pointer is released, the ratio is unlocked: the width follows the
 *   horizontal distance and the height the vertical distance, each on its own.
 * - Keys, with the handle focused: Arrow Right and Left change the width by 10 pixels and keep the
 *   ratio, Arrow Up and Down change the height likewise; with Shift, Left and Right change the width
 *   alone and Up and Down change the height alone (the ratio unlocked).
 * - A CSS pixel is 15 twips (96 pixels to the inch, 20 twips to the point, 72 points to the inch).
 *   The unit is a fact of the CSS reference pixel, not a figure of the spec.
 * - A drag below one pixel wide, or a result the command refuses (outside 1 to 31680 twips), leaves
 *   the picture as it was and says nothing else: the command's refusal is the rule.
 * - The handle does nothing where the view is not editable (the stylesheet hides it there). Every change is a transaction of the view,
 *   so it is one undo step and the sync path sends it like any other edit.
 */
import type { Node as PmNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { type FigureSize, resizeFigure } from '../figure-layout.ts';

/** Twips in one CSS pixel. */
export const TWIPS_PER_PX = 15;

/** The key step, in twips: 10 pixels. */
const KEY_STEP = 10 * TWIPS_PER_PX;

/** The smallest width or height a drag or a key sets, in twips: one pixel. */
const MIN_TWIPS = TWIPS_PER_PX;

export interface ResizeTarget {
  /** The node now in the document: its `width` and `height` are in twips. */
  node(): PmNode;
  /** The node's position, or undefined when the view no longer holds it. */
  pos(): number | undefined;
  /** Draws a size on the picture while a drag is going on, and again when it is over. */
  preview(widthTwips: number, heightTwips: number): void;
}

export interface ResizeHandle {
  readonly dom: HTMLElement;
  /** Takes the node's new size (after an update from outside). */
  sync(node: PmNode): void;
  /** Whether an event came from the handle, so that the editor leaves it alone. */
  owns(target: EventTarget | null): boolean;
  destroy(): void;
}

const num = (node: PmNode, name: string): number => {
  const value = node.attrs[name];
  return typeof value === 'number' ? value : 0;
};

const clamp = (value: number): number => Math.max(MIN_TWIPS, Math.round(value));

/** Draws a size in CSS pixels. CSSOM property writes are not an inline-style attribute, so a policy
 * without `unsafe-inline` styles allows them (ADR 0039). */
export function drawSize(el: HTMLElement, widthTwips: number, heightTwips: number): void {
  if (widthTwips > 0) el.style.inlineSize = `${widthTwips / TWIPS_PER_PX}px`;
  if (heightTwips > 0) el.style.blockSize = `${heightTwips / TWIPS_PER_PX}px`;
}

export function resizeHandle(view: EditorView, target: ResizeTarget): ResizeHandle {
  const dom = document.createElement('span');
  dom.className = 'de-resize-handle';
  dom.setAttribute('role', 'slider');
  dom.setAttribute('aria-label', 'Picture width');
  dom.setAttribute('aria-orientation', 'horizontal');
  dom.setAttribute('aria-valuemin', String(MIN_TWIPS));
  dom.setAttribute('aria-valuemax', '31680');
  dom.tabIndex = 0;
  // The handle is not text: the editor must not move the caret into it.
  dom.contentEditable = 'false';

  const sync = (node: PmNode): void => {
    const width = num(node, 'width');
    dom.setAttribute('aria-valuenow', String(width));
    dom.setAttribute('aria-valuetext', `${width / 20} points`);
  };
  sync(target.node());

  /** Applies a size through the command; false when the command refuses it. */
  const commit = (size: FigureSize): boolean => {
    const pos = target.pos();
    if (pos === undefined) return false;
    return resizeFigure(pos, size)(view.state, view.dispatch);
  };
  const restore = (): void => {
    const node = target.node();
    target.preview(num(node, 'width'), num(node, 'height'));
  };

  let drag: {
    id: number;
    x: number;
    y: number;
    width: number;
    height: number;
    next: { width: number; height: number };
  } | null = null;

  const sizeAt = (event: PointerEvent): { width: number; height: number } => {
    if (!drag) return { width: 0, height: 0 };
    const dx = (event.clientX - drag.x) * TWIPS_PER_PX;
    const dy = (event.clientY - drag.y) * TWIPS_PER_PX;
    if (event.shiftKey) return { width: clamp(drag.width + dx), height: clamp(drag.height + dy) };
    const width = clamp(drag.width + dx);
    return { width, height: clamp((width * drag.height) / drag.width) };
  };

  const onDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !view.editable || target.pos() === undefined) return;
    const node = target.node();
    const width = num(node, 'width');
    const height = num(node, 'height');
    if (width <= 0 || height <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      dom.setPointerCapture(event.pointerId);
    } catch {
      // A pointer the browser does not know (a synthetic event): the drag still follows the handle.
    }
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      width,
      height,
      next: { width, height },
    };
  };
  const onMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.next = sizeAt(event);
    target.preview(drag.next.width, drag.next.height);
  };
  const finish = (event: PointerEvent, apply: boolean): void => {
    if (!drag || event.pointerId !== drag.id) return;
    // The release decides the ratio: Shift may have been pressed after the last move.
    const next = apply ? sizeAt(event) : drag.next;
    const { width, height } = drag;
    drag = null;
    try {
      if (dom.hasPointerCapture(event.pointerId)) dom.releasePointerCapture(event.pointerId);
    } catch {
      // Nothing was captured.
    }
    if (!apply || (next.width === width && next.height === height)) return restore();
    const done = event.shiftKey
      ? commit({ width: next.width, height: next.height, lockAspect: false })
      : commit({ width: next.width });
    if (!done) restore();
  };
  const onUp = (event: PointerEvent): void => finish(event, true);
  const onCancel = (event: PointerEvent): void => finish(event, false);

  const onKey = (event: KeyboardEvent): void => {
    if (!view.editable) return;
    const node = target.node();
    const sign =
      event.key === 'ArrowRight' || event.key === 'ArrowUp'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
          ? -1
          : 0;
    if (sign === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft';
    const current = num(node, horizontal ? 'width' : 'height');
    const next = clamp(current + sign * KEY_STEP);
    const size: FigureSize = horizontal ? { width: next } : { height: next };
    if (event.shiftKey) size.lockAspect = false;
    commit(size);
  };

  dom.addEventListener('pointerdown', onDown);
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onCancel);
  dom.addEventListener('keydown', onKey);

  return {
    dom,
    sync,
    owns: (t) => t instanceof Node && dom.contains(t),
    destroy: () => {
      dom.removeEventListener('pointerdown', onDown);
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointercancel', onCancel);
      dom.removeEventListener('keydown', onKey);
    },
  };
}
