/**
 * The editor's mode where the user may only suggest (PRM-031; 07 §7, eighth bullet).
 *
 * Where the selection is in a scope the user may only suggest in, the editor stays in suggestion
 * mode and the way to leave it is disabled (`shell/modes.ts`, reason `suggestOnly`). This module
 * decides which mode the core should be in, and keeps the mode the user chose apart from the mode
 * the shell set, so that choosing `edit` again applies once the caret moves to a scope they may
 * edit (PRM-031 criterion 3).
 *
 * A locked, archived or workflow document gives no `review` either (`modes.ts`), so the shell does
 * not switch there; the server's limit decides, as before.
 */
import type { AccessSummary, EditorMode } from '../core-api.ts';

const DOCUMENT_LIMITS = new Set<string>(['locked', 'archived', 'workflow']);

/** The user holds `suggest` but not `edit` at the selection. */
export function suggestOnlyHere(here: AccessSummary | undefined): boolean {
  return here !== undefined && here.caps.includes('suggest') && !here.caps.includes('edit');
}

/**
 * The mode in effect at the selection, given the mode the user chose: `edit` becomes `review` where
 * the user may only suggest (07 §7); every other choice stands.
 */
export function modeInScope(chosen: EditorMode, here: AccessSummary | undefined): EditorMode {
  if (chosen !== 'edit' || !suggestOnlyHere(here)) return chosen;
  const limit = here?.limit ?? null;
  if (limit !== null && DOCUMENT_LIMITS.has(limit)) return chosen;
  return 'review';
}

/** What the shell remembers between runs of the mode effect. */
export interface ModeTrack {
  /** The mode the user or the host last chose (a mode the core changed to that the shell did not ask for). */
  readonly chosen: EditorMode | null;
  /** The core's mode the last time the effect ran. */
  readonly seen: EditorMode | null;
  /** The mode the shell asked the core for and has not yet seen. */
  readonly pending: EditorMode | null;
}

export const START_TRACK: ModeTrack = { chosen: null, seen: null, pending: null };

export interface ModeStep {
  readonly track: ModeTrack;
  /** The mode to ask the core for now, or null when the core is already in the right mode. */
  readonly target: EditorMode | null;
}

/**
 * One run of the mode effect. A change of the core's mode that the shell did not ask for is the
 * user's or the host's choice; a change it did ask for is only confirmed. Then the mode in effect
 * for the selection is compared with the core's mode.
 */
export function stepMode(
  track: ModeTrack,
  current: EditorMode,
  here: AccessSummary | undefined,
): ModeStep {
  let chosen = track.chosen;
  if (current !== track.seen && current !== track.pending) chosen = current;
  const want = modeInScope(chosen ?? current, here);
  const target = want !== current ? want : null;
  return { track: { chosen, seen: current, pending: target }, target };
}
