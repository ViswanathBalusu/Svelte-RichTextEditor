/**
 * Forwarding of a channel between nodes over the internal bus (BE-062; 06 §2.1, §4.3, §6).
 *
 * A channel that lands on a node which is not its document's owner is forwarded to the owner over
 * a stream. This module is the stream and the bookkeeping only; it has no tie to a transport. The
 * caller supplies `out` (put a wire message on the bus) and feeds what comes back in through
 * `receive` and `tick`. The bus itself is not chosen (BE-059 is open), so the transport is not
 * named here.
 *
 * The rules this module holds:
 *
 * - Ordered, gap-detected delivery. The receiver delivers sequence numbers 1, 2, 3, ... once each.
 *   A frame that arrives early is held. A missing number is a gap; the receiver asks for it with a
 *   `nack`, and asks again after `repairMs` until `maxNacks` is used up.
 * - The sender keeps only the last `retain` frames. A `nack` for a frame it no longer keeps gets a
 *   `gone`, and the gap cannot be repaired.
 * - An unrepairable gap closes the channel with code `unavailable` and a `retryInMs`, which maps to
 *   `ch.closed` for the client. The client then resumes (06 §2.1; 05 §5.2).
 * - When the owner of a document changes, every forwarded channel for that document is closed with
 *   `unavailable`. The client reconnects and is routed to the new owner (BE-061).
 *
 * Time is passed in by the caller (`now`, in milliseconds), so that a test can drive it.
 * Authentication happens at the gateway; the authority checks run in the owning room, not here.
 */

/** A message on the forwarding stream. `payload` is opaque to this module. */
export type ForwardWire<T> =
  | { readonly k: 'data'; readonly seq: number; readonly payload: T }
  | { readonly k: 'nack'; readonly seq: number }
  | { readonly k: 'gone'; readonly seq: number }
  | { readonly k: 'head'; readonly seq: number };

/** Why a forwarded channel closed, as it maps to `ch.closed`. */
export interface ForwardClose {
  readonly code: 'unavailable';
  readonly reason: string;
  readonly retryInMs: number;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer`);
}

/** The sending end of a forwarded stream. It keeps the last `retain` frames for repair. */
export class ForwardSender<T> {
  private next = 1;
  private readonly kept = new Map<number, T>();
  private readonly out: (w: ForwardWire<T>) => void;
  private readonly retain: number;

  constructor(out: (w: ForwardWire<T>) => void, retain: number) {
    assertPositiveInteger('retain', retain);
    this.out = out;
    this.retain = retain;
  }

  /** Send the next payload. Returns its sequence number. */
  send(payload: T): number {
    const seq = this.next++;
    this.kept.set(seq, payload);
    if (this.kept.size > this.retain) {
      const oldest = this.kept.keys().next().value;
      if (oldest !== undefined) this.kept.delete(oldest);
    }
    this.out({ k: 'data', seq, payload });
    return seq;
  }

  /**
   * Tell the receiver the highest sequence number sent so far. A lost last frame makes no gap for
   * the receiver to see, so the sender announces its head on a heartbeat.
   */
  announce(): void {
    if (this.next > 1) this.out({ k: 'head', seq: this.next - 1 });
  }

  /** Answer a `nack` from the receiver: resend the frame, or say it is gone. */
  receive(w: ForwardWire<T>): void {
    if (w.k !== 'nack') return;
    if (this.kept.has(w.seq)) {
      this.out({ k: 'data', seq: w.seq, payload: this.kept.get(w.seq) as T });
    } else {
      this.out({ k: 'gone', seq: w.seq });
    }
  }
}

export interface ForwardReceiverOptions {
  /** How long a gap stays open before the receiver asks for it again. */
  readonly repairMs: number;
  /** How many `nack`s a missing frame gets before the gap is unrepairable. */
  readonly maxNacks: number;
  /** The `retryInMs` a client is given when the channel closes. */
  readonly retryInMs: number;
}

interface Gap {
  since: number;
  nacks: number;
}

/** The receiving end of a forwarded stream. Delivers each frame once, in order. */
export class ForwardReceiver<T> {
  private expected = 1;
  private readonly held = new Map<number, T>();
  private readonly gaps = new Map<number, Gap>();
  private closedWith: ForwardClose | undefined;
  private duplicateCount = 0;
  private readonly out: (w: ForwardWire<T>) => void;
  private readonly deliver: (seq: number, payload: T) => void;
  private readonly onClose: (c: ForwardClose) => void;
  private readonly opts: ForwardReceiverOptions;

  constructor(
    out: (w: ForwardWire<T>) => void,
    deliver: (seq: number, payload: T) => void,
    onClose: (c: ForwardClose) => void,
    opts: ForwardReceiverOptions,
  ) {
    assertPositiveInteger('repairMs', opts.repairMs);
    assertPositiveInteger('maxNacks', opts.maxNacks);
    assertPositiveInteger('retryInMs', opts.retryInMs);
    this.out = out;
    this.deliver = deliver;
    this.onClose = onClose;
    this.opts = opts;
  }

  /** The close, once the channel has closed; undefined while it is open. */
  get closed(): ForwardClose | undefined {
    return this.closedWith;
  }

  /** How many frames arrived that were already delivered or already held. */
  get duplicates(): number {
    return this.duplicateCount;
  }

  /** Feed one wire message from the bus. */
  receive(w: ForwardWire<T>, now: number): void {
    if (this.closedWith !== undefined) return;
    if (w.k === 'data') this.onData(w.seq, w.payload, now);
    else if (w.k === 'head') this.noteMissing(w.seq + 1, now, false);
    else if (w.k === 'gone') this.onGone(w.seq);
  }

  /** Repeat the nacks of gaps that have waited `repairMs`; close when a gap has used them all. */
  tick(now: number): void {
    if (this.closedWith !== undefined) return;
    for (const [seq, gap] of this.gaps) {
      if (now - gap.since < this.opts.repairMs) continue;
      if (gap.nacks >= this.opts.maxNacks) {
        this.close(`frame ${seq} was not repaired after ${gap.nacks} requests`);
        return;
      }
      gap.nacks += 1;
      gap.since = now;
      this.out({ k: 'nack', seq });
    }
  }

  private onData(seq: number, payload: T, now: number): void {
    if (seq < this.expected || this.held.has(seq)) {
      this.duplicateCount += 1;
      return;
    }
    this.held.set(seq, payload);
    this.gaps.delete(seq);
    this.noteMissing(seq, now, true);
    while (this.held.has(this.expected)) {
      const next = this.held.get(this.expected) as T;
      this.held.delete(this.expected);
      this.deliver(this.expected, next);
      this.expected += 1;
    }
  }

  /**
   * Open a gap for each number below `upTo` that is neither held nor open. A frame that a later
   * frame overtook is asked for at once. A number only known from the sender's head may still be
   * in flight, so it is asked for after `repairMs`, from `tick`.
   */
  private noteMissing(upTo: number, now: number, askAtOnce: boolean): void {
    for (let missing = this.expected; missing < upTo; missing += 1) {
      if (this.held.has(missing) || this.gaps.has(missing)) continue;
      if (askAtOnce) {
        this.gaps.set(missing, { since: now, nacks: 1 });
        this.out({ k: 'nack', seq: missing });
      } else {
        this.gaps.set(missing, { since: now, nacks: 0 });
      }
    }
  }

  private onGone(seq: number): void {
    if (seq < this.expected || this.held.has(seq)) return;
    this.close(`frame ${seq} is no longer kept by the sender`);
  }

  private close(reason: string): void {
    const c: ForwardClose = { code: 'unavailable', reason, retryInMs: this.opts.retryInMs };
    this.closedWith = c;
    this.gaps.clear();
    this.held.clear();
    this.onClose(c);
  }
}

/**
 * The forwarded channels this node holds, by document, and the owner each was forwarded to. When
 * a document's owner changes, every forwarded channel for it closes (`unavailable`, with the
 * `retryInMs` given); the client reconnects and is routed to the new owner.
 */
export class ForwardedChannels {
  private readonly owners = new Map<string, string>();
  private readonly byDoc = new Map<string, Set<string>>();
  private readonly retryInMs: number;

  constructor(retryInMs: number) {
    assertPositiveInteger('retryInMs', retryInMs);
    this.retryInMs = retryInMs;
  }

  /** Record that `channel` on `doc` is forwarded to `owner`. */
  open(channel: string, doc: string, owner: string): void {
    this.owners.set(doc, owner);
    let set = this.byDoc.get(doc);
    if (set === undefined) {
      set = new Set();
      this.byDoc.set(doc, set);
    }
    set.add(channel);
  }

  /** The channel has closed on its own; forget it. */
  forget(channel: string, doc: string): void {
    this.byDoc.get(doc)?.delete(channel);
  }

  /**
   * Set the owner of `doc`. When it differs from the owner on record, every forwarded channel for
   * `doc` is removed and returned with its close. An unchanged owner closes nothing.
   */
  setOwner(doc: string, owner: string): Array<{ channel: string; close: ForwardClose }> {
    const previous = this.owners.get(doc);
    this.owners.set(doc, owner);
    if (previous === undefined || previous === owner) return [];
    const set = this.byDoc.get(doc);
    if (set === undefined) return [];
    const closed = [...set].map((channel) => ({
      channel,
      close: {
        code: 'unavailable' as const,
        reason: `owner of the document changed to ${owner}`,
        retryInMs: this.retryInMs,
      },
    }));
    this.byDoc.delete(doc);
    return closed;
  }

  /** How many channels are forwarded for `doc`. */
  count(doc: string): number {
    return this.byDoc.get(doc)?.size ?? 0;
  }
}
