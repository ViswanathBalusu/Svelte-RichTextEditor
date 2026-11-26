/**
 * Notifications of the reference host (UX-098; 13 §11.1, §11.2). The webhook queue hands each
 * verified event to the handler `notifier(sink)`, which turns `dep.comment.mentioned.v1` and
 * `dep.task.assigned.v1` into one notification for a sink. Other events, and the dispatcher's
 * test ping, cause none.
 *
 * The service's events name the person and the comment or thread in `data` (`principal`,
 * `comment`, `thread` for a mention; `assignee`, `thread` for a task). The e-mail address is the
 * host's own record: `mailSink` looks the person up in the host's directory and never asks the
 * document service for one (owner decision 71). The sinks are an in-memory one (tests), a log line
 * with identifiers only, and the mail sink, which sends through the SMTP client to the relay named
 * by `DOCEDIT_HOST_SMTP` (the demo stack's Mailpit, a development mail sink).
 */
import type { Directory } from './directory.ts';
import { sendMail, type MailMessage, type SmtpTarget } from './smtp.ts';
import type { ReceivedEvent } from './webhook-receiver.ts';

/** The events that notify a person (12 §6.3; 05 §7). */
export const NOTIFYING_EVENTS: ReadonlySet<string> = new Set([
  'dep.comment.mentioned.v1',
  'dep.task.assigned.v1',
]);

export interface Notification {
  /** The `webhook-id` of the delivery that caused it. */
  webhookId: string;
  /** The CloudEvents `id` of the event, when the body has one. */
  eventId: string | null;
  type: string;
  /** The document identifier (CloudEvents `subject`). */
  document: string;
  /** Who is told: `user:<sub>` or `group:<id>`; null when the event does not say. */
  principal: string | null;
  /** The comment of a mention, and the thread of a mention or a task. */
  comment: string | null;
  thread: string | null;
}

export interface NotificationSink {
  send(notification: Notification): Promise<void>;
}

/** Keeps every notification sent, for tests. */
export class MemoryNotificationSink implements NotificationSink {
  readonly sent: Notification[] = [];

  send(notification: Notification): Promise<void> {
    this.sent.push(structuredClone(notification));
    return Promise.resolve();
  }
}

/** Writes one line per notification with identifiers only; never a body or an address. */
export function logSink(write: (line: string) => void = (l) => console.info(l)): NotificationSink {
  return {
    send(n) {
      write(`notification ${n.type} document=${n.document} webhook-id=${n.webhookId}`);
      return Promise.resolve();
    },
  };
}

function dataOf(event: ReceivedEvent): Record<string, unknown> {
  const data = event.body['data'];
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A mention names a `principal`, a task an `assignee`; a bare identifier is taken as a user. */
function principalOf(event: ReceivedEvent): string | null {
  const data = dataOf(event);
  const named = textOf(
    event.type === 'dep.task.assigned.v1' ? data['assignee'] : data['principal'],
  );
  if (named === null) return null;
  return /^(user|group):/.test(named) ? named : `user:${named}`;
}

/** The notification an event causes, or null when it causes none. */
export function notificationOf(event: ReceivedEvent): Notification | null {
  if (event.test || event.subject === null || !NOTIFYING_EVENTS.has(event.type)) return null;
  const id = event.body['id'];
  const data = dataOf(event);
  return {
    webhookId: event.webhookId,
    eventId: typeof id === 'string' ? id : null,
    type: event.type,
    document: event.subject,
    principal: principalOf(event),
    comment: textOf(data['comment']),
    thread: textOf(data['thread']),
  };
}

export interface MailSinkOptions {
  /** The relay: the demo stack's development mail sink. */
  smtp: SmtpTarget;
  /** The host's directory, which holds the addresses. Read on each notification. */
  directory: () => Promise<Directory>;
  /** The host's address as a reader reaches it, for the link; no trailing slash. */
  publicUrl: string;
  /** The sender address of the notifications. */
  from: string;
  /** Replaces `sendMail`, for tests. */
  send?: (target: SmtpTarget, message: MailMessage) => Promise<void>;
}

/**
 * The link in the mail: the host's own page for the document, with the comment and thread named
 * in the query. It carries no token and no secret; whoever follows it signs in to the host as
 * usual (the demo's sign-in is a choice of seeded person, `/as/<sub>`).
 */
export function documentLink(
  publicUrl: string,
  recipient: string,
  n: Pick<Notification, 'document' | 'comment' | 'thread'>,
): string {
  const query = new URLSearchParams();
  if (n.thread !== null) query.set('thread', n.thread);
  if (n.comment !== null) query.set('comment', n.comment);
  const q = query.size > 0 ? `?${query.toString()}` : '';
  return `${publicUrl}/as/${encodeURIComponent(recipient)}/docs/${encodeURIComponent(n.document)}${q}`;
}

/**
 * Sends one e-mail to each person the notification names (a group gives its members). The address
 * comes from the host's directory; a person without one gets nothing, and so does a notification
 * that names nobody. A failed send rejects, so that the work queue records it.
 */
export function mailSink(options: MailSinkOptions): NotificationSink {
  const send = options.send ?? sendMail;
  return {
    async send(n) {
      if (n.principal === null) return;
      const people = (await options.directory()).recipients(n.principal);
      for (const person of people) {
        const link = documentLink(options.publicUrl, person.sub, n);
        const mention = n.type === 'dep.comment.mentioned.v1';
        await send(options.smtp, {
          from: options.from,
          to: person.email,
          subject: mention ? 'You were mentioned in a comment' : 'A task was assigned to you',
          text: [
            `Hello ${person.name},`,
            '',
            mention
              ? 'Someone mentioned you in a comment on a document.'
              : 'A comment thread on a document was assigned to you.',
            '',
            `Open the document: ${link}`,
            '',
            'This message comes from the demonstration host. It is not a production deployment.',
            '',
          ].join('\n'),
          messageId: `${n.webhookId}.${person.sub}@${options.from.split('@')[1] ?? 'localhost'}`,
        });
      }
    },
  };
}

/** The queue's handler: one notification per queued event that causes one. */
export function notifier(sink: NotificationSink): (event: ReceivedEvent) => Promise<void> {
  return async (event) => {
    const n = notificationOf(event);
    if (n !== null) await sink.send(n);
  };
}
