/**
 * The strings of the `commentsPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_COMMENTS_PANE = {
  // The comments pane (UX-030). The thread text and the names are content.
  'comments.filter.label': 'Show',
  'comments.filter.open': 'Open',
  'comments.filter.resolved': 'Resolved',
  'comments.filter.all': 'All',
  'comments.filter.assignee': 'Assigned to',
  'comments.filter.anyone': 'Anyone',
  'comments.empty': 'No comments match this view.',
  'comments.state.open': 'Open',
  'comments.state.resolved': 'Resolved',
  'comments.replies': {
    one: '{count} reply',
    other: '{count} replies',
  },
  'comments.target.detached': 'The commented text was removed.',
  'comments.target.block': 'On a {kind}.',
  'comments.target.excerpt': 'On “{text}”.',
  'comments.row.name': '{author}, {state}, {replies}',

  // A followed link (UX-034): the announcement is the author, time and state only.
  'comments.link.announce': '{author}, {time}, {state}.',
  'comments.link.unavailable':
    'This comment cannot be shown. It may have been deleted, or you may not be able to view this document.',

  // The thread view (UX-029): replies, edits, resolving, deleting.
  'comments.show': 'Show in document',
  'comments.show.label': 'Show in document, thread by {author}',
  'comments.shown': 'Shown in the document.',
  'comments.picked': 'Thread by {author} chosen in the document.',

  // What a refresh of the list announces (UX-030 criterion 4).
  'comments.announce.created': 'New comment thread by {author}.',
  'comments.announce.reply': 'New reply in the thread by {author}.',
  'comments.announce.resolved': 'Thread by {author} resolved.',
  'comments.announce.reopened': 'Thread by {author} reopened.',
  'comments.announce.deleted': 'Thread by {author} deleted.',
  'comments.thread.comment.name': '{author}, {time}, {state}',
  'comments.thread.open': 'Open thread by {author}',
  'comments.thread.back': 'Back to the list',
  'comments.thread.label': 'Thread by {author}',
  'comments.thread.detached': 'The commented text was removed. The thread stays here to read.',
  'comments.thread.edited': 'edited',
  'comments.thread.edit': 'Edit',
  'comments.thread.edit.label': 'Edit comment by {author}',
  'comments.thread.edit.save': 'Save',
  'comments.thread.edit.cancel': 'Cancel',
  'comments.thread.deleteComment': 'Delete',
  'comments.thread.deleteThread': 'Delete thread',
  'comments.thread.resolve': 'Resolve',
  'comments.thread.reopen': 'Reopen',
  'comments.thread.reply.label': 'Reply',
  'comments.thread.reply.post': 'Post reply',
  'comments.thread.conflict':
    'This thread changed while you were writing. The latest version is shown and your text is kept.',
  'comments.thread.failed': 'That did not work. Your text is kept.',
  'comments.thread.gone': 'This thread no longer exists.',
  'comments.thread.emptyBody': 'Write something first.',
  'comments.thread.posted': 'Reply added.',
  'comments.thread.saved': 'Comment saved.',
  'comments.thread.commentDeleted': 'Comment deleted.',
  'comments.thread.threadDeleted': 'Thread deleted.',
  'comments.thread.resolved': 'Thread resolved.',
  'comments.thread.reopened': 'Thread reopened.',

  // The thread as a task (UX-032). The assignee is shown as text.
  'comments.thread.task.assigned': 'Task, assigned to {name}.',
  'comments.thread.task.none': 'Not assigned to anyone.',
  'comments.thread.assign.label': 'Assign to',
  'comments.thread.assign.results': 'People to assign the thread to',
  'comments.thread.assign.clear': 'Clear assignee',
  'comments.thread.assigned': 'Thread assigned.',
  'comments.thread.unassigned': 'Assignee cleared.',
} as const satisfies StringTable;

registerSource(EN_GB_COMMENTS_PANE);
