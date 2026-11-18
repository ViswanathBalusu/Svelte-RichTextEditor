/**
 * The internal bus on Valkey streams (BE-063; owner decision 136: Valkey streams). One stream per
 * topic, `XADD` to publish and `XREAD BLOCK` to subscribe, over the RESP client of
 * `valkey-buckets.ts` (no new dependency).
 *
 * - The stream of a topic is ordered by the server, so a subscriber sees a topic's messages in the
 *   order they were published. Streams are capped (`MAXLEN ~`) and expire when idle, so a topic of
 *   a node that left does not stay for ever.
 * - Nothing here is state of record. If Valkey is flushed, a stream starts again; if it cannot be
 *   reached, `publish` answers false and the reader waits and tries again. A message published
 *   while a subscriber could not read is read when it can, unless the stream was trimmed or lost;
 *   consumers (channel forwarding) number their own frames and cope with either.
 * - A subscriber starts at the server's clock when `subscribe` resolved, so it hears what is
 *   published after that and nothing older.
 * - One reader connection serves every subscription of the node: it reads all subscribed streams in
 *   one `XREAD` of at most `blockMs`, so a new subscription is picked up within that time.
 */
import { parseValkeyUrl, ValkeyClient, type RespValue, type ValkeyUrl } from './valkey-buckets.ts';
import type { Bus, BusHandler, BusStats, Subscription } from './bus.ts';

export interface ValkeyBusOptions {
  readonly node: string;
  /** `redis://host:port` of the Valkey server. */
  readonly url: string;
  /** Prefix of every key; a deployment or a test run names its own. */
  readonly prefix?: string;
  /** Connect and command timeout in milliseconds (publishing). */
  readonly timeoutMs?: number;
  /** How long one read waits for news, in milliseconds. */
  readonly blockMs?: number;
  /** The most entries a stream keeps (approximate). */
  readonly maxLen?: number;
  /** Milliseconds after which an idle stream is deleted. */
  readonly idleExpiryMs?: number;
}

interface Topic {
  readonly key: string;
  readonly handlers: Set<BusHandler>;
  /** The id after which the next read starts. */
  after: string;
}

export class ValkeyBus implements Bus {
  readonly node: string;
  readonly stats: BusStats = { published: 0, failed: 0, received: 0 };
  /** Reads that failed; a test uses it to see the bus come back. */
  readFailures = 0;
  readonly #writer: ValkeyClient;
  readonly #reader: ValkeyClient;
  readonly #prefix: string;
  readonly #blockMs: number;
  readonly #maxLen: number;
  readonly #expiry: number;
  readonly #topics = new Map<string, Topic>();
  #loop: Promise<void> | null = null;
  #closed = false;

  constructor(o: ValkeyBusOptions) {
    const url: ValkeyUrl = parseValkeyUrl(o.url);
    const timeout = o.timeoutMs ?? 1000;
    this.node = o.node;
    this.#blockMs = o.blockMs ?? 250;
    this.#writer = new ValkeyClient(url, timeout);
    // A read may wait `blockMs` for an answer, so its timeout is longer than that.
    this.#reader = new ValkeyClient(url, this.#blockMs + timeout);
    this.#prefix = o.prefix ?? 'docedit:bus:';
    this.#maxLen = o.maxLen ?? 10_000;
    this.#expiry = o.idleExpiryMs ?? 10 * 60_000;
  }

  async publish(topic: string, body: string): Promise<boolean> {
    if (this.#closed) return false;
    const key = `${this.#prefix}${topic}`;
    try {
      await this.#writer.command(
        'XADD',
        key,
        'MAXLEN',
        '~',
        String(this.#maxLen),
        '*',
        'f',
        this.node,
        'b',
        body,
      );
      await this.#writer.command('PEXPIRE', key, String(this.#expiry));
      this.stats.published++;
      return true;
    } catch {
      this.stats.failed++;
      return false;
    }
  }

  async subscribe(topic: string, on: BusHandler): Promise<Subscription> {
    let t = this.#topics.get(topic);
    if (!t) {
      // The server's clock fixes where the stream is read from; a subscriber that cannot reach it
      // starts from the local clock, which is as good for a topic that is quiet when it joins.
      let ms = Date.now();
      try {
        const time = await this.#writer.command('TIME');
        if (Array.isArray(time)) ms = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
      } catch {
        // Keep the local time.
      }
      t = this.#topics.get(topic);
      if (!t) {
        t = { key: `${this.#prefix}${topic}`, handlers: new Set(), after: `${ms}-0` };
        this.#topics.set(topic, t);
      }
    }
    t.handlers.add(on);
    this.#loop ??= this.#run();
    const topicName = topic;
    return {
      close: () => {
        const held = this.#topics.get(topicName);
        held?.handlers.delete(on);
        if (held && held.handlers.size === 0) this.#topics.delete(topicName);
      },
    };
  }

  async #run(): Promise<void> {
    while (!this.#closed) {
      const topics = [...this.#topics.values()];
      if (topics.length === 0) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      try {
        const reply = await this.#reader.command(
          'XREAD',
          'COUNT',
          '200',
          'BLOCK',
          String(this.#blockMs),
          'STREAMS',
          ...topics.map((t) => t.key),
          ...topics.map((t) => t.after),
        );
        this.#deliver(topics, reply);
      } catch {
        this.readFailures++;
        if (!this.#closed) await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  #deliver(topics: readonly Topic[], reply: RespValue): void {
    if (!Array.isArray(reply)) return;
    const byKey = new Map(topics.map((t) => [t.key, t]));
    for (const stream of reply) {
      if (!Array.isArray(stream)) continue;
      const topic = byKey.get(String(stream[0]));
      const entries = stream[1];
      if (!topic || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!Array.isArray(entry)) continue;
        const id = String(entry[0]);
        const fields = Array.isArray(entry[1]) ? entry[1] : [];
        let from = '';
        let body = '';
        for (let i = 0; i + 1 < fields.length; i += 2) {
          if (fields[i] === 'f') from = String(fields[i + 1]);
          else if (fields[i] === 'b') body = String(fields[i + 1]);
        }
        topic.after = id;
        this.stats.received++;
        for (const h of [...topic.handlers]) {
          try {
            h({ from, body });
          } catch {
            // A handler's fault is its own; the stream goes on.
          }
        }
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#writer.close();
    this.#reader.close();
    await this.#loop?.catch(() => undefined);
  }
}
