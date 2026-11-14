/**
 * How an erased person is shown (08 §13; HIS-038 criterion 2; HIS-015 criterion 5).
 *
 * Erasure deletes the one mapping row from a host `sub` to the surrogate identifier, and nothing
 * in the log changes (HIS-038). So an author's runs keep the surrogate they were written under, and
 * that identifier no longer leads to a person. This module decides only the label shown for it:
 * an identifier in the erased set is an unknown person, and never a name. An assistant named on
 * the run is still shown, because the agent is an identity of the connection, not of a person.
 */
import { type AuthorLabel, authorLabel } from './attribution.ts';

export interface UnknownAuthorLabel {
  kind: 'unknown';
  agent?: string;
}

export type ShownAuthor = AuthorLabel | UnknownAuthorLabel;

/** The label for an author whose surrogate may have been erased (HIS-015 criterion 5). */
export function shownAuthor(
  a: { user: string; agent?: string | undefined },
  erased: ReadonlySet<string>,
): ShownAuthor {
  if (!erased.has(a.user)) return authorLabel(a);
  const label: UnknownAuthorLabel = { kind: 'unknown' };
  if (a.agent !== undefined && a.agent !== '') label.agent = a.agent;
  return label;
}
