/**
 * Suggestion decisions in history (08 §14; HIS-042; ADR 0145 records the open points).
 *
 * A suggestion mark carries no time (03 §5), so the date shown for a suggestion comes from the log:
 * the server time of the commit that introduced it, found by the suggestion's identifier (HIS-042
 * criterion 2). The map from identifier to commit is not in 06 §4.1, so the document service keeps
 * it as an index (HIS-042 criterion 4). This module builds that index from the commits and answers
 * from it. It never scans the commits to find an identifier; the commit lookup is a callback, so
 * the service can answer it from its own rows.
 *
 * What is not here: the commit stored for an accepted or rejected suggestion (origin
 * `suggestion.accept` or `suggestion.reject`) is written by the service, and the rendering of marks
 * in the document and the review pane is the UI's. Both stay with their owners (HIS-042 Notes).
 */
import { type CommitMeta, type HistoryResult, refuse } from './types.ts';

/** One suggestion identifier and the `seq` of the commit that introduced it. */
export interface SuggestionIntroduction {
  suggestionId: string;
  seq: number;
}

/** Suggestion identifier to the `seq` of the commit that introduced it. */
export type SuggestionIndex = ReadonlyMap<string, number>;

/** The server-side facts a suggestion's date is taken from (HIS-042 criterion 2). */
export interface SuggestionDate {
  suggestionId: string;
  /** The `seq` of the commit that introduced the suggestion. */
  seq: number;
  /** Server time of that commit, Unix milliseconds. */
  time: number;
  origin: string;
  user: string;
}

/**
 * Builds the index from identifier to introducing commit. When an identifier appears in more than
 * one commit, the commit with the lowest `seq` introduced it and the others are ignored, so the
 * answer does not depend on the order of the entries. An entry that is not a whole, positive
 * `seq`, or that has an empty identifier, is refused.
 */
export function suggestionIndex(
  entries: Iterable<SuggestionIntroduction>,
): HistoryResult<{ index: Map<string, number> }> {
  const index = new Map<string, number>();
  for (const e of entries) {
    if (e.suggestionId === '')
      return refuse('validation_failed', 'a suggestion identifier must not be empty');
    if (!Number.isSafeInteger(e.seq) || e.seq < 1)
      return refuse('validation_failed', 'a commit seq must be a positive whole number');
    const known = index.get(e.suggestionId);
    if (known === undefined || e.seq < known) index.set(e.suggestionId, e.seq);
  }
  return { ok: true, index };
}

/** The `seq` of the commit that introduced a suggestion, from the index (no scan). */
export function introducedBy(index: SuggestionIndex, suggestionId: string): number | undefined {
  return index.get(suggestionId);
}

/**
 * The date of a suggestion: the server time of the commit that introduced it. The mark's own time
 * is not an input, so it cannot be used. A suggestion the index does not know, or a commit the
 * lookup cannot find, is `not_found`.
 */
export function suggestionDate(
  index: SuggestionIndex,
  suggestionId: string,
  commitAt: (seq: number) => CommitMeta | undefined,
): HistoryResult<{ date: SuggestionDate }> {
  const seq = index.get(suggestionId);
  if (seq === undefined) return refuse('not_found', 'no commit introduced this suggestion');
  const c = commitAt(seq);
  if (c === undefined) return refuse('not_found', 'the introducing commit is not in the log');
  return {
    ok: true,
    date: { suggestionId, seq, time: c.time, origin: c.origin, user: c.user },
  };
}
