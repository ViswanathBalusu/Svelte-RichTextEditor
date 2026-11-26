// Which view the element shows for its `view` attribute (FE-065; 02 §7; 05 §8.1). This module is the
// decision only: it reads the attribute value and what the page offers, and says which view to
// mount. Mounting the views, the web view's "Web layout" label drawn in the page, and the attribute
// change that keeps the editing core are not here (FE-065 Notes).
//
// The default when the attribute is absent or unknown is `web`. 05 §8.1 does not state a default
// (an open question); `web` is the proposed default and is recorded in docs/adr/0204-lane-FE-053-065.md.

/** The views the element can show (02 §7). */
export type ViewName = 'web' | 'read' | 'print';

/** What the page offers: whether the editable page view exists (FE-101) and whether the device is a touch device. */
export interface ViewOffer {
  readonly touch: boolean;
  readonly pageViewAvailable: boolean;
}

/** The view to mount, and whether it is a fallback for a view that was asked for and is not there. */
export interface ViewChoice {
  readonly view: ViewName;
  /** True when a different view is shown than the attribute asked for. */
  readonly fallback: boolean;
}

/** The interface strings of the views. Replaceable strings are UX's (13 §8). */
export const VIEW_STRINGS = {
  web: 'Web layout',
  print: 'Page layout',
  /** The label of the read-only pages (FE-095). */
  read: 'Reading layout',
  /** The control in the page view's label that shows the web view instead (FE-099 criterion 4). */
  toWeb: 'Use the accessible web layout',
  /** The control in the web view's label, after the author chose it, that returns to the page view. */
  toPrint: 'Use the page layout',
} as const;

/** The default view when the attribute is absent or unknown (proposed; see the header). */
export const DEFAULT_VIEW: ViewName = 'web';

/**
 * Chooses the view. A touch device always gets the web view (FE-113). `print` falls back to the web
 * view while the page view is not available, and says so; an unknown value gets the default.
 */
export function selectView(attribute: string | null, offer: ViewOffer): ViewChoice {
  if (offer.touch) return { view: 'web', fallback: attribute !== null && attribute !== 'web' };
  if (attribute === 'read') return { view: 'read', fallback: false };
  if (attribute === 'print') {
    return offer.pageViewAvailable
      ? { view: 'print', fallback: false }
      : { view: 'web', fallback: true };
  }
  return { view: 'web', fallback: false };
}
