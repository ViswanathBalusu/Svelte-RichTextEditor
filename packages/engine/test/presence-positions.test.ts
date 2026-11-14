/**
 * Presence positions as the sender publishes them (SYN-036 criterion 1; 04 §11). The receiver's
 * mapping and holding (criteria 2 to 4) and its caret drawing (criterion 5) are not built yet.
 */
import type { PresenceUpdate } from '@docedit/protocol';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { PresenceClient, toConfirmed } from '../src/presence.ts';
import { editingSchema } from '../src/schema.ts';
import { type SyncState, initialState, local, takeCommit } from '../src/sync/state.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { posOf } from './support.ts';

const schema = editingSchema();
const limits = { maxStepsPerCommit: 500, maxCommitBytes: 1024 * 1024 };

/**
 * A sender with one commit in flight ("NEW " typed in the intro) and one queued step (a "Q" typed
 * at the start of the middle paragraph). Its confirmed document is at seq 3.
 */
function withUnconfirmed(): SyncState {
  const doc = schema.nodeFromJSON(contractDocument().doc);
  let s = initialState(doc, 3, 'inc-1');
  const first = new Transform(s.visible).insert(
    posOf(s.visible, IDS.intro) + 1,
    schema.text('NEW '),
  );
  s = local(s, first.steps, first.doc);
  s = takeCommit(s, 'c1', limits)!.state;
  const second = new Transform(s.visible).insert(posOf(s.visible, IDS.mid) + 1, schema.text('Q'));
  return local(s, second.steps, second.doc);
}

describe('presence positions of the sender (SYN-036 criterion 1)', () => {
  it('maps a visible selection back to positions in the confirmed document', () => {
    const s = withUnconfirmed();
    const intro = posOf(s.confirmed, IDS.intro) + 1;
    const inside = posOf(s.visible, IDS.intro) + 1 + 2; // inside "NEW " (unconfirmed, in flight)
    expect(toConfirmed(s, inside, inside)).toEqual({ anchor: intro, head: intro });
    const end = posOf(s.visible, IDS.intro) + 1 + 4; // just after "NEW "
    expect(toConfirmed(s, end, end)).toEqual({ anchor: intro, head: intro });
    const later = posOf(s.visible, IDS.intro) + 1 + 4 + 3; // three characters into "Hello world"
    expect(toConfirmed(s, later, later)).toEqual({ anchor: intro + 3, head: intro + 3 });
  });

  it('maps through the queued steps as well as the in-flight commit', () => {
    const s = withUnconfirmed();
    const mid = posOf(s.confirmed, IDS.mid) + 1;
    const afterQ = posOf(s.visible, IDS.mid) + 2; // after the queued "Q"
    expect(toConfirmed(s, afterQ, afterQ)).toEqual({ anchor: mid, head: mid });
  });

  it('publishes the confirmed positions with the confirmed seq, not the visible ones', () => {
    const s = withUnconfirmed();
    const sent: PresenceUpdate[] = [];
    const port = {
      update: (_docId: string, update: PresenceUpdate) => void sent.push(update),
      onPeers: () => () => {},
    };
    const clock = { now: () => 1000, setTimeout: () => 0, clearTimeout: () => {} };
    const visible = posOf(s.visible, IDS.intro) + 1 + 2;
    const host = {
      sync: s,
      selection: () => ({ anchor: visible, head: visible, scope: 'body' }),
      setPeers: () => {},
      visibleDoc: () => s.visible,
    };
    const client = new PresenceClient(port, 'doc-1', host, { clock });
    client.selectionChanged();
    client.end();
    expect(sent).toHaveLength(1);
    const intro = posOf(s.confirmed, IDS.intro) + 1;
    expect(sent[0]).toEqual({
      seq: 3,
      state: { selection: { anchor: intro, head: intro }, scope: 'body', status: 'active' },
    });
  });
});
