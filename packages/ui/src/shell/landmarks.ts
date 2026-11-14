/**
 * Moving between the parts of the editor by keyboard (UX-023; 02 §10): Ctrl+F6 moves focus to the
 * next landmark in the order header, toolbar, page, panes, status bar, and Shift+Ctrl+F6 back.
 * Browsers that give Ctrl+F6 a meaning of their own get the alternative of the shortcut table
 * (Alt+F6), which the shell binds everywhere. A landmark that is absent, hidden or empty is
 * skipped.
 *
 * Landmarks are the shell's elements with `data-landmark`; each has a role and an accessible name.
 * The ordering and the stepping are pure functions over any node type, so they are tested in
 * Node.js; the DOM reading is in `landmarksIn` and `focusTarget`.
 */
import { canonicalKey } from '../commands/keys.ts';
import { shortcutRow } from '../shortcuts/table.ts';

export const LANDMARK_ORDER = ['header', 'toolbar', 'page', 'pane', 'status'] as const;
export type Landmark = (typeof LANDMARK_ORDER)[number];

/** One candidate landmark: its node, its `data-landmark` value and whether it is shown. */
export interface LandmarkEntry<T> {
  readonly node: T;
  readonly landmark: string | null;
  readonly visible: boolean;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visible(el: Element): boolean {
  return !el.closest('[hidden]') && el.getClientRects().length > 0;
}

/**
 * The landmarks that are shown, in landmark order, then in the order the entries were given (the
 * document order). An entry that is hidden, or names no known landmark, is left out.
 */
export function orderLandmarks<T>(entries: readonly LandmarkEntry<T>[]): T[] {
  const rank = (name: string | null) => LANDMARK_ORDER.indexOf((name ?? '') as Landmark);
  return entries
    .map((entry, order) => ({ entry, order, rank: rank(entry.landmark) }))
    .filter(({ entry, rank: r }) => entry.visible && r >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ entry }) => entry.node);
}

/** The index of the first landmark that holds the active element, or -1 when none does. */
export function indexHolding<T>(list: readonly T[], holds: (landmark: T) => boolean): number {
  return list.findIndex(holds);
}

/**
 * The landmark after (or before) the one at `current`, wrapping round. Without a current landmark,
 * a step forward gives the first and a step back the last.
 */
export function stepLandmark<T>(list: readonly T[], current: number, step: 1 | -1): T | undefined {
  if (list.length === 0) return undefined;
  if (current < 0) return step === 1 ? list[0] : list[list.length - 1];
  return list[(current + step + list.length) % list.length];
}

/** The landmark after (or before) the one that holds `active`, wrapping round. */
export function nextLandmark(
  list: readonly HTMLElement[],
  active: Element | null,
  step: 1 | -1,
): HTMLElement | undefined {
  const current = active ? indexHolding(list, (el) => el.contains(active)) : -1;
  return stepLandmark(list, current, step);
}

/** The landmarks present, in landmark order, then in document order. */
export function landmarksIn(shell: Element): HTMLElement[] {
  const entries: LandmarkEntry<HTMLElement>[] = [
    ...shell.querySelectorAll<HTMLElement>('[data-landmark]'),
  ].map((el) => ({
    node: el,
    landmark: el.dataset['landmark'] ?? null,
    visible: visible(el),
  }));
  return orderLandmarks(entries);
}

/** The element to focus in a landmark: its roving control, its first control, or itself. */
export function focusTarget(landmark: HTMLElement): HTMLElement {
  const roving = landmark.querySelector<HTMLElement>('[role="toolbar"] [tabindex="0"]');
  if (roving && visible(roving)) return roving;
  const first = [...landmark.querySelectorAll<HTMLElement>(FOCUSABLE)].find(visible);
  if (first) return first;
  if (!landmark.hasAttribute('tabindex')) landmark.tabIndex = -1;
  return landmark;
}

/** The canonical keys that move forward and back, with the table's alternatives. */
export function landmarkKeys(apple: boolean): { next: Set<string>; previous: Set<string> } {
  const keysOf = (id: string) =>
    new Set(
      [...(shortcutRow(id)?.keys ?? []), ...(shortcutRow(id)?.alternative ?? [])]
        .map((k) => canonicalKey(k, apple))
        .filter((k): k is string => k !== null),
    );
  return { next: keysOf('shell.nextLandmark'), previous: keysOf('shell.previousLandmark') };
}
