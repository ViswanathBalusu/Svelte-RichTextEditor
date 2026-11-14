/**
 * UX-104 criterion 3 (lane U-UX-091-104): a collaborator working inside hidden content has no
 * name flag in the presence list the shell shows, and nothing is published for them to the
 * reader's view (ADR 0019). The caret layer (`core.carets`) is not produced by any core yet, so
 * only the list is checked here; a caret view must reuse the same filter when it is built.
 */
import type { PresencePeers, PresencePeer } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { PresencePeerInfo } from '../src/api.ts';
import { PresenceClient } from '../src/presence.ts';
import { editingSchema } from '../src/schema.ts';
import { initialState } from '../src/sync/state.ts';
import { SPIKE_IDS, projectedDocument } from './fixtures.ts';
import { posOf } from './support.ts';

const schema = editingSchema();

function peer(session: string, scope: string, at: number): PresencePeer {
  return {
    session,
    user: { id: `u-${session}`, name: `Person ${session}` } as PresencePeer['user'],
    seq: 0,
    state: {
      selection: { anchor: at, head: at },
      scope,
      status: 'active',
    },
  };
}

function setup() {
  const doc = schema.nodeFromJSON(projectedDocument('Clause').doc);
  const sync = initialState(doc, 0, 'inc-u-ux-104');
  // The placeholder is the hidden region; a position just inside it is in hidden content.
  const inside = posOf(doc, SPIKE_IDS.region) + 1;
  let listener: ((state: PresencePeers) => void) | null = null;
  const port = {
    update: () => undefined,
    onPeers: (_docId: string, cb: (state: PresencePeers) => void) => {
      listener = cb;
      return () => undefined;
    },
  };
  const shown: PresencePeerInfo[][] = [];
  const host = {
    sync,
    selection: () => ({ anchor: 1, head: 1, scope: 'body' }),
    setPeers: (list: readonly PresencePeerInfo[]) => void shown.push([...list]),
    visibleDoc: () => doc,
  };
  const clock = { now: () => 1000, setTimeout: () => 0, clearTimeout: () => {} };
  const client = new PresenceClient(port as never, 'doc-u-ux-104', host, { clock, session: 'me' });
  const deliver = (peers: PresencePeer[]) => listener?.({ peers, left: [] });
  return { client, deliver, shown, inside };
}

describe('hidden content has no peer in the presence list (UX-104 criterion 3)', () => {
  it('lists a peer in the body but not one whose scope is a hidden region', () => {
    const { deliver, shown, inside } = setup();
    deliver([peer('inHidden', `region:${SPIKE_IDS.region}`, inside), peer('inBody', 'body', 1)]);
    const last = shown.at(-1) ?? [];
    expect(last.map((p) => p.session)).toEqual(['inBody']);
    expect(last.some((p) => p.name === 'Person inHidden')).toBe(false);
  });

  it('keeps a peer out of the list while it stays in hidden content, and adds it once it leaves', () => {
    const { deliver, shown, inside } = setup();
    deliver([peer('mover', `region:${SPIKE_IDS.region}`, inside)]);
    expect(shown.at(-1)).toEqual([]);
    deliver([peer('mover', 'body', 1)]);
    expect(shown.at(-1)?.map((p) => p.session)).toEqual(['mover']);
  });
});
