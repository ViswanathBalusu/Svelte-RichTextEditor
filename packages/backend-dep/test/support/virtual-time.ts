/**
 * Virtual time for backend-dep's lifecycle tests (PRO-014, PRO-019): timers armed through the
 * platform run only when a test advances the clock, and every timer delay and every random draw
 * is logged in order, so that a test can check the exact schedule of reconnections. Node.js test
 * support only: it runs the tests, it is not part of the package.
 */
import type { Platform } from '../../src/platform.ts';

/** One entry of the schedule: a timer armed with `ms`, or a jitter draw of `value`. */
export type ClockEvent = { kind: 'timer'; ms: number } | { kind: 'random'; value: number };

/** A seeded generator in [0, 1) (mulberry32), so that a failing seed can be replayed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lets pending promise continuations run. The network and the backend chain many of them. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 500; i++) await Promise.resolve();
}

const EPOCH_MS = 1_700_000_000_000;

interface Pending {
  id: number;
  at: number;
  fn: () => void;
}

export class VirtualClock {
  /** The schedule: every timer armed and every random draw, in order. */
  readonly log: ClockEvent[] = [];
  private t = 0;
  private seq = 0;
  private queue: Pending[] = [];
  private readonly rng: () => number;

  constructor(seed = 1) {
    this.rng = mulberry32(seed);
  }

  /** Milliseconds since the clock started. */
  get elapsed(): number {
    return this.t;
  }

  /** How many timers are armed. */
  get armed(): number {
    return this.queue.length;
  }

  /** The platform parts that a test passes to `createDepBackend({ platform })`. */
  platform(): Pick<Platform, 'setTimeout' | 'clearTimeout' | 'now' | 'random'> {
    return {
      setTimeout: (fn, ms) => this.arm(fn, ms),
      clearTimeout: (h) => this.disarm(h),
      now: () => EPOCH_MS + this.t,
      random: () => {
        const value = this.rng();
        this.log.push({ kind: 'random', value });
        return value;
      },
    };
  }

  /** Runs the next armed timer, moving the clock to its time. False when none is armed. */
  async runNext(): Promise<boolean> {
    await settle();
    const next = this.earliest(Infinity);
    if (!next) return false;
    this.queue = this.queue.filter((p) => p.id !== next.id);
    this.t = Math.max(this.t, next.at);
    next.fn();
    await settle();
    return true;
  }

  /** Runs every timer due within `ms`, then moves the clock to the end of that span. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await settle();
      const next = this.earliest(end);
      if (!next) break;
      this.queue = this.queue.filter((p) => p.id !== next.id);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    await settle();
    this.t = end;
  }

  private earliest(until: number): Pending | undefined {
    let best: Pending | undefined;
    for (const p of this.queue)
      if (
        p.at <= until &&
        (best === undefined || p.at < best.at || (p.at === best.at && p.id < best.id))
      )
        best = p;
    return best;
  }

  private arm(fn: () => void, ms: number): number {
    const id = ++this.seq;
    const delay = Math.max(0, ms);
    this.queue.push({ id, at: this.t + delay, fn });
    this.log.push({ kind: 'timer', ms: delay });
    return id;
  }

  private disarm(handle: unknown): void {
    const id = handle as number;
    this.queue = this.queue.filter((p) => p.id !== id);
  }
}
