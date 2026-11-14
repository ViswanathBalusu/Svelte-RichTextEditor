/**
 * The room's broadcast window (SYN-041; 04 §12, §5 step 10): the host side of `CommitCoalescer`.
 * Every message the bridge translated for the room's channels goes through `pass`. While the room
 * has at least `minSubscribers` channels, a `sync.commit` is held for `windowMs` and joined by the
 * commits that follow on its channel; any other message on the channel ends the held one first, so
 * an acknowledgement or a rejection never overtakes a lower `seq` (SYN-015). Below the threshold
 * nothing is held and nothing waits.
 *
 * The coalescer is pure; this class owns its timer and hands the messages whose window ended to
 * `deliver`. Off unless the operator sets `coalescing` (what "many" means is an open question,
 * docs/adr/0356-lane-U-SYN-037-053.md; no threshold or window is chosen here).
 */
import { CommitCoalescer, type DepOutbound } from '@docedit/protocol/bridge';

export interface CoalescingSettings {
  /** How long a commit may be held, in milliseconds (04 §12: 30 to 50 ms, a target). */
  readonly windowMs: number;
  /** The number of channels from which a room coalesces ("many subscribers"). At least 1. */
  readonly minSubscribers: number;
}

export class BroadcastWindow {
  readonly #coalescer: CommitCoalescer;
  readonly #min: number;
  readonly #now: () => number;
  readonly #deliver: (out: DepOutbound[]) => void;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerDue = Number.POSITIVE_INFINITY;
  #stopped = false;

  constructor(
    settings: CoalescingSettings,
    opts: { now: () => number; deliver: (out: DepOutbound[]) => void },
  ) {
    if (!Number.isInteger(settings.minSubscribers) || settings.minSubscribers < 1)
      throw new RangeError('minSubscribers must be a whole number of at least 1');
    this.#coalescer = new CommitCoalescer(settings.windowMs);
    this.#min = settings.minSubscribers;
    this.#now = opts.now;
    this.#deliver = opts.deliver;
  }

  /** The messages to send now, in order, for the room's output `out` with `subscribers` channels. */
  pass(out: readonly DepOutbound[], subscribers: number): DepOutbound[] {
    if (this.#stopped) return [...out];
    const now = this.#now();
    const coalesce = subscribers >= this.#min;
    const sent: DepOutbound[] = [];
    for (const o of out) sent.push(...this.#coalescer.push(o, now, coalesce));
    this.#arm();
    return sent;
  }

  /** The channel's held message, ended now, before the host sends the channel anything itself. */
  end(channel: string): DepOutbound[] {
    const out = this.#coalescer.end(channel);
    this.#arm();
    return out;
  }

  /** The channel went away: its held message is dropped. */
  drop(channel: string): void {
    this.#coalescer.drop(channel);
    this.#arm();
  }

  /** Every held message, ended now (the room stops). */
  flush(): DepOutbound[] {
    const out = this.#coalescer.flush();
    this.#arm();
    return out;
  }

  /** Stops the timer for good; later messages pass through unheld. */
  stop(): void {
    this.#stopped = true;
    this.#clear();
  }

  #arm(): void {
    const due = this.#coalescer.nextDue();
    if (due === undefined) {
      this.#clear();
      return;
    }
    if (this.#timer && this.#timerDue <= due) return;
    this.#clear();
    this.#timerDue = due;
    this.#timer = setTimeout(() => this.#fire(), Math.max(0, due - this.#now()));
  }

  #fire(): void {
    this.#timer = null;
    this.#timerDue = Number.POSITIVE_INFINITY;
    if (this.#stopped) return;
    const out = this.#coalescer.poll(this.#now());
    this.#arm();
    if (out.length > 0) this.#deliver(out);
  }

  #clear(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#timerDue = Number.POSITIVE_INFINITY;
  }
}
