/**
 * The webhook dispatcher (05 §7; 06 §1; 10 §3.2, §3.7; BE-055, BE-057). It turns each event a
 * subscription matches into a delivery row, sends it through the egress transport (BE-056), and
 * signs it with the subscription's active secrets (PRO-070).
 *
 * - Fan-out: one row per matching subscription; the event is the same body for each, and each
 *   row has its own message identifier (`webhook-id`). Sends run concurrently, so a slow or failing
 *   target does not hold back the others (BE-055 criterion 3).
 * - Throttle: `dep.commit.rejected.v1` is admitted at most `max` times per `windowMs` per tenant;
 *   the rest are counted in the log and not raised. The rate is an input with no default (the spec
 *   gives none). `dep.document.changed.v1` is debounced by `DocumentChangeDebounce` (event-throttle.ts),
 *   which the composition puts in front of this dispatcher as its sink.
 * - Replay: a recent delivery is sent again with its own `webhook-id`; the timestamp is new, so
 *   that the receiver's five-minute tolerance is kept.
 * - Test ping: a message marked `test: true`, signed and sent the same way. Its event name is not in
 *   the published catalogue (a gap, see the story Notes), so `dep.webhook.test.v1` is a placeholder.
 * - Filters: a subscription receives only the event names it lists (BE-057 criterion 5).
 * - Logs: identifiers, event names and status only. A body and a secret never reach the log.
 *
 * - Retries (PRO-071): when a `retry` policy is given, a transient failure (a timeout, a transport
 *   error, an unresolved name, or a non-2xx answer) is sent again under the same `webhook-id`, after
 *   `baseMs * factor^(attempt - 1)`, until the next send would fall more than 24 hours after the row
 *   was created; then the row is abandoned (state `failed`). A refusal by the egress policy is not
 *   retried. The base delay and the factor are not stated by the spec: the caller supplies them.
 *
 * Persistence: the delivery rows sit behind `DeliveryStore`; only the in-memory store is built. A
 * PostgreSQL table for deliveries is not built. No composition passes a retry policy yet, so the
 * running service does not retry. This module is universal in spirit but uses `node:crypto` through
 * `webhook-signing.ts` and `webhook-envelope.ts`.
 */
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import type { DepEvent, EventSink } from './events.ts';
import { toCloudEvent } from './webhook-envelope.ts';
import { signDelivery } from './webhook-signing.ts';
import type { SubscriptionRecord, SubscriptionStore } from './webhook-subscriptions.ts';
import type { Transport } from './webhook-egress.ts';
import { ApiError } from './problems.ts';

export const COMMIT_REJECTED = 'dep.commit.rejected.v1';
export const TEST_EVENT = 'dep.webhook.test.v1';
export const CLOUDEVENTS_JSON = 'application/cloudevents+json';

export type DeliveryState = 'pending' | 'delivered' | 'failed';

export interface DeliveryRow {
  /** The delivery identifier (a row). */
  id: string;
  /** `webhook-id`: the same on every send of this row, retries and replays included (PRO-071). */
  messageId: string;
  tenant: string;
  subscription: string;
  eventType: string;
  /** The CloudEvents `id` of the event, or a fresh id for a test ping. */
  eventId: string;
  /** The exact body sent. Kept for replay; never written to the log. */
  body: string;
  test: boolean;
  state: DeliveryState;
  attempts: number;
  lastStatus: number | null;
  /** A refusal or failure reason (identifiers only), or null after a success. */
  lastReason: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryStore {
  insert(row: DeliveryRow): Promise<void>;
  get(id: string): Promise<DeliveryRow | null>;
  update(row: DeliveryRow): Promise<void>;
  /** The rows of one subscription, oldest first. Every row is kept (the replay window is not stated). */
  ofSubscription(tenant: string, subscription: string): Promise<DeliveryRow[]>;
}

/** An in-process store of delivery rows, for tests and for a deployment without PostgreSQL. */
export class MemoryDeliveryStore implements DeliveryStore {
  readonly #rows = new Map<string, DeliveryRow>();

  insert(row: DeliveryRow): Promise<void> {
    if (this.#rows.has(row.id))
      return Promise.reject(new Error('a delivery identifier is used once'));
    this.#rows.set(row.id, structuredClone(row));
    return Promise.resolve();
  }

  get(id: string): Promise<DeliveryRow | null> {
    const row = this.#rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : null);
  }

  update(row: DeliveryRow): Promise<void> {
    if (!this.#rows.has(row.id)) return Promise.reject(new Error('no such delivery'));
    this.#rows.set(row.id, structuredClone(row));
    return Promise.resolve();
  }

  ofSubscription(tenant: string, subscription: string): Promise<DeliveryRow[]> {
    const out: DeliveryRow[] = [];
    for (const row of this.#rows.values()) {
      if (row.tenant === tenant && row.subscription === subscription)
        out.push(structuredClone(row));
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return Promise.resolve(out);
  }
}

export interface ThrottlePolicy {
  windowMs: number;
  max: number;
}

/** The window in which a delivery is retried: "up to 24 hours" (05 §7, PRO-071). */
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The retry schedule (PRO-071). The base delay and the factor are not stated by the spec. */
export interface RetryPolicy {
  /** The delay before the first retry, in milliseconds. A positive number. */
  baseMs: number;
  /** The growth of the delay per attempt. At least 1. */
  factor: number;
  /** The last send must fall no later than this many milliseconds after the row was created. */
  maxAgeMs: number;
}

/** Failures worth another send. A refusal by the egress policy is not one of them. */
const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  'timeout',
  'transport_error',
  'unresolved',
]);

export type DispatcherLogEntry =
  | { event: 'raised'; eventType: string; deliveries: number }
  | { event: 'suppressed'; eventType: string; reason: 'throttled' }
  | { event: 'envelope_refused'; eventType: string; reason: 'envelope' }
  | {
      event: 'attempt';
      delivery: string;
      subscription: string;
      eventType: string;
      status: number | null;
      reason: string | null;
    }
  | { event: 'replay'; delivery: string; subscription: string; eventType: string }
  | { event: 'ping'; delivery: string; subscription: string };

export interface DispatcherDeps {
  subscriptions: SubscriptionStore;
  deliveries: DeliveryStore;
  /** The egress proxy (BE-056). The dispatcher has no other route to a target. */
  transport: Transport;
  /** The CloudEvents `source` of every body: a non-empty URI reference (a setting). */
  source: string;
  /** Server time in Unix milliseconds. */
  now: () => number;
  /** Admission of `dep.commit.rejected.v1`. Required: the rate is not given by the spec. */
  rejectedThrottle: ThrottlePolicy;
  log?: (entry: DispatcherLogEntry) => void;
  /** A new identifier for a delivery row. Defaults to a UUID version 7. */
  newId?: () => string;
  /** The retry schedule (PRO-071). Absent: a failed send is not retried. */
  retry?: RetryPolicy;
  /** Runs `run` after `delayMs`. Defaults to `setTimeout`, unreferenced so that it does not hold the process. */
  schedule?: (run: () => void, delayMs: number) => void;
}

/** A send's result as the row records it. */
function rowState(ok: boolean, status: number): DeliveryState {
  return ok && status >= 200 && status < 300 ? 'delivered' : 'failed';
}

export class WebhookDispatcher implements EventSink {
  readonly #subs: SubscriptionStore;
  readonly #rows: DeliveryStore;
  readonly #transport: Transport;
  readonly #source: string;
  readonly #now: () => number;
  readonly #throttle: ThrottlePolicy;
  readonly #log: (entry: DispatcherLogEntry) => void;
  readonly #newId: () => string;
  readonly #retry: RetryPolicy | undefined;
  readonly #schedule: (run: () => void, delayMs: number) => void;
  readonly #inflight = new Set<Promise<unknown>>();
  /** Times of admitted rejections per tenant, inside the window. */
  readonly #admitted = new Map<string, number[]>();

  constructor(deps: DispatcherDeps) {
    if (deps.source.length === 0) throw new RangeError('the source must not be empty');
    if (!Number.isFinite(deps.rejectedThrottle.windowMs) || deps.rejectedThrottle.windowMs <= 0)
      throw new RangeError('the rejection window must be positive');
    if (!Number.isSafeInteger(deps.rejectedThrottle.max) || deps.rejectedThrottle.max < 1)
      throw new RangeError('the rejection maximum is a positive integer');
    this.#subs = deps.subscriptions;
    this.#rows = deps.deliveries;
    this.#transport = deps.transport;
    this.#source = deps.source;
    this.#now = deps.now;
    this.#throttle = deps.rejectedThrottle;
    this.#log = deps.log ?? (() => undefined);
    this.#newId = deps.newId ?? (() => uuid7());
    if (deps.retry !== undefined) {
      const { baseMs, factor, maxAgeMs } = deps.retry;
      if (!Number.isFinite(baseMs) || baseMs <= 0)
        throw new RangeError('the retry base delay must be positive');
      if (!Number.isFinite(factor) || factor < 1)
        throw new RangeError('the retry factor must be at least 1');
      if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0)
        throw new RangeError('the retry window must be positive');
    }
    this.#retry = deps.retry;
    this.#schedule =
      deps.schedule ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        timer.unref();
      });
  }

  /** The EventSink face: the event is raised in the background; `drain` waits for it. */
  emit(event: DepEvent): void {
    this.#track(this.raise(event));
  }

  /** Creates one delivery row per matching subscription and starts its send. Resolves to the rows. */
  async raise(event: DepEvent): Promise<string[]> {
    if (event.type === COMMIT_REJECTED && !this.#admit(event.tenant)) {
      this.#log({ event: 'suppressed', eventType: event.type, reason: 'throttled' });
      return [];
    }
    let body: string;
    let eventId: string;
    try {
      const cloud = toCloudEvent(event, { source: this.#source });
      body = JSON.stringify(cloud);
      eventId = cloud.id;
    } catch {
      this.#log({ event: 'envelope_refused', eventType: event.type, reason: 'envelope' });
      return [];
    }
    const subs = (await this.#subs.list(event.tenant)).filter((s) => s.events.includes(event.type));
    const ids: string[] = [];
    for (const sub of subs) {
      const row = this.#newRow(sub.tenant, sub.id, event.type, eventId, body, false);
      await this.#rows.insert(row);
      ids.push(row.id);
      this.#track(this.#send(row.id));
    }
    this.#log({ event: 'raised', eventType: event.type, deliveries: ids.length });
    return ids;
  }

  /** A test ping to one subscription: signed and sent as a real delivery, marked `test`. */
  async ping(tenant: string, subscription: string): Promise<string> {
    const sub = await this.#subs.get(tenant, subscription);
    if (!sub) throw new ApiError('not_found', 'no such subscription');
    const eventId = randomUUID();
    const body = JSON.stringify({
      specversion: '1.0',
      id: eventId,
      source: this.#source,
      type: TEST_EVENT,
      time: new Date(this.#now()).toISOString(),
      datacontenttype: 'application/json',
      data: {},
      test: true,
    });
    const row = this.#newRow(tenant, subscription, TEST_EVENT, eventId, body, true);
    await this.#rows.insert(row);
    this.#log({ event: 'ping', delivery: row.id, subscription });
    await this.#send(row.id);
    return row.id;
  }

  /** Sends a recent delivery again under its own `webhook-id`. Resolves to the row after the send. */
  async replay(tenant: string, delivery: string): Promise<DeliveryRow> {
    const row = await this.#rows.get(delivery);
    if (!row || row.tenant !== tenant) throw new ApiError('not_found', 'no such delivery');
    this.#log({
      event: 'replay',
      delivery: row.id,
      subscription: row.subscription,
      eventType: row.eventType,
    });
    await this.#send(row.id);
    const after = await this.#rows.get(row.id);
    if (!after) throw new ApiError('not_found', 'no such delivery');
    return after;
  }

  /** Resolves when every send started so far has finished. */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.all([...this.#inflight]);
  }

  #newRow(
    tenant: string,
    subscription: string,
    eventType: string,
    eventId: string,
    body: string,
    test: boolean,
  ): DeliveryRow {
    const now = this.#now();
    return {
      id: this.#newId(),
      messageId: `msg_${this.#newId()}`,
      tenant,
      subscription,
      eventType,
      eventId,
      body,
      test,
      state: 'pending',
      attempts: 0,
      lastStatus: null,
      lastReason: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** One send of a row: signed with the subscription's current active secrets, then recorded. */
  async #send(id: string): Promise<void> {
    const row = await this.#rows.get(id);
    if (!row) return;
    const sub: SubscriptionRecord | null = await this.#subs.get(row.tenant, row.subscription);
    const now = this.#now();
    if (!sub) {
      await this.#record({
        ...row,
        state: 'failed',
        attempts: row.attempts + 1,
        lastStatus: null,
        lastReason: 'subscription_removed',
        updatedAt: now,
      });
      return;
    }
    const headers = signDelivery({
      id: row.messageId,
      timestamp: Math.floor(now / 1000),
      body: row.body,
      secrets: sub.secrets,
    });
    let result: Awaited<ReturnType<Transport['deliver']>>;
    try {
      result = await this.#transport.deliver({
        url: sub.url,
        headers: { ...headers, 'content-type': CLOUDEVENTS_JSON },
        body: row.body,
      });
    } catch {
      result = { ok: false, reason: 'transport_error' };
    }
    const status = result.ok ? result.status : null;
    const delivered = result.ok && rowState(true, result.status) === 'delivered';
    const transient = !delivered && (result.ok || TRANSIENT_REASONS.has(result.reason));
    const at = this.#now();
    const attempts = row.attempts + 1;
    const delay = transient ? this.#retryDelay(row.createdAt, attempts, at) : null;
    await this.#record({
      ...row,
      state: delivered ? 'delivered' : delay !== null ? 'pending' : 'failed',
      attempts,
      lastStatus: status,
      lastReason: result.ok ? null : result.reason,
      updatedAt: at,
    });
    // The retry keeps the row, so it keeps its `webhook-id` (PRO-071 criterion 2).
    if (delay !== null) this.#schedule(() => this.#track(this.#send(row.id)), delay);
  }

  /** The delay before the next send, or null when no retry is due: no policy, or the window would close. */
  #retryDelay(createdAt: number, attempts: number, at: number): number | null {
    if (this.#retry === undefined) return null;
    const delay = this.#retry.baseMs * this.#retry.factor ** (attempts - 1);
    return at + delay - createdAt > this.#retry.maxAgeMs ? null : delay;
  }

  async #record(row: DeliveryRow): Promise<void> {
    await this.#rows.update(row);
    this.#log({
      event: 'attempt',
      delivery: row.id,
      subscription: row.subscription,
      eventType: row.eventType,
      status: row.lastStatus,
      reason: row.lastReason,
    });
  }

  /** Sliding-window admission of rejections for one tenant. */
  #admit(tenant: string): boolean {
    const now = this.#now();
    const kept = (this.#admitted.get(tenant) ?? []).filter(
      (t) => now - t < this.#throttle.windowMs,
    );
    if (kept.length >= this.#throttle.max) {
      this.#admitted.set(tenant, kept);
      return false;
    }
    kept.push(now);
    this.#admitted.set(tenant, kept);
    return true;
  }

  #track(work: Promise<unknown>): void {
    const settled: Promise<unknown> = work
      .catch(() => undefined)
      .finally(() => {
        this.#inflight.delete(settled);
      });
    this.#inflight.add(settled);
  }
}
