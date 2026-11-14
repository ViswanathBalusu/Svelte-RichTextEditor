/**
 * Admission control (04 §12; SYN-037; second review SR-K2, SR-M7).
 *
 * Before any other work on a commit, the room estimates its cost from the number of steps, the
 * rebase distance in steps and the serialised size, and charges it to the connection's budget and
 * the tenant's. A commit whose budget is spent is rejected with `rate_limited`, action `retry` and
 * a `retryAfterMs`. The charge covers steps 2 to 7 (deduplication, base, rebase, apply, invariants,
 * permissions), so it is taken whatever the outcome of those steps.
 *
 * Costs are in abstract units. Neither the formula nor any budget is calibrated: the spec gives
 * none, and SYN-038 measures them. A host that configures no admission control admits everything.
 */

/** What the estimate is made from: known before any work (04 §12). */
export interface CostInput {
  /** Steps in the commit. */
  steps: number;
  /** Steps accepted after the commit's base, which each of its steps is mapped through. */
  rebaseSteps: number;
  /** Serialised size of the commit in bytes. */
  bytes: number;
  /** Visibility classes the stored commit is projected for (ADR 0019; SR-M7); 1 without them. */
  fanOut: number;
}

/**
 * The default estimate: each step is mapped through every step since the base and applied once,
 * the result is checked in proportion to the commit's size, and every visibility class repeats the
 * outgoing work. Uncalibrated (SYN-038).
 */
export function defaultCost(c: CostInput): number {
  const steps = Math.max(0, c.steps);
  return (
    (steps * (1 + Math.max(0, c.rebaseSteps)) + Math.ceil(Math.max(0, c.bytes) / 1024)) *
    Math.max(1, c.fanOut)
  );
}

/** A budget the room charges. The host owns a tenant's budget and shares it between rooms. */
export interface Budget {
  /** Milliseconds until `units` may be spent; 0 when they may be spent now. */
  wait(units: number, now: number): number;
  /** Spends `units` (the balance may go below zero for one expensive commit). */
  charge(units: number, now: number): void;
}

export interface BucketConfig {
  /** Units the budget holds when full. */
  capacity: number;
  /** Units it regains per second. */
  refillPerSecond: number;
}

/**
 * A token bucket. A commit is admitted when the balance covers its cost, or the capacity for a
 * commit that costs more than the bucket holds, so that no commit is refused for ever; the balance
 * may then go negative and later commits wait for it to refill.
 */
export class TokenBucket implements Budget {
  private balance: number;
  private at: number;
  readonly config: BucketConfig;

  constructor(config: BucketConfig, now: number) {
    if (!(config.capacity > 0) || !(config.refillPerSecond > 0))
      throw new RangeError('a budget needs a positive capacity and refill rate');
    this.config = config;
    this.balance = config.capacity;
    this.at = now;
  }

  private refill(now: number): void {
    if (now > this.at) {
      this.balance = Math.min(
        this.config.capacity,
        this.balance + ((now - this.at) * this.config.refillPerSecond) / 1000,
      );
      this.at = now;
    }
  }

  available(now: number): number {
    this.refill(now);
    return this.balance;
  }

  wait(units: number, now: number): number {
    this.refill(now);
    const need = Math.min(units, this.config.capacity);
    if (this.balance >= need) return 0;
    return Math.ceil(((need - this.balance) * 1000) / this.config.refillPerSecond);
  }

  charge(units: number, now: number): void {
    this.refill(now);
    this.balance -= units;
  }
}

export interface AdmissionConfig {
  /** Each connection's budget (one per session, 05 §5.1). */
  connection: BucketConfig;
  /** The tenant's budget, shared by every room of the tenant on the process (06 §12, SR-K2). */
  tenant?: Budget;
  /** The estimate; `defaultCost` when absent. */
  cost?: (c: CostInput) => number;
  /** How many visibility classes a stored commit is projected for (SR-M7); 1 when absent. */
  fanOut?: () => number;
}

/** The room's side of admission control: a bucket per session and the shared tenant budget. */
export class Admission {
  private readonly config: AdmissionConfig;
  private readonly sessions = new Map<string, TokenBucket>();
  /** Estimated units charged, for the fuzzing report (SYN-049) and the calibration (SYN-038). */
  charged = 0;

  constructor(config: AdmissionConfig) {
    this.config = config;
  }

  estimate(c: Omit<CostInput, 'fanOut'>): number {
    const input: CostInput = { ...c, fanOut: this.config.fanOut?.() ?? 1 };
    return (this.config.cost ?? defaultCost)(input);
  }

  /**
   * Admits and charges a commit of `units` for a session, or returns the milliseconds to wait. The
   * longer of the two waits is returned, so that a retry after it can pass both budgets.
   */
  admit(session: string, units: number, now: number): number {
    let bucket = this.sessions.get(session);
    if (!bucket) {
      bucket = new TokenBucket(this.config.connection, now);
      this.sessions.set(session, bucket);
    }
    const wait = Math.max(bucket.wait(units, now), this.config.tenant?.wait(units, now) ?? 0);
    if (wait > 0) return wait;
    bucket.charge(units, now);
    this.config.tenant?.charge(units, now);
    this.charged += units;
    return 0;
  }
}
