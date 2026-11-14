/**
 * The mention picker's rules (UX-031 criteria 2, 3 and 6; 05 §8.1 `searchPrincipals`, §6.2 mentions).
 *
 * Each typed query is numbered. Results come back later, possibly out of order; only the results of
 * the newest query are shown, so a late answer to an older query is ignored (criterion 2). A mention
 * node stores only the principal identifier, `user:<sub>` or `group:<id>` (criterion 3, 07 §1); the
 * name is resolved for display and never stored. Without a `searchPrincipals` in the host, mentions
 * are not offered (criterion 6). The picker that calls these is `mention-picker.ts`.
 */

/** The picker's query counter: the newest query issued, and the query whose results are shown. */
export interface MentionSearch {
  readonly issued: number;
  readonly shown: number | null;
}

export const START_MENTION_SEARCH: MentionSearch = { issued: 0, shown: null };

/** Issues a new query: the caller sends it and keeps `id` to match the results when they arrive. */
export function issueQuery(search: MentionSearch): {
  readonly search: MentionSearch;
  readonly id: number;
} {
  const id = search.issued + 1;
  return { search: { issued: id, shown: search.shown }, id };
}

/**
 * Whether the results of query `id` may be shown: only when no newer query has been issued (UX-031
 * criterion 2). A result for an older query is stale and is dropped.
 */
export function acceptResults(
  search: MentionSearch,
  id: number,
): { readonly show: boolean; readonly search: MentionSearch } {
  if (id !== search.issued) return { show: false, search };
  return { show: true, search: { issued: search.issued, shown: id } };
}

const PRINCIPAL = /^(user|group):\S+$/;

/** A mention node: the principal identifier and nothing else (UX-031 criterion 3). */
export interface MentionNode {
  readonly type: 'mention';
  readonly principal: string;
}

/** The node for a principal, or null when the identifier is not `user:<sub>` or `group:<id>`. */
export function mentionNode(principal: string): MentionNode | null {
  return PRINCIPAL.test(principal) ? { type: 'mention', principal } : null;
}

/** Mentions are offered only where the host provides `searchPrincipals` (UX-031 criterion 6). */
export function mentionsOffered(hostHasSearchPrincipals: boolean): boolean {
  return hostHasSearchPrincipals;
}
