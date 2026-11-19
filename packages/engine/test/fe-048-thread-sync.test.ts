/**
 * The core takes the service's threads and keeps their ranges aligned (FE-048 criteria 1, 4 and 6;
 * 05 §5.6, §6.2). Node.js: the real core against the mock service (real room, real commits), with a
 * thread port the test controls, because the mock service has no thread resource. The notices are
 * pushed on the core's own channel, as `thread.*` notices of the service are.
 *
 * - Criterion 1: on attach the core lists the threads at its confirmed `seq`; a range thread and a
 *   block thread are held and published for the body view.
 * - Criterion 4: a notice with a range and an older `seq` replaces the copy and the range is mapped
 *   forward through the confirmed commits since that `seq` and through the unconfirmed local steps;
 *   a notice ahead of the confirmed document waits for it; one older than the log reaches asks for
 *   the list again.
 * - Criterion 6: creating, resolving and reopening a thread sends no commit and leaves the document.
 */
import type { MockService } from '@docedit/backend-mock';
import type { Notification, SyncChannel } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import type { ThreadItem, ThreadsPortLike } from '../src/thread-sync.ts';
import { IDS, contractDocument } from './fixtures.ts';
import { caret, microtask, newService, posOf, type, until } from './support.ts';

const ROUND = '0190f000-0000-7000-8000-000000000480';
const BLOCKED = '0190f000-0000-7000-8000-000000000481';

/** The channel of the core, with a way to push a notice into it as the service does. */
function withNotices(channel: SyncChannel): {
  channel: SyncChannel;
  emit: (n: Notification) => void;
} {
  const listeners = new Set<(n: Notification) => void>();
  const wrapped = new Proxy(channel, {
    get(target, key) {
      if (key === 'onEvent')
        return (cb: (n: Notification) => void) => {
          listeners.add(cb);
          const off = target.onEvent(cb);
          return () => {
            listeners.delete(cb);
            off();
          };
        };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { channel: wrapped, emit: (n) => listeners.forEach((l) => l(n)) };
}

interface PortCalls {
  readonly lists: { seq?: number; cursor?: string; limit?: number }[];
  readonly writes: string[];
}

/** A thread port whose listing is `items(seq)` and which records every call. */
function fakePort(items: (seq: number) => ThreadItem[]): { port: ThreadsPortLike } & PortCalls {
  const lists: PortCalls['lists'] = [];
  const writes: string[] = [];
  const port: ThreadsPortLike = {
    threads: async (_docId, query) => {
      lists.push({ ...query });
      return { items: items(query?.seq ?? 0), nextCursor: null };
    },
    createThread: async (_docId, body) => {
      writes.push(`create ${JSON.stringify(body.target)}`);
      return { value: { id: ROUND, state: 'open' }, etag: `${ROUND}:open` };
    },
    thread: async (id) => ({ value: { id, state: 'open' }, etag: `${id}:open` }),
    updateThread: async (id, patch, opts) => {
      writes.push(`update ${id} ${patch.state} if-match ${opts.ifMatch}`);
      return { value: { id, state: patch.state ?? 'open' }, etag: `${id}:${patch.state}` };
    },
  };
  return { port, lists, writes };
}

async function joinWithThreads(
  service: MockService,
  docId: string,
  sub: string,
  role: 'owner' | 'editor',
  port: ThreadsPortLike | null,
) {
  const backend = service.backend({ sub }, { [docId]: role });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: microtask });
  const opened = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const notices = withNotices(opened);
  const limits = backend.auth.session?.limits;
  const detach = core.attach(notices.channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    ...(limits ? { limits } : {}),
    batchMs: 0,
    retry: { minMs: 2, maxMs: 20 },
    features: ['comments'],
    ...(port ? { threads: port } : {}),
  });
  await until(() => core.permissions.get() !== null, `access for ${sub}`);
  return { core, detach, emit: notices.emit, seq: content.seq };
}

const saved = (core: DocumentCore) => until(() => core.saveState.get() === 'saved', 'saved', 5000);
const introStart = (core: DocumentCore) => posOf(internals(core).state.doc, IDS.intro) + 1;

function notice(type: string, id: string, data: Record<string, unknown>): Notification {
  return { type, resource: `/threads/${id}`, data } as unknown as Notification;
}

describe('the core lists the threads and draws them (FE-048 criterion 1)', () => {
  it('lists at the confirmed seq and holds a range thread and a block thread', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const listed = fakePort((seq) => [
      {
        id: ROUND,
        state: 'open',
        target: { range: { from: 0 + 6, to: 0 + 11, baseSeq: seq } },
      },
      { id: BLOCKED, state: 'open', target: { block: IDS.mid } },
    ]);
    const olivia = await joinWithThreads(service, docId, 'olivia', 'owner', listed.port);
    await until(() => olivia.core.threadBlocks.get().length === 1, 'the block thread');
    // The listing is asked at the seq of the content the core holds.
    expect(listed.lists[0]?.seq).toBe(olivia.seq);
    expect(olivia.core.threadBlocks.get()).toEqual([{ id: BLOCKED, block: IDS.mid }]);
    const [range] = olivia.core.threadRanges.get();
    expect(range).toMatchObject({ id: ROUND, from: 6, to: 11, detached: false });
    olivia.detach();
    olivia.core.destroy();
  });

  it('lists nothing when the backend has no comment port', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const olivia = await joinWithThreads(service, docId, 'olivia', 'owner', null);
    expect(olivia.core.threadRanges.get()).toEqual([]);
    olivia.detach();
    olivia.core.destroy();
  });
});

describe('a notice replaces the copy and maps it forward from its seq (FE-048 criterion 4)', () => {
  it('maps through the confirmed commits since the seq and through unconfirmed local steps', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const { port } = fakePort(() => []);
    const olivia = await joinWithThreads(service, docId, 'olivia', 'owner', port);
    const sam = await joinWithThreads(service, docId, 'sam', 'editor', null);
    const at = olivia.seq;
    const start = introStart(olivia.core);

    // Sam types at the start of the intro: a confirmed commit after `at`, which Olivia receives.
    caret(sam.core, IDS.intro, 0);
    type(sam.core, 'Hey ');
    await saved(sam.core);
    await until(
      () => olivia.core.saveState.get() === 'saved' && introText(olivia.core).startsWith('Hey '),
      'sam commit',
    );

    // The service reports the thread on "world" at `at`, before Sam's commit.
    olivia.emit(
      notice('thread.updated', ROUND, {
        state: 'open',
        seq: at,
        range: { from: start + 6, to: start + 11 },
      }),
    );
    expect(olivia.core.threadRanges.get()).toHaveLength(1);
    // The client maps it through Sam's four characters.
    expect(olivia.core.threadRanges.get()[0]).toMatchObject({
      from: start + 10,
      to: start + 15,
      detached: false,
    });

    // Olivia types at the start too; the commit is unconfirmed when the next notice arrives.
    caret(olivia.core, IDS.intro, 0);
    type(olivia.core, 'Big ');
    olivia.emit(
      notice('thread.updated', ROUND, {
        state: 'open',
        seq: at,
        range: { from: start + 6, to: start + 11 },
      }),
    );
    expect(olivia.core.threadRanges.get()[0]).toMatchObject({ from: start + 14, to: start + 19 });
    // Once the commit is confirmed the copy has not moved again (no double mapping).
    await saved(olivia.core);
    expect(olivia.core.threadRanges.get()[0]).toMatchObject({ from: start + 14, to: start + 19 });

    olivia.detach();
    sam.detach();
    olivia.core.destroy();
    sam.core.destroy();
  });

  it('a range the service reports as empty is detached, and a deleted thread is removed', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const { port } = fakePort(() => []);
    const olivia = await joinWithThreads(service, docId, 'olivia', 'owner', port);
    const start = introStart(olivia.core);
    olivia.emit(
      notice('thread.updated', ROUND, {
        state: 'open',
        seq: olivia.seq,
        range: { from: start + 3, to: start + 3 },
      }),
    );
    expect(olivia.core.threadRanges.get()[0]).toMatchObject({ id: ROUND, detached: true });
    olivia.emit(notice('thread.deleted', ROUND, { state: 'open', seq: olivia.seq }));
    expect(olivia.core.threadRanges.get()).toEqual([]);
    olivia.detach();
    olivia.core.destroy();
  });

  it('a notice ahead of the confirmed document waits for it', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const { port } = fakePort(() => []);
    const olivia = await joinWithThreads(service, docId, 'olivia', 'owner', port);
    const sam = await joinWithThreads(service, docId, 'sam', 'editor', null);
    const start = introStart(olivia.core);
    // The notice is for the document after Sam's coming commit; Olivia has not got it yet.
    olivia.emit(
      notice('thread.created', ROUND, {
        state: 'open',
        seq: olivia.seq + 1,
        range: { from: start + 10, to: start + 15 },
      }),
    );
    expect(olivia.core.threadRanges.get()).toEqual([]);
    caret(sam.core, IDS.intro, 0);
    type(sam.core, 'Hey ');
    await saved(sam.core);
    await until(() => olivia.core.threadRanges.get().length === 1, 'the held thread is placed');
    // The positions are those of the document at the notice's seq: nothing maps them further.
    expect(olivia.core.threadRanges.get()[0]).toMatchObject({ from: start + 10, to: start + 15 });
    olivia.detach();
    sam.detach();
    olivia.core.destroy();
    sam.core.destroy();
  });

  it('a notice older than the commits the client keeps asks for the list again', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    // The document has a commit before Olivia joins, so that her floor is above seq 0.
    const sam = await joinWithThreads(service, docId, 'sam', 'editor', null);
    caret(sam.core, IDS.intro, 0);
    type(sam.core, 'Hey ');
    await saved(sam.core);
    const listed = fakePort(() => []);
    const olivia = await joinWithThreads(service, docId, 'olivia', 'owner', listed.port);
    expect(olivia.seq).toBeGreaterThan(0);
    await until(() => listed.lists.length === 1, 'the first listing');
    expect(
      olivia.core.reportThread(ROUND, { seq: olivia.seq - 1, range: { from: 1, to: 3 } }),
    ).toBe('stale');
    expect(olivia.core.threadRanges.get()).toEqual([]);
    // The same through a notice: the core lists the threads again, at its confirmed seq.
    olivia.emit(
      notice('thread.updated', ROUND, {
        state: 'open',
        seq: olivia.seq - 1,
        range: { from: 1, to: 3 },
      }),
    );
    await until(() => listed.lists.length === 2, 'the second listing');
    expect(listed.lists[1]?.seq).toBe(olivia.seq);
    olivia.detach();
    sam.detach();
    olivia.core.destroy();
    sam.core.destroy();
  });
});

function introText(core: DocumentCore): string {
  const doc = internals(core).state.doc;
  const pos = posOf(doc, IDS.intro);
  return doc.nodeAt(pos)!.textContent;
}

describe('creating, resolving and reopening a thread is no commit (FE-048 criterion 6)', () => {
  it('sends requests to the thread resource and leaves the document, the queue and the log', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument());
    const listed = fakePort(() => []);
    const olivia = await joinWithThreads(service, docId, 'olivia', 'owner', listed.port);
    const docBefore = internals(olivia.core).state.doc;
    const headBefore = service.document(docId)!.head;
    const start = introStart(olivia.core);

    const id = await olivia.core.createThread(
      { range: { from: start + 6, to: start + 11, baseSeq: olivia.seq } },
      { body: 'Check this' },
    );
    expect(id).toBe(ROUND);
    await olivia.core.setThreadState(ROUND, 'resolved');
    await olivia.core.setThreadState(ROUND, 'open');
    // The service's notices for the three changes arrive; none of them is a commit either.
    for (const t of ['thread.created', 'thread.resolved', 'thread.reopened'])
      olivia.emit(
        notice(t, ROUND, {
          state: 'open',
          seq: olivia.seq,
          range: { from: start + 6, to: start + 11 },
        }),
      );

    expect(listed.writes).toEqual([
      `create ${JSON.stringify({ range: { from: start + 6, to: start + 11, baseSeq: olivia.seq } })}`,
      `update ${ROUND} resolved if-match ${ROUND}:open`,
      `update ${ROUND} open if-match ${ROUND}:open`,
    ]);
    expect(internals(olivia.core).state.doc.eq(docBefore)).toBe(true);
    expect(olivia.core.saveState.get()).toBe('saved');
    expect(service.document(docId)!.head).toBe(headBefore);
    expect(olivia.core.threadRanges.get()).toHaveLength(1);
    olivia.detach();
    olivia.core.destroy();
  });
});
