/**
 * Runs jobs from a queue with the handler registered for their kind (BE-049 criterion 4). Each
 * claimed job is handled under the tenant of its row: the handler receives the record and must use
 * `job.tenant` for every storage call, never a tenant from the payload (BE-049 criterion 5).
 *
 * The compile worker registers the `export` and `preview` handlers and the asset worker the
 * `asset` handler; this module only dispatches. Phase 1b (ADR 0054): a runner serves the kinds of
 * its handlers, or the subset `kinds` names, so that previews and requested exports can have
 * workers of their own (EXP-007); it runs up to `concurrency` jobs at once; it claims under the
 * tenant limits of `claim` (EXP-007 criterion 3); and it reports progress and outcomes to hooks,
 * which the composition turns into notifications, webhooks and meters.
 */
import { parseTraceparent, type Tracer } from '../../data-plane/tracing.ts';
import type { ClaimOptions, Heartbeat, JobError, JobQueue, JobRecord } from './queue.ts';

export interface JobContext {
  /** Reports the stage and progress and renews the lock; `cancelled` or `lost` means stop. */
  report(stage?: string, progress?: number): Promise<Heartbeat>;
  /** Aborted when the job was cancelled or the lock was lost. */
  signal: AbortSignal;
}

/**
 * Thrown by a handler to fail the job; `retry` asks for another attempt. `result` is kept as the
 * failed job's result, for example the diagnostics of an export that did not compile (EXP-065).
 */
export class JobFailure extends Error {
  override name = 'JobFailure';
  readonly code: string;
  readonly retry: boolean;
  readonly result: Record<string, unknown> | undefined;
  constructor(code: string, message: string, retry = false, result?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.retry = retry;
    this.result = result;
  }
}

export type JobHandler = (job: JobRecord, ctx: JobContext) => Promise<Record<string, unknown>>;

/** How a job ended for this worker. `lost`: cancelled, or another worker took it over. */
export type JobOutcome =
  | { state: 'completed'; result: Record<string, unknown> }
  | { state: 'failed'; error: JobError; retried: boolean }
  | { state: 'lost' };

export interface JobHooks {
  /** A handler reported a stage or progress (EXP-004 criterion 2: `export.progress`). */
  progress?(job: JobRecord, stage: string | undefined, progress: number | undefined): void;
  /** A job ended for this worker, with how long its handler ran, ms. */
  settled?(job: JobRecord, outcome: JobOutcome, ranMs: number): void;
}

export interface JobRunnerOptions {
  queue: JobQueue;
  handlers: Readonly<Record<string, JobHandler>>;
  /** The kinds this runner claims; default every kind with a handler. */
  kinds?: readonly string[];
  /** This worker's identifier, recorded in `locked_by`. */
  worker: string;
  /** How long a claim holds without a heartbeat, ms (setting; ADR 0036). */
  leaseMs: number;
  /** How long to wait after an empty claim, ms. */
  idleMs: number;
  /** Delay before a retried attempt, ms. */
  retryAfterMs: number;
  /** Jobs run at once (default 1). */
  concurrency?: number;
  /** Tenant limits of the claim (EXP-007 criterion 3). */
  claim?: ClaimOptions;
  hooks?: JobHooks;
  now?: () => number;
  onError?: (error: unknown, job: JobRecord) => void;
  /**
   * Records a `job.run` span for each job, under the trace its payload's `traceparent` names
   * (BE-087 criterion 4). Absent: no span.
   */
  tracer?: Tracer;
}

export class JobRunner {
  readonly #o: JobRunnerOptions;
  #running = false;
  #loops: Promise<void>[] = [];
  readonly #wakers = new Set<() => void>();

  constructor(opts: JobRunnerOptions) {
    this.#o = opts;
  }

  get kinds(): readonly string[] {
    return this.#o.kinds ?? Object.keys(this.#o.handlers);
  }

  /** Claims and runs one job; false when none was ready. */
  async runOnce(): Promise<boolean> {
    const { queue, handlers, worker, leaseMs, hooks } = this.#o;
    const now = this.#o.now ?? Date.now;
    const kinds = this.kinds.filter((k) => handlers[k]);
    if (kinds.length === 0) return false;
    const job = await queue.claim(kinds, worker, leaseMs, this.#o.claim);
    if (!job) return false;
    const handler = handlers[job.kind]!;
    const ref = { tenant: job.tenant, id: job.id };
    const abort = new AbortController();
    const ctx: JobContext = {
      signal: abort.signal,
      async report(stage, progress) {
        const r = await queue.heartbeat(ref, worker, leaseMs, {
          ...(stage !== undefined ? { stage } : {}),
          ...(progress !== undefined ? { progress } : {}),
        });
        if (r !== 'ok') abort.abort();
        else if (stage !== undefined || progress !== undefined)
          hooks?.progress?.(job, stage, progress);
        return r;
      },
    };
    // Keep the lock while the handler works, so that a slow job is not taken by another worker.
    const beat = setInterval(
      () => {
        void ctx.report().catch(() => undefined);
      },
      Math.max(10, Math.floor(leaseMs / 3)),
    );
    const started = now();
    const span = this.#o.tracer?.start('job.run', parseTraceparent(job.payload['traceparent']), {
      tenant: job.tenant,
      kind: job.kind,
      job: job.id,
    });
    let outcome: JobOutcome = { state: 'lost' };
    try {
      const result = await handler(job, ctx);
      if (!abort.signal.aborted && (await queue.complete(ref, worker, result)))
        outcome = { state: 'completed', result };
    } catch (e) {
      if (!abort.signal.aborted) {
        const failure: JobError =
          e instanceof JobFailure
            ? { code: e.code, message: e.message }
            : { code: 'internal', message: 'the job failed' };
        const retry = e instanceof JobFailure ? e.retry : true;
        const retried = retry && job.attempts < job.maxAttempts;
        if (
          await queue.fail(
            ref,
            worker,
            failure,
            retry ? this.#o.retryAfterMs : undefined,
            e instanceof JobFailure ? e.result : undefined,
          )
        )
          outcome = { state: 'failed', error: failure, retried };
      }
      this.#o.onError?.(e, job);
    } finally {
      clearInterval(beat);
      span?.end({ state: outcome.state });
    }
    try {
      hooks?.settled?.(job, outcome, now() - started);
    } catch (e) {
      this.#o.onError?.(e, job);
    }
    return true;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const slots = Math.max(1, this.#o.concurrency ?? 1);
    for (let i = 0; i < slots; i++)
      this.#loops.push(
        (async () => {
          while (this.#running) {
            const worked = await this.runOnce().catch(() => false);
            if (!worked && this.#running)
              await new Promise<void>((resolve) => {
                const wake = () => {
                  clearTimeout(t);
                  this.#wakers.delete(wake);
                  resolve();
                };
                const t = setTimeout(wake, this.#o.idleMs);
                this.#wakers.add(wake);
              });
          }
        })(),
      );
  }

  /** Wakes idle loops, for example right after a job was enqueued. */
  poke(): void {
    for (const w of [...this.#wakers]) w();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.poke();
    await Promise.all(this.#loops);
    this.#loops = [];
  }
}
