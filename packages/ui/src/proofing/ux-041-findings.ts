/**
 * The state of the proofing findings for one document (UX-041 criterion 3; 13 §6.1).
 *
 * Findings are computed for one revision of the text. The editor keeps them only while the text
 * they came from is unchanged:
 *
 * - `typed` moves to a new revision and clears the findings, so a finding is never drawn over text
 *   that changed under it. Discarding is the option criterion 3 allows; mapping needs the core's
 *   position map, which this module does not see.
 * - `arrive` keeps a result only when it was computed for the current revision. A late result for an
 *   earlier revision is dropped and nothing is shown for it.
 *
 * Pure: no port is called here and nothing is drawn. The decorations, the typing path and the
 * debounce are the editor's, and the port is not wired yet (see `request.ts`). Criterion 3 is
 * claimed at this rule level only.
 */
import { isFindingCurrent } from './request.ts';

export interface Finding {
  readonly id: string;
  readonly kind: 'spelling' | 'grammar';
  readonly start: number;
  readonly end: number;
  readonly suggestions: readonly string[];
}

export interface FindingsState {
  /** The text revision the shown findings belong to. Starts at 0 and only goes up. */
  readonly revision: number;
  /** Findings computed for `revision`, and no other revision. */
  readonly findings: readonly Finding[];
}

export const START_FINDINGS: FindingsState = { revision: 0, findings: [] };

/** The text changed: a new revision, and no finding is kept for the old one. */
export function typed(state: FindingsState): FindingsState {
  return { revision: state.revision + 1, findings: [] };
}

/** A result from the port, tagged with the revision it was computed from. */
export interface FindingsResult {
  readonly revision: number;
  readonly findings: readonly Finding[];
}

/** Keeps the result only when it is for the current revision. Returns the state either way. */
export function arrive(state: FindingsState, result: FindingsResult): FindingsState {
  if (!isFindingCurrent(result.revision, state.revision)) return state;
  return { revision: state.revision, findings: [...result.findings] };
}
