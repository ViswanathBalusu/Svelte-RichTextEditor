/**
 * FE-012 criterion 4 (lane w1): `flush` called while the channel is reconnecting resolves only after
 * the commits are acknowledged, not when the channel is open again. The first channel never answers
 * the commit; the reopening and the second channel's answer are each held by the test, so the two
 * moments can be told apart. The service is the mock backend, in Node.js.
 */
import { MockService } from '@docedit/backend-mock';
import type { SyncPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { memoryJournal } from '../src/index.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, sleep, type } from './support.ts';

function gate(): { readonly wait: Promise<void>; open(): void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function until(what: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('the awaited state was not reached');
    await sleep(5);
  }
}

describe('FE-012: flush during a reconnection waits for the acknowledgement', () => {
  it('stays pending when the channel reopens and resolves once the commit is confirmed', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), {
      grants: [LEGAL_GRANT_FOR_TESTS],
    });
    const journal = memoryJournal();
    const backend = service.backend({ sub: 'eddie' }, { [docId]: 'editor' });
    await backend.connect();
    const content = await backend.sync.loadContent(docId);
    const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });

    const reopen = gate();
    const answer = gate();
    let reopened = 0;
    const realOpen = backend.sync.open.bind(backend.sync);
    const sync: SyncPort = Object.create(backend.sync) as SyncPort;
    (sync as { open: SyncPort['open'] }).open = async (id, opts) => {
      await reopen.wait;
      const next = await realOpen(id, opts);
      const submit = next.submit.bind(next);
      (next as { submit: unknown }).submit = async (commit: Parameters<typeof submit>[0]) => {
        await answer.wait;
        return submit(commit);
      };
      reopened++;
      return next;
    };

    const first = await backend.sync.open(docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    // The first channel never answers, as for a commit lost with the connection.
    (first as { submit: unknown }).submit = () => new Promise(() => {});
    const detach = core.attach(first, {
      seq: content.seq,
      incarnation: content.incarnation,
      sync,
      batchMs: 0,
      journal,
    });
    caret(core, IDS.intro, 'end');
    type(core, ' kept across the reconnection');
    await sleep(10);
    expect((await journal.read(docId)).commits.length).toBe(1);

    core.reconnect();
    expect(core.connection.get()).toBe('reconnecting');
    let resolved = false;
    const flushed = core.flush({ timeoutMs: 5000 }).then(() => {
      resolved = true;
    });

    // Still reconnecting: nothing is confirmed.
    await sleep(20);
    expect(resolved).toBe(false);

    // The channel is open again, but the commit is not answered yet.
    reopen.open();
    await until(() => reopened === 1 && core.connection.get() === 'online');
    await sleep(20);
    expect(resolved).toBe(false);
    expect((await journal.read(docId)).commits.length).toBe(1);

    // The acknowledgement arrives: now, and only now, the promise resolves.
    answer.open();
    await flushed;
    expect(resolved).toBe(true);
    await core.flushJournal();
    expect((await journal.read(docId)).commits.length).toBe(0);
    const server = await backend.sync.loadContent(docId);
    expect(JSON.stringify(server)).toContain('kept across the reconnection');
    expect(server.seq).toBe(content.seq + 1);

    detach();
    await service.dispose();
  });
});
