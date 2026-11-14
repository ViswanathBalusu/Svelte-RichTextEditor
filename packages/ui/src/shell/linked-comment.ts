/**
 * What a focused, linked comment announces (UX-034 criterion 4; UX-030 criterion 6).
 *
 * Pure. The announcement is the author, the time the thread was created and its state: the three
 * parts the criterion names, and nothing else. The thread's text, its target and its reply count
 * are not part of the announcement, so a link does not read more of the thread than the criterion
 * asks for. The sentence itself is built from the string tables by the view.
 *
 * The shell's entry for a link (`openLinkedComment` in App.svelte) passes a `LinkedTarget` to the
 * comments pane through the shell context: a thread to show and focus, or the unavailable message.
 * Not built here: the element's host method for a comment identifier (UX-034 criterion 2, open in
 * the spec), the copy of a link (criterion 1), and a screen reader run.
 */
import type { ThreadState } from './comment-rules.ts';

/** What the comments pane should show for a followed link (UX-034 criteria 2 and 3). */
export type LinkedTarget =
  { readonly kind: 'thread'; readonly id: string } | { readonly kind: 'unavailable' };

export interface LinkedCommentAnnouncement {
  readonly author: string;
  readonly createdAt: string;
  readonly state: ThreadState;
}

/** The parts announced for a thread. Copies the three fields as given; it does not reformat them. */
export function linkedCommentAnnouncement(thread: {
  readonly author: string;
  readonly createdAt: string;
  readonly state: ThreadState;
}): LinkedCommentAnnouncement {
  return { author: thread.author, createdAt: thread.createdAt, state: thread.state };
}
