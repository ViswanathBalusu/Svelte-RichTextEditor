/**
 * `de-mode-change`, `de-presence` and `de-counts` (UX-014 criterion 5; proposed in ADR 0361, since
 * 05 §8.1 names no event for them).
 *
 * A host that draws its own header (`header="none"`) needs what the built-in header shows. The
 * save and connection state come with `de-status`; these three events carry the rest:
 *
 * - `de-mode-change`: the mode the host asked for and the mode in effect, which the access may
 *   make more restrictive, and which the mode switcher or a `mode.*` command may change.
 * - `de-presence`: the other sessions this reader may see, as identifiers and a status. Names come
 *   from the host's own directory, so none is carried.
 * - `de-counts`: open comment threads and catch-up activity; `null` where the count is unknown.
 *
 * Each is raised once when the watch starts, with the state at that moment, and then whenever its
 * detail changes; a notification that leaves the detail as it was raises nothing. The same state
 * can be read at any time from the element's `headerState` property. No DOM here, so the logic
 * runs in Node.js tests; the views are the core's, reached through the editor.
 */
import type { CountsDetail, ModeChangeDetail, PresenceDetail } from './events.ts';

interface View<T> {
  get(): T;
  subscribe(listener: () => void): () => void;
}

/** What the reporter reads from the editor. Read-only and without content. */
export interface HeaderWatch {
  readonly mode: View<{ readonly requested: string; readonly effective: string }>;
  readonly presence: View<
    readonly { readonly session: string; readonly user: string; readonly status?: string }[]
  >;
  readonly counts: View<{ readonly comments?: number; readonly catchUp?: number }>;
}

export interface HeaderRaise {
  mode(detail: ModeChangeDetail): void;
  presence(detail: PresenceDetail): void;
  counts(detail: CountsDetail): void;
}

/** The three details as they are now. */
export interface HeaderSnapshot {
  readonly mode: ModeChangeDetail;
  readonly presence: PresenceDetail;
  readonly counts: CountsDetail;
}

function count(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reads the three details from the watch: identifiers, a status and counts, and nothing else. */
export function headerSnapshot(watch: HeaderWatch): HeaderSnapshot {
  const mode = watch.mode.get();
  const counts = watch.counts.get();
  return {
    mode: { mode: mode.effective, requested: mode.requested },
    presence: {
      peers: watch.presence.get().map((p) => ({
        session: p.session,
        user: p.user,
        status: p.status === 'idle' ? ('idle' as const) : ('active' as const),
      })),
    },
    counts: { comments: count(counts.comments), catchUp: count(counts.catchUp) },
  };
}

export class HeaderEvents {
  readonly #watch: HeaderWatch;
  readonly #raise: HeaderRaise;
  readonly #last: { mode?: string; presence?: string; counts?: string } = {};

  constructor(watch: HeaderWatch, raise: HeaderRaise) {
    this.#watch = watch;
    this.#raise = raise;
  }

  /** Raises the current state, then subscribes. Returns the function that unsubscribes. */
  start(): () => void {
    this.check();
    const check = (): void => this.check();
    const stops = [
      this.#watch.mode.subscribe(check),
      this.#watch.presence.subscribe(check),
      this.#watch.counts.subscribe(check),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }

  /** Compares each detail with the last one raised; raises those that changed. */
  check(): void {
    const now = headerSnapshot(this.#watch);
    const mode = JSON.stringify(now.mode);
    if (mode !== this.#last.mode) {
      this.#last.mode = mode;
      this.#raise.mode(now.mode);
    }
    const presence = JSON.stringify(now.presence);
    if (presence !== this.#last.presence) {
      this.#last.presence = presence;
      this.#raise.presence(now.presence);
    }
    const counts = JSON.stringify(now.counts);
    if (counts !== this.#last.counts) {
      this.#last.counts = counts;
      this.#raise.counts(now.counts);
    }
  }
}
