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
import { SEED_DIR } from './config.ts';
import { handleWorkflowEvent } from './send-for-completion.ts';
import { workflowDeps } from './workflow-runtime.ts';
import { Directory } from './directory.ts';
import { logSink, mailSink, notifier, type NotificationSink } from './webhook-notifications.ts';
import {
  MemorySeenStore,
  WebhookReceiver,
  WorkQueue,
  type ReceivedEvent,
} from './webhook-receiver.ts';

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
  /** More work for each verified event, after the notification (send for completion, UX-099). */
  onEvent?: (event: ReceivedEvent) => Promise<void>;
  /** The receiver's clock in Unix seconds. */
  now?: () => number;
  /** Runs `run` later; defaults to `setTimeout(run, 0)`. */
  defer?: (run: () => void) => void;
}): WebhookEndpoint {
  const notify = notifier(opts.sink);
  const queue = new WorkQueue(async (event) => {
    await notify(event);
    await opts.onEvent?.(event);
  });
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

export const SMTP_ENV = 'DOCEDIT_HOST_SMTP';
export const PUBLIC_URL_ENV = 'DOCEDIT_HOST_PUBLIC_URL';
export const MAIL_FROM_ENV = 'DOCEDIT_HOST_MAIL_FROM';

/**
 * The notification sink of this process. With `DOCEDIT_HOST_SMTP` (`host:port`) it sends e-mail to
 * that relay, which in the demo stack is the development mail sink (UX-098 criterion 5); the
 * link in the mail starts at `DOCEDIT_HOST_PUBLIC_URL`, and the sender is `DOCEDIT_HOST_MAIL_FROM`
 * (default `notifications@demo.example.test`). Without it, one log line per notification.
 */
export function sinkFromEnv(env: NodeJS.ProcessEnv = process.env): NotificationSink {
  const relay = env[SMTP_ENV];
  if (!relay) return logSink();
  const colon = relay.lastIndexOf(':');
  const port = Number(relay.slice(colon + 1));
  if (colon < 1 || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${SMTP_ENV} is host:port`);
  const publicUrl = env[PUBLIC_URL_ENV];
  if (!publicUrl) throw new Error(`${SMTP_ENV} needs ${PUBLIC_URL_ENV} for the link in the mail`);
  const seedDir = env['DOCEDIT_HOST_SEED'] ?? SEED_DIR;
  let directory: Promise<Directory> | null = null;
  return mailSink({
    smtp: { host: relay.slice(0, colon), port },
    directory: () => (directory ??= Directory.load(seedDir)),
    publicUrl: publicUrl.replace(/\/+$/, ''),
    from: env[MAIL_FROM_ENV] || 'notifications@demo.example.test',
  });
}

/** The endpoint of this process: secrets from the environment, notifications by e-mail or log. */
export function webhookEndpoint(): WebhookEndpoint {
  composed ??= composeWebhookEndpoint({
    secrets: () => secretsFromEnv(),
    sink: sinkFromEnv(),
    onEvent: async (event) => handleWorkflowEvent(await workflowDeps(), event),
  });
  return composed;
}
