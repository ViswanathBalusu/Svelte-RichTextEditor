/**
 * Arrivals and departures of other sessions, for the screen-reader announcements (02 §10; FE-107
 * criterion 3). The core publishes the peers this reader may see (`presence`, 04 §11, ADR 0019);
 * this module turns two successive lists into the users who arrived and who left.
 *
 * - A session is the unit: a peer is one session of a user. A user with two sessions open gives
 *   two notices, one per session. The spec does not say which; this is the reading taken here.
 * - The peers already in the document when the reader opens it are the baseline, and are not
 *   announced; later arrivals and departures are, in the order the snapshots give them. The core's
 *   list starts empty and is filled only when the backend's first `presence.state` arrives, after
 *   the reader has started watching. So the watch can start without a baseline (`null`): it then
 *   reports nothing until `settle()` gives it one. The session settles it with the core's list just
 *   after the core has taken the first `presence.state`, or, when none comes, at the end of a short
 *   opening window (`DEFAULT_PRESENCE_BASELINE_MS`). ADR 0208 records this reading.
 * - No DOM, no Svelte: the module runs in Node.js tests.
 */

/**
 * How long after the channel is attached the first `presence.state` counts as the peers already
 * there. The document service sends that list right after `ch.opened`, and only when some peer has
 * published (`services/document-service/src/data-plane/presence.ts`, `join`); with no peers it sends
 * nothing, so the window ends the wait. A provisional default, not a measurement (ADR 0208).
 */
export const DEFAULT_PRESENCE_BASELINE_MS = 500;

/** The part of a peer this module reads. `PresencePeerInfo` (engine) has these fields. */
export interface PeerLike {
  readonly session: string;
  readonly user: string;
}

export type PresenceChange = 'arrived' | 'left';

/** The users behind the sessions that arrived in `after` and left `before`, each in list order. */
export function presenceChanges(
  before: readonly PeerLike[],
  after: readonly PeerLike[],
): { arrived: string[]; left: string[] } {
  const was = new Set(before.map((peer) => peer.session));
  const now = new Set(after.map((peer) => peer.session));
  const arrived = after.filter((peer) => !was.has(peer.session)).map((peer) => peer.user);
  const left = before.filter((peer) => !now.has(peer.session)).map((peer) => peer.user);
  return { arrived, left };
}

/**
 * Watches the peer list and reports each change once. The baseline is the list given to the
 * constructor, or, when that is `null`, the list given to the first `settle()`; until then
 * `update()` reports nothing.
 */
export class PresenceWatch {
  #seen: readonly PeerLike[] | null;
  readonly #report: (change: PresenceChange, user: string) => void;

  constructor(
    initial: readonly PeerLike[] | null,
    report: (change: PresenceChange, user: string) => void,
  ) {
    this.#seen = initial === null ? null : copy(initial);
    this.#report = report;
  }

  /** Whether the baseline is set. */
  get settled(): boolean {
    return this.#seen !== null;
  }

  /** Takes `peers` as the baseline, without reporting them. Does nothing once settled. */
  settle(peers: readonly PeerLike[]): void {
    if (this.#seen === null) this.#seen = copy(peers);
  }

  /** Takes a new snapshot of the peers and reports what changed since the last one. */
  update(peers: readonly PeerLike[]): void {
    if (this.#seen === null) return;
    const { arrived, left } = presenceChanges(this.#seen, peers);
    this.#seen = copy(peers);
    for (const user of arrived) this.#report('arrived', user);
    for (const user of left) this.#report('left', user);
  }
}

function copy(peers: readonly PeerLike[]): PeerLike[] {
  return peers.map((peer) => ({ session: peer.session, user: peer.user }));
}
