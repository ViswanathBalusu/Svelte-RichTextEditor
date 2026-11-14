/**
 * SYN-036 criterion 5 (lane U-SYN-019-036): a sender types text that is not yet confirmed and
 * publishes its caret inside it. A receiver that places the update must never put the caret inside
 * text the receiver does not have: the position is the confirmed insertion point, which exists in
 * the receiver's confirmed document at the update's seq (04 §11).
 */
import fc from 'fast-check';
import type { PresencePeers, PresenceUpdate } from '@docedit/protocol';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { PresenceClient } from '../src/presence.ts';
import { editingSchema } from '../src/schema.ts';
import { type SyncState, initialState, local, takeCommit } from '../src/sync/state.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { posOf } from './support.ts';

const schema = editingSchema();
const limits = { maxStepsPerCommit: 500, maxCommitBytes: 1024 * 1024 };
const SEQ = 3;
const clock = { now: () => 1000, setTimeout: () => 0, clearTimeout: () => {} };

/** A sender: `typed` is in flight (unconfirmed), and `queued` is a local step behind it. */
function sender(typed: string, queued: string): SyncState {
  const doc = schema.nodeFromJSON(contractDocument().doc);
  let s = initialState(doc, SEQ, 'inc-1');
  const first = new Transform(s.visible).insert(
    posOf(s.visible, IDS.intro) + 1,
    schema.text(typed),
  );
  s = local(s, first.steps, first.doc);
  s = takeCommit(s, 'c1', limits)!.state;
  const second = new Transform(s.visible).insert(
    posOf(s.visible, IDS.mid) + 1,
    schema.text(queued),
  );
  return local(s, second.steps, second.doc);
}

/** The update the sender publishes for a visible caret at `caret`. */
function publish(s: SyncState, caret: number): PresenceUpdate {
  const sent: PresenceUpdate[] = [];
  const port = {
    update: (_docId: string, update: PresenceUpdate) => void sent.push(update),
    onPeers: () => () => {},
  };
  const host = {
    sync: s,
    selection: () => ({ anchor: caret, head: caret, scope: 'body' }),
    setPeers: () => {},
    visibleDoc: () => s.visible,
  };
  const client = new PresenceClient(port, 'doc-1', host, { clock });
  client.selectionChanged();
  client.end();
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

/** A receiver whose confirmed document is the same as the sender's at seq 3, with no unconfirmed text. */
function receiver() {
  const state: SyncState = initialState(schema.nodeFromJSON(contractDocument().doc), SEQ, 'inc-1');
  let deliver: (s: PresencePeers) => void = () => {};
  const host = {
    sync: state,
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
  const client = new PresenceClient(port, 'doc-2', host, { clock });
  return {
    client,
    doc: state.confirmed,
    send(update: PresenceUpdate) {
      deliver({
        peers: [
          {
            session: 'sender',
            user: { id: 'user-sender' },
            seq: update.seq,
            state: update.state,
          },
        ],
        left: [],
      });
    },
  };
}

describe('a caret inside unconfirmed text (SYN-036 criterion 5)', () => {
  it('is drawn at the confirmed insertion point, never inside text the receiver does not have', () => {
    const typed = 'NEW ';
    const s = sender(typed, 'Q');
    const caret = posOf(s.visible, IDS.intro) + 1 + 2; // inside "NEW " (unconfirmed)
    const r = receiver();
    r.send(publish(s, caret));

    const placed = r.client.positionsOf('sender');
    expect(placed).toBeDefined();
    const insertion = posOf(r.doc, IDS.intro) + 1;
    expect(placed).toEqual({ anchor: insertion, head: insertion, seq: SEQ });
    // The receiver holds only the confirmed document: no unconfirmed text is in it.
    expect(r.doc.eq(s.confirmed)).toBe(true);
    const at = r.doc.resolve(placed!.anchor);
    expect(at.parent.isTextblock).toBe(true);
  });

  it('holds for every caret inside the unconfirmed text (property)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z]{1,8}$/),
        fc.integer({ min: 0, max: 8 }),
        (typed, offset) => {
          const s = sender(typed, 'Q');
          const clamped = Math.min(offset, typed.length);
          const caret = posOf(s.visible, IDS.intro) + 1 + clamped;
          const r = receiver();
          r.send(publish(s, caret));
          const placed = r.client.positionsOf('sender');
          const insertion = posOf(r.doc, IDS.intro) + 1;
          expect(placed).toEqual({ anchor: insertion, head: insertion, seq: SEQ });
          expect(r.doc.eq(s.confirmed)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a caret behind a queued, unconfirmed step is drawn at its confirmed position too', () => {
    const s = sender('NEW ', 'Q');
    const afterQ = posOf(s.visible, IDS.mid) + 2; // after the queued "Q"
    const r = receiver();
    r.send(publish(s, afterQ));
    const mid = posOf(r.doc, IDS.mid) + 1;
    expect(r.client.positionsOf('sender')).toEqual({ anchor: mid, head: mid, seq: SEQ });
    expect(r.doc.eq(s.confirmed)).toBe(true);
  });
});
