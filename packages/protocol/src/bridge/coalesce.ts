/**
 * Time-window coalescing of `sync.commit` messages (SYN-041; 04 §11; 05 §5.2).
 *
 * The bridge already merges the consecutive commits of one `translate` call into one `commits`
 * array. A room with many subscribers also gets commits that arrive faster than a window; this
 * coalescer holds the `sync.commit` messages of a channel for one window and sends them as one
 * message. It is pure: the host supplies the clock (`now`) and calls `poll` when `nextDue` says so.
 *
 * Rules, all in the order the room produced them:
 *
 * - a commit held for coalescing starts a window of `windowMs` on its channel; commits that arrive
 *   before the window ends join the same message, in the order received (ascending `seq`);
 * - a commit that would not keep `seq` ascending on its channel ends the held message first;
 * - any other message on the channel (an acknowledgement, a rejection, `perm.changed`, a close)
 *   ends the held message first, so that a reader never sees an acknowledgement or a close before
 *   the commits it follows (SYN-015 ordering);
 * - when `coalesce` is false the commit is not held: the channel's held message is ended and the
 *   commit goes at once. The host decides `coalesce`, from the room's subscriber count (SYN-041;
 *   what "many" means is an open question, and no threshold is set here).
 *
 * The window is a target of 30 to 50 ms (SYN-041). A held message is never delayed past its window.
 */
import type { DepEvent, DepOutbound } from './room-bridge.ts';

/** The `commits` of a `sync.commit` message (DEP's payload). */
type Commits = Extract<DepEvent, { t: 'sync.commit' }>['d']['commits'];

/** The window the room may hold a commit for, in milliseconds (SYN-041: 30 to 50 ms target). */
export function checkWindow(windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0)
    throw new RangeError('a coalescing window needs a positive number of milliseconds');
  return windowMs;
}

interface Held {
  /** The time the held message is sent, `now` of the first commit plus the window. */
  due: number;
  /** The channel's commits so far, in order; the array grows while the window is open. */
  commits: Commits;
}

export class CommitCoalescer {
  readonly windowMs: number;
  readonly #held = new Map<string, Held>();

  constructor(windowMs: number) {
    this.windowMs = checkWindow(windowMs);
  }

  /**
   * Takes one message the room produced, at time `now`, and returns the messages to send now, in
   * order. A commit held for coalescing returns none; a message that ends a held one returns it
   * first.
   */
  push(item: DepOutbound, now: number, coalesce: boolean): DepOutbound[] {
    const { channel, event } = item;
    if (event.t !== 'sync.commit') return [...this.#end(channel), item];
    if (!coalesce) return [...this.#end(channel), item];
    const incoming = event.d.commits;
    if (incoming.length === 0) return [];
    const held = this.#held.get(channel);
    if (!held) {
      this.#hold(channel, incoming, now);
      return [];
    }
    const last = held.commits.at(-1)!.seq;
    if (incoming[0]!.seq <= last) {
      // Out of order for this message: end it, and hold the commit as the start of the next one.
      const ended = this.#end(channel);
      this.#hold(channel, incoming, now);
      return ended;
    }
    held.commits.push(...incoming);
    return [];
  }

  /** The messages whose window has ended by `now`, in the order they were due. */
  poll(now: number): DepOutbound[] {
    const due = [...this.#held.entries()]
      .filter(([, h]) => h.due <= now)
      .sort((a, b) => a[1].due - b[1].due);
    const out: DepOutbound[] = [];
    for (const [channel] of due) out.push(...this.#end(channel));
    return out;
  }

  /** The time at which `poll` next has something to send, or `undefined` when nothing is held. */
  nextDue(): number | undefined {
    let next: number | undefined;
    for (const h of this.#held.values()) if (next === undefined || h.due < next) next = h.due;
    return next;
  }

  /**
   * Ends the channel's held message now: the host calls it before it sends anything to the channel
   * outside `push` (a refusal it answers itself, a close), so that nothing overtakes the commits.
   */
  end(channel: string): DepOutbound[] {
    return this.#end(channel);
  }

  /** Forgets the channel's held message: the channel went away and nothing more reaches it. */
  drop(channel: string): void {
    this.#held.delete(channel);
  }

  /** Ends every held message, for a close of the room or of the process. */
  flush(): DepOutbound[] {
    const out: DepOutbound[] = [];
    for (const channel of [...this.#held.keys()]) out.push(...this.#end(channel));
    return out;
  }

  #hold(channel: string, commits: Commits, now: number): void {
    this.#held.set(channel, { due: now + this.windowMs, commits: [...commits] });
  }

  #end(channel: string): DepOutbound[] {
    const held = this.#held.get(channel);
    if (!held) return [];
    this.#held.delete(channel);
    return [{ channel, event: { t: 'sync.commit', d: { commits: held.commits } } }];
  }
}
