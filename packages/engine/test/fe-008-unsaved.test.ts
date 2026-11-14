/**
 * FE-008 criterion 4 (lane V-FE-001-016): a commit in the journal and unconfirmed while the
 * connection is down reads `unsaved`; when the connection is back and the commit is confirmed it
 * reads `saved`. The channel is backend-mock's real Room channel. The test holds the first commit
 * (it does not reach the service), then makes the channel report `resuming` through the channel's
 * own delivery, which is what a dropped socket produces, and releases the commit when the channel
 * is `live` again.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { memoryJournal } from '../src/index.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, sleep, type, until } from './support.ts';

/** The mock channel's own delivery queue: it carries the channel state the session listens to. */
interface Delivery {
  push(kind: 'state', value: unknown): void;
}

describe('FE-008 criterion 4: the save state reads unsaved while the connection is down', () => {
  it('is unsaved with a journalled commit unconfirmed and the channel down, and saved once confirmed', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const journal = memoryJournal();
    const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
    await backend.connect();
    const content = await backend.sync.loadContent(docId);
    const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
    const channel = await backend.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });

    // Hold every commit until the test releases it: the service has not confirmed it yet.
    const submit = channel.submit.bind(channel);
    const held: Array<() => void> = [];
    (channel as { submit: typeof channel.submit }).submit = (commit) =>
      new Promise((resolve, reject) => {
        held.push(() => {
          submit(commit).then(resolve, reject);
        });
      });

    const detach = core.attach(channel, {
      seq: content.seq,
      incarnation: content.incarnation,
      sync: backend.sync,
      batchMs: 0,
      journal,
      retry: { minMs: 5, maxMs: 20 },
    });

    caret(core, IDS.intro, 'end');
    type(core, ' offline');
    await until(() => held.length > 0, 'the commit is sent to the channel');
    expect(journal.size).toBeGreaterThan(0);
    // Online and unconfirmed: the work is still being saved.
    expect(core.saveState.get()).toBe('saving');

    // The connection drops: the channel reports `resuming` (what a lost socket produces).
    const delivery = (channel as unknown as { delivery: Delivery }).delivery;
    delivery.push('state', { status: 'resuming', reason: 'the socket dropped' });
    await until(() => core.connection.get() === 'reconnecting', 'connection reconnecting');
    await until(() => core.saveState.get() === 'unsaved', 'save state unsaved');
    expect(core.status.get()).toEqual({ connection: 'reconnecting', sync: 'unsaved' });
    // The commit is still journalled: nothing was dropped.
    expect(journal.size).toBeGreaterThan(0);

    // The connection returns, but the commit is not yet confirmed: saving again.
    delivery.push('state', { status: 'live', seq: content.seq });
    await until(() => core.connection.get() === 'online', 'connection online');
    await until(() => core.saveState.get() === 'saving', 'save state saving');

    // The service confirms the commit: saved, and the journal entry leaves.
    for (const release of held.splice(0)) release();
    await until(() => core.saveState.get() === 'saved', 'save state saved');
    await until(() => journal.size === 0, 'the journal empties');
    expect(core.status.get()).toEqual({ connection: 'online', sync: 'saved' });
    await sleep(0);
    detach();
    await service.dispose();
  });
});
