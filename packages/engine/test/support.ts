/**
 * Shared helpers for the engine's Node.js tests: cores attached to backend-mock (which runs the
 * real `Room` of @docedit/authority), positions by identifier, typing through transactions.
 */
import { MockService, type MockServiceOptions } from '@docedit/backend-mock';
import type { DocRole, SyncChannel, SyncPort } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import type { Node } from 'prosemirror-model';
import { DocumentCore, type CoreConfig } from '../src/headless.ts';
import { internals } from '../src/testing.ts';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read views notify in a microtask in tests, so that nothing waits for animation frames. */
export const microtask = (run: () => void): void => queueMicrotask(run);

export function posOf(doc: Node, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

export function textOfNode(doc: Node, id: string): string {
  return doc.nodeAt(posOf(doc, id))!.textContent;
}

/** Puts the caret inside the node with `id`, at `offset` into its content (or its end). */
export function caret(core: DocumentCore, id: string, offset: number | 'end' = 0): void {
  const i = internals(core);
  const at = posOf(i.state.doc, id);
  const node = i.state.doc.nodeAt(at)!;
  const pos = offset === 'end' ? at + node.nodeSize - 1 : at + 1 + offset;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
}

/** Types text at the selection, as a keystroke would. */
export function type(core: DocumentCore, text: string): void {
  const i = internals(core);
  i.dispatch(i.state.tr.insertText(text));
}

export interface Member {
  core: DocumentCore;
  detach: () => void;
  backend: ReturnType<MockService['backend']>;
}

/** What crossed the channels, so that a property test can show it was not vacuous. */
export const traffic = {
  acks: 0,
  rebasedAcks: 0,
  rejects: new Map<string, number>(),
  opens: new Map<string, number>(),
  resets: 0,
  commits: 0,
  /** Each commit a client submitted: its origin hint and step count (FE-049). */
  submitted: [] as { origin: string | undefined; steps: number }[],
  clear(): void {
    this.acks = 0;
    this.rebasedAcks = 0;
    this.rejects.clear();
    this.opens.clear();
    this.resets = 0;
    this.commits = 0;
    this.submitted.length = 0;
  },
};

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** A channel whose traffic is counted. */
export function counted(channel: SyncChannel): SyncChannel {
  bump(traffic.opens, channel.opened.catchUp);
  return {
    get docId() {
      return channel.docId;
    },
    get opened() {
      return channel.opened;
    },
    submit: (commit) => {
      traffic.submitted.push({ origin: commit.origin, steps: commit.steps.length });
      return channel.submit(commit).then(
        (ack) => {
          traffic.acks++;
          if (ack.rebased) traffic.rebasedAcks++;
          return ack;
        },
        (e: unknown) => {
          const code = (e as { code?: unknown }).code;
          bump(traffic.rejects, typeof code === 'string' ? code : 'other');
          throw e;
        },
      );
    },
    onCommits: (cb) =>
      channel.onCommits((commits) => {
        traffic.commits += commits.length;
        cb(commits);
      }),
    onReset: (cb) =>
      channel.onReset((r) => {
        traffic.resets++;
        cb(r);
      }),
    onAccess: (cb) => channel.onAccess(cb),
    onEvent: (cb) => channel.onEvent(cb),
    onState: (cb) => channel.onState(cb),
    onCheck: (cb) => channel.onCheck(cb),
    close: () => channel.close(),
  };
}

/** A sync port whose channels are counted. */
export function countedPort(port: SyncPort): Pick<SyncPort, 'open' | 'loadContent'> {
  return {
    open: async (docId, opts) => counted(await port.open(docId, opts)),
    loadContent: (docId, seq) => port.loadContent(docId, seq),
  };
}

/** Joins a document as 05 §5.2 describes: content over REST, then the channel resumed at its seq. */
export async function join(
  service: MockService,
  docId: string,
  sub: string,
  role: DocRole,
  config: Partial<CoreConfig> = {},
  opts: { batchMs?: number; groups?: string[] } = {},
): Promise<Member> {
  const backend = service.backend(opts.groups ? { sub, groups: opts.groups } : { sub }, {
    [docId]: role,
  });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: microtask, ...config });
  const port = countedPort(backend.sync);
  const channel = await port.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const limits = backend.auth.session?.limits;
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: port,
    ...(limits ? { limits } : {}),
    batchMs: opts.batchMs ?? 0,
    retry: { minMs: 2, maxMs: 20 },
  });
  return { core, detach, backend };
}

/** Waits until `done()` holds, letting timers and microtasks run. */
export async function until(done: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1);
  }
}

export function newService(opts: MockServiceOptions = {}): MockService {
  return new MockService({ presence: false, ...opts });
}
