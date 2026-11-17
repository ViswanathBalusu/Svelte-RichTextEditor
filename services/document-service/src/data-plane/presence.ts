/**
 * The presence relay of one room (05 §5.4; 04 §11; SYN-035, PRO-031). Presence is never stored:
 * it lives in this object and goes when the room goes.
 *
 * - The identity of a peer is the session's, never the client's claim.
 * - `state` was checked against its schema by the codec; here it is held to `presenceBytes`, and a
 *   state above it is not relayed.
 * - At most `presenceHz` updates per second per channel are relayed. A faster client is coalesced:
 *   the latest update waits for the next slot and replaces any it overtakes; nothing is closed.
 * - Positions refer to the sender's projection, so an update reaches only the channels of the
 *   same visibility class (ADR 0019). Until read restrictions are accepted there is one class.
 */
import {
  utf8Length,
  type PresencePeer,
  type PresencePeers,
  type PresenceUpdate,
} from '@docedit/protocol';

export interface PresenceMember {
  readonly session: string;
  readonly user: PresencePeer['user'];
  /** The visibility class of the channel (its gateway token). */
  readonly view: () => string;
  /** Whether the session announced `presence` (05 §1 rule 4). */
  readonly wants: boolean;
  send(p: PresencePeers): void;
}

interface Entry {
  member: PresenceMember;
  peer: PresencePeer | null;
  lastSent: number;
  pending: PresenceUpdate | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PresenceRelay {
  readonly #limits: { presenceHz: number; presenceBytes: number };
  readonly #entries = new Map<string, Entry>();
  /** Counters for tests and metrics. */
  readonly stats = { relayed: 0, coalesced: 0, refused: 0 };

  constructor(limits: { presenceHz: number; presenceBytes: number }) {
    this.#limits = limits;
  }

  /**
   * What the relay holds now (SEC-018 criterion 3): one entry for each joined channel, and the
   * UTF-8 size of every presence state it keeps (the last relayed one and the one waiting for the
   * next slot). Each state is at most `presenceBytes`, so the total is at most twice that for each
   * channel, however many updates arrived.
   */
  get held(): { entries: number; stateBytes: number } {
    let stateBytes = 0;
    for (const e of this.#entries.values()) {
      if (e.peer) stateBytes += utf8Length(JSON.stringify(e.peer.state));
      if (e.pending) stateBytes += utf8Length(JSON.stringify(e.pending.state));
    }
    return { entries: this.#entries.size, stateBytes };
  }

  /** A channel joined: it learns the peers of its class that have published a state. */
  join(key: string, member: PresenceMember): void {
    this.#entries.set(key, { member, peer: null, lastSent: 0, pending: null, timer: null });
    if (!member.wants) return;
    const view = member.view();
    const peers = [...this.#entries.entries()]
      .filter(([k, e]) => k !== key && e.peer !== null && e.member.view() === view)
      .map(([, e]) => e.peer!);
    if (peers.length) member.send({ peers, left: [] });
  }

  /** A channel left: the others learn that its session went away. */
  leave(key: string): void {
    const e = this.#entries.get(key);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    this.#entries.delete(key);
    for (const [, o] of this.#entries)
      if (o.member.wants && o.member.session !== e.member.session)
        o.member.send({ peers: [], left: [e.member.session] });
  }

  update(key: string, update: PresenceUpdate): void {
    const e = this.#entries.get(key);
    if (!e) return;
    if (utf8Length(JSON.stringify(update.state)) > this.#limits.presenceBytes) {
      this.stats.refused++;
      return;
    }
    const interval = 1000 / Math.max(1, this.#limits.presenceHz);
    const now = Date.now();
    if (e.timer === null && now - e.lastSent >= interval) {
      this.#relay(key, e, update, now);
      return;
    }
    if (e.pending) this.stats.coalesced++;
    e.pending = update;
    if (e.timer === null)
      e.timer = setTimeout(
        () => {
          e.timer = null;
          const p = e.pending;
          e.pending = null;
          if (p && this.#entries.get(key) === e) this.#relay(key, e, p, Date.now());
        },
        Math.max(0, e.lastSent + interval - now),
      );
  }

  #relay(key: string, e: Entry, update: PresenceUpdate, now: number): void {
    e.lastSent = now;
    const s = update.state;
    const peer: PresencePeer = {
      session: e.member.session,
      user: e.member.user,
      seq: update.seq,
      // Only the members of 05 §5.4: nothing a client adds, an identity least of all, is relayed.
      state: {
        selection: { anchor: s.selection.anchor, head: s.selection.head },
        scope: s.scope,
        status: s.status,
      },
    };
    e.peer = peer;
    this.stats.relayed++;
    const view = e.member.view();
    for (const [k, o] of this.#entries)
      if (k !== key && o.member.wants && o.member.view() === view)
        o.member.send({ peers: [peer], left: [] });
  }

  close(): void {
    for (const e of this.#entries.values()) if (e.timer) clearTimeout(e.timer);
    this.#entries.clear();
  }
}
