/**
 * FE-009 with decision 47 of `docs/owner-decisions-2026-11-15.md`: unsent work of an earlier visit
 * is sent again only for the same signed-in user, and otherwise discarded after a warning. The sync
 * session writes the user with each commit and queue; `discardForeignWork` removes what another
 * user left; the core's `noticeForeignWork` raises the warning, which names nothing.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { DocumentCore, discardForeignWork } from '../src/headless.ts';
import { memoryJournal } from '../src/index.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, type, until } from './support.ts';

/** A visit by `sub` whose commits never get an answer, so that they stay in the journal. */
async function visitHolding(sub: string, journal: ReturnType<typeof memoryJournal>) {
  const service = new MockService({ presence: false });
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  const backend = service.backend({ sub }, { [docId]: 'editor' });
  await backend.connect();
  const content = await backend.sync.loadContent(docId);
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  (channel as { submit: unknown }).submit = () => new Promise(() => {});
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation: content.incarnation,
    sync: backend.sync,
    batchMs: 0,
    journal,
    user: sub,
  });
  return { core, docId, detach };
}

describe('the journal says whose work it holds (decision 47)', () => {
  it('writes the signed-in user with the commit and with the queue', async () => {
    const journal = memoryJournal();
    const v = await visitHolding('grace', journal);
    caret(v.core, IDS.intro, 'end');
    type(v.core, ' first');
    await until(() => journal.size === 1, 'the commit in the journal');
    caret(v.core, IDS.intro, 'end');
    type(v.core, ' second');
    await until(() => true, 'a turn');
    const held = await journal.read(v.docId);
    expect(held.commits.map((c) => c.user)).toEqual(['grace']);
    if (held.queue.length > 0) expect(held.queueAt?.user).toBe('grace');
    v.detach();
  });

  it('keeps the work for the same user and discards it for another', async () => {
    const journal = memoryJournal();
    const v = await visitHolding('grace', journal);
    caret(v.core, IDS.intro, 'end');
    type(v.core, ' unsent');
    await until(() => journal.size === 1, 'the commit in the journal');
    v.detach();

    expect(await discardForeignWork(journal, v.docId, 'grace')).toEqual({
      commits: 0,
      queue: false,
    });
    expect(journal.size).toBe(1);

    const gone = await discardForeignWork(journal, v.docId, 'ada');
    expect(gone.commits).toBe(1);
    expect(journal.size).toBe(0);
    expect((await journal.read(v.docId)).queue).toEqual([]);
  });

  it('discards the queue of another user, and keeps work written before the rule', async () => {
    const journal = memoryJournal();
    const step = { stepType: 'replace', from: 1, to: 1 } as never;
    await journal.setQueue('doc-a', [step], { seq: 3, incarnation: 'inc', user: 'grace' });
    await journal.setQueue('doc-b', [step], { seq: 3, incarnation: 'inc' });
    await journal.put({ docId: 'doc-b', id: 'c1', base: 3, steps: [step] });
    expect(await discardForeignWork(journal, 'doc-a', 'ada')).toEqual({ commits: 0, queue: true });
    expect((await journal.read('doc-a')).queue).toEqual([]);
    // No user written: nothing says whose it is, so it is kept for anyone.
    expect(await discardForeignWork(journal, 'doc-b', 'ada')).toEqual({ commits: 0, queue: false });
    expect(journal.size).toBe(1);
  });

  it('warns without naming anything', async () => {
    const journal = memoryJournal();
    const v = await visitHolding('ada', journal);
    expect(v.core.refusal.get()).toBeNull();
    v.core.noticeForeignWork();
    expect(v.core.refusal.get()).toMatchObject({ n: 1, reason: 'other-user', scopes: [] });
    v.detach();
  });
});
