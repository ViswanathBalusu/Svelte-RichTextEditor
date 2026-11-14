/**
 * Notifications of the reference host (UX-098; 13 §11.1, §11.2). The webhook queue hands each
 * verified event to the handler `notifier(sink)`, which turns `dep.comment.mentioned.v1` and
 * `dep.task.assigned.v1` into one notification for a sink. Other events, and the dispatcher's
 * test ping, cause none.
 *
 * Not built yet (UX-098 criterion 3): the e-mail itself. The event does not name the mentioned
 * person or the comment (`data` carries only `seq`, gap G83), and the host's directory has no
 * e-mail address, so a notification names the document and the event only. The sinks here are an
 * in-memory one (tests) and a log line with identifiers only (the running host).
 */
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

/** The notification an event causes, or null when it causes none. */
export function notificationOf(event: ReceivedEvent): Notification | null {
  if (event.test || event.subject === null || !NOTIFYING_EVENTS.has(event.type)) return null;
  const id = event.body['id'];
  return {
    webhookId: event.webhookId,
    eventId: typeof id === 'string' ? id : null,
    type: event.type,
    document: event.subject,
  };
}

/** The queue's handler: one notification per queued event that causes one. */
export function notifier(sink: NotificationSink): (event: ReceivedEvent) => Promise<void> {
  return async (event) => {
    const n = notificationOf(event);
    if (n !== null) await sink.send(n);
  };
}
