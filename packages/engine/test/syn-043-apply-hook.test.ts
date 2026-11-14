/**
 * SYN-043 criterion 5: a test hook makes one client apply a confirmed step differently; when the
 * divergence check runs against the server's hash, that client reloads and reports the event
 * (04 §13). The hook is a spy on `ReplaceStep.apply` that applies every replace as a no-op, so the
 * client's confirmed document lacks the inserted text while the server's hash includes it.
 * The control test runs the same check with no hook and expects no action.
 */
import { documentHash, type JsonEnvelope } from '@docedit/model';
import type { ChannelOpened, Commit, Content, RemoteCommit, SyncChannel } from '@docedit/protocol';
import { ReplaceStep, StepResult, Transform } from 'prosemirror-transform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, spikeDocument } from './fixtures.ts';
import { posOf, sleep } from './support.ts';

type Listener<T> = (v: T) => void;

/** A channel that records submits and delivers what the test pushes. */
class HookChannel implements SyncChannel {
  readonly docId = 'doc-1';
  readonly opened: ChannelOpened = {
    head: 0,
    incarnation: 'inc-1',
    catchUp: 'stream',
    access: editorAccess(),
  };
  #commits = new Set<Listener<RemoteCommit[]>>();
  #checks = new Set<Listener<{ seq: number; hash: string; t: 'sync.check' }>>();
  submit(_commit: Commit): Promise<never> {
    return new Promise<never>(() => {});
  }
  push(commits: RemoteCommit[]): void {
    queueMicrotask(() => this.#commits.forEach((cb) => cb(commits)));
  }
  check(seq: number, hash: string): void {
    queueMicrotask(() => this.#checks.forEach((cb) => cb({ t: 'sync.check', seq, hash })));
  }
  onCommits(cb: Listener<RemoteCommit[]>) {
    this.#commits.add(cb);
    return () => void this.#commits.delete(cb);
  }
  onReset() {
    return () => {};
  }
  onAccess() {
    return () => {};
  }
  onEvent() {
    return () => {};
  }
  onState() {
    return () => {};
  }
  onCheck(cb: Listener<{ seq: number; hash: string; t: 'sync.check' }>) {
    this.#checks.add(cb);
    return () => void this.#checks.delete(cb);
  }
  close(): void {}
}

function harness() {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
  const channel = new HookChannel();
  const loads: Array<number | undefined> = [];
  const port = {
    open: async () => channel,
    loadContent: async (_doc: string, seq?: number): Promise<Content> => {
      loads.push(seq);
      return { ...(spikeDocument() as Content), seq: seq ?? 0, incarnation: 'inc-1' };
    },
  };
  c.attach(channel, {
    seq: 0,
    incarnation: 'inc-1',
    sync: port,
    batchMs: 100,
    newId: () => 'c1',
    retry: { minMs: 10, maxMs: 40 },
  } as Parameters<DocumentCore['attach']>[1]);
  return { c, i: internals(c), channel, loads };
}

/** The step that inserts `x` at the end of the spike document, and the hash the server holds for it. */
async function serverStep(h: ReturnType<typeof harness>) {
  const doc = h.i.sync.confirmed;
  const at = posOf(doc, SPIKE_IDS.last) + 1;
  const tr = new Transform(doc).insert(at, h.i.schema.text('x'));
  const env = { cdm: 1, requires: [], doc: tr.doc.toJSON() } as unknown as JsonEnvelope;
  return { step: tr.steps[0]!.toJSON(), hash: await documentHash(env) };
}

const remoteCommit = (seq: number, steps: unknown[]): RemoteCommit => ({
  seq,
  kind: 'steps',
  id: `r${seq}`,
  steps: steps as RemoteCommit['steps'],
  control: null,
  author: { user: 'other', session: 's', agent: null },
  serverTime: 't',
  origin: 'input',
});

describe('divergence check with a client that applies a step differently (SYN-043, 04 §13)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a client whose apply differs reloads on the check and reports divergence', async () => {
    const h = harness();
    await sleep(5);
    const { step, hash } = await serverStep(h);
    // The hook: this client applies every replace as a no-op.
    vi.spyOn(ReplaceStep.prototype, 'apply').mockImplementation((doc) => StepResult.ok(doc));
    h.channel.push([remoteCommit(1, [step])]);
    await sleep(20);
    expect(h.i.sync.seq).toBe(1);
    h.channel.check(1, hash);
    await sleep(40);
    expect(h.loads).toHaveLength(1);
    expect(h.c.problem.get()).toMatchObject({ code: 'divergence', fatal: false });
  });

  it('a client that applies the step as the server does takes no action on the same check', async () => {
    const h = harness();
    await sleep(5);
    const { step, hash } = await serverStep(h);
    h.channel.push([remoteCommit(1, [step])]);
    await sleep(20);
    expect(h.i.sync.seq).toBe(1);
    h.channel.check(1, hash);
    await sleep(40);
    expect(h.loads).toHaveLength(0);
    expect(h.c.problem.get()).toBeNull();
  });
});
