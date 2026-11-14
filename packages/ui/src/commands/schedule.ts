/**
 * At most one publication per animation frame (02 §4; UX-003). The first change in a frame is
 * published in a microtask, so it lands in the same frame as the core's notification; a later
 * change in a frame that already published waits for the next frame.
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
  let requested = false;
  let publishedThisFrame = false;
  let resetRequested = false;

  const run = () => {
    requested = false;
    const task = pending;
    pending = null;
    task?.();
  };

  return {
    request(task) {
      pending = task;
      if (requested) return;
      requested = true;
      if (publishedThisFrame) frame(run);
      else microtask(run);
    },
    published() {
      publishedThisFrame = true;
      if (resetRequested) return;
      resetRequested = true;
      frame(() => {
        resetRequested = false;
        publishedThisFrame = false;
      });
    },
  };
}

/** Runs requests at once: for tests that drive time by hand. */
export function immediateScheduler(): Scheduler {
  return { request: (task) => task(), published: () => {} };
}
