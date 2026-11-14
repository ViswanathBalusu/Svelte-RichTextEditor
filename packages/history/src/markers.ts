/**
 * Read markers move forward only (08 §10; HIS-027 criterion 2). The service stores the result; a
 * marker names the last `seq` a user saw, and a lower or equal `seq` sent later does not move it.
 */
import { type HistoryResult, refuse } from './types.ts';

export interface MarkerAdvance {
  /** The marker after the request: the higher of the stored marker and the requested `seq`. */
  marker: number;
  /** Whether the stored marker moved, so the service writes it. */
  moved: boolean;
}

/**
 * Advances a read marker to `requested`, never backwards. A `seq` above the head is refused: a
 * user cannot have seen what does not exist yet.
 */
export function advanceMarker(
  stored: number | undefined,
  requested: number,
  head: number,
): HistoryResult<MarkerAdvance> {
  if (!Number.isSafeInteger(requested) || requested < 0)
    return refuse('validation_failed', `marker ${requested} is not a sequence number`);
  if (requested > head)
    return refuse('validation_failed', `marker ${requested} is above the head ${head}`);
  if (stored !== undefined && requested <= stored)
    return { ok: true, marker: stored, moved: false };
  return { ok: true, marker: requested, moved: true };
}
