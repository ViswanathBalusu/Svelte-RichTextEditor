/**
 * A confirmed step that fails to apply is a no-op (04 §14; SYN-045), at the state machine: the
 * confirmed document, the sequence number, the in-flight and queued steps and the event recorded.
 * Commits are written by hand in the shape of 05 §5.3.
 */
import { stepsToJson } from '@docedit/authority';
import type { RemoteCommit } from '@docedit/protocol';
import { ReplaceStep, Transform } from 'prosemirror-transform';
import { Slice } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';
import {
  type SyncState,
  initialState,
  local,
  receiveCommits,
  takeCommit,
} from '../src/sync/state.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { posOf } from './support.ts';

const schema = editingSchema();
const limits = { maxStepsPerCommit: 500, maxCommitBytes: 1024 * 1024 };

/** A step that cannot apply to any document of the fixture's size. */
const unappliable = new ReplaceStep(
  9999,
  9999,
  Slice.empty,
).toJSON() as RemoteCommit['steps'][number];

function start(): SyncState {
  const doc = schema.nodeFromJSON(contractDocument().doc);
  return initialState(doc, 3, 'inc-1');
}

/** A local insert on the visible document. */
function typeAt(s: SyncState, id: string, offset: number, text: string): SyncState {
  const tr = new Transform(s.visible).insert(posOf(s.visible, id) + 1 + offset, schema.text(text));
  return local(s, tr.steps, tr.doc);
}

/** A commit of another user with the given steps, as JSON. */
function commitWith(seq: number, steps: RemoteCommit['steps']): RemoteCommit {
  return {
    seq,
    kind: 'steps',
    id: `0192f0c4-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    steps,
    control: null,
    author: { user: 'other', session: 's2', agent: null },
    serverTime: '2026-11-06T10:00:00.000Z',
    origin: 'input',
  };
}

/** A commit of another user that inserts `text` at the start of the intro paragraph. */
function insertCommit(s: SyncState, seq: number, text: string): RemoteCommit {
  const steps = new Transform(s.confirmed).insert(
    posOf(s.confirmed, IDS.intro) + 1,
    schema.text(text),
  ).steps;
  return commitWith(seq, stepsToJson(steps));
}

const text = (doc: SyncState['confirmed'], id: string) => doc.nodeAt(posOf(doc, id))!.textContent;

describe('a confirmed step that does not apply (SYN-045)', () => {
  it('is a no-op: the seq advances, the confirmed document is kept and the event is recorded', () => {
    const s = start();
    const t = receiveCommits(s, [commitWith(4, [unappliable])], schema);
    expect(t.state.seq).toBe(4);
    expect(t.state.confirmed.eq(s.confirmed)).toBe(true);
    expect(t.actions).toContainEqual(expect.objectContaining({ t: 'report', code: 'step_failed' }));
  });

  it('continues with the next commit after a skipped one', () => {
    const s = start();
    const after4 = receiveCommits(s, [commitWith(4, [unappliable])], schema).state;
    const t = receiveCommits(after4, [insertCommit(after4, 5, 'b')], schema);
    expect(t.state.seq).toBe(5);
    expect(text(t.state.confirmed, IDS.intro)).toBe('bHello world');
  });

  it('applies the steps of the commit that do apply and reports the number skipped', () => {
    const s = start();
    const good = insertCommit(s, 4, 'b').steps;
    const t = receiveCommits(s, [commitWith(4, [unappliable, ...good])], schema);
    expect(t.state.seq).toBe(4);
    expect(text(t.state.confirmed, IDS.intro)).toBe('bHello world');
    expect(t.actions).toContainEqual({
      t: 'report',
      code: 'step_failed',
      message: '1 confirmed step of commit 4 did not apply and were treated as no-ops (04 §14)',
    });
  });

  it('gives the same document to every client that receives it (state level)', () => {
    const a = receiveCommits(start(), [commitWith(4, [unappliable])], schema).state;
    const b = receiveCommits(start(), [commitWith(4, [unappliable])], schema).state;
    expect(a.confirmed.eq(b.confirmed)).toBe(true);
    expect(a.seq).toBe(b.seq);
  });

  it('rebases the in-flight and queued steps over a skipped commit', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    s = takeCommit(s, 'c1', limits)!.state; // in flight
    s = typeAt(s, IDS.intro, 1, 'y'); // queued
    const t = receiveCommits(s, [commitWith(4, [unappliable])], schema);
    expect(t.state.seq).toBe(4);
    expect(t.state.inflight?.id).toBe('c1');
    expect(text(t.state.visible, IDS.intro)).toBe('xyHello world');
    expect(t.state.confirmed.eq(s.confirmed)).toBe(true);
  });
});
