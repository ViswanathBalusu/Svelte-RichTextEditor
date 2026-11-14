/**
 * A reload sets unconfirmed work aside as recovered edits (ADR 0019 item 6; SYN-053 criterion 3),
 * at the state machine: the in-flight commit and the queued steps are discarded with the reason
 * `reload`, and the document becomes the content at the head.
 */
import type { Content } from '@docedit/protocol';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';
import { type SyncState, initialState, local, reload, takeCommit } from '../src/sync/state.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { posOf } from './support.ts';

const schema = editingSchema();
const limits = { maxStepsPerCommit: 500, maxCommitBytes: 1024 * 1024 };

function start(): SyncState {
  return initialState(schema.nodeFromJSON(contractDocument().doc), 3, 'inc-1');
}

/** A local insert on the visible document. */
function typeAt(s: SyncState, id: string, offset: number, text: string): SyncState {
  const tr = new Transform(s.visible).insert(posOf(s.visible, id) + 1 + offset, schema.text(text));
  return local(s, tr.steps, tr.doc);
}

describe('unconfirmed work at a reload (SYN-053)', () => {
  it('goes to recovered edits with the reason reload, in-flight first then queued', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    s = takeCommit(s, 'c1', limits)!.state; // in flight
    s = typeAt(s, IDS.intro, 1, 'y'); // queued
    const content = {
      ...(contractDocument() as unknown as Content),
      seq: 9,
      incarnation: 'inc-1',
    } as Content;
    const t = reload(s, content, schema, undefined, false);
    expect(t.state.seq).toBe(9);
    // The in-flight and the queued steps are set aside together, as one recovered item.
    expect(t.state.discarded).toHaveLength(1);
    expect(t.state.discarded.every((d) => d.reason === 'reload')).toBe(true);
    const recovered = t.state.discarded.map((d) => d.text).join('|');
    expect(recovered).toContain('x');
    expect(recovered).toContain('y');
    expect(t.state.visible.eq(t.state.confirmed)).toBe(true);
  });
});
