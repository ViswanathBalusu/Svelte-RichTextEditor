/**
 * FE-141 criterion 4 (lane w1, 2026-11-26): work the journal kept under one view token (ADR 0019;
 * D28: the reader's visibility class) is not applied under another. On the next visit it goes to
 * recovered edits (FE-010), and nothing is sent. Under the same view token it is sent again, as
 * FE-009 has it. A journal written before the token was kept puts the work back as before.
 *
 * `visit` is the one of fe-009-resubmit.test.ts with a `view` option: the token of the visit's
 * `ch.opened`, handed to `attach`. The server is backend-mock's real Room; the journal is in memory
 * and outlives the visits. A visit ends with `kill`: nothing more is written, as when a tab closes.
 */
import { MockService } from '@docedit/backend-mock';
import type { Content } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore, readRestorePlan, restoreBase } from '../src/headless.ts';
import { type JournalPort, memoryJournal } from '../src/index.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, textOfNode, type, until } from './support.ts';

type Journal = JournalPort & { readonly size: number };

async function visit(
  service: MockService,
  docId: string,
  journal: Journal,
  opts: { view?: string; hold?: boolean } = {},
) {
  const backend = service.backend({ sub: 'grace' }, { [docId]: 'editor' });
  await backend.connect();
  const plan = await readRestorePlan(journal, docId);
  const base = plan ? restoreBase(plan) : null;
  let content: Content | null = null;
  let incarnation = '';
  let inflight: string | undefined;
  if (plan && base) {
    try {
      const pinned = await backend.sync.loadContent(docId, base.seq);
      if (pinned.seq === base.seq) {
        content = pinned;
        incarnation = base.incarnation ?? pinned.incarnation;
        if (plan.entry) inflight = plan.entry.id;
      }
    } catch {
      content = null;
    }
  }
  content ??= await backend.sync.loadContent(docId);
  if (incarnation === '') incarnation = content.incarnation;
  const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation, ...(inflight ? { inflight } : {}) },
  });
  const sent: string[] = [];
  const submit = channel.submit.bind(channel);
  (channel as { submit: typeof channel.submit }).submit = (commit) => {
    sent.push(commit.id);
    return opts.hold ? new Promise(() => {}) : submit(commit);
  };
  const kill = core.attach(channel, {
    seq: content.seq,
    incarnation,
    ...(opts.view === undefined ? {} : { view: opts.view }),
    sync: backend.sync,
    batchMs: 0,
    journal,
    retry: { minMs: 2, maxMs: 20 },
    ...(plan ? { restore: plan } : {}),
  });
  return { core, sent, kill };
}

function newDoc() {
  const service = new MockService({ presence: false });
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  return { service, docId };
}

const bodyText = (core: DocumentCore): string => textOfNode(internals(core).state.doc, IDS.intro);

/** A first visit under `view` that types and is killed before the answer. Returns the commit's id. */
async function unconfirmed(service: MockService, docId: string, journal: Journal, view?: string) {
  const first = await visit(service, docId, journal, {
    hold: true,
    ...(view === undefined ? {} : { view }),
  });
  caret(first.core, IDS.intro, 0);
  type(first.core, 'Projected ');
  await until(() => first.sent.length === 1, 'the commit is sent');
  await first.core.flushJournal();
  first.kill();
  return first.sent[0]!;
}

describe('FE-141 criterion 4: journalled work under another view token goes to recovered edits', () => {
  it('writes the view token with the commit', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const id = await unconfirmed(service, docId, journal, 'view-A');
    const held = await journal.read(docId);
    expect(held.commits.map((c) => [c.id, c.view])).toEqual([[id, 'view-A']]);
    await service.dispose();
  });

  it('sets the work aside under a different view token, sends nothing, and keeps it recoverable', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    await unconfirmed(service, docId, journal, 'view-A');
    const second = await visit(service, docId, journal, { view: 'view-B' });
    await until(() => second.core.recovered.get().count === 1, 'the work is set aside');
    expect(second.core.recovered.get().items.map((i) => i.text)).toEqual(['Projected ']);
    expect(bodyText(second.core)).not.toContain('Projected ');
    expect(second.sent).toEqual([]);
    second.kill();
    await service.dispose();
  });

  it('sets it aside when the later visit has no view token at all', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    await unconfirmed(service, docId, journal, 'view-A');
    const second = await visit(service, docId, journal);
    await until(() => second.core.recovered.get().count === 1, 'the work is set aside');
    expect(second.sent).toEqual([]);
    second.kill();
    await service.dispose();
  });

  it('sends it again under the same view token, as FE-009 has it', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const id = await unconfirmed(service, docId, journal, 'view-A');
    const second = await visit(service, docId, journal, { view: 'view-A' });
    expect(bodyText(second.core)).toContain('Projected ');
    await until(() => second.core.saveState.get() === 'saved', 'saved after the resubmission');
    expect(second.sent).toEqual([id]);
    expect(second.core.recovered.get().count).toBe(0);
    second.kill();
    await service.dispose();
  });

  it('puts back work written before the token was kept', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const id = await unconfirmed(service, docId, journal);
    // A commit written by a client that did not know the field has no `view` at all.
    const held = await journal.read(docId);
    for (const entry of held.commits) {
      const { view: _view, ...old } = entry;
      await journal.put(old);
    }
    const second = await visit(service, docId, journal, { view: 'view-B' });
    await until(() => second.core.saveState.get() === 'saved', 'saved after the resubmission');
    expect(second.sent).toEqual([id]);
    second.kill();
    await service.dispose();
  });
});
