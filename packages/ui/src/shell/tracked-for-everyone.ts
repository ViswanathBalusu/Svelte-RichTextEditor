/**
 * "Tracked changes for everyone" (UX-038 criteria 2 and 3; 13 §5; 07 §5.2; 03 §4 `trackChanges`).
 *
 * - `trackedControlOffered` says who is offered the setting: only a user with `manage` (07 §5.2
 *   gives `manage` the switch). The server's refusal of a direct change from anyone else is the
 *   server's, and is not tested here.
 * - `trackedModeFor` is the mode the editor uses while the setting is on. A chosen `edit` becomes
 *   `review` for every user, editors included, and names its reason (criterion 1, the rule). With
 *   the setting off, the chosen mode stands, so editors edit directly again as soon as the setting
 *   reaches the client (criterion 3). The mode is a function of the setting alone, so there is no
 *   state to reload.
 *
 * Reading taken here: "every user including editors" is applied to every user, the owner included.
 * The spec does not say whether a manager is bound too; this is open (see the story's Notes).
 * Not built: the mode switcher's display, the review pane's line about the setting (criterion 5),
 * and the server's rejection of a direct change (criterion 2, second half).
 */
import type { Capability, EditorMode } from '../core-api.ts';

export const TRACKED_REASON = 'trackedForEveryone' as const;

export interface TrackedMode {
  readonly mode: EditorMode;
  /** Why the mode is `review` when the user chose `edit`; null when the setting changes nothing. */
  readonly reason: typeof TRACKED_REASON | null;
}

/** The setting is offered only to a user with `manage` (UX-038 criterion 2). */
export function trackedControlOffered(caps: readonly Capability[]): boolean {
  return caps.includes('manage');
}

/** The mode in effect for a user who chose `chosen`, given the setting. */
export function trackedModeFor(chosen: EditorMode, trackedForEveryone: boolean): TrackedMode {
  if (trackedForEveryone && chosen === 'edit') return { mode: 'review', reason: TRACKED_REASON };
  return { mode: chosen, reason: null };
}
