/**
 * Audit entries of the data plane (07 §14; BE-014, PRM-051): a commit rejected with
 * `permission_denied` or `invalid_op` is recorded with the actor (the per-tenant surrogate), the
 * document, the scopes and the server time, and nothing of the commit's content. Entries are
 * queued and written in batches, off the path of the rejection, and retried while the store fails,
 * so that a burst of rejections (which a throttled webhook may summarise, PRM-053) still leaves an
 * entry for each. The queue is bounded; an entry dropped from a full queue is counted.
 */
import { uuid7 } from '@docedit/model';
import type { AuditEvent, AuditStore } from '../storage/types.ts';

export class Auditor {
  readonly #store: AuditStore | undefined;
  readonly #onError: (e: unknown, where: string) => void;
  readonly #max: number;
  #queue: AuditEvent[] = [];
  #flushing: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #failures = 0;
  readonly stats = { written: 0, dropped: 0, failures: 0 };

  constructor(
    store: AuditStore | undefined,
    onError: (e: unknown, where: string) => void,
    max = 10_000,
  ) {
    this.#store = store;
    this.#onError = onError;
    this.#max = max;
  }

  get enabled(): boolean {
    return this.#store !== undefined;
  }

  get queued(): number {
    return this.#queue.length;
  }

  record(e: Omit<AuditEvent, 'id'>): void {
    if (!this.#store) return;
    if (this.#queue.length >= this.#max) {
      this.#queue.shift();
      this.stats.dropped++;
    }
    this.#queue.push({ id: uuid7(), ...e });
    this.#arm(0);
  }

  #arm(ms: number): void {
    if (this.#timer || this.#flushing) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, ms);
    this.#timer.unref?.();
  }

  /** Writes everything queued; resolves when the queue is empty or the store failed once. */
  flush(): Promise<void> {
    if (!this.#store) return Promise.resolve();
    this.#flushing ??= (async () => {
      try {
        while (this.#queue.length) {
          const batch = this.#queue.slice(0, 200);
          try {
            await this.#store!.record(batch);
          } catch (e) {
            this.#failures++;
            this.stats.failures++;
            this.#onError(e, 'audit');
            // Keep the entries; retry later with a growing delay (25 ms to 5 s).
            return;
          }
          this.#failures = 0;
          this.#queue = this.#queue.slice(batch.length);
          this.stats.written += batch.length;
        }
      } finally {
        this.#flushing = null;
        if (this.#queue.length)
          this.#arm(Math.min(5000, 25 * 2 ** Math.max(0, this.#failures - 1)));
      }
    })();
    return this.#flushing;
  }
}
