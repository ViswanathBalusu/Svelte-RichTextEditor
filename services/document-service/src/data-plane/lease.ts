/**
 * The node lease (06 §2.1, §8; BE-018). A node may own rooms only while it holds a liveness lease,
 * which it renews every few seconds. The database judges expiry by its own clock; the node proves
 * its lease with its own monotonic clock, from the moment it sent the renewal that succeeded, less
 * a margin for drift. It never compares its wall clock with the database's, so a stepped system
 * clock changes nothing (criterion 4).
 *
 * A node that cannot prove its lease stops serving all its rooms, including rooms with only
 * viewers, which would otherwise never notice that another node took the document (06 §8: "A host
 * is partitioned and serves only viewers"). It refuses new channels until a renewal succeeds.
 */
import type { NodeLeaseStore } from '../storage/types.ts';
import type { LeaseSettings } from './settings.ts';

export interface NodeLeaseOptions {
  store: NodeLeaseStore;
  node: string;
  /** The WebSocket address the node announces on its lease row (BE-061), or none. */
  address?: string | undefined;
  settings: LeaseSettings;
  /** Milliseconds from a monotonic clock (default `performance.now`). */
  monotonic?: () => number;
  /** The lease can no longer be proved: stop every room. */
  onLost: (why: string) => void;
  onError: (error: unknown, where: string) => void;
}

export class NodeLease {
  readonly #o: NodeLeaseOptions;
  readonly #mono: () => number;
  /** Monotonic time until which the lease is proved. */
  #validUntil = Number.NEGATIVE_INFINITY;
  #renewTimer: ReturnType<typeof setTimeout> | null = null;
  #checkTimer: ReturnType<typeof setInterval> | null = null;
  #lost = true;
  #stopped = false;
  #renewing: Promise<boolean> | null = null;
  /** Counters for tests and metrics. */
  readonly stats = { renewed: 0, failed: 0, lost: 0 };

  constructor(o: NodeLeaseOptions) {
    this.#o = o;
    this.#mono = o.monotonic ?? (() => performance.now());
  }

  /** Whether the node can prove its lease now. */
  get proven(): boolean {
    return !this.#stopped && this.#mono() < this.#validUntil;
  }

  /** Milliseconds of validity left, for tests and metrics (negative when not proved). */
  get remainingMs(): number {
    return this.#validUntil - this.#mono();
  }

  /** Takes the lease (resolves false when the first renewal failed) and keeps renewing it. */
  async start(): Promise<boolean> {
    const ok = await this.renew();
    const every = Math.max(50, Math.floor(Math.min(this.#o.settings.renewMs, 1000) / 2));
    this.#checkTimer = setInterval(() => this.check(), every);
    this.#checkTimer.unref?.();
    return ok;
  }

  /** One renewal now; resolves whether it succeeded. Renewals never overlap. */
  renew(): Promise<boolean> {
    if (this.#stopped) return Promise.resolve(false);
    this.#renewing ??= (async () => {
      const sent = this.#mono();
      try {
        const { store, node, address, settings } = this.#o;
        if (address === undefined) await store.renew(node, settings.durationMs);
        else await store.renew(node, settings.durationMs, address);
        this.stats.renewed++;
        this.#validUntil = sent + this.#o.settings.durationMs - this.#o.settings.marginMs;
        this.#lost = false;
        return true;
      } catch (e) {
        this.stats.failed++;
        this.#o.onError(e, 'node lease');
        return false;
      } finally {
        this.#renewing = null;
        this.#schedule();
        this.check();
      }
    })();
    return this.#renewing;
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#renewTimer) clearTimeout(this.#renewTimer);
    this.#renewTimer = setTimeout(() => void this.renew(), this.#o.settings.renewMs);
    this.#renewTimer.unref?.();
  }

  /** Stops the rooms when the lease can no longer be proved (called by a timer, and by tests). */
  check(): void {
    if (this.#stopped || this.#lost || this.proven) return;
    this.#lost = true;
    this.stats.lost++;
    this.#o.onLost('the node lease could not be proved');
  }

  /** Stops renewing; with `release`, ends the lease so that other nodes need not wait for it. */
  async stop(release: boolean): Promise<void> {
    this.#stopped = true;
    if (this.#renewTimer) clearTimeout(this.#renewTimer);
    if (this.#checkTimer) clearInterval(this.#checkTimer);
    this.#renewTimer = this.#checkTimer = null;
    await this.#renewing?.catch(() => false);
    if (release)
      await this.#o.store.release(this.#o.node).catch((e: unknown) => this.#o.onError(e, 'lease'));
  }
}
