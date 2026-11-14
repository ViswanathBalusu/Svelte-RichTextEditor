/**
 * Which collaborators' carets the layer draws (UX-027; 13 §5). A pure function over the core's
 * peer view, so the rule can be tested without a browser.
 *
 * The core maps each peer's position through the local steps. A peer whose position cannot be
 * mapped has a null caret, and then nothing of that peer is drawn: no caret, no selection and no
 * flag (UX-027 criterion 3; `PeerCaret` in core-api.ts). Rectangles are passed on unchanged.
 */
import type { PeerCaret, ShellRect } from '../core-api.ts';
import { colourSlot } from './presence.ts';

export interface PeerDrawing {
  readonly session: string;
  readonly user: string;
  /** The name the service reported, if any: the host's directory is asked first (UX-025). */
  readonly name: string | null;
  readonly status: 'active' | 'idle';
  /** The stable colour slot of the person (1 to 8); the colour only repeats the avatar's. */
  readonly slot: number;
  /** The caret's rectangle, as the core reported it: never moved or rescaled here. */
  readonly caret: ShellRect;
  /** The selection rectangles, as the core reported them. */
  readonly selection: readonly ShellRect[];
}

/** The peers that are drawn, in the order the core gave them. A peer with no caret is left out. */
export function drawnPeers(peers: readonly PeerCaret[]): PeerDrawing[] {
  const drawn: PeerDrawing[] = [];
  for (const peer of peers) {
    if (peer.caret === null) continue;
    drawn.push({
      session: peer.session,
      user: peer.user,
      name: peer.name ?? null,
      status: peer.status,
      slot: colourSlot(peer.user),
      caret: peer.caret,
      selection: peer.selection,
    });
  }
  return drawn;
}
