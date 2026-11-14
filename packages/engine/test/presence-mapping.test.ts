/**
 * The receiver's side of presence (SYN-036 criteria 2 to 4): a peer's positions are mapped through
 * the confirmed steps applied since their seq, an update from a later seq is held until the receiver
 * reaches it, and an update older than the retained history is dropped.
 */
import fc from 'fast-check';
import type { PresencePeers } from '@docedit/protocol';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { type PresenceHost, PresenceClient } from '../src/presence.ts';
import { editingSchema } from '../src/schema.ts';
import { type Confirmed, type SyncState, initialState } from '../src/sync/state.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { posOf } from './support.ts';

const schema = editingSchema();
type Peer = PresencePeers['peers'][number];

/** The caret position inside the intro paragraph's text, a few characters in. */
function introCaret(doc: ReturnType<typeof schema.nodeFromJSON>, offset = 4): number {
  return posOf(doc, IDS.intro) + 1 + offset;
}

/**
 * A receiver whose confirmed document starts at `seq`. `advance` applies a confirmed change (text
 * typed at `at`) and reports it to the client as the sync client would.
 */
function receiver(seq: number, historyCommits?: number) {
  let state: SyncState = initialState(schema.nodeFromJSON(contractDocument().doc), seq, 'inc-1');
  let deliver: (s: PresencePeers) => void = () => {};
  const host: PresenceHost = {
    get sync() {
      return state;
    },
    selection: () => ({ anchor: 1, head: 1, scope: 'body' }),
    setPeers: () => {},
    visibleDoc: () => state.visible,
  };
  const port = {
    update: () => {},
    onPeers: (_docId: string, cb: (s: PresencePeers) => void) => {
      deliver = cb;
      return () => {};
    },
  };
  const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };
  const client = new PresenceClient(port, 'doc-1', host, {
    clock,
    ...(historyCommits !== undefined ? { historyCommits } : {}),
  });
  return {
    client,
    get doc() {
      return state.confirmed;
    },
    send(peers: Peer[]) {
      deliver({ peers, left: [] });
    },
    advance(to: number, at: number, text: string): Confirmed {
      const tr = new Transform(state.confirmed).insert(at, schema.text(text));
      state = initialState(tr.doc, to, 'inc-1');
      const change: Confirmed = { from: to - 1, to, steps: tr.steps };
      client.confirmed([change]);
      return change;
    },
    /** A reset or reload: the confirmed document is replaced as a whole (no steps to map through). */
    replace(to: number) {
      state = initialState(state.confirmed, to, 'inc-2');
      client.confirmed([{ from: to - 1, to, steps: null }]);
    },
  };
}

function peerAt(session: string, seq: number, pos: number): Peer {
  return {
    session,
    user: { id: `user-${session}` },
    seq,
    state: { selection: { anchor: pos, head: pos }, scope: 'body', status: 'active' },
  };
}

describe('presence mapping at the receiver (SYN-036 criterion 2)', () => {
  it('maps a peer caret through the confirmed steps applied since its seq', () => {
    const r = receiver(3);
    const caret = introCaret(r.doc);
    r.send([peerAt('p2', 3, caret)]);
    expect(r.client.positionsOf('p2')).toEqual({ anchor: caret, head: caret, seq: 3 });
    // Three characters typed before the peer's caret, confirmed at seq 4.
    r.advance(4, posOf(r.doc, IDS.intro) + 1, 'abc');
    expect(r.client.positionsOf('p2')).toEqual({
      anchor: caret + 3,
      head: caret + 3,
      seq: 4,
    });
  });

  it('keeps the mapping correct over many confirmed changes (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{1,4}$/), { minLength: 1, maxLength: 12 }),
        (inserts) => {
          const r = receiver(3, 256);
          const caret = introCaret(r.doc);
          r.send([peerAt('p2', 3, caret)]);
          let to = 3;
          for (const text of inserts) {
            to += 1;
            r.advance(to, posOf(r.doc, IDS.intro) + 1, text);
          }
          const shift = inserts.reduce((n, t) => n + t.length, 0);
          expect(r.client.positionsOf('p2')).toEqual({
            anchor: caret + shift,
            head: caret + shift,
            seq: to,
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('held updates from a later seq (SYN-036 criterion 3)', () => {
  it('holds an update until the receiver reaches its seq, then places it unmapped', () => {
    const r = receiver(3);
    const caret = introCaret(r.doc);
    r.send([peerAt('p2', 5, caret)]);
    expect(r.client.positionsOf('p2')).toBeUndefined();
    r.advance(4, posOf(r.doc, IDS.intro) + 1, 'x');
    expect(r.client.positionsOf('p2')).toBeUndefined();
    // Reaching seq 5 places it; the update was made at 5, so no mapping is needed.
    r.advance(5, posOf(r.doc, IDS.intro) + 1, 'y');
    expect(r.client.positionsOf('p2')).toEqual({ anchor: caret, head: caret, seq: 5 });
  });
});

describe('updates older than the retained history (SYN-036 criterion 4)', () => {
  it('drops an update older than the retained mapping history', () => {
    const r = receiver(3, 2);
    const caret = introCaret(r.doc);
    for (let to = 4; to <= 6; to++) r.advance(to, posOf(r.doc, IDS.intro) + 1, 'z');
    // Two commits are retained (5 and 6), so mapping from seq 3 is no longer possible.
    r.send([peerAt('old', 3, caret)]);
    expect(r.client.positionsOf('old')).toBeUndefined();
    // An update from a seq the history still covers is placed and mapped.
    // Its caret was at seq 5, after two 'z' typed before it; seq 6 adds one more before it.
    const at5 = caret + 2;
    r.send([peerAt('recent', 5, at5)]);
    expect(r.client.positionsOf('recent')).toEqual({ anchor: at5 + 1, head: at5 + 1, seq: 6 });
  });

  it('drops an update older than a reset, and clears placed positions at the reset', () => {
    const r = receiver(3);
    const caret = introCaret(r.doc);
    r.send([peerAt('p2', 3, caret)]);
    expect(r.client.positionsOf('p2')).toBeDefined();
    r.replace(5);
    expect(r.client.positionsOf('p2')).toBeUndefined();
    r.send([peerAt('p2', 3, caret)]);
    expect(r.client.positionsOf('p2')).toBeUndefined();
    r.send([peerAt('p2', 5, caret)]);
    expect(r.client.positionsOf('p2')).toEqual({ anchor: caret, head: caret, seq: 5 });
  });
});
