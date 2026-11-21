/**
 * The arithmetic of the horizontal ruler and the paragraph dialog (UX-102; 13 §2; 03 §4.5, §7):
 * where the markers of a paragraph's indents and tab stops are, how far each may go, what a drag
 * or a key makes of them, and the patch that `setParagraphFormat` then stores. No DOM here.
 *
 * Lengths are twips (a twentieth of a point), as the document stores them. On screen the web view
 * draws a twip as a fifteenth of a CSS pixel (`paragraph-format-view.ts`: twips over 20 as points),
 * times the zoom of the page. The ruler measures from the left edge of the text, which is where the
 * PDF's left margin ends; a right indent is measured from the right edge.
 *
 * The figures below are the ruler's own layout and steps, proposed and not measurements: it is
 * marked in centimetres, a drag or an arrow key moves a marker by a quarter of one, and a paragraph
 * keeps at least one centimetre of text between its indents.
 */
import type { ParagraphFormatView, TabStopView } from '../core-api.ts';

export const TWIPS_PER_CM = 1440 / 2.54;
/** The grid a drag and the arrow keys keep to: a quarter of a centimetre. */
export const SNAP_TWIPS = TWIPS_PER_CM / 4;
/** What Page Up and Page Down move by: one centimetre. */
export const PAGE_TWIPS = TWIPS_PER_CM;
/** The least text a paragraph keeps between its indents: one centimetre. */
export const MIN_TEXT_TWIPS = Math.round(TWIPS_PER_CM);
/** The CDM's largest length (03 §4.5). */
export const MAX_TWIPS = 31680;
/** The most tab stops a paragraph holds (03 §4.5). */
export const MAX_TABS = 64;

export type MarkerKind = 'left' | 'firstLine' | 'right';

/** CSS pixels for one twip in the web view at a zoom of the page. */
export function pxPerTwip(zoom: number): number {
  return (Number.isFinite(zoom) && zoom > 0 ? zoom : 1) / 15;
}

/** The nearest whole twip on the ruler's grid. */
export function snap(twips: number): number {
  return Math.round(Math.round(twips / SNAP_TWIPS) * SNAP_TWIPS);
}

/** A length as the ruler and the dialog say it: centimetres with at most two decimals. */
export function centimetres(twips: number): number {
  return Math.round((twips / TWIPS_PER_CM) * 100) / 100;
}

/** The whole twips of a length given in centimetres; null when it is not a number. */
export function fromCentimetres(cm: number): number | null {
  return Number.isFinite(cm) ? Math.round(cm * TWIPS_PER_CM) : null;
}

/** The indents the ruler works with: a value the paragraphs do not share counts as 0. */
export interface Indents {
  readonly left: number;
  readonly right: number;
  /** From the left indent; negative for a hanging indent. */
  readonly firstLine: number;
}

export function indentsOf(format: ParagraphFormatView): Indents {
  return {
    left: format.indentLeft ?? 0,
    right: format.indentRight ?? 0,
    firstLine: format.indentFirstLine ?? 0,
  };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

/**
 * How far a marker may go, as its place on the ruler from the left edge of the text. `column` is
 * the width of the text. The left marker moves the first line with it, so it stops where either
 * would leave the text; the first-line marker and the right marker keep `MIN_TEXT_TWIPS` of text.
 * The right marker's place is measured from the left like the others: its indent is `column - at`.
 */
export function markerRange(
  kind: MarkerKind,
  indents: Indents,
  column: number,
): { readonly min: number; readonly max: number } {
  const width = Math.max(0, column);
  if (kind === 'right') {
    const textStart = Math.max(indents.left, indents.left + indents.firstLine, 0);
    return { min: Math.min(width, textStart + MIN_TEXT_TWIPS), max: width };
  }
  const end = Math.max(0, width - indents.right - MIN_TEXT_TWIPS);
  if (kind === 'firstLine') return { min: 0, max: end };
  // The left marker: neither it nor the first line, which moves with it, leaves [0, end].
  return {
    min: Math.max(0, -indents.firstLine),
    max: Math.max(0, end - Math.max(0, indents.firstLine)),
  };
}

/** Where a marker is on the ruler, from the left edge of the text. */
export function markerAt(kind: MarkerKind, indents: Indents, column: number): number {
  if (kind === 'left') return indents.left;
  if (kind === 'firstLine') return indents.left + indents.firstLine;
  return column - indents.right;
}

/**
 * The indents after a marker was put at `at` (a place on the ruler from the left edge of the text).
 * The place is kept inside the marker's range. Moving the left marker keeps the first-line indent
 * as it is, so the first line moves with it; moving the first-line marker changes only that.
 */
export function moveMarker(
  kind: MarkerKind,
  at: number,
  indents: Indents,
  column: number,
): Indents {
  const range = markerRange(kind, indents, column);
  const place = Math.round(clamp(at, range.min, range.max));
  if (kind === 'left') return { ...indents, left: place };
  if (kind === 'firstLine') return { ...indents, firstLine: place - indents.left };
  return { ...indents, right: Math.max(0, Math.round(column) - place) };
}

/** The patch that takes the paragraphs from `before` to `after`: only what changed. Null for no change. */
export function indentPatch(
  before: Indents,
  after: Indents,
  format: ParagraphFormatView,
): Record<string, number> | null {
  const patch: Record<string, number> = {};
  // A value the paragraphs did not share is written even when it comes out as the shown one.
  if (after.left !== before.left || format.indentLeft === null) patch['indentLeft'] = after.left;
  if (after.right !== before.right || format.indentRight === null)
    patch['indentRight'] = after.right;
  if (after.firstLine !== before.firstLine || format.indentFirstLine === null)
    patch['indentFirstLine'] = after.firstLine;
  const changed =
    after.left !== before.left ||
    after.right !== before.right ||
    after.firstLine !== before.firstLine;
  return changed ? patch : null;
}

/** The place a key moves a marker or a tab stop to, or null for a key the ruler does not take. */
export function keyPlace(
  key: string,
  at: number,
  range: { readonly min: number; readonly max: number },
  rtl = false,
): number | null {
  const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
  const back = rtl ? 'ArrowRight' : 'ArrowLeft';
  let next: number;
  if (key === forward || key === 'ArrowUp') next = snapStep(at, 1);
  else if (key === back || key === 'ArrowDown') next = snapStep(at, -1);
  else if (key === 'PageUp') next = at + PAGE_TWIPS;
  else if (key === 'PageDown') next = at - PAGE_TWIPS;
  else if (key === 'Home') next = range.min;
  else if (key === 'End') next = range.max;
  else return null;
  return Math.round(clamp(next, range.min, range.max));
}

/** The next place on the grid in a direction: a place off the grid goes to the grid first. */
function snapStep(at: number, direction: 1 | -1): number {
  const cell = at / SNAP_TWIPS;
  const index = direction > 0 ? Math.floor(cell + 1e-6) + 1 : Math.ceil(cell - 1e-6) - 1;
  return Math.round(index * SNAP_TWIPS);
}

/** The tab stops by position, one at a position (the later one wins), no more than the CDM holds. */
export function normaliseTabs(tabs: readonly TabStopView[]): TabStopView[] {
  const byPlace = new Map<number, TabStopView>();
  for (const tab of tabs) {
    const position = Math.round(clamp(tab.position, 0, MAX_TWIPS));
    byPlace.set(position, { position, align: tab.align, leader: tab.leader });
  }
  return [...byPlace.values()].sort((a, b) => a.position - b.position).slice(0, MAX_TABS);
}

/** The list with a left tab stop without a leader added at `position`; unchanged when it is full. */
export function addTab(tabs: readonly TabStopView[], position: number): TabStopView[] {
  if (tabs.length >= MAX_TABS) return normaliseTabs(tabs);
  return normaliseTabs([...tabs, { position, align: 'left', leader: 'none' }]);
}

/** The list with the stop at `index` moved to `position`; a stop already there gives way to it. */
export function moveTab(
  tabs: readonly TabStopView[],
  index: number,
  position: number,
): TabStopView[] {
  const moved = tabs[index];
  if (!moved) return normaliseTabs(tabs);
  return normaliseTabs([...tabs.filter((_, i) => i !== index), { ...moved, position }]);
}

/** The list without the stop at `index`. */
export function removeTab(tabs: readonly TabStopView[], index: number): TabStopView[] {
  return normaliseTabs(tabs.filter((_, i) => i !== index));
}

/** What `setParagraphFormat` takes for a list of tab stops: null for none. */
export function tabsPatch(tabs: readonly TabStopView[]): { tabs: TabStopView[] | null } {
  const list = normaliseTabs(tabs);
  return { tabs: list.length === 0 ? null : list };
}

/** The whole centimetres a ruler of `column` twips is numbered with: 1, 2, and so on. */
export function centimetreMarks(column: number): number[] {
  const out: number[] = [];
  for (let cm = 1; cm * TWIPS_PER_CM <= column + 0.5; cm++) out.push(cm);
  return out;
}
