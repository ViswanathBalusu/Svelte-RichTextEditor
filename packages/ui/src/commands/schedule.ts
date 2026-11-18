/**
 * At most one publication per animation frame (02 §4; UX-003; UX-072 criterion 4; owner decision 93
 * of 2026-11-17: the scheduler is fixed, the criterion stands). A frame's paint comes after the
 * animation-frame callbacks of its tick, so a publication made in the task phase before a tick and
 * one made in that tick both land before the same paint. The first change is published in a
 * microtask, so it lands in the same frame as the core's notification. After a publication the
 * scheduler holds the next one back until the first tick that is after that paint: the second tick
 * after a publication made in a task phase, the next tick after one made in a tick. It counts
 * ticks, not time. A microtask that runs inside a tick is treated as a task phase, which can only
 * wait one frame longer than needed, never publish twice before one paint.
 */

export interface Scheduler {
  /** Asks for `task` to run once soon; repeated requests before it runs are merged. */
  request(task: () => void): void;
  /** Tells the scheduler that a publication happened now. */
  published(): void;
}

export type FrameFn = (callback: () => void) => void;
export type MicrotaskFn = (callback: () => void) => void;

function defaultFrame(): FrameFn {
  if (typeof requestAnimationFrame === 'function')
    return (cb) => void requestAnimationFrame(() => cb());
  return (cb) => void setTimeout(cb, 16);
}

export function frameScheduler(
  frame: FrameFn = defaultFrame(),
  microtask: MicrotaskFn = queueMicrotask,
): Scheduler {
  let pending: (() => void) | null = null;
  let microtaskQueued = false;
  /** Ticks still to wait before the next publication; above 0 only while `tick` is queued. */
  let gate = 0;
  let counting = false;
  /** True while a task runs from a tick of this scheduler. */
  let inTick = false;

  const run = () => {
    microtaskQueued = false;
    // A publication made meanwhile by someone else has closed the gate: the tick will run the task.
    if (gate > 0) return;
    const task = pending;
    pending = null;
    task?.();
  };

  const tick = () => {
    gate -= 1;
    if (gate > 0) {
      frame(tick);
      return;
    }
    counting = false;
    inTick = true;
    try {
      run();
    } finally {
      inTick = false;
    }
  };

  return {
    request(task) {
      pending = task;
      if (gate > 0 || microtaskQueued) return;
      microtaskQueued = true;
      microtask(run);
    },
    published() {
      gate = Math.max(gate, inTick ? 1 : 2);
      if (counting) return;
      counting = true;
      frame(tick);
    },
  };
}

/** Runs requests at once: for tests that drive time by hand. */
export function immediateScheduler(): Scheduler {
  return { request: (task) => task(), published: () => {} };
}
