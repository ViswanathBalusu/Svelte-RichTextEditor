/**
 * Debounce of `dep.document.changed.v1` (05 §7; spec table: "Debounced to at most once per 10
 * seconds per document"; PRO-072 criterion 2).
 *
 * The first change of a document in a window is raised at once. Later changes in the same window
 * are not raised; the latest of them is kept and raised by `flush` once the window has ended, so the
 * last state of a burst is never lost. The raised event carries the data of the commit it refers to
 * (`seq`, and the hash-chain head once the caller supplies it). Other event types pass through.
 *
 * The caller drives time: `offer(event, now)` on each change and `flush(now)` on a timer, so that the
 * tests need no real clock. `DebouncedEventSink` adds the timer for the running service.
 */
import type { DepEvent, EventSink } from './events.ts';

export const DOCUMENT_CHANGED = 'dep.document.changed.v1';
/** The window of the spec, in milliseconds. */
export const CHANGE_WINDOW_MS = 10_000;

export class DocumentChangeDebounce {
  readonly #sink: EventSink;
  readonly #windowMs: number;
  /** When the last raised event of each document was raised. */
  readonly #raisedAt = new Map<string, number>();
  /** The latest suppressed change of each document, waiting for its window to end. */
  readonly #pending = new Map<string, DepEvent>();

  constructor(sink: EventSink, windowMs: number = CHANGE_WINDOW_MS) {
    if (!Number.isFinite(windowMs) || windowMs <= 0)
      throw new RangeError('the window must be positive');
    this.#sink = sink;
    this.#windowMs = windowMs;
  }

  /** Offers an event at time `now` (Unix milliseconds). */
  offer(event: DepEvent, now: number): void {
    if (event.type !== DOCUMENT_CHANGED) {
      this.#sink.emit(event);
      return;
    }
    const key = `${event.tenant}\u0000${event.subject}`;
    const last = this.#raisedAt.get(key);
    if (last === undefined || now - last >= this.#windowMs) {
      this.#raisedAt.set(key, now);
      this.#pending.delete(key);
      this.#sink.emit(event);
    } else {
      this.#pending.set(key, event);
    }
  }

  /** Raises the latest suppressed change of each document whose window has ended by `now`. */
  flush(now: number): void {
    for (const [key, event] of [...this.#pending]) {
      const last = this.#raisedAt.get(key) ?? 0;
      if (now - last < this.#windowMs) continue;
      this.#pending.delete(key);
      this.#raisedAt.set(key, now);
      this.#sink.emit(event);
    }
  }

  /** Changes waiting for a flush, for tests and for a shutdown that must not drop the last one. */
  get waiting(): number {
    return this.#pending.size;
  }
}

/**
 * An `EventSink` in front of another, with the debounce above and its own flush timer (BE-055
 * criterion 2). One instance is shared by everything that raises `dep.document.changed.v1` (the
 * rooms and the REST routes), so a document has one window, not one per source. The timer is
 * unreferenced and armed only while a change waits; `close` raises what waits and stops it.
 */
export class DebouncedEventSink implements EventSink {
  readonly #debounce: DocumentChangeDebounce;
  readonly #now: () => number;
  readonly #windowMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(sink: EventSink, now: () => number, windowMs: number = CHANGE_WINDOW_MS) {
    this.#debounce = new DocumentChangeDebounce(sink, windowMs);
    this.#now = now;
    this.#windowMs = windowMs;
  }

  emit(event: DepEvent): void {
    this.#debounce.offer(event, this.#now());
    this.#arm();
  }

  /** Raises the changes whose windows have ended; for tests that drive time themselves. */
  flush(): void {
    this.#debounce.flush(this.#now());
  }

  get waiting(): number {
    return this.#debounce.waiting;
  }

  /** Stops the timer. A change still waiting is raised now, so the last state of a burst is kept. */
  close(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#debounce.flush(this.#now() + this.#windowMs);
  }

  #arm(): void {
    if (this.#timer !== null || this.#debounce.waiting === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#debounce.flush(this.#now());
      this.#arm();
    }, this.#windowMs);
    this.#timer.unref?.();
  }
}
