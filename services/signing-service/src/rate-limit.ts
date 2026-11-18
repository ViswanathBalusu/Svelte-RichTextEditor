/**
 * A fixed-window rate limit per key (FRW-052 criterion 3). The limit and the window are required
 * settings: the specification gives no figures, so none is built in.
 */
export interface RateLimit {
  /** Requests allowed per window and key. */
  readonly limit: number;
  readonly windowMs: number;
}

export class FixedWindowLimiter {
  readonly #cfg: RateLimit;
  readonly #now: () => number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(cfg: RateLimit, now: () => number) {
    if (!Number.isInteger(cfg.limit) || cfg.limit < 1)
      throw new RangeError('rate limit: limit must be an integer of at least 1');
    if (!Number.isInteger(cfg.windowMs) || cfg.windowMs < 1)
      throw new RangeError('rate limit: windowMs must be an integer of at least 1');
    this.#cfg = cfg;
    this.#now = now;
  }

  /** Counts one request for `key`; false when the key is over its limit for the window. */
  take(key: string): boolean {
    const now = this.#now();
    const w = this.#windows.get(key);
    if (w === undefined || now - w.start >= this.#cfg.windowMs) {
      this.#windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.#cfg.limit) return false;
    w.count += 1;
    return true;
  }
}
