/**
 * The live region of the screen-reader announcements (02 §10; FE-107), inside the element's shadow
 * root, in the same root as the content it describes (criterion 6).
 *
 * - One region, `role="status"` with `aria-live="polite"` and `aria-atomic="true"`. The spec does not
 *   give a politeness level (FE open question 26); polite is taken for every announcement, so that an
 *   announcement never interrupts what the reader is speaking. Whether a rejected edit should be
 *   assertive is left to the accessibility specialist and recorded in the story's Notes.
 * - The announcer (announcer.ts) hands it one sentence per frame; each sentence replaces the text.
 *   The same sentence twice in a row is still announced: the text is cleared before it is set.
 * - The region is hidden visually with the usual clip technique, set through the CSSOM so that a
 *   strict style policy does not block it (02 §3), and it takes no pointer or focus.
 */

export interface LiveRegion {
  /** The region element, for tests. */
  readonly element: HTMLElement;
  /** Writes one sentence to the region. */
  announce(text: string): void;
  /** Puts the region back as the first child of the root, empty, when it was removed. */
  attach(): void;
  /** Removes the region from the root and empties it. */
  remove(): void;
}

/** Mounts the live region as the first child of `root`, before the shell, so the shell never replaces it. */
export function mountLiveRegion(root: ShadowRoot): LiveRegion {
  const el = root.ownerDocument.createElement('div');
  el.className = 'de-live-region';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  const s = el.style;
  s.position = 'absolute';
  s.width = '1px';
  s.height = '1px';
  s.margin = '-1px';
  s.padding = '0';
  s.border = '0';
  s.overflow = 'hidden';
  s.clipPath = 'inset(50%)';
  s.whiteSpace = 'nowrap';
  s.pointerEvents = 'none';
  root.prepend(el);
  return {
    element: el,
    announce(text) {
      if (el.textContent === text) el.textContent = '';
      el.textContent = text;
    },
    attach() {
      if (el.parentNode !== root) root.prepend(el);
    },
    remove() {
      el.remove();
      el.textContent = '';
    },
  };
}
