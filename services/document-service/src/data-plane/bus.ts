/**
 * The internal bus between nodes (BE-059 decision: Valkey streams; BE-063; BE-062).
 *
 * The bus carries announcements and forwarded channels, never state of record. A commit, a grant,
 * a node lease and the owner of a document live in PostgreSQL; a message on the bus may be lost, and
 * the service stays correct (06 §4.3, §8):
 *
 * - `publish` is best effort. It never throws; it answers whether the message was handed to the bus.
 *   A node that cannot reach the bus goes on serving the rooms it owns.
 * - Within one topic, messages arrive in the order they were published (a Valkey stream is ordered).
 *   Nothing is promised across topics, and a message may be lost: the stream of a forwarded channel
 *   numbers its own frames and repairs or closes on a gap (`channel-forward.ts`).
 * - A subscriber hears only what is published after `subscribe` resolved.
 *
 * `MemoryBus` joins nodes of one process, for tests, with faults that a test sets. `ValkeyBus` is
 * the adapter for Valkey streams (`valkey-bus.ts`). A different bus, such as NATS, is one more
 * adapter behind this interface (ADR 0243, "Internal bus").
 */

/** One message as a subscriber sees it. */
export interface BusMessage {
  /** The node that published it. */
  readonly from: string;
  readonly body: string;
}

export type BusHandler = (m: BusMessage) => void;

export interface Subscription {
  /** Stops delivery to this handler. */
  close(): void;
}

export interface BusStats {
  published: number;
  /** Messages that could not be handed to the bus (it was down, or a fault dropped them). */
  failed: number;
  received: number;
}

export interface Bus {
  /** The node that owns this end of the bus. */
  readonly node: string;
  readonly stats: BusStats;
  /** Hands `body` to the bus for `topic`. Never throws; false when it could not be sent. */
  publish(topic: string, body: string): Promise<boolean>;
  /** Delivers what is published to `topic` from now on. Resolves once that holds. */
  subscribe(topic: string, on: BusHandler): Promise<Subscription>;
  close(): Promise<void>;
}

/** A source of numbers in [0, 1), so that a test's faults are repeatable. */
export type Random = () => number;

/** Faults a test sets on the network of a `MemoryBus`. */
export interface BusFaults {
  /** The bus is unreachable: publishes fail and nothing is delivered. */
  down: boolean;
  /** The share of messages dropped, in [0, 1]. */
  drop: number;
  /** The most milliseconds a message is delayed; order within a topic is kept. */
  delayMs: number;
}

/** The network that `MemoryBus` ends join; one per test. */
export class MemoryBusNetwork {
  readonly faults: BusFaults = { down: false, drop: 0, delayMs: 0 };
  readonly #topics = new Map<string, Set<{ bus: MemoryBus; on: BusHandler }>>();
  /** The time before which the next message of a topic may arrive: keeps the topic in order. */
  readonly #tails = new Map<string, number>();
  readonly #random: Random;

  constructor(random: Random = Math.random) {
    this.#random = random;
  }

  /** The end of the bus for `node`. */
  connect(node: string): MemoryBus {
    return new MemoryBus(node, this);
  }

  /** @internal */
  subscribe(topic: string, bus: MemoryBus, on: BusHandler): Subscription {
    let set = this.#topics.get(topic);
    if (!set) this.#topics.set(topic, (set = new Set()));
    const entry = { bus, on };
    set.add(entry);
    return { close: () => void set.delete(entry) };
  }

  /** @internal */
  send(topic: string, from: string, body: string): boolean {
    const f = this.faults;
    if (f.down || this.#random() < f.drop) return false;
    const now = Date.now();
    const wait = f.delayMs > 0 ? Math.floor(this.#random() * f.delayMs) : 0;
    const at = Math.max(now + wait, this.#tails.get(topic) ?? 0);
    this.#tails.set(topic, at);
    const targets = [...(this.#topics.get(topic) ?? [])];
    const deliver = (): void => {
      if (this.faults.down) return;
      for (const t of targets) {
        if (t.bus.closed) continue;
        t.bus.stats.received++;
        t.on({ from, body });
      }
    };
    if (at <= now) queueMicrotask(deliver);
    else setTimeout(deliver, at - now);
    return true;
  }
}

export class MemoryBus implements Bus {
  readonly node: string;
  readonly stats: BusStats = { published: 0, failed: 0, received: 0 };
  readonly #net: MemoryBusNetwork;
  #closed = false;

  constructor(node: string, net: MemoryBusNetwork) {
    this.node = node;
    this.#net = net;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async publish(topic: string, body: string): Promise<boolean> {
    if (this.#closed) return false;
    const sent = this.#net.send(topic, this.node, body);
    if (sent) this.stats.published++;
    else this.stats.failed++;
    return sent;
  }

  async subscribe(topic: string, on: BusHandler): Promise<Subscription> {
    return this.#net.subscribe(topic, this, on);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
