/**
 * The reference host's webhook endpoint (UX-098; 05 §7; 13 §11.1 item 3), behind the route
 * `POST /webhooks/dep` (src/routes/webhooks/dep/+server.ts). It composes the receiver
 * (webhook-receiver.ts: signature, tolerance, deduplication), the work queue and the notifier
 * (webhook-notifications.ts). The route answers as soon as the delivery is verified and queued;
 * `schedule` runs the queued work on a later turn of the event loop, after the response.
 *
 * The active secrets are read from `DOCEDIT_HOST_WEBHOOK_SECRETS` on every delivery: one secret,
 * or two separated by a space or a comma during a rotation. With none set, every delivery is
 * refused with 401. Demo only: a real host keeps its secrets in its own secret store, and keeps
 * the seen identifiers and the queue in durable storage.
 */
import { logSink, notifier, type NotificationSink } from './webhook-notifications.ts';
import { MemorySeenStore, WebhookReceiver, WorkQueue } from './webhook-receiver.ts';

export const WEBHOOK_SECRETS_ENV = 'DOCEDIT_HOST_WEBHOOK_SECRETS';

/** The active secrets from the environment, in the order given. */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[WEBHOOK_SECRETS_ENV] ?? '').split(/[\s,]+/).filter(Boolean);
}

export interface WebhookEndpoint {
  receiver: WebhookReceiver;
  queue: WorkQueue;
  /** Runs the queued work after the current response; returns at once. */
  schedule(): void;
  /** Resolves when the work scheduled so far has run (tests, shutdown). */
  settled(): Promise<void>;
}

export function composeWebhookEndpoint(opts: {
  /** Read on every delivery, so that a rotation needs no restart. */
  secrets: () => readonly string[];
  sink: NotificationSink;
  /** The receiver's clock in Unix seconds. */
  now?: () => number;
  /** Runs `run` later; defaults to `setTimeout(run, 0)`. */
  defer?: (run: () => void) => void;
}): WebhookEndpoint {
  const queue = new WorkQueue(notifier(opts.sink));
  const receiver = new WebhookReceiver({
    secrets: opts.secrets,
    seen: new MemorySeenStore(),
    queue,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const defer =
    opts.defer ??
    ((run: () => void) => {
      setTimeout(run, 0);
    });
  // One drain at a time: a delivery that arrives during a drain is picked up by the next one.
  let chain: Promise<void> = Promise.resolve();
  return {
    receiver,
    queue,
    schedule() {
      chain = chain
        .then(() => new Promise<void>((resolve) => defer(resolve)))
        .then(() => queue.drain());
    },
    settled: () => chain,
  };
}

let composed: WebhookEndpoint | null = null;

/** The endpoint of this process: secrets from the environment, notifications to the log. */
export function webhookEndpoint(): WebhookEndpoint {
  composed ??= composeWebhookEndpoint({ secrets: () => secretsFromEnv(), sink: logSink() });
  return composed;
}
