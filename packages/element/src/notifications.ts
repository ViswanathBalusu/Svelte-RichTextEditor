/**
 * The client's reading of `event` messages (05 §5.6; PRO-035). A notification says "fetch the
 * resource over REST if you care": it carries a `type`, a `resource`, an optional `rev` and an
 * optional small `data`. The session hands every notice of its channel to one dispatcher, and
 * the parts of the element that care about a type register for it.
 *
 * A type the definition does not list is ignored: no handler runs, nothing is raised and the
 * channel is not closed (PRO-035 criterion 5; PRO-005). That keeps an older element working
 * against a newer server that announces more types. A handler that throws does not stop the
 * handlers after it, and it does not reach the channel.
 *
 * No DOM and no Node.js API: this runs in Node.js tests.
 */
import type { Notification, Unsubscribe } from '@docedit/protocol';

export type NotificationHandler = (notification: Notification) => void;

/**
 * The notification types of DEP 1.0 with the additions of 12 §10 (05 §5.6), in the order of the
 * protocol definition. The names are repeated here and not read from the definition: this module is
 * part of the element's entry, which a host with its own backend loads too, and the definition as
 * data (`DEP1_WIRE` and the modules it is built from) is needed by the DEP client only (FE-002;
 * 13 §9). `test/pro-035-notifications.test.ts` fails when this list and the definition differ.
 */
export const NOTIFICATION_TYPES = [
  'thread.created',
  'thread.updated',
  'thread.resolved',
  'thread.reopened',
  'thread.deleted',
  'comment.created',
  'comment.updated',
  'comment.deleted',
  'comment.reacted',
  'version.created',
  'version.restored',
  'export.progress',
  'export.completed',
  'export.failed',
  'export.cancelled',
  'import.completed',
  'import.failed',
  'asset.ready',
  'asset.failed',
  'document.updated',
] as const;

/** The notification types this build knows (DEP1 and its extensions). */
export const KNOWN_NOTIFICATION_TYPES: ReadonlySet<string> = new Set(NOTIFICATION_TYPES);

export class NotificationDispatcher {
  readonly #handlers = new Map<string, Set<NotificationHandler>>();
  readonly #onHandlerError: ((error: unknown, notification: Notification) => void) | undefined;

  constructor(
    options: { onHandlerError?: (error: unknown, notification: Notification) => void } = {},
  ) {
    this.#onHandlerError = options.onHandlerError;
  }

  /** Registers `handler` for a known type. A type the definition does not list is a programming error. */
  on(type: string, handler: NotificationHandler): Unsubscribe {
    if (!KNOWN_NOTIFICATION_TYPES.has(type))
      throw new RangeError(`"${type}" is not a notification type of the protocol definition`);
    let set = this.#handlers.get(type);
    if (!set) this.#handlers.set(type, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * Hands one notice to the handlers of its type, in the order they registered. Returns how many
   * handlers ran; an unknown type, or a known one nobody listens for, returns 0.
   */
  dispatch(notification: Notification): number {
    if (!KNOWN_NOTIFICATION_TYPES.has(notification.type)) return 0;
    const set = this.#handlers.get(notification.type);
    if (!set) return 0;
    let ran = 0;
    for (const handler of [...set]) {
      ran++;
      try {
        handler(notification);
      } catch (error) {
        this.#onHandlerError?.(error, notification);
      }
    }
    return ran;
  }
}
