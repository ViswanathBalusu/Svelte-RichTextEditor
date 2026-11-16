/**
 * PRM-020 criterion 4 (04 §6, `permission_denied`: "refresh permissions"; 07 §9): after a commit is
 * refused with `permission_denied`, the client's access is the server's. Either the `perm.changed`
 * arrives (before or after the rejection), or the session reopens the channel and takes the access
 * of `ch.opened`. Scripted channel and manual clock, as in `session.test.ts`.
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
import { editorAccess, SPIKE_IDS, spikeDocument } from './fixtures.ts';
import { caret, sleep, type } from './support.ts';

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

class ScriptedChannel implements SyncChannel {
  readonly docId = 'doc-1';
  readonly opened: ChannelOpened;
  readonly submits: Commit[] = [];
  closed = false;
  #answers: Array<{ resolve: (a: Ack) => void; reject: (e: unknown) => void }> = [];
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
  /** Refuses the oldest unanswered commit with `permission_denied` and the scopes. */
  deny(scopes: string[]): void {
    const c = this.submits[this.submits.length - this.#answers.length]!;
    this.#answers.shift()!.reject(
      Object.assign(new Error('permission_denied'), {
        id: c.id,
        code: 'permission_denied',
        action: 'drop',
        head: 0,
        scopes,
      }),
    );
  }
  access(a: Access): void {
    queueMicrotask(() => this.#access.forEach((cb) => cb(a)));
  }
  onCommits(_cb: Listener<RemoteCommit[]>) {
    return () => {};
  }
  onReset(_cb: Listener<SyncReset>) {
    return () => {};
  }
  onAccess(cb: Listener<Access>) {
    this.#access.add(cb);
    return () => void this.#access.delete(cb);
  }
  onEvent() {
    return () => {};
  }
  onState(_cb: Listener<ChannelState>) {
    return () => {};
  }
  onCheck(_cb: Listener<SyncCheck>) {
    return () => {};
  }
  close(): void {
    this.closed = true;
  }
}

/** What the server holds once the body is no longer the user's to edit. */
const serverAccess = (): Access => {
  const before = editorAccess();
  return {
    ...before,
    rev: 2,
    docRole: 'viewer',
    caps: ['view'],
    scopes: { ...before.scopes, body: ['view'] },
  };
};

function harness() {
  const clock = new ManualClock();
  const c = new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
  const first = new ScriptedChannel();
  const opens: Array<{ resume: Resume | undefined; channel: ScriptedChannel }> = [];
  const port = {
    // A reopened channel carries the server's access in `ch.opened` (05 §5.2).
    open: async (_doc: string, o: { resume?: Resume }) => {
      const ch = new ScriptedChannel({ head: o.resume?.seq ?? 0, access: serverAccess() });
      opens.push({ resume: o.resume, channel: ch });
      return ch;
    },
    loadContent: async (_doc: string, seq?: number): Promise<Content> => ({
      ...(spikeDocument() as Content),
      seq: seq ?? 0,
      incarnation: 'inc-1',
    }),
  };
  let ids = 0;
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
  return { c, clock, first, opens };
}

async function typeAndSubmit(h: ReturnType<typeof harness>): Promise<void> {
  await sleep(0);
  caret(h.c, SPIKE_IDS.after, 0);
  type(h.c, 'a');
  await sleep(0);
  expect(h.first.submits).toHaveLength(1);
}

describe('refreshing permissions after permission_denied (PRM-020 criterion 4)', () => {
  it('keeps the channel when perm.changed came before the rejection: the access is already the server`s', async () => {
    const h = harness();
    await typeAndSubmit(h);
    h.first.access(serverAccess());
    await sleep(0);
    h.first.deny(['body']);
    await h.clock.advance(60_000);
    expect(h.c.permissions.get()).toEqual(serverAccess());
    expect(h.opens).toHaveLength(0);
    expect(h.first.closed).toBe(false);
  });

  it('waits for a perm.changed that follows the rejection and does not reopen the channel', async () => {
    const h = harness();
    await typeAndSubmit(h);
    h.first.deny(['body']);
    await h.clock.advance(1_000);
    // Stale: the client still believes it may edit the body.
    expect(h.c.permissions.get()?.scopes['body']).toContain('edit');
    h.first.access(serverAccess());
    await h.clock.advance(60_000);
    expect(h.c.permissions.get()).toEqual(serverAccess());
    expect(h.opens).toHaveLength(0);
  });

  it('reopens the channel when no perm.changed arrives, and takes the access of ch.opened', async () => {
    const h = harness();
    await typeAndSubmit(h);
    h.first.deny(['body']);
    await h.clock.advance(14_999);
    expect(h.opens).toHaveLength(0);
    await h.clock.advance(2);
    expect(h.first.closed).toBe(true);
    expect(h.opens.map((o) => o.resume)).toEqual([{ seq: 0, incarnation: 'inc-1' }]);
    expect(h.c.permissions.get()).toEqual(serverAccess());
    // The refreshed access holds; nothing reopens again.
    await h.clock.advance(60_000);
    expect(h.opens).toHaveLength(1);
  });

  it('treats a refusal without scopes as the document-level capabilities', async () => {
    const h = harness();
    await typeAndSubmit(h);
    h.first.deny([]);
    await h.clock.advance(15_001);
    expect(h.opens).toHaveLength(1);
    expect(h.c.permissions.get()?.caps).toEqual(['view']);
  });
});
