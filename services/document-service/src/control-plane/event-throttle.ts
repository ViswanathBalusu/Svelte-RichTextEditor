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
 * tests need no real clock. Nothing here is wired into the handlers yet (see PRO-072's Notes).
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
