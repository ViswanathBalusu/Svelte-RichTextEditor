/**
 * The audit feed of a security tool: the trail read by polling `GET /audit` (13 §10, §12; UX-082;
 * owner decision 59: polling with a stated cadence, no new route). Like the other client state
 * machines it does no I/O. A driver asks `query()` for the next request, sends it with the
 * tenant's service credential, passes the page it gets to `receive()` and waits `cadenceMs` between
 * polls. `AuditFeedPoller` is a small driver over an injected `fetch` and timers.
 *
 * What the feed guarantees, and what it asks of the service:
 * - Order. The service returns events by time, then identifier, so the events of one document
 *   come in the order they were recorded. An event recorded late with an earlier time than one
 *   already delivered (nodes' clocks differ a little) is delivered when it is read, after the
 *   later one, as long as it is within `overlapMs` of the newest event delivered.
 * - No gap. Each poll starts `overlapMs` before the newest event delivered (`from` is inclusive),
 *   so an event recorded late within that window is still read. The service gives no cursor at the
 *   end of the trail, so the position of a feed is its own: `position()` is a small value that a
 *   consumer saves and gives back to resume where it stopped.
 * - Deduplication. Every event has a stable identifier (UUID version 7). The feed keeps the
 *   identifiers it has delivered inside the window and delivers each one once, across polls and
 *   across a resume.
 *
 * The cadence and the overlap are settings, not measurements: the defaults below are proposed
 * (docs/adr/0432-w3-UX-082-audit-feed.md) and a consumer sets its own.
 */

/** The wait between two polls, in milliseconds (proposed default). */
export const AUDIT_FEED_CADENCE_MS = 5_000;
/** How far before the newest delivered event a poll starts, in milliseconds (proposed default). */
export const AUDIT_FEED_OVERLAP_MS = 60_000;
/** The page size of a poll: the most `GET /audit` allows. */
export const AUDIT_FEED_PAGE = 200;

/** An event as `GET /audit` returns it (07 §14; no content, no token). */
export interface AuditFeedEvent {
  id: string;
  document: string | null;
  actor: string;
  kind: string;
  scopes: string[];
  /** Server time, ISO 8601 in UTC. */
  at: string;
}

export interface AuditFeedPage {
  items: AuditFeedEvent[];
  nextCursor: string | null;
}

/** Where a feed stands: what a consumer saves, and gives back to resume. */
export interface AuditFeedPosition {
  /** The server time of the newest event delivered, in milliseconds since the epoch; null before the first. */
  newest: number | null;
  /** The identifiers delivered at or after `newest - overlapMs`, each with its time. */
  seen: Array<{ id: string; at: number }>;
}

export interface AuditFeedOptions {
  /** Only events of this document, actor or kind (the filters of `GET /audit`). */
  filter?: { document?: string; actor?: string; kind?: string };
  /** Where to resume; absent: from the start of the trail. */
  position?: AuditFeedPosition | null;
  overlapMs?: number;
  /** A page size from 1 to 200. */
  limit?: number;
}

function wholeNumber(name: string, v: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(v) || v < min || v > max)
    throw new RangeError(`${name} is a whole number from ${min} to ${max}`);
  return v;
}

export class AuditFeed {
  readonly #filter: NonNullable<AuditFeedOptions['filter']>;
  readonly #overlapMs: number;
  readonly #limit: number;
  #newest: number | null;
  readonly #seen = new Map<string, number>();
  /** The cursor of the next page of the poll in progress, and the `from` that poll started with. */
  #cursor: string | null = null;
  #from: number | null = null;

  constructor(opts: AuditFeedOptions = {}) {
    this.#filter = opts.filter ?? {};
    this.#overlapMs = wholeNumber('overlapMs', opts.overlapMs ?? AUDIT_FEED_OVERLAP_MS, 0);
    this.#limit = wholeNumber('limit', opts.limit ?? AUDIT_FEED_PAGE, 1, AUDIT_FEED_PAGE);
    this.#newest = opts.position?.newest ?? null;
    for (const s of opts.position?.seen ?? []) this.#seen.set(s.id, s.at);
  }

  /** The query string of the next request (without a leading `?`). */
  query(): string {
    if (this.#cursor === null)
      this.#from = this.#newest === null ? null : this.#newest - this.#overlapMs;
    const params = new URLSearchParams();
    for (const key of ['document', 'actor', 'kind'] as const) {
      const v = this.#filter[key];
      if (v !== undefined) params.set(key, v);
    }
    if (this.#from !== null) params.set('from', new Date(Math.max(0, this.#from)).toISOString());
    params.set('limit', String(this.#limit));
    if (this.#cursor !== null) params.set('cursor', this.#cursor);
    return params.toString();
  }

  /**
   * Takes a page. Returns the events not delivered before, in the order the service gave them, and
   * whether the poll goes on at once (the page was not the last).
   */
  receive(page: AuditFeedPage): { events: AuditFeedEvent[]; more: boolean } {
    const events: AuditFeedEvent[] = [];
    for (const e of page.items) {
      if (this.#seen.has(e.id)) continue;
      const at = Date.parse(e.at);
      if (!Number.isFinite(at)) continue;
      this.#seen.set(e.id, at);
      if (this.#newest === null || at > this.#newest) this.#newest = at;
      events.push(e);
    }
    this.#cursor = page.nextCursor;
    if (this.#cursor === null && this.#newest !== null) {
      const floor = this.#newest - this.#overlapMs;
      for (const [id, at] of this.#seen) if (at < floor) this.#seen.delete(id);
    }
    return { events, more: this.#cursor !== null };
  }

  /** Forgets a poll that failed part way, so the next request starts from the position again. */
  abandonPoll(): void {
    this.#cursor = null;
  }

  /** The position to save. */
  position(): AuditFeedPosition {
    return {
      newest: this.#newest,
      seen: [...this.#seen].map(([id, at]) => ({ id, at })),
    };
  }
}

// --- A driver over an injected `fetch` and timers -------------------------------------------------

/** The part of a `fetch` response the driver reads. */
export interface FeedResponse {
  status: number;
  json(): Promise<unknown>;
}

export type FeedFetch = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string> },
) => Promise<FeedResponse>;

export interface FeedTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AuditFeedPollerOptions extends AuditFeedOptions {
  /** The service address up to and including the version prefix, for example `https://host/v1`. */
  baseUrl: string;
  /** The tenant's service credential (an API key or a service JWT). A user token is refused. */
  credential: string;
  fetch: FeedFetch;
  timers: FeedTimers;
  cadenceMs?: number;
  /** Called with each batch of new events, in order. The next poll waits until it returns. */
  deliver(events: AuditFeedEvent[], position: AuditFeedPosition): void | Promise<void>;
  /** Called with a failed poll (a refusal or a network error); the feed polls again at its cadence. */
  failed?(error: Error): void;
}

export class AuditFeedPoller {
  readonly feed: AuditFeed;
  readonly #o: AuditFeedPollerOptions;
  readonly #cadenceMs: number;
  #timer: unknown = null;
  #running = false;

  constructor(opts: AuditFeedPollerOptions) {
    this.#o = opts;
    this.#cadenceMs = wholeNumber('cadenceMs', opts.cadenceMs ?? AUDIT_FEED_CADENCE_MS, 1);
    this.feed = new AuditFeed(opts);
  }

  /** One poll: every page until the last, delivering as it goes. Returns the events delivered. */
  async pollOnce(): Promise<number> {
    let delivered = 0;
    try {
      for (;;) {
        const res = await this.#o.fetch(`${this.#o.baseUrl}/audit?${this.feed.query()}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.#o.credential}`, Accept: 'application/json' },
        });
        if (res.status !== 200) throw new Error(`GET /audit answered ${res.status}`);
        const { events, more } = this.feed.receive((await res.json()) as AuditFeedPage);
        if (events.length > 0) {
          await this.#o.deliver(events, this.feed.position());
          delivered += events.length;
        }
        if (!more) return delivered;
      }
    } catch (e) {
      this.feed.abandonPoll();
      this.#o.failed?.(e instanceof Error ? e : new Error(String(e)));
      return delivered;
    }
  }

  /** Polls now and then every `cadenceMs`, until `stop()`. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = async (): Promise<void> => {
      await this.pollOnce();
      if (this.#running)
        this.#timer = this.#o.timers.setTimeout(() => void tick(), this.#cadenceMs);
    };
    void tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) this.#o.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }
}
