// The client channel machine (05 §5.2 to §5.6; 04 §8, §9; PRO-004, PRO-094 groundwork): the order of
// commits and acknowledgements, catch-up in its three modes, and resume after gaps, duplicates,
// timeouts, lost connections and retryable closes. Universal: Node.js and browsers.
import { describe, expect, it } from 'vitest';
import type {
  Access,
  Ack,
  ChannelOpened,
  ClientMessage,
  Commit,
  RemoteCommit,
  ServerMessage,
} from '../generated/types.ts';
import { ClientChannel, RELOAD_REASON, type ChannelEffect } from './channel.ts';

const DOC = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
const INC = '0192aa00-0000-7000-8000-000000000001';
const T = '2026-09-18T10:42:00.000Z';
const access = (rev: number, caps: Access['caps'] = ['view', 'edit']): Access => ({
  rev,
  asOfSeq: 0,
  docRole: 'editor',
  caps,
  scopes: { body: caps },
  leases: {},
  fill: null,
  restrictions: [],
});
const id = (n: number) => `0192f0c4-0000-7000-8000-${String(n).padStart(12, '0')}`;
const remote = (seq: number, cid = id(1000 + seq)): RemoteCommit => ({
  seq,
  kind: 'steps',
  id: cid,
  steps: [{ stepType: 'replace', from: 1, to: 1 }],
  control: null,
  author: { user: 'other', session: null, agent: null },
  serverTime: T,
  origin: 'input',
});
const commit = (n: number, base: number): Commit => ({
  id: id(n),
  base,
  steps: [
    { stepType: 'replace', from: 1, to: 1, slice: { content: [{ type: 'text', text: 'x' }] } },
  ],
});

function machine() {
  let n = 0;
  return new ClientChannel({ doc: DOC, ids: () => `e${++n}`, answerTimeoutMs: 1000 });
}

const sends = (fx: ChannelEffect[]) =>
  fx.filter((e) => e.kind === 'send').map((e) => (e as { message: ClientMessage }).message);
const kinds = (fx: ChannelEffect[]) => fx.map((e) => e.kind);
const states = (fx: ChannelEffect[]) => fx.flatMap((e) => (e.kind === 'state' ? [e.state] : []));

function opened(re: string, ch: number, d: Partial<ChannelOpened> = {}): ServerMessage {
  return {
    t: 'ch.opened',
    re,
    ch,
    d: { head: 5, incarnation: INC, catchUp: 'reload', access: access(1), ...d },
  };
}

/** Opens a channel at `seq` (stream from it) and returns it live. */
function live(seq = 5) {
  const m = machine();
  const open = sends(m.open(1, ['presence'], { seq, incarnation: INC, view: 'v1' }, 0))[0]!;
  m.receive(opened(open.id!, 1, { head: seq, catchUp: 'stream', view: 'v1' }), 0);
  m.receive({ t: 'sync.caughtUp', ch: 1, d: { seq } }, 0);
  return m;
}

describe('opening (05 §5.2)', () => {
  it('opens without resume and goes live at the head of a reload (D27)', () => {
    const m = machine();
    const fx = m.open(1, ['presence'], undefined, 0);
    const open = sends(fx)[0]!;
    expect(open).toEqual({
      t: 'ch.open',
      id: 'e1',
      ch: 1,
      d: { kind: 'doc', doc: DOC, engine: 'pm-steps/1', cdm: 1, features: ['presence'] },
    });
    const r = m.receive(opened('e1', 1), 0);
    expect(kinds(r)).toEqual(['opened', 'access', 'state']);
    expect(states(r)).toEqual([{ status: 'live', seq: 5 }]);
    expect(m.seq).toBe(5);
  });

  it('streams after a resume: catching_up, the commits, then live at sync.caughtUp', () => {
    const m = machine();
    m.open(1, [], { seq: 3, incarnation: INC }, 0);
    const r1 = m.receive(opened('e1', 1, { catchUp: 'stream' }), 0);
    expect(states(r1)).toEqual([{ status: 'catching_up', head: 5 }]);
    const r2 = m.receive({ t: 'sync.commit', ch: 1, d: { commits: [remote(4), remote(5)] } }, 0);
    expect(r2).toEqual([{ kind: 'commits', commits: [remote(4), remote(5)] }]);
    expect(states(m.receive({ t: 'sync.caughtUp', ch: 1, d: { seq: 5 } }, 0))).toEqual([
      { status: 'live', seq: 5 },
    ]);
  });

  it('pages over REST for catchUp "page", holding live messages until the head is reached', () => {
    const m = machine();
    m.open(1, [], { seq: 2, incarnation: INC }, 0);
    const r = m.receive(opened('e1', 1, { catchUp: 'page' }), 0);
    expect(r.at(-1)).toEqual({ kind: 'page', after: 2, head: 5 });
    expect(m.receive({ t: 'sync.commit', ch: 1, d: { commits: [remote(6)] } }, 0)).toEqual([]);
    expect(m.paged([remote(3), remote(4)], 0).at(-1)).toEqual({ kind: 'page', after: 4, head: 5 });
    const done = m.paged([remote(5)], 0);
    expect(kinds(done)).toEqual(['commits', 'state', 'commits']);
    expect(m.seq).toBe(6);
    expect(m.phase).toBe('live');
  });

  it('rejects the first open with the ch.rejected code', () => {
    const m = machine();
    m.open(1, [], undefined, 0);
    const r = m.receive(
      { t: 'ch.rejected', re: 'e1', ch: 1, d: { code: 'not_found', message: 'no' } },
      0,
    );
    expect(r).toEqual([{ kind: 'openFailed', code: 'not_found', message: 'no' }]);
    expect(m.phase).toBe('closed');
  });
});

describe('commits and acknowledgements (05 §5.3; 04 §8)', () => {
  it('submits on a live channel and resolves the acknowledgement, advancing seq', () => {
    const m = live();
    const fx = m.submit(1, commit(1, 5), 0);
    const submit = sends(fx)[0]!;
    expect(submit).toMatchObject({ t: 'sync.submit', ch: 1, d: commit(1, 5) });
    const ack: Ack = { id: id(1), seq: 6, serverTime: T, rebased: false };
    expect(m.receive({ t: 'sync.ack', re: submit.id!, ch: 1, d: ack }, 0)).toEqual([
      { kind: 'ack', handle: 1, ack },
    ]);
    expect(m.seq).toBe(6);
  });

  it('settles a rejection without advancing seq', () => {
    const m = live();
    const submit = sends(m.submit(1, commit(1, 5), 0))[0]!;
    const reject = {
      id: id(1),
      code: 'permission_denied' as const,
      message: 'no',
      action: 'drop' as const,
      head: 5,
    };
    expect(m.receive({ t: 'sync.reject', re: submit.id!, ch: 1, d: reject }, 0)).toEqual([
      { kind: 'reject', handle: 1, reject },
    ]);
    expect(m.seq).toBe(5);
  });

  it('ignores a sync.reject whose re it does not own (PRO-028)', () => {
    const m = live();
    const submit = sends(m.submit(1, commit(1, 5), 0))[0]!;
    const stray = {
      id: id(9),
      code: 'conflict' as const,
      message: 'not ours',
      action: 'drop' as const,
      head: 5,
    };
    expect(m.receive({ t: 'sync.reject', re: id(77), ch: 1, d: stray }, 0)).toEqual([]);
    expect(m.seq).toBe(5);
    // The commit in flight is still awaiting its own answer, and settles normally.
    const ack: Ack = { id: id(1), seq: 6, serverTime: T, rebased: false };
    expect(m.receive({ t: 'sync.ack', re: submit.id!, ch: 1, d: ack }, 0)).toEqual([
      { kind: 'ack', handle: 1, ack },
    ]);
    expect(m.seq).toBe(6);
  });

  it('refuses locally to build a commit above maxStepsPerCommit or maxCommitBytes (PRO-022)', () => {
    const m = live();
    m.setLimits({ maxCommitBytes: 400, maxStepsPerCommit: 2 });
    const step = {
      stepType: 'replace',
      from: 1,
      to: 1,
      slice: { content: [{ type: 'text', text: 'x' }] },
    };
    const tooMany = { id: id(1), base: 5, steps: [step, step, step] };
    const a = m.submit(1, tooMany, 0);
    expect(a).toEqual([expect.objectContaining({ kind: 'fail', handle: 1, code: 'too_large' })]);
    const big: Commit = {
      id: id(2),
      base: 5,
      steps: [
        {
          stepType: 'replace',
          from: 1,
          to: 1,
          slice: { content: [{ type: 'text', text: 'y'.repeat(600) }] },
        },
      ],
    } as Commit;
    const b = m.submit(2, big, 0);
    expect(b).toEqual([expect.objectContaining({ kind: 'fail', handle: 2, code: 'too_large' })]);
    // Nothing above the limits left the client.
    expect(sends([...a, ...b])).toEqual([]);
    // A commit within the limits is sent.
    const c = m.submit(3, commit(3, 5), 0);
    expect(kinds(c)).toEqual(['send']);
    expect(sends(c)).toHaveLength(1);
  });

  it('applies the limits given at construction, and the 04 defaults when none are given', () => {
    const def = new ClientChannel({ doc: DOC, ids: () => 'x' });
    expect(def.submit(1, commit(1, 0), 0)).toEqual([]); // not live: queued, not refused
    const small = new ClientChannel({
      doc: DOC,
      ids: () => 'x',
      limits: { maxCommitBytes: 1_048_576, maxStepsPerCommit: 0 },
    });
    expect(kinds(small.submit(1, commit(1, 0), 0))).toEqual(['fail']);
  });

  it('accepts an acknowledgement rebuilt for a duplicate, with an earlier seq (04 §5 step 2)', () => {
    const m = live();
    const submit = sends(m.submit(1, commit(1, 5), 0))[0]!;
    const ack: Ack = { id: id(1), seq: 3, serverTime: T, rebased: true, steps: [] };
    expect(kinds(m.receive({ t: 'sync.ack', re: submit.id!, ch: 1, d: ack }, 0))).toEqual(['ack']);
    expect(m.seq).toBe(5);
  });

  it('drops duplicates and resumes on a gap, naming the commit in flight', () => {
    const m = live();
    expect(
      m.receive({ t: 'sync.commit', ch: 1, d: { commits: [remote(5), remote(6)] } }, 0),
    ).toEqual([{ kind: 'commits', commits: [remote(6)] }]);
    const submit = sends(m.submit(1, commit(1, 6), 0))[0]!;
    const r = m.receive({ t: 'sync.commit', ch: 1, d: { commits: [remote(8)] } }, 0);
    expect(sends(r)).toEqual([{ t: 'ch.close', ch: 1 }]);
    expect(r).toContainEqual({
      kind: 'fail',
      handle: 1,
      code: 'unavailable',
      message: 'gap: expected seq 7, received 8',
    });
    expect(r.at(-1)).toMatchObject({ kind: 'reopen', delayMs: 0 });
    expect(m.phase).toBe('resuming');
    // Messages of the old channel number are no longer the channel's.
    expect(m.ch).toBeNull();
    expect(
      m.receive(
        {
          t: 'sync.ack',
          re: submit.id!,
          ch: 1,
          d: { id: id(1), seq: 7, serverTime: T, rebased: false },
        },
        0,
      ),
    ).toEqual([]);
    const reopen = sends(m.reopen(2, [], 0))[0]!;
    expect(reopen.d).toMatchObject({
      resume: { seq: 6, incarnation: INC, inflight: id(1), view: 'v1' },
    });
  });

  it('treats its own commit in the stream as the answer to the submit', () => {
    const m = live();
    m.submit(1, commit(1, 5), 0);
    const r = m.receive(
      { t: 'sync.commit', ch: 1, d: { commits: [remote(6, id(1)), remote(7)] } },
      0,
    );
    expect(r).toEqual([
      {
        kind: 'ack',
        handle: 1,
        ack: { id: id(1), seq: 6, serverTime: T, rebased: true, steps: remote(6).steps },
      },
      { kind: 'commits', commits: [remote(7)] },
    ]);
  });

  it('resumes when a commit is not answered within ackTimeoutMs (04 §8)', () => {
    const m = live();
    m.submit(1, commit(1, 5), 100);
    expect(m.deadline()).toBe(1100);
    expect(m.tick(1099)).toEqual([]);
    const r = m.tick(1100);
    expect(states(r)).toEqual([
      {
        status: 'resuming',
        reason: 'no answer to a commit within ackTimeoutMs (04 §8)',
        retryInMs: 0,
      },
    ]);
    expect(m.faults.timeouts).toBe(1);
  });

  it('holds submits made while resuming until the channel is live again (04 §9 step 5)', () => {
    const m = live();
    m.connectionLost('cut');
    expect(m.submit(1, commit(1, 5), 0)).toEqual([]);
    const reopen = sends(m.reopen(2, [], 0))[0]!;
    m.receive(opened(reopen.id!, 2, { catchUp: 'stream', view: 'v1' }), 0);
    const r = m.receive({ t: 'sync.caughtUp', ch: 2, d: { seq: 5 } }, 0);
    expect(sends(r)).toMatchObject([{ t: 'sync.submit', ch: 2, d: commit(1, 5) }]);
  });

  it('refuses an invalid commit without sending it', () => {
    const m = live();
    const r = m.submit(1, { id: 'not-a-uuid', base: 5, steps: [] }, 0);
    expect(r).toMatchObject([{ kind: 'fail', handle: 1, code: 'bad_message' }]);
  });
});

describe('closing and resuming (05 §5.2; 04 §9; ADR 0019)', () => {
  it('resumes after ch.closed unavailable or slow_consumer, after retryInMs', () => {
    const m = live();
    const r = m.receive(
      { t: 'ch.closed', ch: 1, d: { code: 'slow_consumer', reason: 'behind', retryInMs: 250 } },
      0,
    );
    expect(r.at(-1)).toMatchObject({ kind: 'reopen', delayMs: 250 });
    expect(sends(r)).toEqual([]);
  });

  it('closes on ch.closed forbidden, with the code', () => {
    const m = live();
    const r = m.receive({ t: 'ch.closed', ch: 1, d: { code: 'forbidden', reason: 'revoked' } }, 0);
    expect(states(r)).toEqual([{ status: 'closed', code: 'forbidden', reason: 'revoked' }]);
  });

  it('closes a channel whose resume is answered with a reload: the caller replaces the document', () => {
    const m = live();
    m.connectionLost('cut');
    const reopen = sends(m.reopen(2, [], 0))[0]!;
    const r = m.receive(opened(reopen.id!, 2, { catchUp: 'reload', view: 'v2', head: 9 }), 0);
    expect(sends(r)).toEqual([{ t: 'ch.close', ch: 2 }]);
    expect(states(r)).toEqual([
      { status: 'closed', code: 'unavailable', reason: RELOAD_REASON, retryInMs: 0 },
    ]);
  });

  it('retries a resume refused with already_open', () => {
    const m = live();
    m.connectionLost('cut');
    const reopen = sends(m.reopen(2, [], 0))[0]!;
    const r = m.receive(
      { t: 'ch.rejected', re: reopen.id!, ch: 2, d: { code: 'already_open', message: 'busy' } },
      0,
    );
    expect(r).toEqual([{ kind: 'reopen', attempt: 1, reason: 'ch.rejected: already_open' }]);
  });

  it('reports a lost connection as resuming and fails the commits in flight (D23)', () => {
    const m = live();
    m.submit(1, commit(1, 5), 0);
    const r = m.connectionLost('cut');
    expect(r).toEqual([
      { kind: 'fail', handle: 1, code: 'unavailable', message: 'cut' },
      { kind: 'state', state: { status: 'resuming', reason: 'cut' } },
    ]);
    expect(m.resumePoint()).toEqual({ seq: 5, incarnation: INC, inflight: id(1), view: 'v1' });
  });

  it('fails a first open when the connection is lost before the answer', () => {
    const m = machine();
    m.open(1, [], undefined, 0);
    expect(m.connectionLost('cut')).toEqual([
      { kind: 'openFailed', code: 'unavailable', message: 'cut' },
    ]);
  });

  it('closes by the caller with code null, once, and refuses later submits', () => {
    const m = live();
    const r = m.close();
    expect(sends(r)).toEqual([{ t: 'ch.close', ch: 1 }]);
    expect(states(r)).toEqual([{ status: 'closed', code: null, reason: 'closed by the client' }]);
    expect(m.close()).toEqual([]);
    expect(m.submit(1, commit(1, 5), 0)).toMatchObject([{ kind: 'fail', code: 'unavailable' }]);
  });

  it('delivers a changed access after a resume, and not an identical one', () => {
    const m = live();
    m.connectionLost('cut');
    let reopen = sends(m.reopen(2, [], 0))[0]!;
    expect(
      kinds(
        m.receive(opened(reopen.id!, 2, { catchUp: 'stream', view: 'v1', access: access(1) }), 0),
      ),
    ).toEqual(['state']);
    m.receive({ t: 'sync.caughtUp', ch: 2, d: { seq: 5 } }, 0);
    m.connectionLost('cut');
    reopen = sends(m.reopen(3, [], 0))[0]!;
    const r = m.receive(
      opened(reopen.id!, 3, { catchUp: 'stream', view: 'v1', access: access(1, ['view']) }),
      0,
    );
    expect(kinds(r)).toEqual(['access', 'state']);
  });
});
