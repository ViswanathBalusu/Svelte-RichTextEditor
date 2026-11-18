/**
 * Runs work once the document has been quiet for a moment (UX-066 criterion 5). The accessibility
 * checker reads the whole document, which is too much to do inside a keystroke. Each request
 * replaces the one before it, so a burst of changes costs one run, started after the burst and in
 * an idle period where the browser has one. `cancel` drops a run that has not started.
 */
export interface QuietScheduler {
  /** Asks for a run; a run still waiting is replaced. */
  request(run: () => void): void;
  /** Drops a run that has not started. */
  cancel(): void;
  /** True while a run is waiting. */
  readonly pending: boolean;
}

export interface QuietOptions {
  /** Milliseconds the document must stay quiet before the run starts. */
  quietMs: number;
  /** Starts the run in an idle period when the platform has one; absent means at once. */
  whenIdle?: ((start: () => void) => () => void) | undefined;
  /** The timer, for tests. */
  timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

/** `requestIdleCallback` where the platform has it, with a bounded wait so a busy page still runs. */
export function browserIdle(timeoutMs = 1000): (start: () => void) => () => void {
  return (start) => {
    const g = globalThis as {
      requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof g.requestIdleCallback !== 'function') {
      start();
      return () => {};
    }
    const handle = g.requestIdleCallback(start, { timeout: timeoutMs });
    return () => g.cancelIdleCallback?.(handle);
  };
}

export function quietScheduler(options: QuietOptions): QuietScheduler {
  const timers = options.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let timer: unknown = null;
  let stopIdle: (() => void) | null = null;
  let waiting = false;

  const cancel = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    stopIdle?.();
    stopIdle = null;
    waiting = false;
  };

  return {
    request(run) {
      cancel();
      waiting = true;
      timer = timers.set(() => {
        timer = null;
        const start = (): void => {
          stopIdle = null;
          waiting = false;
          run();
        };
        if (options.whenIdle) stopIdle = options.whenIdle(start);
        else start();
      }, options.quietMs);
    },
    cancel,
    get pending() {
      return waiting;
    },
  };
}
