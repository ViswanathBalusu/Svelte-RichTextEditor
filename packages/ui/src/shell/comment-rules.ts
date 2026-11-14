/**
 * Who may do what to a comment thread, and which threads a list shows (UX-029 criteria 2 and 5,
 * UX-030 criterion 3; 07 §12 table: "Resolve, reopen or assign a thread: `comment` in its scope;
 * delete needs the author or `manage`").
 *
 * These are pure rules over the capabilities the core reports for a scope. The controls that call
 * them (the comment menu, the reply box, the pane's filters) are not built yet; nothing here draws
 * or sends anything.
 */
import type { Capability } from '../core-api.ts';

/** The reason a control is withdrawn, as a code; the text is the shell's to give (UX-029 criterion 5). */
export type DenialReason = 'noComment' | 'notAuthor';

export type Decision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: DenialReason };

const ALLOW: Decision = { allowed: true };

/** The author of an item, or a user with `manage`: the rule for editing a comment and deleting a thread. */
function authorOrManage(user: string, author: string, caps: readonly Capability[]): Decision {
  if (user === author || caps.includes('manage')) return ALLOW;
  return { allowed: false, reason: 'notAuthor' };
}

/** Edit a comment: its author or a user with `manage` (UX-029 criterion 2). */
export function canEditComment(
  user: string,
  commentAuthor: string,
  caps: readonly Capability[],
): Decision {
  return authorOrManage(user, commentAuthor, caps);
}

/** Delete a comment: its author or a user with `manage` (UX-029 criterion 2). */
export function canDeleteComment(
  user: string,
  commentAuthor: string,
  caps: readonly Capability[],
): Decision {
  return authorOrManage(user, commentAuthor, caps);
}

/** Delete a whole thread: its author or a user with `manage` (UX-029 criterion 2; 07 §12). */
export function canDeleteThread(
  user: string,
  threadAuthor: string,
  caps: readonly Capability[],
): Decision {
  return authorOrManage(user, threadAuthor, caps);
}

/**
 * Reply to a thread, or resolve and reopen it: `comment` in the thread's scope (07 §12). Without
 * it the reply box is absent or disabled, with the reason (UX-029 criterion 5).
 */
export function canReply(caps: readonly Capability[]): Decision {
  return caps.includes('comment') ? ALLOW : { allowed: false, reason: 'noComment' };
}

export type ThreadState = 'open' | 'resolved';

/** The fields of a thread the pane's filters read. `position` is the document order the core gives. */
export interface ThreadRow {
  readonly id: string;
  readonly state: ThreadState;
  readonly assignee: string | null;
  readonly position: number;
}

/**
 * The pane's filter. The default list shows open threads only: resolved threads leave it and stay
 * reachable through `state: 'resolved'` or `'all'` (UX-029 criterion 3). `assignee` narrows the list
 * to the threads assigned to that person.
 */
export interface ThreadFilter {
  readonly state: ThreadState | 'all';
  readonly assignee?: string | null;
}

export const DEFAULT_THREAD_FILTER: ThreadFilter = { state: 'open' };

/**
 * The threads a filter lists, in document order (UX-030 criterion 3). The input is not changed;
 * ties in `position` keep the order the caller gave.
 */
export function filterThreads<T extends ThreadRow>(
  threads: readonly T[],
  filter: ThreadFilter,
): T[] {
  const kept = threads.filter((t) => {
    if (filter.state !== 'all' && t.state !== filter.state) return false;
    if (filter.assignee !== undefined && filter.assignee !== null) {
      return t.assignee === filter.assignee;
    }
    return true;
  });
  return kept
    .map((t, index) => ({ t, index }))
    .sort((a, b) => a.t.position - b.t.position || a.index - b.index)
    .map(({ t }) => t);
}
