/**
 * Ordered delivery for a channel's callbacks (decision D21), shared by every backend so that they
 * all behave the same way:
 * - nothing is delivered synchronously: delivery runs in microtasks, and only once a callback is
 *   registered, so a caller that registers its callbacks right after `open()` resolves sees every
 *   message in arrival order;
 * - a message of a kind with no subscriber is kept and delivered, in arrival order, to the first
 *   subscriber of that kind;
 * - a settlement (resolving or rejecting a `submit()` promise) is ordered with the messages, and
 *   delivery yields one microtask after it, so code that awaits the promise directly runs before
 *   the next message.
 *
 * Universal: promises only, no timers.
 */
import type { Unsubscribe } from './types.ts';

type Item = { n: number; kind: string; value: unknown } | { n: number; settle: () => void };

export class OrderedDelivery {
  private queue: Item[] = [];
  private readonly backlog = new Map<string, Item[]>();
  private readonly subscribers = new Map<string, Set<(value: unknown) => void>>();
  private scheduled = false;
  private ended = false;
  private counter = 0;
  private readonly onError: (e: unknown) => void;

  /** `onError` receives what a callback throws; by default it surfaces as an unhandled rejection. */
  constructor(opts: { onError?: (e: unknown) => void } = {}) {
    this.onError =
      opts.onError ??
      ((e) => {
        void Promise.reject(e);
      });
  }

  /** Queues a message of `kind`. Ignored once the delivery has ended. */
  push(kind: string, value: unknown): void {
    if (this.ended) return;
    this.queue.push({ n: this.counter++, kind, value });
    this.schedule();
  }

  /** Queues a settlement, in order with the messages. Settlements run even after end(). */
  settle(fn: () => void): void {
    this.queue.push({ n: this.counter++, settle: fn });
    this.schedule(true);
  }

  /** Registers a callback for `kind`; messages kept for that kind are delivered to it, in order. */
  subscribe<T>(kind: string, cb: (value: T) => void): Unsubscribe {
    let set = this.subscribers.get(kind);
    if (!set) {
      set = new Set();
      this.subscribers.set(kind, set);
    }
    const fn = cb as (value: unknown) => void;
    set.add(fn);
    const held = this.backlog.get(kind);
    if (held?.length) {
      this.backlog.delete(kind);
      // Kept messages return to the queue in arrival order.
      this.queue = [...this.queue, ...held].sort((a, b) => a.n - b.n);
    }
    this.schedule();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      set.delete(fn);
    };
  }

  /**
   * Stops accepting messages. With `drop`, queued messages are discarded (settlements still run);
   * otherwise what is queued is still delivered. `last` is delivered after everything kept, for
   * example the final `closed` state of a channel.
   */
  end(opts: { drop?: boolean; last?: { kind: string; value: unknown } } = {}): void {
    if (this.ended) return;
    if (opts.drop) {
      this.queue = this.queue.filter((i) => 'settle' in i);
      this.backlog.clear();
    }
    if (opts.last) this.queue.push({ n: this.counter++, ...opts.last });
    this.ended = true;
    this.schedule(true);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private hasSubscribers(): boolean {
    for (const s of this.subscribers.values()) if (s.size) return true;
    return false;
  }

  /** Schedules a pump once someone listens; settlements are always pumped. */
  private schedule(force = false): void {
    if (this.scheduled || this.queue.length === 0) return;
    if (!force && !this.hasSubscribers()) return;
    this.scheduled = true;
    void Promise.resolve().then(() => this.pump());
  }

  private pump(): void {
    this.scheduled = false;
    const listening = this.hasSubscribers();
    while (this.queue.length) {
      const item = this.queue[0]!;
      if (!listening && !('settle' in item)) {
        // Nobody listens yet: wait for the first subscription, but let settlements behind run.
        const next = this.queue.findIndex((i) => 'settle' in i);
        if (next < 0) return;
        const [s] = this.queue.splice(next, 1);
        (s as { settle: () => void }).settle();
        if (this.queue.length) this.schedule(true);
        return;
      }
      this.queue.shift();
      if ('settle' in item) {
        item.settle();
        // Yield: the reactions to the settlement run before the next message (D21).
        if (this.queue.length) this.schedule(true);
        return;
      }
      const subs = this.subscribers.get(item.kind);
      if (!subs || subs.size === 0) {
        if (!this.ended) {
          const held = this.backlog.get(item.kind) ?? [];
          held.push(item);
          this.backlog.set(item.kind, held);
        }
        continue;
      }
      for (const cb of [...subs]) {
        try {
          cb(item.value);
        } catch (e) {
          // Report a subscriber's error without breaking delivery to the others.
          this.onError(e);
        }
      }
    }
  }
}
