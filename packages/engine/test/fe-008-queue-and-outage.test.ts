/**
 * FE-008 criteria 2 and 4 (lane w1), on backend-mock's real Room with an in-memory journal.
 *
 * Criterion 2: while steps are queued and not yet sent, the journal holds the in-flight commit, the
 * queue and the recovered edits together, and follows the queue as it changes (04 §8).
 *
 * Criterion 4, the half FE-008 had open: the service answers a commit with `unavailable`, which is
 * what a room does when PostgreSQL is unavailable (06 §8, failure modes; 04 §8 `retry`). The
 * connection stays online, the commit stays in the journal and is sent again under the same
 * identifier, and the save state reads `unsaved` until the commit is confirmed, then `saved`.
 */
import { MockService } from '@docedit/backend-mock';
import type { SyncChannel, SyncReject } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { type JournalPort, memoryJournal } from '../src/index.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, sleep, textOfNode, type, until } from './support.ts';

type Journal = JournalPort & { readonly size: number };

/** `until` for a condition that reads the journal, which answers with a promise. */
async function untilRead(done: () => Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1);
  }
}
type Answer = SyncReject | 'hold' | null;

/** Joins with a journal; `answer` decides each submit: a refusal, never answered, or the room. */
async function join(
  service: MockService,
  docId: string,
  journal: Journal,
  answer: (commit: { id: string; base: number }) => Answer,
) {
  const backend = service.backend({ sub: 'grace' }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const sent: string[] = [];
  const submit = channel.submit.bind(channel);
  (channel as { submit: SyncChannel['submit'] }).submit = async (commit) => {
    sent.push(commit.id);
    const a = answer(commit);
    if (a === 'hold') return new Promise(() => {});
    if (a) throw Object.assign(new Error(a.message), a);
    return submit(commit);
  };
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
    journal,
    retry: { minMs: 2, maxMs: 20 },
  });
  return { core, detach, sent };
}

describe('FE-008 criterion 2: the journal holds the in-flight commit, the queue and recovered edits', () => {
  it('holds all three at once, and follows the queue as it changes', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const journal = memoryJournal();
    let n = 0;
    // The first commit is refused for good; every later one is never answered.
    const g = await join(service, docId, journal, (c) =>
      n++ === 0
        ? { id: c.id, code: 'invalid_op', action: 'drop', head: c.base, message: 'refused' }
        : 'hold',
    );
    caret(g.core, IDS.intro, 0);
    type(g.core, 'refused ');
    await until(() => g.core.recovered.get().count === 1, 'the refused work is set aside');
    await untilRead(
      async () => ((await journal.readRecovered?.(docId)) ?? []).length === 1,
      'the recovered edit is in the journal',
    );

    type(g.core, 'flying ');
    await until(() => g.sent.length === 2, 'the second commit is sent');
    type(g.core, 'queued');
    await untilRead(
      async () => (await journal.read(docId)).queue.length > 0,
      'the queue is written',
    );

    const first = await journal.read(docId);
    // In flight: one commit, under the identifier that was sent and never answered.
    expect(first.commits.map((c) => c.id)).toEqual([g.sent[1]]);
    expect(JSON.stringify(first.commits)).toContain('flying');
    expect(JSON.stringify(first.queue)).toContain('queued');
    const recovered = (await journal.readRecovered?.(docId)) ?? [];
    expect(recovered.map((r) => r.text)).toEqual(['refused ']);
    // The refused work is in the recovered edits only: not in the commit, not in the queue.
    expect(JSON.stringify(first)).not.toContain('refused');

    // The queue changes: the journal's queue follows it, and the rest is untouched.
    type(g.core, ' more');
    await untilRead(
      async () => JSON.stringify((await journal.read(docId)).queue).includes('more'),
      'the longer queue is written',
    );
    const second = await journal.read(docId);
    expect(JSON.stringify(second.queue)).not.toBe(JSON.stringify(first.queue));
    expect(JSON.stringify(second.queue)).toContain('queued');
    expect(second.commits.map((c) => c.id)).toEqual([g.sent[1]]);
    expect(((await journal.readRecovered?.(docId)) ?? []).map((r) => r.text)).toEqual(['refused ']);
    g.detach();
    await service.dispose();
  });
});

describe('FE-008 criterion 4: unsaved while the service cannot acknowledge', () => {
  it('reads unsaved while commits are answered `unavailable`, and saved once one is confirmed', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const journal = memoryJournal();
    let outage = true;
    const g = await join(service, docId, journal, (c) =>
      outage
        ? {
            id: c.id,
            code: 'unavailable',
            action: 'retry',
            head: c.base,
            message: 'the database is unavailable',
            retryAfterMs: 2,
          }
        : null,
    );
    caret(g.core, IDS.intro, 'end');
    type(g.core, ' kept');
    await until(() => g.sent.length >= 3, 'the commit is sent again and again');
    // The connection is up; the service cannot store the commit: unsaved, and still journalled.
    expect(g.core.connection.get()).toBe('online');
    expect(g.core.saveState.get()).toBe('unsaved');
    expect(g.core.status.get()).toEqual({ connection: 'online', sync: 'unsaved' });
    const held = await journal.read(docId);
    expect(held.commits).toHaveLength(1);
    expect(JSON.stringify(held.commits)).toContain('kept');
    // The same commit, under the same identifier, each time (04 §8).
    expect(new Set(g.sent).size).toBe(1);
    // The editor keeps working locally meanwhile.
    type(g.core, ' and more');
    await sleep(10);
    expect(g.core.saveState.get()).toBe('unsaved');
    expect(textOfNode(internals(g.core).state.doc, IDS.intro)).toContain('kept and more');

    outage = false;
    await until(() => g.core.saveState.get() === 'saved', 'saved once the service confirms');
    expect(g.core.status.get()).toEqual({ connection: 'online', sync: 'saved' });
    expect(journal.size).toBe(0);
    expect((await journal.read(docId)).queue).toEqual([]);
    g.detach();
    await service.dispose();
  });

  it('a refusal that is not `unavailable` does not read unsaved', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const journal = memoryJournal();
    let busy = 3;
    const states: string[] = [];
    const g = await join(service, docId, journal, (c) =>
      busy-- > 0
        ? {
            id: c.id,
            code: 'busy',
            action: 'retry',
            head: c.base,
            message: 'busy',
            retryAfterMs: 2,
          }
        : null,
    );
    g.core.saveState.subscribe(() => states.push(g.core.saveState.get()));
    caret(g.core, IDS.intro, 'end');
    type(g.core, ' busy');
    await until(() => g.core.saveState.get() === 'saved', 'saved after the retries');
    expect(g.sent.length).toBeGreaterThanOrEqual(4);
    expect(states).not.toContain('unsaved');
    g.detach();
    await service.dispose();
  });
});
