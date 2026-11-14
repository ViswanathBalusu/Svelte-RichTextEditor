/**
 * Bulk review and the live list of suggestions (UX-036 criteria 2 and 4; UX-037 criterion 4).
 *
 * - `bulkPlan` decides what "accept all" or "reject all" applies over the rows that match the
 *   selection, region or author filter: the matching rows in a scope where the user holds `edit`
 *   (the caller's `canEdit`, from `reviewOffers`). The other matching rows stay pending and are
 *   counted as `leftPending`, so the shell can say how many were left (criterion 2). Rows outside
 *   the match are not part of the action and are not counted.
 * - `applySuggestionChange` is the list's update when a suggestion arrives or is resolved, by this
 *   user or by another person. A resolve for an id the list does not hold changes nothing and is
 *   no error (UX-036 criterion 4). The result stays in document order (UX-037 criterion 4).
 *
 * Pure: the transforms, the commit and the view are elsewhere. The message text for the count and
 * the browser run for a resolve by another person are not in this module.
 */
import { listSuggestions, type SuggestionRow } from './review-rules.ts';

export interface BulkPlan {
  /** The ids to accept or reject: matching rows in a scope where the user may edit, in input order. */
  readonly apply: readonly string[];
  /** Matching rows left pending because the user may not edit their scope. */
  readonly leftPending: number;
}

/** The bulk plan over the rows that `matches` selects. Input is not changed. */
export function bulkPlan<T extends SuggestionRow>(
  rows: readonly T[],
  matches: (row: T) => boolean,
  canEdit: (row: T) => boolean,
): BulkPlan {
  const apply: string[] = [];
  let leftPending = 0;
  for (const row of rows) {
    if (!matches(row)) continue;
    if (canEdit(row)) apply.push(row.id);
    else leftPending++;
  }
  return { apply, leftPending };
}

/** A change to the list: a suggestion arrives, or one is resolved (by anyone). */
export type SuggestionChange<T extends SuggestionRow> =
  { readonly kind: 'arrive'; readonly row: T } | { readonly kind: 'resolve'; readonly id: string };

/**
 * The list after one change, in document order. An arrival with an id the list already holds
 * replaces that row. A resolve removes the row with that id, and removes nothing when there is none.
 */
export function applySuggestionChange<T extends SuggestionRow>(
  rows: readonly T[],
  change: SuggestionChange<T>,
): T[] {
  if (change.kind === 'resolve') {
    return listSuggestions(rows.filter((r) => r.id !== change.id));
  }
  const kept = rows.filter((r) => r.id !== change.row.id);
  kept.push(change.row);
  return listSuggestions(kept);
}
