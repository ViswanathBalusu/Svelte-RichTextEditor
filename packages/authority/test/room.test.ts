// The room's authority algorithm (04 §5): one scenario per step and failure mode (SYN-006 to
// SYN-016). The property suite covers the interleavings; these pin each rule on its own.
import { Fragment, Slice } from 'prosemirror-model';
import { AttrStep, ReplaceStep } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { Room } from '../src/room/room.ts';
import type { CommitInput, Effects, ToClient } from '../src/room/types.ts';
import { stepsToJson } from '../src/steps.ts';
import { REQUIRES, USERS, baseDoc, basePermissions, posInside, posOf, schema } from './fixtures.ts';

let clock = 1_760_000_000_000;
let counter = 0;
const id = () => `0192f0c4-7b1e-7000-8000-${(++counter).toString(16).padStart(12, '0')}`;

function room(limits?: {
  maxStepsPerCommit: number;
  maxCommitBytes: number;
  maxRebaseSteps: number;
}): Room {
  return new Room({
    schema,
    initial: baseDoc(),
    requires: REQUIRES,
    log: [],
    perms: basePermissions(),
    initialRevision: 1,
    epoch: 1,
    incarnation: 'inc-1',
    now: () => ++clock,
    ...(limits ? { limits } : {}),
  });
}

const insert = (doc = baseDoc(), at = 'pIntro0000000001', text = 'x') => {
  const pos = posInside(doc, at);
  return stepsToJson([
    new ReplaceStep(pos, pos, new Slice(Fragment.from(schema.text(text)), 0, 0)),
  ]);
};

function msgs(fx: Effects, channel: string): ToClient[] {
  return fx.send.filter((o) => o.channel === channel).map((o) => o.msg);
}
function reject(fx: Effects, channel: string) {
  const m = msgs(fx, channel).find((x) => x.t === 'sync.reject');
  return m && m.t === 'sync.reject' ? m : null;
}

describe('room', () => {
  it('acknowledges after storage and broadcasts to the others, in sequence order (steps 8 to 10)', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('a1', USERS.alice);
    const fx = r.submit('c1', { id: id(), base: 0, steps: insert() });
    expect(fx.send).toEqual([]); // nothing before storage (G2)
    expect(fx.write?.commits).toHaveLength(1);
    const done = r.writeCompleted({ status: 'ok' });
    expect(msgs(done, 'c1').map((m) => m.t)).toEqual(['sync.ack']);
    expect(msgs(done, 'a1').map((m) => m.t)).toEqual(['sync.commit']);
    const ack = msgs(done, 'c1')[0]!;
    if (ack.t === 'sync.ack') expect(ack).toMatchObject({ seq: 1, rebased: false });
  });

  it('rebases a commit made on an older base and acknowledges with the mapped steps (step 4)', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('b1', USERS.bob);
    r.submit('c1', { id: id(), base: 0, steps: insert(baseDoc(), 'pIntro0000000001', 'AAA') });
    r.writeCompleted({ status: 'ok' });
    const fx = r.submit('b1', {
      id: id(),
      base: 0,
      steps: insert(baseDoc(), 'pIntro0000000001', 'B'),
    });
    const done = r.writeCompleted({ status: 'ok' });
    expect(fx.write).not.toBeNull();
    const ack = msgs(done, 'b1')[0]!;
    expect(ack.t === 'sync.ack' && ack.rebased && ack.steps?.length === 1).toBe(true);
    expect(
      r.document.child(1).child(1).textContent.startsWith('BAAA') ||
        r.document.child(1).child(1).textContent.startsWith('AAAB'),
    ).toBe(true);
  });

  it('refuses a second submission on a channel while one is in flight (busy)', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.submit('c1', { id: id(), base: 0, steps: insert() });
    expect(reject(r.submit('c1', { id: id(), base: 0, steps: insert() }), 'c1')?.code).toBe('busy');
  });

  it('deduplicates a resubmission while the first copy waits for storage, and after it is stored (G4)', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const commit: CommitInput = { id: id(), base: 0, steps: insert() };
    r.submit('c1', commit);
    // The connection drops; the client reconnects on a new channel and resubmits the same commit.
    r.close('c1');
    r.open('c2', USERS.carol, { seq: 0, incarnation: 'inc-1', inflight: commit.id });
    expect(r.submit('c2', commit).send).toEqual([]);
    const done = r.writeCompleted({ status: 'ok' });
    expect(msgs(done, 'c2').map((m) => m.t)).toEqual(['sync.ack']);
    // Once stored, a further resubmission gets the acknowledgement rebuilt from the log.
    r.open('c3', USERS.carol);
    const again = msgs(r.submit('c3', commit), 'c3')[0]!;
    expect(again.t === 'sync.ack' && again.seq === 1 && again.rebased).toBe(true);
    expect(r.head).toBe(1);
  });

  it("refuses another user's commit identifier (step 2)", () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('m1', USERS.mallory);
    const commit: CommitInput = { id: id(), base: 0, steps: insert() };
    r.submit('c1', commit);
    r.writeCompleted({ status: 'ok' });
    expect(
      reject(
        r.submit('m1', { ...commit, steps: insert(r.document, 'pIntro0000000001', 'evil') }),
        'm1',
      )?.code,
    ).toBe('invalid_op');
  });

  it('refuses a base ahead of the head with reload, and a base too far behind with stale_base (step 3)', () => {
    const r = room({ maxStepsPerCommit: 500, maxCommitBytes: 1 << 20, maxRebaseSteps: 1 });
    r.open('c1', USERS.carol);
    r.open('b1', USERS.bob);
    const ahead = reject(r.submit('c1', { id: id(), base: 5, steps: insert() }), 'c1');
    expect(ahead).toMatchObject({ code: 'invalid_op', action: 'reload' });
    r.submit('c1', { id: id(), base: 0, steps: insert(baseDoc(), 'pIntro0000000001', 'a') });
    r.writeCompleted({ status: 'ok' });
    r.submit('c1', { id: id(), base: 1, steps: insert(r.document, 'pIntro0000000001', 'b') });
    r.writeCompleted({ status: 'ok' });
    expect(reject(r.submit('b1', { id: id(), base: 0, steps: insert() }), 'b1')).toMatchObject({
      code: 'stale_base',
      action: 'rebase',
      head: 2,
    });
  });

  it('refuses disallowed step types, malformed steps and oversized commits', () => {
    const r = room({ maxStepsPerCommit: 2, maxCommitBytes: 2000, maxRebaseSteps: 5000 });
    r.open('c1', USERS.carol);
    expect(
      reject(
        r.submit('c1', {
          id: id(),
          base: 0,
          steps: [{ stepType: 'docAttr', attr: 'x', value: 1 }],
        }),
        'c1',
      )?.code,
    ).toBe('invalid_op');
    expect(
      reject(r.submit('c1', { id: id(), base: 0, steps: [{ stepType: 'replace' }] }), 'c1')?.code,
    ).toBe('invalid_op');
    expect(
      reject(
        r.submit('c1', { id: id(), base: 0, steps: [...insert(), ...insert(), ...insert()] }),
        'c1',
      )?.code,
    ).toBe('too_large');
    expect(
      reject(
        r.submit('c1', {
          id: id(),
          base: 0,
          steps: insert(baseDoc(), 'pIntro0000000001', 'x'.repeat(5000)),
        }),
        'c1',
      )?.code,
    ).toBe('too_large');
    expect(reject(r.submit('c1', { id: 'not-a-uuid', base: 0, steps: insert() }), 'c1')?.code).toBe(
      'invalid_op',
    );
    expect(
      reject(r.submit('c1', { id: id(), base: 0, steps: insert(), origin: 'restore' }), 'c1')?.code,
    ).toBe('invalid_op');
  });

  it('refuses a wrongly typed fill with field_invalid (P7)', () => {
    const r = room();
    r.open('e1', USERS.erin);
    const doc = baseDoc();
    const steps = stepsToJson([new AttrStep(posOf(doc, 'fTenantName00001'), 'value', 42)]);
    expect(reject(r.submit('e1', { id: id(), base: 0, steps }), 'e1')?.code).toBe('field_invalid');
  });

  it('refuses everything on a locked document with read_only (step 1)', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.permissionsChanged({ ...basePermissions(), revision: 2, documentState: 'locked' });
    expect(reject(r.submit('c1', { id: id(), base: 0, steps: insert() }), 'c1')?.code).toBe(
      'read_only',
    );
  });

  it('rejects everything not stored when a write fails, and continues from the durable state', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('b1', USERS.bob);
    r.submit('c1', { id: id(), base: 0, steps: insert() });
    // Bob's commit is accepted into the tentative state behind Carol's, waiting for the next write.
    r.submit('b1', { id: id(), base: 0, steps: insert(baseDoc(), 'pMiddle000000001', 'b') });
    const done = r.writeCompleted({ status: 'failed' });
    expect(reject(done, 'c1')).toMatchObject({ code: 'unavailable', action: 'retry' });
    expect(reject(done, 'b1')).toMatchObject({ code: 'unavailable', action: 'retry' });
    expect(r.head).toBe(0);
    expect(r.pendingCount).toBe(0);
  });

  it('re-reads the log tail when the outcome of a write is unknown', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const fx = r.submit('c1', { id: id(), base: 0, steps: insert() });
    const done = r.writeCompleted({ status: 'unknown', tail: fx.write!.commits });
    expect(msgs(done, 'c1').map((m) => m.t)).toEqual(['sync.ack']);
    expect(r.head).toBe(1);
    const r2 = room();
    r2.open('c1', USERS.carol);
    r2.submit('c1', { id: id(), base: 0, steps: insert() });
    expect(reject(r2.writeCompleted({ status: 'unknown', tail: [] }), 'c1')?.code).toBe(
      'unavailable',
    );
    expect(r2.head).toBe(0);
  });

  it('stops serving and closes every channel when another writer holds the document (fencing)', () => {
    const r = room();
    r.open('c1', USERS.carol);
    r.open('a1', USERS.alice);
    r.submit('c1', { id: id(), base: 0, steps: insert() });
    const done = r.writeCompleted({ status: 'fenced' });
    expect(done.send.map((o) => o.msg.t).sort()).toEqual(['ch.closed', 'ch.closed']);
    expect(r.isStopped).toBe(true);
    expect(reject(r.submit('a1', { id: id(), base: 0, steps: insert() }), 'a1')).toBeNull(); // channel gone
  });

  it('refuses a write made under replaced permissions, reloads them and records a control commit (G7)', () => {
    const r = room();
    r.open('b1', USERS.bob);
    // Bob edits the legal region under revision 1. The grant is revoked in the database (revision 2),
    // but the notification to the room is lost.
    r.submit('b1', { id: id(), base: 0, steps: insert(baseDoc(), 'pLegal000000001B', 'ok ') });
    const revoked = { ...basePermissions(), revision: 2, grants: [] };
    const done = r.writeCompleted({ status: 'revision_moved', perms: revoked });
    expect(reject(done, 'b1')).toMatchObject({ code: 'unavailable', action: 'retry' });
    expect(msgs(done, 'b1').some((m) => m.t === 'perm.changed')).toBe(true);
    // The room writes the control commit for revision 2 next.
    expect(done.write?.commits[0]).toMatchObject({ kind: 'control', revision: 2 });
    r.writeCompleted({ status: 'ok' });
    // Bob resubmits and is now refused: the check runs against the new permissions.
    const again = reject(
      r.submit('b1', { id: id(), base: 1, steps: insert(r.document, 'pLegal000000001B', 'ok ') }),
      'b1',
    );
    expect(again).toMatchObject({ code: 'permission_denied', scopes: ['region:rLegal000000000B'] });
  });

  it('catches a reconnecting client up and reports its in-flight commit (04 §9)', () => {
    const r = room();
    r.open('c1', USERS.carol);
    const commit: CommitInput = { id: id(), base: 0, steps: insert() };
    r.submit('c1', commit);
    r.close('c1');
    r.writeCompleted({ status: 'ok' });
    const fx = r.open('c2', USERS.carol, { seq: 0, incarnation: 'inc-1', inflight: commit.id });
    const m = msgs(fx, 'c2');
    expect(m.map((x) => x.t)).toEqual(['ch.opened', 'sync.commit', 'sync.caughtUp']);
    const opened = m[0]!;
    if (opened.t === 'ch.opened')
      expect(opened).toMatchObject({ catchUp: 'stream', inflight: { state: 'accepted', seq: 1 } });
    const reload = msgs(
      r.open('c3', USERS.carol, { seq: 9, incarnation: 'inc-1', inflight: null }),
      'c3',
    )[0]!;
    expect(reload.t === 'ch.opened' && reload.catchUp === 'reload').toBe(true);
    const other = msgs(
      r.open('m1', USERS.mallory, { seq: 1, incarnation: 'inc-1', inflight: commit.id }),
      'm1',
    )[0]!;
    expect(other.t === 'ch.opened' && other.inflight).toEqual({ state: 'unknown' });
  });
});
