/**
 * Reconnect and resume over a scripted channel (04 §8, §9; SYN-028): what a reload does with
 * unconfirmed work, what an in-flight commit reported `accepted` or `unknown` leads to, and when a
 * stream goes live. Each reconnect opens a channel whose `ch.opened` the test writes (ChannelOpened).
 */
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
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import type { Clock } from '../src/sync/session.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, spikeDocument } from './fixtures.ts';
import { caret, sleep, textOfNode, type } from './support.ts';

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

  constructor(opened: ChannelOpened) {
    this.opened = opened;
  }
  submit(commit: Commit): Promise<Ack> {
    this.submits.push(commit);
    return new Promise<Ack>((resolve, reject) => this.#answers.push({ resolve, reject }));
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

/**
 * Attaches a core to a port that opens one channel per entry of `plans`, in order; each plan is the
 * `ch.opened` of that open (its head and catch-up). Content for reloads is the spike document at the
 * requested seq.
 */
function setup(plans: Array<Partial<ChannelOpened>>) {
  const clock = new ManualClock();
  const c = new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
  // channels[0] is the channel the core is attached to; channels[k] is the k-th reopen.
  const first = new ScriptedChannel({
    head: 0,
    incarnation: 'inc-1',
    catchUp: 'stream',
    access: editorAccess(),
  });
  const channels: ScriptedChannel[] = [first];
  const resumes: Array<Resume | undefined> = [];
  let ids = 0;
  const port = {
    open: async (_doc: string, o: { resume?: Resume }) => {
      const plan = plans[channels.length - 1] ?? {};
      resumes.push(o.resume);
      const ch = new ScriptedChannel({
        head: o.resume?.seq ?? 0,
        incarnation: 'inc-1',
        catchUp: 'stream',
        access: editorAccess(),
        ...plan,
      });
      channels.push(ch);
      return ch;
    },
    loadContent: async (_doc: string, seq?: number): Promise<Content> => ({
      ...(spikeDocument() as Content),
      seq: seq ?? 0,
      incarnation: 'inc-1',
    }),
  };
  c.attach(first, {
    seq: 0,
    incarnation: 'inc-1',
    sync: port,
    clock,
    batchMs: 100,
    newId: () => `c${++ids}`,
    retry: { minMs: 10, maxMs: 40 },
    limits: { ackTimeoutMs: 15_000, maxStepsPerCommit: 500, maxCommitBytes: 1 << 20 },
  });
  return { c, i: internals(c), clock, channels, resumes };
}

/** A control commit (no steps) at `seq`, as a stream delivers it. */
const control = (seq: number, id = `r${seq}`): RemoteCommit => ({
  seq,
  kind: 'control',
  id,
  steps: [] as RemoteCommit['steps'],
  control: { type: 'grants', rev: seq },
  author: { user: 'other', session: 's', agent: null },
  serverTime: 't',
  origin: 'input',
});

/** Types one letter and waits until it is in flight on the first channel. */
async function typeOneLetter(h: ReturnType<typeof setup>): Promise<void> {
  await sleep(0);
  caret(h.c, SPIKE_IDS.after, 0);
  type(h.c, 'a');
  await sleep(0);
}

/** Drops the connection with a retryable close and lets the session reopen it. */
async function drop(h: ReturnType<typeof setup>, n: number): Promise<void> {
  h.channels[n]!.state({ status: 'closed', code: 'unavailable', reason: 'room moved' });
  await h.clock.advance(1);
  await sleep(5);
}

describe('reload moves unconfirmed work to recovered edits (SYN-028 criterion 2)', () => {
  it('a catch-up reload replaces the confirmed document and sets the unconfirmed text aside', async () => {
    const h = setup([{ catchUp: 'reload', head: 3, inflight: { state: 'unknown' } }]);
    const before = textOfNode(h.i.state.doc, SPIKE_IDS.after);
    await typeOneLetter(h);
    expect(h.channels[0]!.submits.map((s) => s.id)).toEqual(['c1']);
    await drop(h, 0);
    expect(h.resumes[0]).toEqual({ seq: 0, incarnation: 'inc-1', inflight: 'c1' });
    expect(h.c.confirmedSeq.get()).toBe(3);
    const recovered = h.c.recovered.get().items;
    expect(recovered.map((r) => [r.reason, r.text])).toEqual([['reload', 'a']]);
    // The reloaded document is the head's content: the set-aside letter is not in it.
    expect(textOfNode(h.i.state.doc, SPIKE_IDS.after)).toBe(before);
    expect(h.channels[1]!.submits).toHaveLength(0);
  });
});

describe('an in-flight commit reported by the resume (SYN-028 criterion 5)', () => {
  it('accepted: the stream carries the commit under its id, so it is not resubmitted', async () => {
    const h = setup([{ head: 1, inflight: { state: 'accepted', seq: 1 } }]);
    await typeOneLetter(h);
    const sent = h.channels[0]!.submits[0]!;
    await drop(h, 0);
    expect(h.resumes[0]?.inflight).toBe(sent.id);
    h.channels[1]!.push([
      {
        seq: 1,
        kind: 'steps',
        id: sent.id,
        steps: sent.steps as RemoteCommit['steps'],
        control: null,
        author: { user: 'me', session: 's', agent: null },
        serverTime: 't',
        origin: 'input',
      },
    ]);
    await h.clock.advance(1);
    await sleep(5);
    expect(h.c.confirmedSeq.get()).toBe(1);
    expect(h.channels[1]!.submits).toHaveLength(0);
    expect(h.c.saveState.get()).toBe('saved');
  });

  it('unknown: resent with the same id only after the stream has caught up', async () => {
    const h = setup([{ head: 2, inflight: { state: 'unknown' } }]);
    await typeOneLetter(h);
    await drop(h, 0);
    const second = h.channels[1]!;
    expect(second.submits).toHaveLength(0); // not before the catch-up
    second.push([control(1)]);
    await h.clock.advance(1);
    await sleep(5);
    expect(second.submits).toHaveLength(0); // still catching up at seq 1 of head 2
    second.push([control(2)]);
    await h.clock.advance(1);
    await sleep(5);
    expect(second.submits.map((s) => s.id)).toEqual(['c1']);
  });
});

describe('a stream goes live on sync.caughtUp (SYN-028 criterion 3)', () => {
  it('commits are applied in order, and nothing is sent before the live state arrives', async () => {
    // The resume reports the in-flight commit `unknown`, so it is resent once the stream is live.
    const h = setup([{ head: 2, inflight: { state: 'unknown' } }]);
    await typeOneLetter(h);
    await drop(h, 0);
    const second = h.channels[1]!;
    second.push([control(1)]);
    await sleep(5);
    expect(h.c.confirmedSeq.get()).toBe(1);
    await h.clock.advance(200);
    expect(second.submits).toHaveLength(0); // catching up, and the head is not reached yet
    // sync.caughtUp (the channel's live state). Commit 2 is not delivered here, so only the signal
    // ends the catch-up; the head path is tested in session.test.ts.
    second.state({ status: 'live', seq: 2 });
    await sleep(5);
    await h.clock.advance(200);
    expect(second.submits.map((s) => s.id)).toEqual(['c1']);
  });
});

describe('suspend and resume (FE-005 criteria 3 and 4; 02 §2.1)', () => {
  it('suspend closes the channel and opens none; the unconfirmed work stays', async () => {
    const h = setup([{}]);
    await typeOneLetter(h);
    const sent = h.channels[0]!.submits[0]!;
    h.c.suspendSync();
    expect(h.channels[0]!.closed).toBe(true);
    expect(h.c.connection.get()).toBe('offline');
    // No retry timer reopens it, however long the suspension lasts.
    await h.clock.advance(60_000);
    expect(h.channels).toHaveLength(1);
    expect(h.resumes).toEqual([]);
    expect(h.c.syncSnapshot().inflight?.id).toBe(sent.id);
    expect(textOfNode(h.i.state.doc, SPIKE_IDS.after).startsWith('a')).toBe(true);
  });

  it('a second suspend and a resume without a suspend do nothing', async () => {
    const h = setup([{}]);
    await sleep(0);
    h.c.resumeSync();
    await h.clock.advance(100);
    expect(h.channels).toHaveLength(1);
    expect(h.channels[0]!.closed).toBe(false);
    h.c.suspendSync();
    h.c.suspendSync();
    expect(h.channels[0]!.closed).toBe(true);
  });

  it('resume reopens with the confirmed seq and the in-flight commit, and sends what waited', async () => {
    const h = setup([{ inflight: { state: 'unknown' } }]);
    await typeOneLetter(h);
    const sent = h.channels[0]!.submits[0]!;
    h.c.suspendSync();
    // An edit made while suspended waits in the queue: there is no channel to send it on.
    type(h.c, 'b');
    await h.clock.advance(1_000);
    expect(h.channels).toHaveLength(1);

    h.c.resumeSync();
    await h.clock.advance(1);
    await sleep(5);
    expect(h.channels).toHaveLength(2);
    expect(h.resumes[0]).toEqual({ seq: 0, incarnation: 'inc-1', inflight: sent.id });
    expect(h.c.connection.get()).toBe('online');
    await h.clock.advance(1_000);
    // The commit whose fate is unknown is sent again under its identifier (04 §9).
    expect(h.channels[1]!.submits.map((s) => s.id)).toContain(sent.id);
    expect(textOfNode(h.i.state.doc, SPIKE_IDS.after).startsWith('ab')).toBe(true);
    expect(h.c.recovered.get().count).toBe(0);
  });
});
