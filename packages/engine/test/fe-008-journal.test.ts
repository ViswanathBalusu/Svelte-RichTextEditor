/**
 * FE-008: unconfirmed commits are written to the recovery journal before they are sent, the
 * acknowledged ones leave it, a failed write sends nothing and reads as unsaved, and a commit that
 * was never acknowledged is still in the journal after its tab has gone (backend-mock's real Room).
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { type JournalPort, memoryJournal } from '../src/index.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, posOf, sleep, textOfNode, type, until } from './support.ts';

function newService(): MockService {
  return new MockService({ presence: false });
}

/** Joins as an editor with a journal, and records what the journal and the channel do in order. */
async function joinWithJournal(
  service: MockService,
  docId: string,
  journal: JournalPort & { readonly size: number },
  log: string[],
  sentAt: { ids: string[]; journalSizes: number[] },
) {
  const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const submit = channel.submit.bind(channel);
  (channel as { submit: typeof channel.submit }).submit = (commit) => {
    log.push(`send ${commit.id}`);
    sentAt.ids.push(commit.id);
    sentAt.journalSizes.push(journal.size);
    return submit(commit);
  };
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
    journal,
    retry: { minMs: 5, maxMs: 20 },
  });
  return { core, backend, channel, detach };
}

const saved = (core: DocumentCore) => until(() => core.saveState.get() === 'saved', 'saved');

describe('FE-008: the journal is written before a commit is sent', () => {
  it('writes each commit before it is sent, and removes it once acknowledged', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const journal = memoryJournal();
    const log: string[] = [];
    const sentAt = { ids: [] as string[], journalSizes: [] as number[] };
    const { core, detach } = await joinWithJournal(service, docId, journal, log, sentAt);
    caret(core, IDS.intro, 'end');
    type(core, ' journalled');
    await saved(core);
    expect(sentAt.ids.length).toBeGreaterThan(0);
    // The commit was in the journal at the moment it was sent (criterion 1).
    expect(sentAt.journalSizes.every((n) => n >= 1)).toBe(true);
    // Acknowledged commits leave the journal (criterion 3).
    expect(journal.size).toBe(0);
    expect((await journal.read(docId)).commits).toEqual([]);
    expect(textOfNode(internals(core).state.doc, IDS.intro)).toContain('journalled');
    detach();
    await service.dispose();
  });

  it('a failed journal write sends nothing and reads as unsaved until the write succeeds', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const real = memoryJournal();
    let failing = true;
    const journal: JournalPort & { readonly size: number } = {
      get size() {
        return real.size;
      },
      put: async (e) => {
        if (failing) throw new Error('IndexedDB unavailable');
        return real.put(e);
      },
      remove: (d, id) => real.remove(d, id),
      setQueue: async (d, steps) => {
        if (failing) throw new Error('IndexedDB unavailable');
        return real.setQueue(d, steps);
      },
      read: (d) => real.read(d),
    };
    const log: string[] = [];
    const sentAt = { ids: [] as string[], journalSizes: [] as number[] };
    const { core, detach } = await joinWithJournal(service, docId, journal, log, sentAt);
    caret(core, IDS.intro, 'end');
    type(core, ' held');
    await sleep(60);
    expect(sentAt.ids).toEqual([]);
    expect(core.saveState.get()).toBe('unsaved');
    failing = false;
    await saved(core);
    expect(sentAt.ids.length).toBeGreaterThan(0);
    expect(real.size).toBe(0);
    detach();
    await service.dispose();
  });

  it('an unacknowledged commit stays in the journal after its tab is gone (criterion 6)', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const journal = memoryJournal();
    const log: string[] = [];
    const sentAt = { ids: [] as string[], journalSizes: [] as number[] };
    const { core, channel, detach } = await joinWithJournal(service, docId, journal, log, sentAt);
    // The server never answers: the tab is closed before the acknowledgement arrives.
    (channel as { submit: unknown }).submit = () => new Promise(() => {});
    caret(core, IDS.intro, 'end');
    type(core, ' lost?');
    await sleep(30);
    detach();
    await service.dispose();
    const { commits } = await journal.read(docId);
    expect(commits.length).toBeGreaterThan(0);
    const text = commits
      .flatMap((c) => c.steps)
      .map((s) => JSON.stringify(s))
      .join('');
    expect(text).toContain('lost?');
    expect(posOf(internals(core).state.doc, IDS.intro)).toBeGreaterThan(0);
  });

  it('holds the in-flight commit and the queue while a commit is unacknowledged', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const journal = memoryJournal();
    const log: string[] = [];
    const sentAt = { ids: [] as string[], journalSizes: [] as number[] };
    const { core, channel, detach } = await joinWithJournal(service, docId, journal, log, sentAt);
    (channel as { submit: unknown }).submit = () => new Promise(() => {});
    caret(core, IDS.intro, 'end');
    type(core, ' one');
    await sleep(20);
    type(core, ' two');
    await sleep(20);
    const { commits, queue } = await journal.read(docId);
    expect(commits.length).toBe(1);
    expect(queue.length).toBeGreaterThan(0);
    detach();
    await service.dispose();
  });

  it('journal entries carry commit members only, never a token (10 §3.1)', async () => {
    const service = newService();
    const docId = service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const journal = memoryJournal();
    const log: string[] = [];
    const sentAt = { ids: [] as string[], journalSizes: [] as number[] };
    const { core, channel, detach } = await joinWithJournal(service, docId, journal, log, sentAt);
    (channel as { submit: unknown }).submit = () => new Promise(() => {});
    caret(core, IDS.intro, 'end');
    type(core, ' shape');
    await sleep(20);
    const { commits } = await journal.read(docId);
    // `incarnation` is the log's identifier at `base` (FE-009), not a credential.
    // `view` (FE-141) names the visibility class the commit was made under (ADR 0019): the same
    // kind of identifier as `incarnation`, which the client echoes in its resume; not a credential.
    const allowed = new Set([
      'docId',
      'id',
      'base',
      'steps',
      'origin',
      'incarnation',
      'user',
      'view',
    ]);
    for (const c of commits) for (const k of Object.keys(c)) expect(allowed.has(k)).toBe(true);
    expect(JSON.stringify(commits)).not.toMatch(/token|bearer|authorization/i);
    detach();
    await service.dispose();
  });
});
