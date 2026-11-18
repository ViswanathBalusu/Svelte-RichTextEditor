/**
 * The client state machine (04 §7 to §9; SYN-017 to SYN-020), step by step, without a backend.
 * Commits, acknowledgements and rejections are written by hand in the shapes of 05 §5.3.
 */
import { stepsToJson } from '@docedit/authority';
import type { Content, RemoteCommit, SyncReject } from '@docedit/protocol';
import { ReplaceStep, Transform } from 'prosemirror-transform';
import { Slice } from 'prosemirror-model';
import type { Node } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { editingSchema } from '../src/schema.ts';
import {
  type SyncState,
  initialState,
  local,
  opened,
  caughtUp,
  receiveAck,
  receiveCommits,
  receiveReject,
  reload,
  reset,
  resendCommit,
  settled,
  takeCommit,
  unconfirmed,
} from '../src/sync/state.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { posOf } from './support.ts';

const schema = editingSchema();
const limits = { maxStepsPerCommit: 500, maxCommitBytes: 1024 * 1024 };

function start(): SyncState {
  const doc = schema.nodeFromJSON(contractDocument().doc);
  return initialState(doc, 3, 'inc-1');
}

/** A local insert on the visible document. */
function typeAt(s: SyncState, id: string, offset: number, text: string): SyncState {
  const tr = new Transform(s.visible).insert(posOf(s.visible, id) + 1 + offset, schema.text(text));
  return local(s, tr.steps, tr.doc);
}

/** A commit of another user, made on the confirmed document. */
function remote(
  s: SyncState,
  id: string,
  offset: number,
  text: string,
  seq = s.seq + 1,
): RemoteCommit {
  const steps = text
    ? new Transform(s.confirmed).insert(posOf(s.confirmed, id) + 1 + offset, schema.text(text))
        .steps
    : [];
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

const text = (doc: Node, id: string) => doc.nodeAt(posOf(doc, id))!.textContent;

const reject = (
  id: string,
  code: SyncReject['code'],
  action: SyncReject['action'],
  head = 3,
): SyncReject => ({
  id,
  code,
  action,
  head,
  message: code,
});

describe('confirmed document and rebuilds (SYN-017)', () => {
  it('keeps a confirmed document separate from the visible state', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    expect(text(s.confirmed, IDS.intro)).toBe('Hello world');
    expect(text(s.visible, IDS.intro)).toBe('xHello world');
    expect(unconfirmed(s)).toHaveLength(1);
    s = takeCommit(s, 'c1', limits)!.state;
    expect(text(s.confirmed, IDS.intro)).toBe('Hello world');
  });

  it('an acknowledgement without rebase applies its own steps and changes nothing visible', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    const sent = takeCommit(s, 'c1', limits)!;
    s = sent.state;
    const visible = s.visible;
    const t = receiveAck(s, { id: 'c1', seq: 4, serverTime: 'x', rebased: false }, schema);
    expect(t.effect).toBeNull(); // 04 §7: equal steps, a no-op
    expect(t.state.seq).toBe(4);
    expect(t.state.inflight).toBeNull();
    expect(t.state.confirmed.eq(visible)).toBe(true);
    expect(t.state.visible).toBe(visible);
  });

  it('an acknowledgement with rebase applies the authority steps, and the queue is rebuilt', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    s = takeCommit(s, 'c1', limits)!.state;
    s = typeAt(s, IDS.intro, 1, 'y'); // queued behind the in-flight commit
    // The authority placed our insert at the end instead (as if mapped over something).
    const authority = new Transform(s.confirmed).insert(
      posOf(s.confirmed, IDS.intro) + 12,
      schema.text('x'),
    );
    const t = receiveAck(
      s,
      { id: 'c1', seq: 4, serverTime: 'x', rebased: true, steps: stepsToJson(authority.steps) },
      schema,
    );
    expect(t.effect?.kind).toBe('rebuild');
    expect(text(t.state.confirmed, IDS.intro)).toBe('Hello worldx');
    // The queued `y` was made after our `x` at offset 0, so it maps through the change.
    expect(text(t.state.visible, IDS.intro)).toBe('yHello worldx');
    expect(t.state.queue).toHaveLength(1);
  });

  it('rebuilds from the confirmed document: overlapping mark steps end equal to the authority', () => {
    // Local: bold over "Hello"; remote: bold over "lo wor" (overlap), then our commit is refused.
    let s = start();
    const p = posOf(s.visible, IDS.intro) + 1;
    const bold = schema.marks['bold']!.create({ value: true });
    const mine = new Transform(s.visible).addMark(p, p + 5, bold);
    s = local(s, mine.steps, mine.doc);
    s = takeCommit(s, 'c1', limits)!.state;
    const theirs = new Transform(s.confirmed).addMark(p + 3, p + 9, bold).steps;
    const c: RemoteCommit = { ...remote(s, IDS.intro, 0, ''), steps: stepsToJson(theirs) };
    s = receiveCommits(s, [c], schema).state;
    const dropped = receiveReject(s, reject('c1', 'permission_denied', 'drop', 4));
    // The visible document is the confirmed one (theirs applied), never "ours undone by inverse".
    expect(dropped.state.visible.eq(dropped.state.confirmed)).toBe(true);
    const expected = new Transform(schema.nodeFromJSON(contractDocument().doc)).addMark(
      p + 3,
      p + 9,
      bold,
    ).doc;
    expect(dropped.state.confirmed.eq(expected)).toBe(true);
  });
});

describe('one commit in flight (SYN-018)', () => {
  it('sends the queue with base equal to the confirmed seq and keeps one in flight', () => {
    let s = typeAt(start(), IDS.intro, 0, 'a');
    const first = takeCommit(s, 'c1', limits)!;
    expect(first.commit).toMatchObject({ id: 'c1', base: 3 });
    s = typeAt(first.state, IDS.intro, 1, 'b');
    expect(takeCommit(s, 'c2', limits)).toBeNull(); // at most one in flight
    s = receiveAck(s, { id: 'c1', seq: 4, serverTime: 'x', rebased: false }, schema).state;
    const second = takeCommit(s, 'c2', limits)!;
    expect(second.commit.base).toBe(4);
    expect(second.commit.steps).toHaveLength(1);
  });

  it('splits a queue larger than the limits into successive commits', () => {
    let s = start();
    for (let i = 0; i < 7; i++) s = typeAt(s, IDS.intro, 0, String(i));
    const byCount = takeCommit(s, 'c1', { maxStepsPerCommit: 3, maxCommitBytes: 1 << 20 })!;
    expect(byCount.commit.steps).toHaveLength(3);
    expect(byCount.state.queue).toHaveLength(4);
    const size = JSON.stringify({
      id: 'c1',
      base: 3,
      steps: stepsToJson(s.queue.slice(0, 2)),
    }).length;
    const byBytes = takeCommit(s, 'c1', { maxStepsPerCommit: 500, maxCommitBytes: size })!;
    expect(byBytes.commit.steps).toHaveLength(2);
    expect(JSON.stringify(byBytes.commit).length).toBeLessThanOrEqual(size);
  });

  it('a resent commit keeps its id, base and original steps', () => {
    let s = typeAt(start(), IDS.intro, 0, 'a');
    const sent = takeCommit(s, 'c1', limits)!;
    s = sent.state;
    // A remote commit arrives first: our local copy is rebased, the sent steps are not.
    s = receiveCommits(s, [remote(s, IDS.intro, 0, 'R')], schema).state;
    s = receiveReject(s, reject('c1', 'unavailable', 'retry')).state;
    const again = resendCommit(s)!;
    expect(again.commit).toEqual(sent.commit);
  });
});

describe('remote commits and gaps (SYN-019)', () => {
  it('applies a commit to the confirmed document and rebases in-flight and queued steps', () => {
    let s = typeAt(start(), IDS.intro, 5, '1');
    s = takeCommit(s, 'c1', limits)!.state;
    s = typeAt(s, IDS.intro, 6, '2');
    const t = receiveCommits(s, [remote(s, IDS.intro, 0, '>>')], schema);
    expect(t.state.seq).toBe(4);
    expect(text(t.state.confirmed, IDS.intro)).toBe('>>Hello world');
    expect(text(t.state.visible, IDS.intro)).toBe('>>Hello12 world');
    expect(t.state.inflight!.local).toHaveLength(1);
    expect(t.state.queue).toHaveLength(1);
  });

  it('a commit that is not the next seq is a gap: reconnect, nothing applied', () => {
    const s = start();
    const t = receiveCommits(s, [remote(s, IDS.intro, 0, 'x', 5)], schema);
    expect(t.actions).toEqual([{ t: 'reconnect', reason: 'gap: commit 5 after 3' }]);
    expect(t.state).toBe(s);
  });

  it('several commits in one message are applied in ascending seq, each checked', () => {
    const s = typeAt(start(), IDS.mid, 0, 'L');
    const c4 = remote(s, IDS.intro, 0, 'a');
    const after4 = receiveCommits(s, [c4], schema).state;
    const c5 = remote(after4, IDS.intro, 0, 'b');
    const t = receiveCommits(s, [c4, c5], schema);
    expect(t.state.seq).toBe(5);
    expect(text(t.state.visible, IDS.intro)).toBe('baHello world');
    expect(text(t.state.visible, IDS.mid)).toBe('LBetween');
    const gap = receiveCommits(s, [c4, { ...c5, seq: 7 }], schema);
    expect(gap.state.seq).toBe(4);
    expect(gap.actions.some((a) => a.t === 'reconnect')).toBe(true);
  });

  it('a local step whose content another user removed is dropped and kept as recovered edit', () => {
    let s = start();
    s = typeAt(s, IDS.intro, 6, 'NEW');
    s = typeAt(s, IDS.mid, 0, 'K'); // the rest of the local work, which stays
    const at = posOf(s.confirmed, IDS.intro) + 1;
    const del = new Transform(s.confirmed).delete(at + 2, at + 9).steps;
    const t = receiveCommits(
      s,
      [{ ...remote(s, IDS.intro, 0, ''), steps: stepsToJson(del) }],
      schema,
    );
    // Our insert lay inside the deleted range: it maps to nothing, as in ProseMirror's collab, so it
    // is dropped; the user is told through the recovered edits (UX-016, UX-017).
    expect(text(t.state.visible, IDS.intro)).toBe('Held');
    expect(text(t.state.visible, IDS.mid)).toBe('KBetween');
    expect(t.state.queue).toHaveLength(1);
    expect(t.state.discarded.map((d) => [d.reason, d.text])).toEqual([['rebase', 'NEW']]);
    expect(t.actions.some((a) => a.t === 'discarded')).toBe(true);
    // A mark step on deleted text maps to nothing and is dropped too.
    let m = start();
    const p = posOf(m.visible, IDS.intro) + 1;
    const mark = new Transform(m.visible).addMark(p + 3, p + 5, schema.marks['bold']!.create());
    m = local(m, mark.steps, mark.doc);
    const wipe = new Transform(m.confirmed).delete(p, p + 11).steps;
    const dropped = receiveCommits(
      m,
      [{ ...remote(m, IDS.intro, 0, ''), steps: stepsToJson(wipe) }],
      schema,
    );
    expect(dropped.state.queue).toHaveLength(0);
    expect(dropped.actions.some((a) => a.t === 'discarded')).toBe(true);
    expect(dropped.state.discarded).toHaveLength(1);
  });

  it('our own commit in the stream is the acknowledgement', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    const sent = takeCommit(s, 'c1', limits)!;
    s = sent.state;
    const own: RemoteCommit = {
      ...remote(s, IDS.intro, 0, ''),
      id: 'c1',
      steps: sent.commit.steps,
    };
    const t = receiveCommits(s, [own], schema);
    expect(t.state.inflight).toBeNull();
    expect(t.state.seq).toBe(4);
    expect(t.effect).toBeNull();
    expect(t.actions).toContainEqual({ t: 'acknowledged', id: 'c1', seq: 4 });
  });

  it('a control commit advances the seq and changes no content', () => {
    const s = typeAt(start(), IDS.intro, 0, 'x');
    const control: RemoteCommit = {
      ...remote(s, IDS.intro, 0, ''),
      kind: 'control',
      steps: [],
      control: { type: 'grants', rev: 2 },
    };
    const t = receiveCommits(s, [control], schema);
    expect(t.state.seq).toBe(4);
    expect(t.effect).toBeNull();
    expect(t.state.visible).toBe(s.visible);
    expect(t.state.confirmed).toBe(s.confirmed);
  });
});

describe('rejections by code and action (SYN-020)', () => {
  const inFlight = (): SyncState => {
    const s = typeAt(start(), IDS.intro, 0, 'x');
    return typeAt(takeCommit(s, 'c1', limits)!.state, IDS.mid, 0, 'q');
  };

  it('rebase: waits for the head, then resends the rebased steps as a new commit', () => {
    let s = inFlight();
    s = receiveReject(s, reject('c1', 'stale_base', 'rebase', 5)).state;
    expect(s.inflight).toBeNull();
    expect(s.queue).toHaveLength(2);
    expect(takeCommit(s, 'c2', limits)).toBeNull(); // confirmed seq 3 < head 5
    s = receiveCommits(s, [remote(s, IDS.end, 0, 'r')], schema).state;
    s = receiveCommits(s, [remote(s, IDS.end, 0, 's')], schema).state;
    const next = takeCommit(s, 'c2', limits)!;
    expect(next.commit).toMatchObject({ id: 'c2', base: 5 });
    expect(next.commit.steps).toHaveLength(2);
  });

  it('permission_denied: discards, rebuilds from the confirmed document plus later steps, keeps recovered edits, refreshes permissions', () => {
    const t = receiveReject(inFlight(), reject('c1', 'permission_denied', 'drop'));
    expect(text(t.state.visible, IDS.intro)).toBe('Hello world');
    expect(text(t.state.visible, IDS.mid)).toBe('qBetween');
    expect(t.state.discarded.map((d) => [d.reason, d.commit, d.text])).toEqual([
      ['permission_denied', 'c1', 'x'],
    ]);
    expect(t.actions.map((a) => a.t)).toEqual(['discarded', 'refresh-permissions']);
    expect(t.effect?.kind).toBe('rebuild');
  });

  it('invalid_op: drop discards the steps; reload discards local state and reloads', () => {
    const drop = receiveReject(inFlight(), reject('c1', 'invalid_op', 'drop'));
    expect(drop.state.inflight).toBeNull();
    expect(drop.state.queue).toHaveLength(1);
    const again = receiveReject(inFlight(), reject('c1', 'invalid_op', 'reload'));
    expect(settled(again.state)).toBe(true);
    expect(again.state.visible.eq(again.state.confirmed)).toBe(true);
    expect(again.actions.map((a) => a.t)).toEqual(['discarded', 'reload']);
  });

  it('too_large: splits the change and resubmits; a single step is reported', () => {
    let s = typeAt(start(), IDS.intro, 0, 'a');
    s = typeAt(s, IDS.intro, 0, 'b');
    s = takeCommit(s, 'c1', limits)!.state;
    const t = receiveReject(s, reject('c1', 'too_large', 'drop'));
    expect(t.actions).toEqual([{ t: 'split', maxSteps: 1 }]);
    expect(t.state.queue).toHaveLength(2);
    const one = takeCommit(t.state, 'c2', { maxStepsPerCommit: 1, maxCommitBytes: 1 << 20 })!;
    const single = receiveReject(one.state, reject('c2', 'too_large', 'drop'));
    expect(single.actions.map((a) => a.t)).toContain('report');
    expect(single.state.discarded).toHaveLength(1);
  });

  it('busy, rate_limited, unavailable: retry the same commit after the indicated delay', () => {
    for (const code of ['busy', 'rate_limited', 'unavailable'] as const) {
      const t = receiveReject(inFlight(), { ...reject('c1', code, 'retry'), retryAfterMs: 250 });
      expect(t.state.inflight?.resend).toBe(true);
      expect(t.actions).toEqual([{ t: 'resend', afterMs: 250 }]);
      expect(resendCommit(t.state)!.commit.id).toBe('c1');
    }
  });

  it('read_only: drop, and the editor switches to read-only', () => {
    const t = receiveReject(inFlight(), reject('c1', 'read_only', 'drop'));
    expect(t.actions.map((a) => a.t)).toContain('read-only');
  });

  it('a rejection carries the head, kept for the wait', () => {
    const t = receiveReject(inFlight(), reject('c1', 'rebase_failed', 'rebase', 9));
    expect(t.state.waitForHead).toBe(9);
  });

  it('a rejection of another commit is ignored', () => {
    const s = inFlight();
    expect(receiveReject(s, reject('other', 'invalid_op', 'drop')).state).toBe(s);
  });
});

describe('resume, reload and reset (04 §9, §3.2)', () => {
  it('an in-flight commit reported unknown is resent after caught up, with the same id', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    s = takeCommit(s, 'c1', limits)!.state;
    const o = opened(s, {
      head: 3,
      incarnation: 'inc-1',
      catchUp: 'stream',
      inflight: { state: 'unknown' },
      access: {} as never,
    });
    expect(o.resendAfterCaughtUp).toBe(true);
    const up = caughtUp(o.transition.state, true);
    expect(resendCommit(up.state)!.commit.id).toBe('c1');
  });

  it('an in-flight commit reported accepted is found in the stream', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    const sent = takeCommit(s, 'c1', limits)!;
    s = sent.state;
    const o = opened(s, {
      head: 4,
      incarnation: 'inc-1',
      catchUp: 'stream',
      inflight: { state: 'accepted', seq: 4 },
      access: {} as never,
    });
    expect(o.resendAfterCaughtUp).toBe(false);
    const own = { ...remote(s, IDS.intro, 0, ''), id: 'c1', steps: sent.commit.steps };
    expect(receiveCommits(o.transition.state, [own], schema).state.inflight).toBeNull();
  });

  it('a reload replaces the confirmed document and sets unconfirmed work aside', () => {
    const s = typeAt(start(), IDS.intro, 0, 'x');
    const content = { ...contractDocument(), seq: 9, incarnation: 'inc-2' } as never;
    const t = reload(s, content, schema, 'view-1', false);
    expect(t.state.seq).toBe(9);
    expect(t.state.incarnation).toBe('inc-2');
    expect(t.state.view).toBe('view-1');
    expect(settled(t.state)).toBe(true);
    expect(t.state.discarded.map((d) => d.text)).toEqual(['x']);
    expect(t.effect?.kind).toBe('replace');
  });

  it('a reset re-applies local steps to the new content; the in-flight commit stays for its rejection', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    s = takeCommit(s, 'c1', limits)!.state;
    const content = { ...contractDocument(), seq: 4, incarnation: 'inc-1' } as never;
    const t = reset(s, content, schema);
    expect(t.state.seq).toBe(4);
    expect(t.state.inflight?.id).toBe('c1');
    expect(text(t.state.visible, IDS.intro)).toBe('xHello world');
    const r = receiveReject(t.state, reject('c1', 'stale_base', 'rebase', 4));
    expect(takeCommit(r.state, 'c2', limits)!.commit).toMatchObject({ base: 4 });
  });
});

/** A snapshot of the contract document in which another user has written "Snap " at the start of the intro. */
function snapshotContent(seq: number): Content {
  const doc = schema.nodeFromJSON(contractDocument().doc);
  const changed = new Transform(doc).insert(posOf(doc, IDS.intro) + 1, schema.text('Snap ')).doc;
  return {
    ...contractDocument(),
    doc: changed.toJSON(),
    seq,
    incarnation: 'inc-1',
  } as unknown as Content;
}

describe('rejected fills (SYN-021)', () => {
  /** A fill of the intro paragraph in flight, and an edit queued behind it on another paragraph. */
  const fill = (): SyncState => {
    const s = typeAt(start(), IDS.intro, 0, 'mine ');
    return typeAt(takeCommit(s, 'c1', limits)!.state, IDS.mid, 0, 'q');
  };

  it('a conflict discards the fill and shows the other value; the values are not merged', () => {
    let s = typeAt(start(), IDS.intro, 0, 'mine ');
    s = takeCommit(s, 'c1', limits)!.state;
    // The other fill reached the authority first, so it arrives before the rejection (SYN-019 ordering).
    s = receiveCommits(s, [remote(s, IDS.intro, 0, 'theirs ')], schema).state;
    const t = receiveReject(s, {
      ...reject('c1', 'conflict', 'drop'),
      message: 'changed by another user',
    });
    expect(text(t.state.visible, IDS.intro)).toBe('theirs Hello world');
    expect(t.state.visible.eq(t.state.confirmed)).toBe(true);
    expect(t.state.inflight).toBeNull();
    expect(t.state.discarded.map((d) => [d.reason, d.commit, d.text])).toEqual([
      ['conflict', 'c1', 'mine '],
    ]);
    expect(t.actions).toContainEqual({
      t: 'report',
      code: 'conflict',
      message: 'changed by another user',
    });
  });

  it('a conflict that named fields keeps their identifiers on the discarded item (FRW-010)', () => {
    let s = typeAt(start(), IDS.intro, 0, 'mine ');
    s = takeCommit(s, 'c1', limits)!.state;
    s = receiveCommits(s, [remote(s, IDS.intro, 0, 'theirs ')], schema).state;
    const t = receiveReject(s, {
      ...reject('c1', 'conflict', 'drop'),
      scopes: ['field:f1', 'body', 'field:f2'],
    });
    expect(t.state.discarded.map((d) => [d.reason, d.fields])).toEqual([
      ['conflict', ['f1', 'f2']],
    ]);
    const plain = receiveReject(fill(), reject('c1', 'conflict', 'drop'));
    expect(plain.state.discarded[0]?.fields).toBeUndefined();
  });

  it('a field_invalid discards the fill and reports the validation message', () => {
    const t = receiveReject(fill(), {
      ...reject('c1', 'field_invalid', 'drop'),
      message: 'Enter a date',
    });
    expect(text(t.state.visible, IDS.intro)).toBe('Hello world');
    expect(t.state.discarded.map((d) => [d.reason, d.text])).toEqual([['field_invalid', 'mine ']]);
    expect(t.actions).toContainEqual({
      t: 'report',
      code: 'field_invalid',
      message: 'Enter a date',
    });
  });

  it.each(['conflict', 'field_invalid'] as const)(
    'with %s the action is drop and the other pending steps are kept where they apply',
    (code) => {
      const t = receiveReject(fill(), reject('c1', code, 'drop'));
      expect(t.state.inflight).toBeNull();
      expect(t.state.queue).toHaveLength(1);
      expect(text(t.state.visible, IDS.mid)).toBe('qBetween');
      expect(t.effect?.kind).toBe('rebuild');
    },
  );
});

describe('reset on a snapshot (SYN-023)', () => {
  it('replaces the confirmed document with the content at the reset seq and sets the seq', () => {
    const content = snapshotContent(9);
    const t = reset(start(), content, schema);
    expect(t.state.seq).toBe(9);
    expect(t.state.confirmed.eq(schema.nodeFromJSON(content.doc))).toBe(true);
    expect(text(t.state.confirmed, IDS.intro)).toBe('Snap Hello world');
    expect(t.effect?.kind).toBe('replace');
  });

  it('re-applies the local steps to the new content; those that fail go to recovered edits', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x'); // in flight
    s = takeCommit(s, 'c1', limits)!.state;
    s = typeAt(s, IDS.intro, 1, 'y'); // queued
    // A step that cannot apply to any document of this size.
    s = local(s, [new ReplaceStep(9999, 9999, Slice.empty)], s.visible);
    const t = reset(s, snapshotContent(9), schema);
    expect(text(t.state.visible, IDS.intro)).toBe('xySnap Hello world');
    expect(t.state.inflight?.id).toBe('c1');
    expect(t.state.inflight?.local).toHaveLength(1);
    expect(t.state.queue).toHaveLength(1);
    expect(t.state.discarded.map((d) => [d.reason, d.commit, d.steps.length])).toEqual([
      ['reset', null, 1],
    ]);
    expect(t.actions).toContainEqual({ t: 'discarded', items: t.state.discarded });
  });

  it('an in-flight commit with an older base is not resubmitted unchanged after stale_base', () => {
    let s = typeAt(start(), IDS.intro, 0, 'x');
    s = takeCommit(s, 'c1', limits)!.state;
    s = typeAt(s, IDS.intro, 1, 'y');
    s = reset(s, snapshotContent(9), schema).state;
    const r = receiveReject(s, reject('c1', 'stale_base', 'rebase', 9));
    expect(resendCommit(r.state)).toBeNull();
    const next = takeCommit(r.state, 'c2', limits)!;
    expect(next.commit).toMatchObject({ id: 'c2', base: 9 });
    expect(next.commit.steps).toHaveLength(2);
  });

  it('the next commit expected is the reset seq plus one', () => {
    const t = reset(start(), snapshotContent(9), schema);
    const ok = receiveCommits(t.state, [remote(t.state, IDS.end, 0, 'z', 10)], schema);
    expect(ok.state.seq).toBe(10);
    expect(ok.actions.some((a) => a.t === 'reconnect')).toBe(false);
    const gap = receiveCommits(t.state, [remote(t.state, IDS.end, 0, 'z', 11)], schema);
    expect(gap.actions).toEqual([{ t: 'reconnect', reason: 'gap: commit 11 after 9' }]);
    expect(gap.state.seq).toBe(9);
  });
});
