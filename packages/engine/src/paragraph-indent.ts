/**
 * Increase and decrease indent (FE-129 criterion 4; 03 §4.5, §7; 02 §10).
 *
 * Each command moves the left indent of every selected paragraph the user may edit by the document's
 * `defaultTabStop` (the `settings` node, 03 §4.1; 720 twips in the spike document). A decrease never
 * goes below zero. A paragraph without a left indent counts as zero. The result must stay within the
 * CDM's length range (I6); when a paragraph would pass it, the command is unavailable and changes
 * nothing.
 *
 * The command applies to list items too, as the criterion says. Word moves a list item by its level
 * instead; that reading is not decided here (see the story's Notes).
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';
import { selectedParagraphs } from './styles.ts';

export type IndentDirection = 'increase' | 'decrease';

/** The largest left indent the CDM stores, in twips (`LENGTH`, 03 §4.5). */
export const MAX_INDENT_TWIPS = 31680;

/** The document's default tab interval in twips, from the `settings` node. */
export function defaultTabStopOf(doc: PMNode): number {
  let tab = 720;
  doc.firstChild?.forEach((node) => {
    if (node.type.name === 'settings' && typeof node.attrs['defaultTabStop'] === 'number') {
      tab = node.attrs['defaultTabStop'];
    }
  });
  return tab;
}

/** The left indent after one step, or null when it would pass the CDM's range. */
export function steppedIndent(
  current: number | null,
  step: number,
  direction: IndentDirection,
): number | null {
  const base = current ?? 0;
  const next = direction === 'increase' ? base + step : Math.max(0, base - step);
  return next > MAX_INDENT_TWIPS ? null : next;
}

/** Moves the left indent of the selected, editable paragraphs by one default tab stop (FE-129 criterion 4). */
export function changeIndent(
  direction: IndentDirection,
  writable: (pos: number) => boolean,
): Command {
  return (state, dispatch) => {
    const step = defaultTabStopOf(state.doc);
    const targets = selectedParagraphs(state).filter(({ pos }) => writable(pos));
    // Unavailable when no selected paragraph may be changed (FE-127's rule for styles, too).
    if (targets.length === 0) return false;
    const changes: Array<{ pos: number; indent: number }> = [];
    for (const { node, pos } of targets) {
      const next = steppedIndent(
        (node.attrs['indentLeft'] as number | null | undefined) ?? null,
        step,
        direction,
      );
      if (next === null) return false;
      if (next !== node.attrs['indentLeft']) changes.push({ pos, indent: next });
    }
    if (dispatch && changes.length) {
      const tr = state.tr;
      for (const { pos, indent } of changes) tr.setNodeAttribute(pos, 'indentLeft', indent);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
