/**
 * Export workers that follow the queue (BE-065; 06 §6, §8; 09 §9.5). A `WorkerPool` runs stateless
 * `JobRunner`s; an `Autoscaler` reads the queue depth of the kinds the pool serves and sets the
 * number of workers. The rules this module holds:
 *
 * - Workers are added while the backlog (queued and running jobs of the pool's kinds) rises, and
 *   the pool never goes above its maximum.
 * - A warm floor: the pool keeps at least `minWorkers` up, even when the queue is empty.
 * - A worker that is removed finishes the job it is running before it stops (`JobRunner.stop`
 *   waits for the running attempt; nothing is cancelled to make room).
 * - Priorities and tenant limits (BE-050) are not touched here: every worker claims through the
 *   same queue with the same `ClaimOptions`, so the claim rules are the queue's, unchanged.
 *
 * The policy holds no measured number. The caller sets the floor, the ceiling and how many jobs one
 * worker takes on; nothing here is a default for them.
 */
import type { JobHandler, JobHooks } from './runner.ts';
import { JobRunner } from './runner.ts';
import type { ClaimOptions, JobQueue } from './queue.ts';

export interface ScalePolicy {
  /** The warm floor: workers kept up when the queue is empty. Integer, zero or more. */
  readonly minWorkers: number;
  /** The most workers the pool may run. Integer, at least `minWorkers`. */
  readonly maxWorkers: number;
  /** Jobs one worker is expected to take on: the backlog per worker. Integer, at least one. */
  readonly jobsPerWorker: number;
}

function checkPolicy(p: ScalePolicy): void {
  const ints = [p.minWorkers, p.maxWorkers, p.jobsPerWorker];
  if (!ints.every((n) => Number.isSafeInteger(n))) throw new RangeError('policy needs integers');
  if (p.minWorkers < 0) throw new RangeError('minWorkers must be zero or more');
  if (p.maxWorkers < p.minWorkers) throw new RangeError('maxWorkers must be at least minWorkers');
  if (p.jobsPerWorker < 1) throw new RangeError('jobsPerWorker must be at least one');
}

/** The number of workers the backlog asks for, within the policy's floor and ceiling. */
export function desiredWorkers(backlog: number, policy: ScalePolicy): number {
  checkPolicy(policy);
  if (!Number.isSafeInteger(backlog) || backlog < 0)
    throw new RangeError('backlog must be a count of jobs');
  const wanted = Math.ceil(backlog / policy.jobsPerWorker);
  return Math.min(policy.maxWorkers, Math.max(policy.minWorkers, wanted));
}

export interface WorkerPoolOptions {
  queue: JobQueue;
  handlers: Readonly<Record<string, JobHandler>>;
  /** The kinds the pool's workers claim, in any order: the queue serves them by priority. */
  kinds?: readonly string[];
  /** A prefix for the workers' identifiers, recorded as `locked_by`. */
  name: string;
  leaseMs: number;
  idleMs: number;
  retryAfterMs: number;
  /** Jobs each worker runs at once (default 1). */
  concurrency?: number;
  /** The claim options of every worker: tenant limits (EXP-007 criterion 3). */
  claim?: ClaimOptions;
  hooks?: JobHooks;
  onError?: (error: unknown) => void;
}

/** A set of stateless job workers whose size can be changed while they run. */
export class WorkerPool {
  readonly #o: WorkerPoolOptions;
  readonly #runners: JobRunner[] = [];
  #issued = 0;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(options: WorkerPoolOptions) {
    this.#o = options;
  }

  /** The number of workers running now. */
  get size(): number {
    return this.#runners.length;
  }

  /** The kinds the workers claim. */
  get kinds(): readonly string[] {
    return this.#o.kinds ?? Object.keys(this.#o.handlers);
  }

  /**
   * Sets the number of workers, adding them at once and stopping the extra ones after their running
   * job ends. Changes are applied one after another. Resolves with the size reached.
   */
  scaleTo(n: number): Promise<number> {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('a pool size is a count');
    const next = this.#chain.then(() => this.#scale(n));
    this.#chain = next.catch(() => undefined);
    return next;
  }

  async #scale(n: number): Promise<number> {
    while (this.#runners.length < n) {
      const worker = `${this.#o.name}-${++this.#issued}`;
      const runner = new JobRunner({
        queue: this.#o.queue,
        handlers: this.#o.handlers,
        ...(this.#o.kinds ? { kinds: this.#o.kinds } : {}),
        worker,
        leaseMs: this.#o.leaseMs,
        idleMs: this.#o.idleMs,
        retryAfterMs: this.#o.retryAfterMs,
        ...(this.#o.concurrency !== undefined ? { concurrency: this.#o.concurrency } : {}),
        ...(this.#o.claim ? { claim: this.#o.claim } : {}),
        ...(this.#o.hooks ? { hooks: this.#o.hooks } : {}),
        onError: (e) => this.#o.onError?.(e),
      });
      runner.start();
      this.#runners.push(runner);
    }
    while (this.#runners.length > n) {
      const runner = this.#runners.pop()!;
      // Waits for the attempt in progress to end; nothing is cancelled.
      await runner.stop();
    }
    return this.#runners.length;
  }

  /** Stops every worker, each after its running job. */
  async stop(): Promise<void> {
    await this.scaleTo(0);
  }
}

export interface AutoscalerOptions {
  queue: JobQueue;
  pool: WorkerPool;
  policy: ScalePolicy;
  /** The kinds whose backlog counts; default the pool's kinds. */
  kinds?: readonly string[];
}

export interface ScaleStep {
  /** Queued and running jobs of the counted kinds. */
  readonly backlog: number;
  /** The workers the pool was asked to run. */
  readonly wanted: number;
  /** The workers running after the step. */
  readonly workers: number;
}

/** Sets a pool's size from the queue depth, once per call to `tick`. */
export class Autoscaler {
  readonly #o: AutoscalerOptions;

  constructor(options: AutoscalerOptions) {
    checkPolicy(options.policy);
    this.#o = options;
  }

  async tick(): Promise<ScaleStep> {
    const kinds = new Set(this.#o.kinds ?? this.#o.pool.kinds);
    const depth = await this.#o.queue.depth();
    const backlog = depth
      .filter((d) => kinds.has(d.kind))
      .reduce((sum, d) => sum + d.queued + d.running, 0);
    const wanted = desiredWorkers(backlog, this.#o.policy);
    const workers = await this.#o.pool.scaleTo(wanted);
    return { backlog, wanted, workers };
  }
}
