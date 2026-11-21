/**
 * The webhook delivery of the composed service (05 §7; BE-055, BE-056; PRM-053; lane
 * U-PRM-052-067). `startService` calls `composeWebhooks` when `config.webhooks` is set and passes
 * the dispatcher as the `events` sink of both planes: the control plane raises grant and region
 * state changes into it, and the room raises refused commits (`DataPlaneDeps.events`).
 *
 * - Subscriptions: one store is shared by the `/webhooks` routes and the dispatcher, so that a
 *   subscription created over REST is the one deliveries are sent to. Only the in-memory store is
 *   built (no PostgreSQL table for subscriptions exists yet), so subscriptions end with the process.
 * - Deliveries: the in-memory store by default; `PgDeliveryStore` waits for its migration.
 * - Egress: every send goes through `EgressProxy` with the system resolver and the Node.js
 *   connector (BE-056); a target whose address is not public is refused and the row records why.
 * - Retries (PRO-071): with `settings.retry` the dispatcher retries a failed delivery with
 *   exponential delay inside the 24 hours of 05 §7; without it, it does not (no default, ADR 0216).
 * - Throttle: `dep.commit.rejected.v1` is admitted `rejectedMax` times per `rejectedWindowMs`.
 *
 * No number has a default here: the spec gives none (ADR 0146), so `config.ts` requires them.
 */
import type { WebhookSettings } from '../config.ts';
import type { Logger } from '../log.ts';
import {
  MemoryDeliveryStore,
  WebhookDispatcher,
  type DeliveryStore,
  type DispatcherLogEntry,
  RETRY_WINDOW_MS,
} from './webhook-dispatcher.ts';
import {
  EgressProxy,
  nodeConnector,
  systemResolver,
  type Connector,
  type Resolver,
  type Transport,
} from './webhook-egress.ts';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
  type SubscriptionStore,
} from './webhook-subscriptions.ts';

/** What a caller of `startService` may replace: tests record sends or read the rows. */
export interface WebhookOverrides {
  /** Replaces the egress proxy. Tests only: production sends go through `EgressProxy`. */
  transport?: Transport;
  deliveries?: DeliveryStore;
  /** Replaces the resolver and the connector under the real `EgressProxy`: the rules stay in force. */
  egress?: { resolver?: Resolver; connector?: Connector };
  /** Replaces the timer of the retries, so that a test fires them by hand. */
  schedule?: (run: () => void, delayMs: number) => void;
}

export interface ComposeWebhooksInput {
  settings: WebhookSettings;
  /** The CloudEvents `source` when the settings give none. */
  serviceId: string;
  now: () => number;
  logger: Logger;
  /** The subscription store; absent, an in-memory one. */
  store?: SubscriptionStore;
  /** The `/webhooks` routes; absent, built over `store`. Given, `store` must be given too. */
  routes?: WebhookSubscriptions;
  overrides?: WebhookOverrides;
}

export interface ComposedWebhooks {
  dispatcher: WebhookDispatcher;
  store: SubscriptionStore;
  routes: WebhookSubscriptions;
  deliveries: DeliveryStore;
}

/** Dispatcher log entries as structured log lines: identifiers, event names and codes only. */
function logTo(logger: Logger): (entry: DispatcherLogEntry) => void {
  return (e) => {
    switch (e.event) {
      case 'attempt':
        if (e.reason !== null || e.status === null || e.status < 200 || e.status > 299)
          logger.warn({
            event: 'webhook.attempt.failed',
            tenant: e.tenant,
            message: e.eventType,
            ...(e.status !== null ? { status: e.status } : {}),
            ...(e.reason !== null ? { code: e.reason } : {}),
          });
        return;
      case 'suppressed':
        logger.info({
          event: 'webhook.suppressed',
          tenant: e.tenant,
          message: e.eventType,
          code: e.reason,
        });
        return;
      case 'envelope_refused':
        logger.error({
          event: 'webhook.envelope_refused',
          tenant: e.tenant,
          message: e.eventType,
          code: e.reason,
        });
        return;
      default:
        return;
    }
  };
}

export function composeWebhooks(input: ComposeWebhooksInput): ComposedWebhooks {
  const { settings, overrides = {} } = input;
  if (input.routes && !input.store)
    throw new Error(
      'parts.webhooks needs parts.webhookStore when webhooks are delivered, so that the routes and the dispatcher share one store',
    );
  const store = input.store ?? new MemorySubscriptionStore();
  const routes = input.routes ?? new WebhookSubscriptions({ store, now: input.now });
  const deliveries = overrides.deliveries ?? new MemoryDeliveryStore();
  const transport =
    overrides.transport ??
    new EgressProxy({
      resolver: overrides.egress?.resolver ?? systemResolver,
      connector: overrides.egress?.connector ?? nodeConnector(settings.timeoutMs),
      maxRedirects: settings.maxRedirects,
      ...(settings.testAllow ? { allow: settings.testAllow } : {}),
    });
  const dispatcher = new WebhookDispatcher({
    subscriptions: store,
    deliveries,
    transport,
    source: settings.source ?? input.serviceId,
    now: input.now,
    rejectedThrottle: { windowMs: settings.rejectedWindowMs, max: settings.rejectedMax },
    log: logTo(input.logger),
    // PRO-071: with a schedule in the settings, a failed delivery is retried inside 24 hours.
    ...(settings.retry ? { retry: { ...settings.retry, maxAgeMs: RETRY_WINDOW_MS } } : {}),
    ...(overrides.schedule ? { schedule: overrides.schedule } : {}),
  });
  return { dispatcher, store, routes, deliveries };
}
