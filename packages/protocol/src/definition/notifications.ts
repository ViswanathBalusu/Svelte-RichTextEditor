/**
 * Notifications on the socket (05 §5.6), as data (PRO-003). They live in a module of their own, so
 * that a client, which reads them, does not take the webhooks of the events plane (`events.ts`)
 * with them (FND-008).
 */
import { type Annotated, type NamedShape, str } from './shapes.ts';

export interface NotificationDef extends Annotated {
  type: string;
  /** The resource the notification points at, relative to `rest`. */
  resource: string;
  spec: string;
  owner: string;
}

const thread = (type: string): NotificationDef => ({
  type,
  resource: '/threads/{tid}',
  spec: '05 §5.6',
  doc: "Thread events carry the thread's current range and the `seq` it refers to.",
  gaps: ['G48'],
  owner: 'PRO',
});
const n = (type: string, resource: string, extra: Annotated = {}): NotificationDef => ({
  type,
  resource,
  spec: '05 §5.6',
  owner: 'PRO',
  ...extra,
});

export const NOTIFICATIONS: readonly NotificationDef[] = [
  thread('thread.created'),
  thread('thread.updated'),
  thread('thread.resolved'),
  thread('thread.reopened'),
  thread('thread.deleted'),
  n('comment.created', '/comments/{cid}'),
  n('comment.updated', '/comments/{cid}'),
  n('comment.deleted', '/comments/{cid}'),
  n('version.created', '/documents/{id}/versions'),
  n('version.restored', '/documents/{id}/versions'),
  n('export.progress', '/exports/{jid}'),
  n('export.completed', '/exports/{jid}'),
  n('export.failed', '/exports/{jid}'),
  n('export.cancelled', '/exports/{jid}'),
  n('import.completed', '/imports/{jid}'),
  n('import.failed', '/imports/{jid}'),
  n('asset.ready', '/assets/{aid}'),
  n('asset.failed', '/assets/{aid}'),
  n('document.updated', '/documents/{id}', { gaps: ['G49'] }),
];

/** The shape of a notification's type name (05 §5.6). */
export const NOTIFICATION_TYPE_SHAPE: NamedShape = {
  name: 'NotificationType',
  owner: 'PRO',
  shape: str({
    known: NOTIFICATIONS.map((x) => x.type),
    minLength: 1,
    doc: 'Notification type: an open vocabulary; a client ignores types it does not know (05 §1 rule 3).',
    spec: '05 §5.6',
    gaps: ['G49'],
  }),
};
