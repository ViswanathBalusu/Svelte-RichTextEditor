/**
 * FE-011: when the page is hidden, every pending journal write is started and the journal holds all
 * unconfirmed work. The core's `flushJournal()` is what the element calls on `visibilitychange`.
 * Writes are held by a gate so that the test can see the flush wait for them.
 */
import { MockService } from '@docedit/backend-mock';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { type JournalPort, memoryJournal } from '../src/index.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, sleep, type } from './support.ts';

/** A journal whose writes wait until `open()`: their completion is in the test's hands. */
function gatedJournal() {
  const real = memoryJournal();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const journal: JournalPort & { readonly size: number } = {
    get size() {
      return real.size;
    },
    async put(e) {
      await gate;
      return real.put(e);
    },
    remove: (d, id) => real.remove(d, id),
    async setQueue(d, steps) {
      await gate;
      return real.setQueue(d, steps);
    },
    read: (d) => real.read(d),
  };
  return { journal, real, open };
}

describe('FE-011: the journal is complete when the page is hidden', () => {
  it('flushJournal waits for the pending write, and the keystroke before it is journalled', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const gate = gatedJournal();
    const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
    await backend.connect();
    const content = await backend.sync.loadContent(docId);
    const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
    const channel = await backend.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    let sent = 0;
    const submit = channel.submit.bind(channel);
    (channel as { submit: typeof channel.submit }).submit = (c) => {
      sent++;
      return submit(c);
    };
    const detach = core.attach(channel, {
      seq: content.seq,
      incarnation: content.incarnation,
      sync: backend.sync,
      batchMs: 0,
      journal: gate.journal,
    });
    caret(core, IDS.intro, 'end');
    type(core, ' hidden');
    // The page is hidden at once, straight after the keystroke: the flush must wait.
    let flushed = false;
    const flush = core.flushJournal().then(() => {
      flushed = true;
    });
    await sleep(20);
    expect(flushed).toBe(false);
    // Nothing is sent before its write is durable (criterion 4: not the only copy).
    expect(sent).toBe(0);
    gate.open();
    await flush;
    expect(flushed).toBe(true);
    // The keystroke is in the journal: as the in-flight commit or the queue, not lost.
    const { commits, queue } = await gate.real.read(docId);
    expect(commits.length + queue.length).toBeGreaterThan(0);
    detach();
    await service.dispose();
  });
});
