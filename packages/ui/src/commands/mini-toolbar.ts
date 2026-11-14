/**
 * The mini toolbar's items (13 §2, §4; UX-010), generated from the registry's states. The toolbar
 * itself is rendering; this function decides what it may offer. Nothing is offered without a
 * selection, and a command that changes content is left out when the user's access or the mode
 * does not allow a change at the selection (UX-004; the registry's states carry the reason).
 *
 * Common formatting is the `format` group (the spec default; the story's Notes record it).
 */
import type { CommandView } from './types.ts';

/** The groups whose commands the mini toolbar offers. */
export const MINI_TOOLBAR_GROUPS: readonly string[] = ['format'];

/**
 * The commands the mini toolbar offers for a selection. `selectionEmpty` is true for a collapsed
 * selection, which shows no mini toolbar at all.
 */
export function miniToolbarItems(
  views: readonly CommandView[],
  selectionEmpty: boolean,
): CommandView[] {
  if (selectionEmpty) return [];
  return views.filter(
    (view) =>
      view.offered &&
      view.entry.toolbar !== false &&
      MINI_TOOLBAR_GROUPS.includes(view.entry.group) &&
      // Formatting that changes the text. A command that only arms or lists (the painter's arming,
      // the language list) is not offered here, so a user who may only view sees nothing.
      view.entry.changesContent === true &&
      !(view.reason === 'no-access' || view.reason === 'mode'),
  );
}
