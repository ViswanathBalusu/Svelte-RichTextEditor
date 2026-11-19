/**
 * FE-012 criterion 5 (lane w1, 2026-11-18): a host navigates away after a rejected `flush`, and the
 * next visit sends the unconfirmed work again (FE-009). The first visit's server never answers the
 * commit, so `flush({ timeoutMs })` rejects with the count; the visit ends as a closed tab does
 * (the core is detached, nothing more is written); the second visit reads the journal, loads the
 * content at the commit's base, opens the channel with a resume that names the commit as in flight,
 * and the same commit, under its own identifier, reaches the real Room of backend-mock. Node.js.
 */
import { MockService } from '@docedit/backend-mock';
import type { SyncChannel } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore, readRestorePlan, restoreBase } from '../src/headless.ts';
import { type JournalPort, memoryJournal } from '../src/index.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, textOfNode, type, until } from './support.ts';

/** One visit, as the element's session makes it (session.ts), with a channel the test can hold. */
async function visit(
  service: MockService,
  docId: string,
  journal: JournalPort,
  opts: { hold: boolean },
) {
  const backend = service.backend({ sub: 'frances' }, { [docId]: 'editor' });
  await backend.connect();
  const plan = await readRestorePlan(journal, docId);
  const base = plan ? restoreBase(plan) : null;
  let content = await backend.sync.loadContent(docId);
  let incarnation = content.incarnation;
  let inflight: string | undefined;
  if (plan && base) {
    const pinned = await backend.sync.loadContent(docId, base.seq);
    if (pinned.seq === base.seq) {
      content = pinned;
      incarnation = base.incarnation ?? pinned.incarnation;
      if (plan.entry) inflight = plan.entry.id;
    }
  }
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation, ...(inflight ? { inflight } : {}) },
  });
  const sent: string[] = [];
  const submit = channel.submit.bind(channel);
  (channel as { submit: SyncChannel['submit'] }).submit = (commit) => {
    sent.push(commit.id);
    return opts.hold ? new Promise(() => {}) : submit(commit);
  };
  const detach = core.attach(channel, {
    seq: content.seq,
    incarnation,
    sync: backend.sync,
    batchMs: 0,
    journal,
    retry: { minMs: 2, maxMs: 20 },
    ...(plan ? { restore: plan } : {}),
  });
  return { core, sent, detach, backend };
}

describe('FE-012 criterion 5: work left by a rejected flush is sent again on the next visit', () => {
  it('rejects at the timeout, and the next visit resubmits the same commit once', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const journal = memoryJournal();

    // First visit: the commit is sent and never answered; flush gives up with the count.
    const first = await visit(service, docId, journal, { hold: true });
    caret(first.core, IDS.intro, 'end');
    type(first.core, ' Navigated');
    await until(() => first.sent.length === 1, 'the commit is sent');
    const error = await first.core.flush({ timeoutMs: 50 }).then(
      () => null,
      (e: unknown) => e as { count?: number },
    );
    expect(error).toMatchObject({ count: 1 });
    // The host navigates away: the core is detached and nothing more is written.
    first.detach();
    expect((await journal.read(docId)).commits).toHaveLength(1);

    // Second visit: the document is opened again and the work is sent again, under the same id.
    const second = await visit(service, docId, journal, { hold: false });
    await until(
      () => textOfNode(internals(second.core).state.doc, IDS.intro).includes('Navigated'),
      'the work is back in the document',
    );
    await second.core.flush({ timeoutMs: 5000 });
    // The commit that went out again is the one the first visit sent, under its own identifier.
    expect(second.sent).toEqual(first.sent);
    // It is on the server exactly once, and the journal is empty.
    const onServer = JSON.stringify((await second.backend.sync.loadContent(docId)).doc);
    expect(onServer.split('Navigated').length - 1).toBe(1);
    expect((await journal.read(docId)).commits).toHaveLength(0);
    second.detach();
    await service.dispose();
  });
});
