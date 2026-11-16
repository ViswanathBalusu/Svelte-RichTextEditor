/**
 * The sync session over a scripted channel and a manual clock (04 §8, §9; SYN-018, SYN-019): when
 * commits are sent, what a gap, a timeout or a close does, and what a resume carries. The channel
 * here follows the port contract (05 §8.3; D21): nothing is delivered synchronously.
 */
import { documentHash, type JsonEnvelope } from '@docedit/model';
import type {
  Access,
  Ack,
  ChannelOpened,
  ChannelState,
  Commit,
  Content,
  RemoteCommit,
  Resume,
  SyncChannel,
  SyncCheck,
  SyncReset,
} from '@docedit/protocol';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import type { Clock } from '../src/sync/session.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, spikeDocument } from './fixtures.ts';
import { caret, posOf, sleep, type } from './support.ts';

class ManualClock implements Clock {
  t = 1_000;
  #timers: Array<{ at: number; fn: () => void; id: number }> = [];
  #next = 1;
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.push({ at: this.t + ms, fn, id });
    return id;
  }
  clearTimeout(h: unknown): void {
    this.#timers = this.#timers.filter((x) => x.id !== h);
  }
  /** Moves time forward and runs what is due, in order, letting deliveries run first. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      await sleep(0);
      this.#timers.sort((a, b) => a.at - b.at);
      const next = this.#timers[0];
      if (!next || next.at > end) break;
      this.#timers.shift();
      this.t = next.at;
      next.fn();
      await sleep(0);
    }
    this.t = end;
    await sleep(0);
  }
}

type Listener<T> = (v: T) => void;

/** A channel the test drives: it records submits and delivers what the test pushes, later. */
class ScriptedChannel implements SyncChannel {
  readonly docId = 'doc-1';
  readonly opened: ChannelOpened;
  readonly submits: Commit[] = [];
  closed = false;
  #answers: Array<{ resolve: (a: Ack) => void; reject: (e: unknown) => void }> = [];
  #commits = new Set<Listener<RemoteCommit[]>>();
  #states = new Set<Listener<ChannelState>>();
  #checks = new Set<Listener<SyncCheck>>();
  #resets = new Set<Listener<SyncReset>>();
  #access = new Set<Listener<Access>>();

  constructor(opened: Partial<ChannelOpened> = {}) {
    this.opened = {
      head: 0,
      incarnation: 'inc-1',
      catchUp: 'stream',
      access: editorAccess(),
      ...opened,
    };
  }
  submit(commit: Commit): Promise<Ack> {
    this.submits.push(commit);
    return new Promise<Ack>((resolve, reject) => this.#answers.push({ resolve, reject }));
  }
  ack(seq: number): void {
    const c = this.submits[this.#answered()]!;
    this.#answers.shift()!.resolve({ id: c.id, seq, serverTime: 't', rebased: false });
  }
  reject(code: string, action: string, head: number, retryAfterMs?: number): void {
    const c = this.submits[this.#answered()]!;
    this.#answers.shift()!.reject(
      Object.assign(new Error(code), {
        id: c.id,
        code,
        action,
        head,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      }),
    );
  }
  #answered(): number {
    return this.submits.length - this.#answers.length;
  }
  push(commits: RemoteCommit[]): void {
    queueMicrotask(() => this.#commits.forEach((cb) => cb(commits)));
  }
  state(s: ChannelState): void {
    queueMicrotask(() => this.#states.forEach((cb) => cb(s)));
  }
  check(c: SyncCheck): void {
    queueMicrotask(() => this.#checks.forEach((cb) => cb(c)));
  }
  reset(r: SyncReset): void {
    queueMicrotask(() => this.#resets.forEach((cb) => cb(r)));
  }
  onCommits(cb: Listener<RemoteCommit[]>) {
    this.#commits.add(cb);
    return () => void this.#commits.delete(cb);
  }
  onReset(cb: Listener<SyncReset>) {
    this.#resets.add(cb);
    return () => void this.#resets.delete(cb);
  }
  onAccess(cb: Listener<Access>) {
    this.#access.add(cb);
    return () => void this.#access.delete(cb);
  }
  onEvent() {
    return () => {};
  }
  onState(cb: Listener<ChannelState>) {
    this.#states.add(cb);
    return () => void this.#states.delete(cb);
  }
  onCheck(cb: Listener<SyncCheck>) {
    this.#checks.add(cb);
    return () => void this.#checks.delete(cb);
  }
  close(): void {
    this.closed = true;
  }
}

function harness(opened: Partial<ChannelOpened> = {}, view?: string) {
  const clock = new ManualClock();
  const c = new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
  const first = new ScriptedChannel(opened);
  const opens: Array<{ resume: Resume | undefined; channel: ScriptedChannel }> = [];
  const loads: Array<number | undefined> = [];
  let ids = 0;
  const port = {
    open: async (_doc: string, o: { resume?: Resume }) => {
      const ch = new ScriptedChannel({ head: o.resume?.seq ?? 0, ...(view ? { view } : {}) });
      opens.push({ resume: o.resume, channel: ch });
      return ch;
    },
    loadContent: async (_doc: string, seq?: number): Promise<Content> => {
      loads.push(seq);
      return { ...(spikeDocument() as Content), seq: seq ?? 0, incarnation: 'inc-1' };
    },
  };
  const detach = c.attach(first, {
    seq: 0,
    incarnation: 'inc-1',
    ...(view ? { view } : {}),
    sync: port,
    clock,
    batchMs: 100,
    newId: () => `c${++ids}`,
    retry: { minMs: 10, maxMs: 40 },
    limits: { ackTimeoutMs: 15_000, maxStepsPerCommit: 500, maxCommitBytes: 1 << 20 },
  });
  return { c, i: internals(c), clock, first, opens, loads, detach };
}

const remoteCommit = (seq: number, steps: unknown[] = []): RemoteCommit => ({
  seq,
  kind: steps.length ? 'steps' : 'control',
  id: `r${seq}`,
  steps: steps as RemoteCommit['steps'],
  control: steps.length ? null : { type: 'grants', rev: seq },
  author: { user: 'other', session: 's', agent: null },
  serverTime: 't',
  origin: 'input',
});

describe('sending (SYN-018)', () => {
  it('sends at once when idle, one commit in flight, then batches for at most batchMs', async () => {
    const h = harness();
    await sleep(0);
    caret(h.c, SPIKE_IDS.after, 0);
    type(h.c, 'a');
    await sleep(0);
    expect(h.first.submits.map((s) => [s.id, s.base, s.steps.length])).toEqual([['c1', 0, 1]]);
    type(h.c, 'b');
    type(h.c, 'c');
    await sleep(0);
    expect(h.first.submits).toHaveLength(1); // one in flight
    await h.clock.advance(10);
    h.first.ack(1);
    await sleep(0);
    // Answered 10 ms after sending: the queue waits until 100 ms after the last send.
    expect(h.first.submits).toHaveLength(1);
    await h.clock.advance(89);
    expect(h.first.submits).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.first.submits.map((s) => [s.id, s.base, s.steps.length])).toEqual([
      ['c1', 0, 1],
      ['c2', 1, 2],
    ]);
    expect(h.c.saveState.get()).toBe('saving');
    h.first.ack(2);
    await sleep(0);
    expect(h.c.saveState.get()).toBe('saved');
    expect(h.c.confirmedSeq.get()).toBe(2);
  });

  it('retries the same commit with the same id after a retry rejection', async () => {
    const h = harness();
    await sleep(0);
    caret(h.c, SPIKE_IDS.after, 0);
    type(h.c, 'a');
    await sleep(0);
    h.first.reject('unavailable', 'retry', 0);
    await h.clock.advance(1);
    expect(h.first.submits.map((s) => s.id)).toEqual(['c1', 'c1']);
    expect(h.first.submits[1]).toEqual(h.first.submits[0]);
  });

  it('waits at least retryAfterMs before it sends the same commit again (PRO-028; 04 §8)', async () => {
    for (const code of ['busy', 'rate_limited', 'unavailable']) {
      const h = harness();
      await sleep(0);
      caret(h.c, SPIKE_IDS.after, 0);
      type(h.c, 'a');
      await sleep(0);
      const rejectedAt = h.clock.now();
      h.first.reject(code, 'retry', 0, 250);
      // Later typing does not bring the resubmission forward, and nothing else is sent meanwhile.
      await h.clock.advance(100);
      type(h.c, 'b');
      await h.clock.advance(149);
      expect(h.clock.now() - rejectedAt).toBe(249);
      expect(h.first.submits.map((s) => s.id)).toEqual(['c1']);
      await h.clock.advance(1);
      expect(h.first.submits.map((s) => s.id)).toEqual(['c1', 'c1']);
      expect(h.first.submits[1]).toEqual(h.first.submits[0]);
      // Once it is acknowledged, the queued work follows as a new commit.
      h.first.ack(1);
      await h.clock.advance(100);
      expect(h.first.submits.map((s) => [s.id, s.base])).toEqual([
        ['c1', 0],
        ['c1', 0],
        ['c2', 1],
      ]);
      h.detach();
    }
  });

  it('waits the longer of retryAfterMs and its own backoff when retries repeat (PRO-028)', async () => {
    const h = harness();
    await sleep(0);
    caret(h.c, SPIKE_IDS.after, 0);
    type(h.c, 'a');
    await sleep(0);
    const waits: number[] = [];
    for (const hint of [30, 5, 5, 300]) {
      const sent = h.first.submits.length;
      const at = h.clock.now();
      h.first.reject('busy', 'retry', 0, hint);
      await h.clock.advance(hint - 1);
      expect(h.first.submits).toHaveLength(sent);
      while (h.first.submits.length === sent) await h.clock.advance(1);
      waits.push(h.clock.now() - at);
      expect(h.first.submits[sent]).toEqual(h.first.submits[0]);
    }
    // The hint is the floor; from the third refusal the session's own backoff (10 ms, doubling) is longer.
    expect(waits).toEqual([30, 5, 10, 300]);
    h.detach();
  });
});

describe('gaps, timeouts and closes (SYN-019; 04 §9)', () => {
  it('a commit that is not the next seq closes the channel and resumes from the confirmed seq', async () => {
    const h = harness();
    await sleep(0);
    h.first.push([remoteCommit(1)]);
    await sleep(0);
    h.first.push([remoteCommit(3)]); // 2 is missing
    await h.clock.advance(1);
    expect(h.first.closed).toBe(true);
    expect(h.opens.map((o) => o.resume)).toEqual([{ seq: 1, incarnation: 'inc-1' }]);
    expect(h.c.confirmedSeq.get()).toBe(1);
  });

  it('a commit not answered within ackTimeoutMs resumes with the in-flight commit named', async () => {
    const h = harness();
    await sleep(0);
    caret(h.c, SPIKE_IDS.after, 0);
    type(h.c, 'a');
    await sleep(0);
    await h.clock.advance(14_999);
    expect(h.opens).toHaveLength(0);
    await h.clock.advance(1);
    expect(h.opens.map((o) => o.resume)).toEqual([
      { seq: 0, incarnation: 'inc-1', inflight: 'c1' },
    ]);
    // The new channel does not report it accepted: once caught up (here at once, the head being
    // the resume point) it is resent with the same id and base (04 §9 step 5).
    const second = h.opens[0]!.channel;
    expect(second.submits.map((s) => [s.id, s.base])).toEqual([['c1', 0]]);
  });

  it('a resume echoes the view token of the channel the content came from (ADR 0019; D28)', async () => {
    const h = harness({ view: 'v-1' }, 'v-1');
    await sleep(0);
    h.first.state({ status: 'closed', code: 'unavailable', reason: 'room moved' });
    await h.clock.advance(1);
    expect(h.opens[0]!.resume).toEqual({ seq: 0, incarnation: 'inc-1', view: 'v-1' });
  });

  it('a revocation takes the core offline; reconnect() opens a new channel', async () => {
    const h = harness();
    await sleep(0);
    h.first.state({ status: 'closed', code: 'forbidden', reason: 'revoked' });
    await h.clock.advance(1);
    expect(h.c.connection.get()).toBe('offline');
    expect(h.opens).toHaveLength(0);
    h.c.reconnect();
    await h.clock.advance(1);
    expect(h.opens).toHaveLength(1);
    expect(h.c.connection.get()).toBe('online');
  });

  it('catch-up reload loads the content at the head and replaces the confirmed document', async () => {
    const h = harness({ catchUp: 'reload', head: 7 });
    await h.clock.advance(1);
    expect(h.loads).toEqual([7]);
    expect(h.c.confirmedSeq.get()).toBe(7);
  });

  it('a reset loads the content pinned at its seq, then the next commit is seq + 1 (PRO-030 criterion 2)', async () => {
    const h = harness();
    await sleep(0);
    h.first.reset({ seq: 9, reason: 'import' } as SyncReset);
    await h.clock.advance(1);
    await sleep(5);
    expect(h.loads).toEqual([9]);
    expect(h.c.confirmedSeq.get()).toBe(9);
    h.first.push([remoteCommit(10)]);
    await h.clock.advance(1);
    await sleep(5);
    expect(h.loads).toEqual([9]);
    expect(h.c.confirmedSeq.get()).toBe(10);
  });

  it('a reload that brings a feature this build lacks is refused and fatal (03 §2)', async () => {
    const clock = new ManualClock();
    const c = new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
    const before = internals(c).state.doc;
    const port = {
      open: async () => new ScriptedChannel(),
      loadContent: async (): Promise<Content> =>
        ({ ...spikeDocument(), requires: ['x-future'], seq: 4, incarnation: 'inc-1' }) as Content,
    };
    c.attach(new ScriptedChannel({ catchUp: 'reload', head: 4 }), {
      seq: 0,
      incarnation: 'inc-1',
      sync: port,
      clock,
    });
    await clock.advance(1);
    expect(c.problem.get()).toMatchObject({ code: 'unsupported_feature', fatal: true });
    expect(c.problem.get()?.message).toMatch(/x-future/);
    expect(c.connection.get()).toBe('offline');
    expect(internals(c).state.doc).toBe(before); // never opened with content dropped
  });

  it('a divergence check that does not match reloads the document (04 §13)', async () => {
    const h = harness();
    await sleep(0);
    h.first.check({ seq: 0, hash: '0'.repeat(64) });
    await h.clock.advance(1);
    await sleep(5);
    expect(h.loads).toHaveLength(1);
    // A matching hash changes nothing.
    const env = {
      cdm: 1,
      requires: [],
      doc: h.i.sync.confirmed.toJSON(),
    } as unknown as JsonEnvelope;
    h.first.check({ seq: h.i.sync.seq, hash: await documentHash(env) });
    await sleep(5);
  });

  it('a divergence check that matches takes no action and reports nothing (04 §13)', async () => {
    const h = harness();
    await sleep(0);
    const env = {
      cdm: 1,
      requires: [],
      doc: h.i.sync.confirmed.toJSON(),
    } as unknown as JsonEnvelope;
    h.first.check({ seq: h.i.sync.seq, hash: await documentHash(env) });
    await h.clock.advance(1);
    await sleep(5);
    expect(h.loads).toHaveLength(0);
    expect(h.c.problem.get()).toBeNull();
  });

  it('a divergence check at another seq is ignored (04 §13)', async () => {
    const h = harness();
    await sleep(0);
    h.first.check({ seq: h.i.sync.seq + 1, hash: '0'.repeat(64) });
    await h.clock.advance(1);
    await sleep(5);
    expect(h.loads).toHaveLength(0);
    expect(h.c.problem.get()).toBeNull();
  });

  it('a divergence reloads the document and reports it with the code divergence (04 §13)', async () => {
    const h = harness();
    await sleep(0);
    h.first.check({ seq: h.i.sync.seq, hash: '0'.repeat(64) });
    await h.clock.advance(1);
    await sleep(5);
    expect(h.loads).toHaveLength(1);
    expect(h.c.problem.get()).toMatchObject({ code: 'divergence', fatal: false });
  });

  it('a confirmed step that does not apply is skipped and reported as step_failed (04 §14)', async () => {
    const h = harness();
    await sleep(0);
    const unappliable = { stepType: 'replace', from: 9999, to: 9999 };
    h.first.push([remoteCommit(1, [unappliable])]);
    await h.clock.advance(1);
    await sleep(5);
    expect(h.i.sync.seq).toBe(1);
    expect(h.c.problem.get()).toMatchObject({ code: 'step_failed', fatal: false });
  });

  it('the stream catches up by the head as well as by sync.caughtUp', async () => {
    const h = harness({ head: 2 });
    await sleep(0);
    caret(h.c, SPIKE_IDS.after, 0);
    type(h.c, 'a');
    await sleep(0);
    expect(h.first.submits).toHaveLength(0); // still catching up
    const at = posOf(h.i.sync.confirmed, SPIKE_IDS.last) + 1;
    const step = new Transform(h.i.sync.confirmed).insert(at, h.i.schema.text('x')).steps[0]!;
    h.first.push([remoteCommit(1), remoteCommit(2, [step.toJSON()])]);
    await h.clock.advance(1);
    expect(h.first.submits.map((s) => s.base)).toEqual([2]);
  });
});
