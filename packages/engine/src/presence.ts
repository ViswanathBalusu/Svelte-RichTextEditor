/**
 * Presence in the editing core (04 §11; 05 §5.4; ADR 0019): the user's own selection is published as
 * positions in the confirmed document (the visible selection mapped back through the unconfirmed
 * steps) with the confirmed `seq`, at most `presenceHz` times a second; the peers the backend reports
 * become a plain list for the shell. A peer is left out when its scope is a region this reader may
 * not see (a placeholder in the projection): the server drops such presence (ADR 0019, item 5), and
 * the client never shows it either.
 *
 * A receiver keeps each peer's positions in its own confirmed document (SYN-036). An update at a
 * `seq` the receiver has reached is mapped through the confirmed steps applied since; an update from
 * a later `seq` is held until the receiver reaches it; an update older than the retained mapping
 * history is dropped. A replacement of the confirmed document (a reset or a reload) clears the peers'
 * positions, because they cannot be mapped through it.
 */
import { inverseMapsOf } from '@docedit/authority';
import type { PresencePeers, PresenceUpdate, Unsubscribe } from '@docedit/protocol';
import type { Node } from 'prosemirror-model';
import { Mapping, type StepMap } from 'prosemirror-transform';
import type { PresencePeerInfo, PresencePortLike } from './api.ts';
import { PLACEHOLDER } from './schema.ts';
import type { Clock } from './sync/session.ts';
import { type Confirmed, type SyncState, unconfirmed } from './sync/state.ts';

export type { PresencePortLike };

/**
 * How many confirmed commits a receiver keeps the mapping of (SYN-036 criterion 4). The spec does not
 * state a number; this is a proposed default (ADR 0108), and the option `historyCommits` overrides it.
 */
export const DEFAULT_MAPPING_HISTORY = 256;

type PeerRecord = PresencePeers['peers'][number];

/** A peer's selection, kept in the receiver's confirmed document at `at`. */
interface Placed {
  readonly peer: PeerRecord;
  readonly at: number;
  readonly anchor: number;
  readonly head: number;
}

/** The maps of one confirmed change, which took the confirmed document to `to`. */
interface Mapped {
  readonly to: number;
  readonly maps: readonly StepMap[];
}

/** Positions in the confirmed document for a visible selection (04 §11). */
export function toConfirmed(
  s: SyncState,
  anchor: number,
  head: number,
): { anchor: number; head: number } {
  const back = new Mapping(inverseMapsOf(unconfirmed(s)));
  return { anchor: back.map(anchor, -1), head: back.map(head, -1) };
}

/** Region identifiers shown as placeholders in a document (ADR 0019). */
export function hiddenRegions(doc: Node): ReadonlySet<string> {
  const out = new Set<string>();
  doc.lastChild?.forEach((n) => {
    if (n.type.name === PLACEHOLDER && typeof n.attrs['id'] === 'string') out.add(n.attrs['id']);
  });
  return out;
}

/** Whether a peer may be shown to this reader. */
export function visiblePeer(
  peer: PresencePeers['peers'][number],
  doc: Node,
  hidden: ReadonlySet<string>,
): boolean {
  const scope = peer.state.scope;
  if (scope.startsWith('region:') && hidden.has(scope.slice('region:'.length))) return false;
  const { anchor, head } = peer.state.selection;
  const size = doc.content.size;
  return anchor >= 0 && head >= 0 && anchor <= size && head <= size;
}

export interface PresenceHost {
  readonly sync: SyncState;
  /** The visible selection and its DEP scope. */
  selection(): { anchor: number; head: number; scope: string };
  setPeers(peers: readonly PresencePeerInfo[]): void;
  visibleDoc(): Node;
}

export class PresenceClient {
  readonly #port: PresencePortLike;
  readonly #docId: string;
  readonly #host: PresenceHost;
  readonly #clock: Clock;
  readonly #intervalMs: number;
  readonly #session: string | null;
  readonly #peers = new Map<string, Placed>();
  /** Updates from a seq the receiver has not reached yet, by session (SYN-036 criterion 3). */
  readonly #held = new Map<string, PeerRecord>();
  /** The confirmed changes since `#floor`, oldest first: one entry per seq. */
  readonly #history: Mapped[] = [];
  readonly #retain: number;
  /** The oldest seq whose positions can still be mapped; older updates are dropped. */
  #floor: number;
  readonly #unsubscribe: Unsubscribe;
  #lastSent = Number.NEGATIVE_INFINITY;
  #timer: unknown = null;
  #last = '';

  constructor(
    port: PresencePortLike,
    docId: string,
    host: PresenceHost,
    opts: { clock: Clock; hz?: number; session?: string; historyCommits?: number },
  ) {
    this.#port = port;
    this.#docId = docId;
    this.#host = host;
    this.#clock = opts.clock;
    // 04 §11: at most 10 updates a second unless `welcome.limits.presenceHz` says otherwise.
    this.#intervalMs = 1000 / Math.max(1, opts.hz ?? 10);
    this.#session = opts.session ?? null;
    this.#retain = Math.max(0, opts.historyCommits ?? DEFAULT_MAPPING_HISTORY);
    this.#floor = host.sync.seq;
    this.#unsubscribe = port.onPeers(docId, (state) => this.#receive(state));
  }

  #receive(state: PresencePeers): void {
    for (const session of state.left) {
      this.#peers.delete(session);
      this.#held.delete(session);
    }
    for (const peer of state.peers) if (peer.session !== this.#session) this.#offer(peer);
    this.refresh();
  }

  /** An update from a peer: placed now, held until the receiver reaches its seq, or dropped. */
  #offer(peer: PeerRecord): void {
    const at = this.#host.sync.seq;
    if (peer.seq > at) {
      this.#held.set(peer.session, peer);
      return;
    }
    this.#held.delete(peer.session);
    this.#place(peer, at);
  }

  /** Places an update whose seq is at most `at`, mapped through the confirmed changes since it. */
  #place(peer: PeerRecord, at: number): void {
    // Older than the retained history: the positions cannot be mapped, so the update is dropped.
    if (peer.seq < this.#floor) return;
    const since = this.#history.filter((e) => e.to > peer.seq).flatMap((e) => e.maps);
    const mapping = new Mapping(since);
    const { anchor, head } = peer.state.selection;
    this.#peers.set(peer.session, {
      peer,
      at,
      anchor: mapping.map(anchor),
      head: mapping.map(head),
    });
  }

  /**
   * The receiver's confirmed document changed (SYN-036): each change maps the placed positions and is
   * kept in the history; held updates that the receiver has now reached are placed. A replacement
   * (`steps` null) starts the history over and clears the placed positions.
   */
  confirmed(changes: readonly Confirmed[]): void {
    for (const c of changes) {
      if (c.steps === null) {
        this.#history.length = 0;
        this.#floor = c.to;
        this.#peers.clear();
      } else {
        const maps = c.steps.map((step) => step.getMap());
        const mapping = new Mapping(maps);
        for (const [session, p] of this.#peers)
          this.#peers.set(session, {
            ...p,
            at: c.to,
            anchor: mapping.map(p.anchor),
            head: mapping.map(p.head),
          });
        this.#history.push({ to: c.to, maps });
        while (this.#history.length > this.#retain) this.#floor = this.#history.shift()!.to;
      }
      for (const [session, peer] of [...this.#held]) {
        if (peer.seq > c.to) continue;
        this.#held.delete(session);
        this.#place(peer, c.to);
      }
    }
    this.refresh();
  }

  /**
   * The positions of a peer in the receiver's confirmed document, and the seq they refer to, or
   * undefined when no update of that peer is placed (SYN-036).
   */
  positionsOf(session: string): { anchor: number; head: number; seq: number } | undefined {
    const p = this.#peers.get(session);
    return p ? { anchor: p.anchor, head: p.head, seq: p.at } : undefined;
  }

  /** Recomputes the list the shell shows: after a peer update and after every remote change. */
  refresh(): void {
    const s = this.#host.sync;
    const doc = this.#host.visibleDoc();
    const hidden = hiddenRegions(doc);
    // The placed positions are in the confirmed document; the visible one adds the local steps.
    const forward = new Mapping(unconfirmed(s).map((step) => step.getMap()));
    const list: PresencePeerInfo[] = [];
    for (const { peer, anchor, head } of this.#peers.values()) {
      const selection = { anchor: forward.map(anchor), head: forward.map(head) };
      if (!visiblePeer({ ...peer, state: { ...peer.state, selection } }, doc, hidden)) continue;
      list.push({
        session: peer.session,
        user: peer.user.id,
        name: peer.user.name ?? null,
        status: peer.state.status,
      });
    }
    list.sort((a, b) => (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
    this.#host.setPeers(list);
  }

  /** The selection or the confirmed seq changed: publish, at most every `1 / presenceHz` s. */
  selectionChanged(): void {
    const now = this.#clock.now();
    const due = this.#lastSent + this.#intervalMs;
    if (now < due) {
      if (this.#timer === null)
        this.#timer = this.#clock.setTimeout(() => {
          this.#timer = null;
          this.selectionChanged();
        }, due - now);
      return;
    }
    const s = this.#host.sync;
    const sel = this.#host.selection();
    const update: PresenceUpdate = {
      seq: s.seq,
      state: {
        selection: toConfirmed(s, sel.anchor, sel.head),
        scope: sel.scope,
        status: 'active',
      },
    };
    const key = JSON.stringify(update);
    if (key === this.#last) return;
    this.#last = key;
    this.#lastSent = now;
    this.#port.update(this.#docId, update);
  }

  end(): void {
    this.#unsubscribe();
    if (this.#timer !== null) this.#clock.clearTimeout(this.#timer);
    this.#timer = null;
  }
}
