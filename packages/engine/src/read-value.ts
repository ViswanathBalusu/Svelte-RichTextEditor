/**
 * Small read-only views of the core's state (02 §4; FE-023): the user interface subscribes to them
 * and never holds the document or the editor state. A core's views share one `ViewHub`, which
 * coalesces notifications: however many transactions run and however many views they change, the
 * subscribers are called once per animation frame, in one pass, with the final values (FE-024). A
 * change that leaves a view equal to its old value schedules nothing.
 */

export interface ReadView<T> {
  get(): T;
  /** Returns the function that unsubscribes. */
  subscribe(listener: () => void): () => void;
}

/** Runs a callback before the next frame: `requestAnimationFrame`, or a microtask without a DOM. */
export type Schedule = (run: () => void) => void;

export const nextFrame: Schedule = (run) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
  else queueMicrotask(run);
};

/** Collects the views changed since the last frame and notifies their subscribers in one pass. */
export class ViewHub {
  readonly #schedule: Schedule;
  readonly #dirty = new Set<ReadValue<unknown>>();
  #scheduled = false;
  /** How many notification passes ran, for the tests of FE-024. */
  passes = 0;

  constructor(schedule: Schedule = nextFrame) {
    this.#schedule = schedule;
  }

  /** Whether a pass is scheduled. */
  get pending(): boolean {
    return this.#scheduled;
  }

  mark(view: ReadValue<unknown>): void {
    this.#dirty.add(view);
    if (this.#scheduled) return;
    this.#scheduled = true;
    this.#schedule(() => this.flush());
  }

  /** Notifies now (a pass also runs on its own at the next frame). */
  flush(): void {
    this.#scheduled = false;
    if (this.#dirty.size === 0) return;
    const views = [...this.#dirty];
    this.#dirty.clear();
    this.passes++;
    for (const v of views) v.notify();
  }
}

export class ReadValue<T> implements ReadView<T> {
  #value: T;
  readonly #listeners = new Set<() => void>();
  readonly #equal: (a: T, b: T) => boolean;
  readonly #hub: ViewHub;

  constructor(initial: T, equal: (a: T, b: T) => boolean = Object.is, hub?: ViewHub | Schedule) {
    this.#value = initial;
    this.#equal = equal;
    this.#hub = hub instanceof ViewHub ? hub : new ViewHub(hub);
  }

  get(): T {
    return this.#value;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  set(value: T): void {
    if (this.#equal(this.#value, value)) return;
    this.#value = value;
    this.#hub.mark(this as ReadValue<unknown>);
  }

  /** Called by the hub. */
  notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** Structural equality for the small plain-data snapshots the views hold. */
export function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
