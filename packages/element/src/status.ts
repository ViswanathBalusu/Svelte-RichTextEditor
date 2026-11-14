/**
 * The save state and the connection as the host sees them (02 §2.2; 05 §8.1; FE-007, PRO-087).
 *
 * - `StatusReporter` raises `de-status` at most once per animation frame, and only when
 *   `{ connection, sync }` differs from what it last raised. Connection and save state change
 *   independently of each other.
 * - `ChangeReporter` raises `de-change` with the latest confirmed `seq`, at most once per interval,
 *   so typing does not raise one event per keystroke.
 *
 * No DOM: the scheduler is injected, so the logic runs in Node.js tests.
 */
import type { Access } from '@docedit/protocol';
import type { Connection, StatusDetail, SyncState } from './events.ts';

export type Scheduler = (run: () => void) => void;

/**
 * The next animation frame while the page is visible. Hidden pages get no frames, so there the
 * update runs in the next task instead of waiting until the page is shown again.
 */
export const frameScheduler: Scheduler = (run) => {
  const visible = !('document' in globalThis) || document.visibilityState === 'visible';
  if (visible && 'requestAnimationFrame' in globalThis) requestAnimationFrame(() => run());
  else setTimeout(run, 0);
};

export class StatusReporter {
  #current: StatusDetail;
  #raised: StatusDetail | null = null;
  #scheduled = false;
  #closed = false;
  readonly #raise: (status: StatusDetail) => void;
  readonly #schedule: Scheduler;

  constructor(
    raise: (status: StatusDetail) => void,
    initial: StatusDetail,
    schedule: Scheduler = frameScheduler,
  ) {
    this.#raise = raise;
    this.#current = initial;
    this.#schedule = schedule;
  }

  get current(): StatusDetail {
    return this.#current;
  }

  update(change: { connection?: Connection; sync?: SyncState }): void {
    if (this.#closed) return;
    this.#current = { ...this.#current, ...change };
    if (this.#scheduled || same(this.#current, this.#raised)) return;
    this.#scheduled = true;
    this.#schedule(this.#flush);
  }

  /** Raises the current status in the next frame even if it was raised before (a new session). */
  announce(): void {
    this.#raised = null;
    this.update({});
  }

  #flush = (): void => {
    this.#scheduled = false;
    if (this.#closed || same(this.#current, this.#raised)) return;
    this.#raised = this.#current;
    this.#raise(this.#current);
  };

  close(): void {
    this.#closed = true;
  }
}

function same(a: StatusDetail, b: StatusDetail | null): boolean {
  return b !== null && a.connection === b.connection && a.sync === b.sync;
}

type Timer = ReturnType<typeof setTimeout>;

export class ChangeReporter {
  #seq: number;
  #raisedSeq: number;
  #timer: Timer | null = null;
  #closed = false;
  readonly #raise: (seq: number) => void;
  readonly #intervalMs: number;

  /** `seq` is the confirmed `seq` the document was loaded at; it is not raised. */
  constructor(raise: (seq: number) => void, seq: number, intervalMs: number) {
    this.#raise = raise;
    this.#seq = seq;
    this.#raisedSeq = seq;
    this.#intervalMs = intervalMs;
  }

  confirmed(seq: number): void {
    if (this.#closed || seq <= this.#seq) return;
    this.#seq = seq;
    this.#timer ??= setTimeout(this.#flush, this.#intervalMs);
  }

  #flush = (): void => {
    this.#timer = null;
    if (this.#closed || this.#seq === this.#raisedSeq) return;
    this.#raisedSeq = this.#seq;
    this.#raise(this.#seq);
  };

  close(): void {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

const CHANGE_CAPS = new Set(['edit', 'suggest', 'fill', 'structure']);

/**
 * Whether the access lets the user change anything in the document: a scope or the document level
 * with `edit`, `suggest`, `fill` or `structure`. Without one, the save state is `readonly` (FE-007).
 * Comments are not document commits, so `comment` alone is read-only here.
 */
export function mayChange(access: Access): boolean {
  if (access.caps.some((c) => CHANGE_CAPS.has(c))) return true;
  return Object.values(access.scopes).some((caps) => caps.some((c) => CHANGE_CAPS.has(c)));
}

/** The connection a channel state stands for (05 §8.1 `de-status`). */
export function connectionOf(status: 'catching_up' | 'live' | 'resuming' | 'closed'): Connection {
  switch (status) {
    case 'catching_up':
    case 'live':
      return 'online';
    case 'resuming':
      return 'reconnecting';
    case 'closed':
      return 'offline';
  }
}
