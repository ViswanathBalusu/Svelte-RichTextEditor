/**
 * Labels the authors of history list groups with the erasure rule (08 §13; HIS-038 criterion 2).
 *
 * `groupCommits` names authors by their surrogate identifier, as the log stores them. After an
 * erasure those identifiers lead to no person, so the list shows each erased one through
 * `shownAuthor` (erasure.ts) and keeps every other author as it is. This is the list's half of
 * criterion 2; attribution and comparison are not labelled here (see HIS-038's notes).
 */
import { shownAuthor, type ShownAuthor } from './erasure.ts';
import type { HistoryGroup, HistoryItem } from './groups.ts';

export interface LabelledGroup extends Omit<HistoryGroup, 'authors'> {
  authors: ShownAuthor[];
}

export type LabelledItem = LabelledGroup | Exclude<HistoryItem, HistoryGroup>;

/** A group with each author shown as the erasure rule decides. The input is not changed. */
export function labelGroupAuthors(group: HistoryGroup, erased: ReadonlySet<string>): LabelledGroup {
  return { ...group, authors: group.authors.map((a) => shownAuthor(a, erased)) };
}

/** A page of history items with every group's authors labelled; versions pass through. */
export function labelHistoryItems(
  items: readonly HistoryItem[],
  erased: ReadonlySet<string>,
): LabelledItem[] {
  return items.map((item) => (item.type === 'group' ? labelGroupAuthors(item, erased) : item));
}
