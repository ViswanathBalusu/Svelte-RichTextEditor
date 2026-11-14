/**
 * The webhook receiver of the reference host (UX-098; 05 §7). It checks the Standard Webhooks
 * signature (headers `webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256 over
 * `id.timestamp.body`; a five-minute tolerance; two active secrets during rotation), drops a
 * delivery whose `webhook-id` it has already handled, and hands the event to a queue so that the
 * response is sent before any work (e-mail, storage) is done. Order is not assumed.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Standard Webhooks: a timestamp more than five minutes from the receiver's clock is refused. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Delivery retries run for up to 24 hours (05 §7). An identifier is remembered for that long plus
 * the tolerance, so that a retry of the last attempt is still recognised as a duplicate.
 */
export const DEDUPE_RETENTION_SECONDS = 24 * 3600 + WEBHOOK_TOLERANCE_SECONDS;

const SECRET_PREFIX = 'whsec_';

export type VerifyFailure =
  'missing-headers' | 'bad-timestamp' | 'stale-timestamp' | 'bad-signature' | 'no-secret';

export type VerifyResult =
  { ok: true; id: string; timestamp: number } | { ok: false; reason: VerifyFailure };

/** Decodes a Standard Webhooks secret (`whsec_` and base64 of the key bytes). */
export function decodeSecret(secret: string): Buffer {
  if (!secret.startsWith(SECRET_PREFIX)) throw new Error('webhook secret must start with whsec_');
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  if (key.length === 0) throw new Error('webhook secret has no key bytes');
  return key;
}

/** The signature of one delivery under one key, as the `v1,<base64>` form of the header. */
export function signatureFor(key: Buffer, id: string, timestamp: string, body: string): string {
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest();
  return `v1,${mac.toString('base64')}`;
}

/**
 * Verifies one delivery. `secrets` holds every active secret (two during a rotation); a delivery
 * signed by any of them is accepted. `nowSeconds` is the receiver's clock in Unix seconds.
 */
export function verifyWebhook(input: {
  headers: Headers;
  body: string;
  secrets: readonly string[];
  nowSeconds: number;
}): VerifyResult {
  const id = input.headers.get('webhook-id');
  const timestamp = input.headers.get('webhook-timestamp');
  const signature = input.headers.get('webhook-signature');
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing-headers' };
  if (!/^\d{1,15}$/.test(timestamp)) return { ok: false, reason: 'bad-timestamp' };
  const sent = Number(timestamp);
  if (Math.abs(input.nowSeconds - sent) > WEBHOOK_TOLERANCE_SECONDS)
    return { ok: false, reason: 'stale-timestamp' };
  if (input.secrets.length === 0) return { ok: false, reason: 'no-secret' };

  // The header may carry several space-separated signatures (one per secret during rotation).
  const presented = signature.split(' ').filter((s) => s.startsWith('v1,'));
  for (const secret of input.secrets) {
    const expected = Buffer.from(signatureFor(decodeSecret(secret), id, timestamp, input.body));
    for (const candidate of presented) {
      const got = Buffer.from(candidate, 'utf8');
      if (got.length === expected.length && timingSafeEqual(got, expected))
        return { ok: true, id, timestamp: sent };
    }
  }
  return { ok: false, reason: 'bad-signature' };
}

/** Remembers the identifiers of deliveries already handled. */
export interface SeenStore {
  has(id: string): boolean;
  add(id: string, atSeconds: number): void;
  /** Forgets identifiers older than the retention window. */
  prune(nowSeconds: number): void;
}

export class MemorySeenStore implements SeenStore {
  readonly #seen = new Map<string, number>();

  has(id: string): boolean {
    return this.#seen.has(id);
  }

  add(id: string, atSeconds: number): void {
    this.#seen.set(id, atSeconds);
  }

  prune(nowSeconds: number): void {
    for (const [id, at] of this.#seen)
      if (nowSeconds - at > DEDUPE_RETENTION_SECONDS) this.#seen.delete(id);
  }

  get size(): number {
    return this.#seen.size;
  }
}

/** A verified event as the receiver passes it on. The body is parsed but not interpreted. */
export interface ReceivedEvent {
  webhookId: string;
  type: string;
  /** The document identifier. Null only for the dispatcher's test ping, which names no document. */
  subject: string | null;
  /** True for the dispatcher's test ping (`test: true` in the body); nothing is done for it. */
  test: boolean;
  body: Record<string, unknown>;
}

export type ReceiveOutcome =
  { status: 202; duplicate: boolean } | { status: 400 | 401; reason: string };

/**
 * The receiver. `receive` verifies, deduplicates and enqueues, then returns: the caller answers the
 * dispatcher with the outcome, and the queue does the work later. A delivery is remembered only
 * after it was queued, so a delivery that failed to queue is retried by the dispatcher.
 */
export class WebhookReceiver {
  readonly #secrets: () => readonly string[];
  readonly #seen: SeenStore;
  readonly #queue: { push(event: ReceivedEvent): void };
  readonly #now: () => number;

  constructor(opts: {
    /** Read on every delivery, so that a rotation takes effect without a restart. */
    secrets: () => readonly string[];
    seen: SeenStore;
    queue: { push(event: ReceivedEvent): void };
    now?: () => number;
  }) {
    this.#secrets = opts.secrets;
    this.#seen = opts.seen;
    this.#queue = opts.queue;
    this.#now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  receive(headers: Headers, body: string): ReceiveOutcome {
    const now = this.#now();
    const verified = verifyWebhook({ headers, body, secrets: this.#secrets(), nowSeconds: now });
    if (!verified.ok) {
      const unauthorised = verified.reason === 'bad-signature' || verified.reason === 'no-secret';
      return { status: unauthorised ? 401 : 400, reason: verified.reason };
    }
    this.#seen.prune(now);
    if (this.#seen.has(verified.id)) return { status: 202, duplicate: true };

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { status: 400, reason: 'bad-json' };
    }
    if (!isEventBody(parsed)) return { status: 400, reason: 'bad-event' };

    this.#queue.push({
      webhookId: verified.id,
      type: parsed.type,
      subject: typeof parsed['subject'] === 'string' ? parsed['subject'] : null,
      test: parsed['test'] === true,
      body: parsed,
    });
    this.#seen.add(verified.id, now);
    return { status: 202, duplicate: false };
  }
}

/**
 * A CloudEvents body with a `type`. Every event carries a `subject` (the document); only the
 * dispatcher's test ping (`test: true`, webhook-dispatcher.ts) has none, and it is accepted so that
 * the ping is answered 2xx.
 */
function isEventBody(v: unknown): v is Record<string, unknown> & { type: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o['type'] !== 'string') return false;
  return typeof o['subject'] === 'string' || (o['subject'] === undefined && o['test'] === true);
}

/**
 * An in-process queue: `push` returns at once, and `drain` runs the handler for each queued event
 * in arrival order. A failing handler is recorded and does not stop the rest. A production host
 * would use a durable queue here.
 */
export class WorkQueue {
  readonly #items: ReceivedEvent[] = [];
  readonly #handler: (event: ReceivedEvent) => Promise<void>;
  readonly failures: Array<{ webhookId: string; error: unknown }> = [];

  constructor(handler: (event: ReceivedEvent) => Promise<void>) {
    this.#handler = handler;
  }

  push(event: ReceivedEvent): void {
    this.#items.push(event);
  }

  get pending(): number {
    return this.#items.length;
  }

  async drain(): Promise<void> {
    for (let next = this.#items.shift(); next; next = this.#items.shift()) {
      try {
        await this.#handler(next);
      } catch (error) {
        this.failures.push({ webhookId: next.webhookId, error });
      }
    }
  }
}
