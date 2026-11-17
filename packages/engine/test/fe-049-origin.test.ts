/**
 * FE-049 criterion 2 (Node.js): undo and redo are submitted as ordinary commits with origin `undo`
 * or `redo` (04 §3.1). The state machine tags each queued step with its origin, copies the tag
 * through every rebase and cuts a commit where the origin changes, so one commit never mixes
 * origins. Then a real core against backend-mock (the authority's room) shows the commit that
 * crosses the channel.
 */
import { stepsToJson } from '@docedit/authority';
import type { RemoteCommit } from '@docedit/protocol';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';
import {
  type SyncState,
  initialState,
  local,
  receiveAck,
  receiveCommits,
  receiveReject,
  takeCommit,
} from '../src/sync/state.ts';
import { internals } from '../src/testing.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, join, newService, posOf, textOfNode, traffic, type, until } from './support.ts';

const schema = editingSchema();
const limits = { maxStepsPerCommit: 500, maxCommitBytes: 1024 * 1024 };
const ack = (id: string, seq: number) => ({ id, seq, serverTime: 'x', rebased: false });

const start = (): SyncState =>
  initialState(schema.nodeFromJSON(contractDocument().doc), 3, 'inc-1');

/** A local insert on the visible document, queued with `origin`. */
function typeAt(
  s: SyncState,
  id: string,
  offset: number,
  text: string,
  origin?: 'undo' | 'redo',
): SyncState {
  const tr = new Transform(s.visible).insert(posOf(s.visible, id) + 1 + offset, schema.text(text));
  return local(s, tr.steps, tr.doc, origin);
}

function remote(s: SyncState, id: string, offset: number, text: string): RemoteCommit {
  const steps = new Transform(s.confirmed).insert(
    posOf(s.confirmed, id) + 1 + offset,
    schema.text(text),
  ).steps;
  const seq = s.seq + 1;
  return {
    seq,
    kind: 'steps',
    id: `0192f0c4-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    steps: stepsToJson(steps),
    control: null,
    author: { user: 'other', session: 's2', agent: null },
    serverTime: '2026-11-06T10:00:00.000Z',
    origin: 'input',
  };
}

describe('the origin of a queued step (FE-049 criterion 2)', () => {
  it('cuts a commit where the origin changes, so that none mixes origins', () => {
    let s = typeAt(start(), IDS.intro, 0, 'a');
    s = typeAt(s, IDS.intro, 1, 'b');
    s = typeAt(s, IDS.intro, 2, 'c', 'undo');
    s = typeAt(s, IDS.intro, 3, 'd', 'undo');
    s = typeAt(s, IDS.intro, 4, 'e', 'redo');
    s = typeAt(s, IDS.intro, 5, 'f');
    const seen: { origin: string | undefined; steps: number }[] = [];
    for (let i = 1; i <= 4; i++) {
      const next = takeCommit(s, `c${i}`, limits)!;
      seen.push({ origin: next.commit.origin, steps: next.commit.steps.length });
      s = receiveAck(next.state, ack(`c${i}`, s.seq + 1), schema).state;
    }
    expect(seen).toEqual([
      { origin: undefined, steps: 2 },
      { origin: 'undo', steps: 2 },
      { origin: 'redo', steps: 1 },
      { origin: undefined, steps: 1 },
    ]);
    expect(takeCommit(s, 'c5', limits)).toBeNull();
  });

  it('a step with no origin hint is sent as before, with no origin on the commit', () => {
    const s = typeAt(start(), IDS.intro, 0, 'a');
    expect('origin' in takeCommit(s, 'c1', limits)!.commit).toBe(false);
  });

  it('keeps the origin when the authority rebases the queue over a remote commit', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x'); // in flight
    s = takeCommit(s, 'c1', limits)!.state;
    s = typeAt(s, IDS.intro, 1, 'y', 'undo');
    s = receiveCommits(s, [remote(s, IDS.intro, 5, 'R')], schema).state;
    s = receiveAck(s, ack('c1', s.seq + 1), schema).state;
    expect(takeCommit(s, 'c2', limits)!.commit.origin).toBe('undo');
  });

  it('keeps the origin when the acknowledgement carries the authority steps', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    s = takeCommit(s, 'c1', limits)!.state;
    s = typeAt(s, IDS.intro, 1, 'y', 'redo');
    const authority = new Transform(s.confirmed).insert(
      posOf(s.confirmed, IDS.intro) + 12,
      schema.text('x'),
    );
    s = receiveAck(
      s,
      { ...ack('c1', 4), rebased: true, steps: stepsToJson(authority.steps) },
      schema,
    ).state;
    expect(s.queue).toHaveLength(1);
    expect(takeCommit(s, 'c2', limits)!.commit.origin).toBe('redo');
  });

  it('keeps the origin when the in-flight commit is dropped and the queue rebuilt', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    s = takeCommit(s, 'c1', limits)!.state;
    s = typeAt(s, IDS.intro, 1, 'y', 'undo');
    s = receiveReject(s, {
      id: 'c1',
      code: 'permission_denied',
      action: 'drop',
      head: 3,
      message: 'permission_denied',
    }).state;
    expect(s.queue.length).toBeGreaterThan(0);
    expect(takeCommit(s, 'c2', limits)!.commit.origin).toBe('undo');
  });
});

describe('undo and redo cross the channel with their origin (FE-049 criterion 2)', () => {
  it('submits the undo and the redo as commits with origin undo and redo', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const ada = await join(service, docId, 'ada', 'editor');
    const bob = await join(service, docId, 'bob', 'editor');
    const settled = (c: { saveState: { get(): string } }) =>
      until(() => c.saveState.get() === 'saved', 'saved', 5000);
    traffic.clear();

    caret(ada.core, IDS.intro, 0);
    type(ada.core, 'A');
    await settled(ada.core);
    caret(bob.core, IDS.intro, 'end');
    type(bob.core, 'B');
    await settled(bob.core);
    const text = (m: typeof ada) => textOfNode(internals(m.core).state.doc, IDS.intro);
    await until(() => text(ada).endsWith('B'), 'bob arrives');
    expect(traffic.submitted.map((c) => c.origin)).toEqual([undefined, undefined]);

    traffic.clear();
    expect(ada.core.run('undo')).toBe(true);
    await settled(ada.core);
    expect(traffic.submitted).toEqual([{ origin: 'undo', steps: 1 }]);
    expect(text(ada)).toBe('Hello worldB');

    traffic.clear();
    expect(ada.core.run('redo')).toBe(true);
    await settled(ada.core);
    expect(traffic.submitted).toEqual([{ origin: 'redo', steps: 1 }]);
    expect(text(ada)).toBe('AHello worldB');
    await until(() => text(bob) === 'AHello worldB', 'bob sees it');

    ada.detach();
    bob.detach();
    await service.dispose();
  });
});
