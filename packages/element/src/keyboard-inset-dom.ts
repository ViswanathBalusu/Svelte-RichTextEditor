/**
 * The browser side of `keyboard-inset.ts` (FE-114): reads `window.visualViewport`, the touch
 * signal, the scroller the editor sits in, and the host's `--de-keyboard-inset` property.
 */
import { type CaretBox, watchKeyboardInset } from './keyboard-inset.ts';

/** What the wiring reads of the editing core. */
export interface CaretSource {
  readonly revision: { subscribe(listener: () => void): () => void };
  caretRect(): CaretBox | null;
}

/** The host property that carries the covered height; `ui` adds it below the body. */
export const KEYBOARD_INSET_PROPERTY = '--de-keyboard-inset';

/** The nearest ancestor (through shadow roots) that scrolls vertically, or null for the page. */
export function nearestScroller(from: Element): Element | null {
  let node: Node | null = from;
  while (node) {
    const parent: Node | null = node instanceof ShadowRoot ? node.host : (node.parentNode ?? null);
    if (parent instanceof Element) {
      const style = getComputedStyle(parent);
      const scrolls = /(auto|scroll)/.test(style.overflowY);
      if (scrolls && parent.scrollHeight > parent.clientHeight) return parent;
    }
    node = parent;
  }
  return null;
}

/**
 * Keeps the caret above the on-screen keyboard while the root's editing surface has focus. Returns
 * the function that stops it, or a no-op where the browser has no visual viewport.
 */
export function attachKeyboardInset(root: ShadowRoot, core: CaretSource): () => void {
  const visual = typeof window === 'undefined' ? null : window.visualViewport;
  if (!visual) return () => {};
  const host = root.host as HTMLElement;
  const focused = (): boolean => {
    const active = root.activeElement;
    return active instanceof HTMLElement && active.isContentEditable;
  };
  const watch = watchKeyboardInset({
    visual,
    layoutHeight: () => window.innerHeight,
    // A person who is not typing in the document is not followed.
    caretRect: () => (focused() ? core.caretRect() : null),
    scrollBy: (dy) => {
      const scroller = nearestScroller(host);
      if (scroller) scroller.scrollBy({ top: dy });
      else window.scrollBy({ top: dy });
    },
    setInset: (px) => {
      if (px > 0) host.style.setProperty(KEYBOARD_INSET_PROPERTY, `${px}px`);
      else host.style.removeProperty(KEYBOARD_INSET_PROPERTY);
    },
    enabled: () => typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches,
  });
  const stopRevisions = core.revision.subscribe(() => watch.check());
  // Focus moving into the document with the keyboard already up is a reason to look too.
  const onFocus = (): void => watch.check();
  root.addEventListener('focusin', onFocus);
  return () => {
    stopRevisions();
    root.removeEventListener('focusin', onFocus);
    watch.stop();
  };
}
