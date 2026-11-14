/**
 * Extension hooks stay off the typing path (UX-054; 13 §7.2, §9).
 *
 * - `notify` only enqueues. It never calls a hook, never waits for one and never throws, so a
 *   transaction returns as it would without extensions.
 * - Hooks run later, from `later` (the caller passes one that runs after the frame has painted;
 *   `afterPaint` is the browser's choice). Each hook is called with one event at a time per slot.
 * - The pending queue holds at most `capacity` events; when it is full the oldest is dropped and
 *   counted. The number of hooks awaiting a promise is capped at `maxInFlight`, so a hook that never
 *   resolves holds one slot and no more. Neither bound is in the spec: both are required options
 *   and the values are the caller's (ADR 0136 records the open question).
 * - A hook that throws, or whose promise rejects, is reported through `onError` and does not stop
 *   the queue. Nothing a hook returns can change the event or the keystroke (13 §7.2).
 */

export interface HookQueueOptions<E> {
  /** Receives one event. May return a promise; the queue waits for it only as a slot. */
  readonly handler: (event: E) => unknown;
  /** The most events held waiting for the handler. At least 1. */
  readonly capacity: number;
  /** The most handler calls awaiting a promise at once. At least 1. */
  readonly maxInFlight: number;
  /** Runs `run` later, after the current transaction has been painted. */
  readonly later: (run: () => void) => void;
  /** Called with what a handler threw or rejected with. Errors thrown here are ignored. */
  readonly onError: (error: unknown) => void;
}

export interface HookQueueStats {
  /** Events waiting for a handler call. */
  readonly pending: number;
  /** Handler calls whose promise has not settled. */
  readonly inFlight: number;
  /** Events removed because the queue was full. */
  readonly dropped: number;
  /** Handler calls that finished without an error (synchronously or on settling). */
  readonly delivered: number;
  /** Handler calls that threw or rejected. */
  readonly failed: number;
}

/** Runs `run` after the next paint: after the current frame's rendering, then a macrotask. */
export function afterPaint(run: () => void): void {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown })
    .requestAnimationFrame;
  if (typeof raf === 'function') raf(() => setTimeout(run, 0));
  else setTimeout(run, 0);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function assertBound(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a whole number of at least 1`);
}

export class HookQueue<E> {
  readonly #options: HookQueueOptions<E>;
  #pending: E[] = [];
  #inFlight = 0;
  #scheduled = false;
  #dropped = 0;
  #delivered = 0;
  #failed = 0;
  #destroyed = false;

  constructor(options: HookQueueOptions<E>) {
    assertBound('capacity', options.capacity);
    assertBound('maxInFlight', options.maxInFlight);
    this.#options = options;
  }

  /** Queues an event for the hook. Synchronous, bounded and never throws. */
  notify(event: E): void {
    if (this.#destroyed) return;
    if (this.#pending.length >= this.#options.capacity) {
      this.#pending.shift();
      this.#dropped++;
    }
    this.#pending.push(event);
    this.#schedule();
  }

  stats(): HookQueueStats {
    return {
      pending: this.#pending.length,
      inFlight: this.#inFlight,
      dropped: this.#dropped,
      delivered: this.#delivered,
      failed: this.#failed,
    };
  }

  /** Forgets pending events and ignores later ones; calls still awaiting a promise settle quietly. */
  destroy(): void {
    this.#destroyed = true;
    this.#pending = [];
  }

  #schedule(): void {
    if (this.#scheduled || this.#destroyed || this.#pending.length === 0) return;
    this.#scheduled = true;
    this.#options.later(() => {
      this.#scheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    while (
      !this.#destroyed &&
      this.#pending.length > 0 &&
      this.#inFlight < this.#options.maxInFlight
    ) {
      const event = this.#pending.shift() as E;
      this.#deliver(event);
    }
  }

  #deliver(event: E): void {
    let result: unknown;
    try {
      result = this.#options.handler(event);
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (!isThenable(result)) {
      this.#delivered++;
      return;
    }
    this.#inFlight++;
    Promise.resolve(result).then(
      () => {
        this.#delivered++;
        this.#settle();
      },
      (error: unknown) => {
        this.#fail(error);
        this.#settle();
      },
    );
  }

  #settle(): void {
    this.#inFlight--;
    this.#schedule();
  }

  #fail(error: unknown): void {
    this.#failed++;
    try {
      this.#options.onError(error);
    } catch {
      // A failing error sink must not stop the queue.
    }
  }
}

/**
 * What a hook receives when the document has changed: the core's `revision` after the change
 * (`CoreApi.revision`: any applied transaction, a permission change, a change of the open panel).
 * A hook reads anything else it needs from the document API; nothing it returns is used.
 */
export interface DocumentChangedEvent {
  readonly kind: 'changed';
  readonly revision: number;
}

/**
 * The hooks a host registers for its extensions (13 §7.1, §7.2), as the shell takes them. The
 * bounds have no value in the spec (ADR 0136): the host sets them.
 */
export interface ExtensionHooks {
  readonly handlers: ReadonlyArray<(event: DocumentChangedEvent) => unknown>;
  /** Per hook: the most events held waiting. At least 1. */
  readonly capacity: number;
  /** Per hook: the most calls awaiting a promise at once. At least 1. */
  readonly maxInFlight: number;
  /** Receives what a hook threw or rejected with. */
  readonly onError: (error: unknown) => void;
}

/** The read side of a core view, as `connectHooks` needs it. */
interface RevisionView {
  get(): number;
  subscribe(listener: () => void): () => void;
}

export interface ConnectedHooks {
  /** One entry per handler, in the order given. */
  stats(): HookQueueStats[];
  /** Stops listening and forgets pending events. */
  stop(): void;
}

/**
 * Feeds the hooks from the core's revision (UX-054). The subscriber only enqueues: one queue per
 * handler, so a slow hook never delays another, and each hook runs from `later`, after the paint.
 */
export function connectHooks(
  revision: RevisionView,
  hooks: ExtensionHooks,
  later: (run: () => void) => void = afterPaint,
): ConnectedHooks {
  const queues = hooks.handlers.map(
    (handler) =>
      new HookQueue<DocumentChangedEvent>({
        handler,
        capacity: hooks.capacity,
        maxInFlight: hooks.maxInFlight,
        later,
        onError: hooks.onError,
      }),
  );
  let last = revision.get();
  const unsubscribe = revision.subscribe(() => {
    const next = revision.get();
    if (next === last) return;
    last = next;
    const event: DocumentChangedEvent = Object.freeze({ kind: 'changed', revision: next });
    for (const queue of queues) queue.notify(event);
  });
  return {
    stats: () => queues.map((q) => q.stats()),
    stop: () => {
      unsubscribe();
      for (const queue of queues) queue.destroy();
    },
  };
}
