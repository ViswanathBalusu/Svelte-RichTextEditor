/**
 * PRO-026 criterion 5 (lane U-PRO-018-034): a log whose incarnation changed after a database
 * recovery. A client with unconfirmed work reconnects, the server answers the resume with a reload
 * under the new incarnation, and the session moves the unconfirmed work to recovered edits (SYN-026,
 * SYN-028). The scripted channel and the manual clock follow sync-resume.test.ts; the content for
 * the reload carries the new incarnation. Node.js, no network.
 */
import type {
  Access,
  Ack,
  ChannelOpened,
  ChannelState,
  Commit,
  Content,
  Notification,
  RemoteCommit,
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
  #answers: Array<{ resolve: (a: Ack) => void; reject: (e: unknown) => void }> = [];
  #commits = new Set<Listener<RemoteCommit[]>>();
  #states = new Set<Listener<ChannelState>>();
  #checks = new Set<Listener<SyncCheck>>();
  #resets = new Set<Listener<SyncReset>>();
  #access = new Set<Listener<Access>>();
  #events = new Set<Listener<Notification>>();

  constructor(opened: ChannelOpened) {
    this.opened = opened;
  }
  submit(commit: Commit): Promise<Ack> {
    this.submits.push(commit);
    return new Promise<Ack>((resolve, reject) => this.#answers.push({ resolve, reject }));
  }
  state(s: ChannelState): void {
    queueMicrotask(() => this.#states.forEach((cb) => cb(s)));
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
  onEvent(cb: Listener<Notification>) {
    this.#events.add(cb);
    return () => void this.#events.delete(cb);
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
    // The scripted channel has no connection to close.
  }
}

const OLD = 'inc-1';
const NEW = 'inc-2';

describe('PRO-026 criterion 5: a changed incarnation after a recovery moves unconfirmed work to recovered edits', () => {
  it('reload under the new incarnation replaces the document and keeps the typed letter as recovered', async () => {
    const clock = new ManualClock();
    const c = new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
    const resumes: Array<{ seq: number; incarnation: string; inflight?: string } | undefined> = [];
    const channels: ScriptedChannel[] = [];
    let ids = 0;

    // The second open answers with a reload at head 3 under the new incarnation, and reports the
    // in-flight commit unknown: the log was recovered and does not hold it.
    const plans: Array<Partial<ChannelOpened>> = [
      { head: 3, incarnation: NEW, catchUp: 'reload', inflight: { state: 'unknown' } },
    ];
    const port = {
      open: async (
        _doc: string,
        o: { resume?: { seq: number; incarnation: string; inflight?: string } },
      ) => {
        resumes.push(o.resume);
        const plan = plans[channels.length - 1] ?? {};
        const ch = new ScriptedChannel({
          head: o.resume?.seq ?? 0,
          incarnation: OLD,
          catchUp: 'stream',
          access: editorAccess(),
          ...plan,
        } as ChannelOpened);
        channels.push(ch);
        return ch;
      },
      loadContent: async (_doc: string, seq?: number): Promise<Content> => ({
        ...(spikeDocument() as Content),
        seq: seq ?? 3,
        incarnation: NEW,
      }),
    };

    const first = new ScriptedChannel({
      head: 0,
      incarnation: OLD,
      catchUp: 'stream',
      access: editorAccess(),
    } as ChannelOpened);
    channels.push(first);
    c.attach(first, {
      seq: 0,
      incarnation: OLD,
      sync: port,
      clock,
      batchMs: 100,
      newId: () => `c${++ids}`,
      retry: { minMs: 10, maxMs: 40 },
      limits: { ackTimeoutMs: 15_000, maxStepsPerCommit: 500, maxCommitBytes: 1 << 20 },
    });
    const i = internals(c);

    const before = textOfNode(i.state.doc, SPIKE_IDS.after);
    await sleep(0);
    caret(c, SPIKE_IDS.after, 0);
    type(c, 'a');
    await sleep(0);
    expect(channels[0]!.submits.map((s) => s.id)).toEqual(['c1']);

    // Drop the connection: the session resumes with the old incarnation and the in-flight id.
    channels[0]!.state({ status: 'closed', code: 'unavailable', reason: 'database recovered' });
    await clock.advance(1);
    await sleep(5);

    expect(resumes[0]).toEqual({ seq: 0, incarnation: OLD, inflight: 'c1' });
    // The reload took the new head from the content under the new incarnation.
    expect(c.confirmedSeq.get()).toBe(3);
    // The unconfirmed letter is recovered, and it is no longer in the document.
    const recovered = c.recovered.get().items;
    expect(recovered.map((r) => [r.reason, r.text])).toEqual([['reload', 'a']]);
    expect(textOfNode(i.state.doc, SPIKE_IDS.after)).toBe(before);
    // The unknown commit is not resubmitted on the reloaded channel.
    expect(channels[1]!.submits).toHaveLength(0);

    // The next resume names the new incarnation, so the session follows the recovered log.
    channels[1]!.state({ status: 'closed', code: 'unavailable', reason: 'reconnect' });
    await clock.advance(1);
    await sleep(5);
    expect(resumes[1]).toEqual({ seq: 3, incarnation: NEW });
  });
});
