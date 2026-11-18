/**
 * Keeps the caret above the on-screen keyboard (FE-114; 02 §12).
 *
 * On a phone the keyboard covers the lower part of the page. Where the browser resizes only the
 * visual viewport for it (iOS Safari, Chrome on Android with `interactive-widget=resizes-visual`),
 * the layout viewport keeps its height, and the area the keyboard covers is the part of the layout
 * viewport that lies below `visualViewport.offsetTop + visualViewport.height`. This module reads
 * that and does two things when the visual viewport resizes, and after each change of the selection:
 *
 * - it sets the covered height as `--de-keyboard-inset` on the host, which the stylesheet adds below
 *   the body, so that the page can scroll far enough to bring the last line above the keyboard;
 * - it scrolls by the distance that puts the caret inside the visible part, with a margin.
 *
 * No DOM here: the viewport, the caret, the scroll and the property are passed in, so that the
 * rules run in Node.js tests. The visual viewport is the browser's own object in the element.
 */

/** A rectangle in layout-viewport coordinates, as `getBoundingClientRect` and `coordsAtPos` give. */
export interface CaretBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the module reads of `window.visualViewport`. */
export interface VisualViewportLike {
  readonly offsetTop: number;
  readonly height: number;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
}

/** The space between the caret and the edge of the visible area, in CSS pixels. */
export const CARET_MARGIN = 8;

/**
 * The height of the layout viewport that the visual viewport does not show at its bottom, in whole
 * CSS pixels and never below zero. Rounding keeps sub-pixel noise from counting as a keyboard.
 */
export function coveredHeight(
  layoutHeight: number,
  visual: { offsetTop: number; height: number },
): number {
  const covered = layoutHeight - (visual.offsetTop + visual.height);
  return covered > 0.5 ? Math.round(covered) : 0;
}

/**
 * How far to scroll the page, in CSS pixels (positive is down), so that the caret lies inside the
 * visible part of the layout viewport: between the top of the visual viewport and its bottom, each
 * with `margin`. Zero when it is already there. When the caret is taller than the visible part, its
 * bottom wins, because the line being typed is the one that must not be hidden.
 */
export function scrollToCaret(
  caret: CaretBox,
  visual: { offsetTop: number; height: number },
  margin: number = CARET_MARGIN,
): number {
  const top = visual.offsetTop;
  const bottom = visual.offsetTop + visual.height;
  const caretBottom = caret.y + caret.height;
  if (caretBottom + margin > bottom) return Math.ceil(caretBottom + margin - bottom);
  if (caret.y - margin < top) return Math.floor(caret.y - margin - top);
  return 0;
}

export interface KeyboardInsetOptions {
  readonly visual: VisualViewportLike;
  /** The layout viewport's height (`window.innerHeight`). */
  layoutHeight(): number;
  /** The caret of the view that has focus, or null when there is none or no view has focus. */
  caretRect(): CaretBox | null;
  /** Scrolls the page (or the scroller the editor sits in) by `dy` CSS pixels. */
  scrollBy(dy: number): void;
  /** Sets the covered height as `--de-keyboard-inset` in pixels; 0 removes it. */
  setInset(px: number): void;
  /** Whether the module applies at all: a touch device. Read at each event. */
  enabled(): boolean;
  margin?: number;
}

export interface KeyboardInset {
  /** Reads the viewport and the caret now. The element calls it after each change of the selection. */
  check(): void;
  /** Removes the listener and the property. */
  stop(): void;
}

/** Starts the watch. The state at the start is read once, so a keyboard that is already up counts. */
export function watchKeyboardInset(options: KeyboardInsetOptions): KeyboardInset {
  const { visual } = options;
  let inset = 0;
  let stopped = false;

  const update = (): void => {
    if (stopped) return;
    const next = options.enabled() ? coveredHeight(options.layoutHeight(), visual) : 0;
    if (next !== inset) {
      inset = next;
      options.setInset(next);
    }
    // Only while something covers the page. Without a keyboard the browser keeps the caret in view
    // itself, and a scroll here would fight a person who scrolls on purpose.
    if (inset === 0) return;
    const caret = options.caretRect();
    if (caret === null) return;
    const dy = scrollToCaret(caret, visual, options.margin);
    if (dy !== 0) options.scrollBy(dy);
  };

  visual.addEventListener('resize', update);
  update();
  return {
    check: update,
    stop() {
      if (stopped) return;
      stopped = true;
      visual.removeEventListener('resize', update);
      if (inset !== 0) options.setInset(0);
      inset = 0;
    },
  };
}
