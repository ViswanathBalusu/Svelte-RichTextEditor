/**
 * FRW-076 criterion 5 (reworded by decision 186 of the owner, 2026-11-15): a value a participant
 * typed into a field and closed the tab on before it was acknowledged is resubmitted once when the
 * participant returns, and is not offered as a recovered edit.
 *
 * The visit is what the element's session does (see fe-009-resubmit.test.ts): read the journal,
 * load the content pinned at the commit's base, open the channel naming the commit as in flight and
 * hand the plan to `attach`. The service is backend-mock's real room with the authority's fill rules;
 * the participant may only fill the tenant's fields. Node.js.
 */
import { MockService } from '@docedit/backend-mock';
import type { Content, SyncChannel } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore, readRestorePlan, restoreBase } from '../src/headless.ts';
import { memoryJournal } from '../src/index.ts';
import { FIELD_IDS, fieldsDocument } from './frw-fields-fixture.ts';
import { microtask, until } from './support.ts';

async function visit(
  service: MockService,
  docId: string,
  journal: ReturnType<typeof memoryJournal>,
  opts: { hold?: boolean } = {},
) {
  const backend = service.backend(
    { sub: 'tessa', fill: { roles: ['role_tenant'] } },
    { [docId]: 'filler' },
  );
  await backend.connect();
  const plan = await readRestorePlan(journal, docId);
  const base = plan ? restoreBase(plan) : null;
  let content: Content | null = null;
  let incarnation = '';
  let inflight: string | undefined;
  if (plan && base) {
    const pinned = await backend.sync.loadContent(docId, base.seq);
    if (pinned.seq === base.seq) {
      content = pinned;
      incarnation = base.incarnation ?? pinned.incarnation;
      if (plan.entry) inflight = plan.entry.id;
    }
  }
  content ??= await backend.sync.loadContent(docId);
  if (incarnation === '') incarnation = content.incarnation;
  const core = new DocumentCore({ doc: content, mode: 'fill', schedule: microtask });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation, ...(inflight ? { inflight } : {}) },
  });
  const sent: string[] = [];
  const submit = channel.submit.bind(channel);
  (channel as { submit: SyncChannel['submit'] }).submit = (commit) => {
    sent.push(commit.id);
    // The first visit never gets an answer: the tab is closed before the server's acknowledgement.
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
  await until(() => core.permissions.get() !== null, 'the access arrives');
  return { core, detach, backend, sent, resume: { inflight } };
}

const count = (text: string, token: string): number => text.split(token).length - 1;

describe('FRW-076 criterion 5: a value typed and not acknowledged comes back once', () => {
  it('is resubmitted when the participant returns, once, and is not a recovered edit', async () => {
    const service = new MockService({ presence: false });
    const docId = service.createDocument(fieldsDocument());
    const journal = memoryJournal();
    const first = await visit(service, docId, journal, { hold: true });
    first.core.enterFieldValue(FIELD_IDS.name, 'Ada');
    await until(() => first.sent.length === 1, 'the entry is sent');
    const id = first.sent[0]!;
    await first.core.flushJournal();
    first.detach(); // the tab is closed; the commit was never answered
    expect((await journal.read(docId)).commits.map((c) => c.id)).toEqual([id]);
    // Nothing is stored yet.
    expect(JSON.stringify((await first.backend.sync.loadContent(docId)).doc)).not.toContain(
      '"Ada"',
    );

    const second = await visit(service, docId, journal);
    try {
      // The channel is opened naming the commit, and the value is back in the field at once.
      expect(second.resume.inflight).toBe(id);
      expect(second.core.fieldValues()['tenant.name']).toBe('Ada');
      await until(() => second.core.saveState.get() === 'saved', 'saved after the resubmission');
      // One resubmission, under the same identifier, stored once.
      expect(second.sent).toEqual([id]);
      expect(
        count(JSON.stringify((await second.backend.sync.loadContent(docId)).doc), '"Ada"'),
      ).toBe(1);
      // No recovered edit is offered, in the core or in the journal.
      expect(second.core.recovered.get().count).toBe(0);
      expect(second.core.recovered.get().items).toEqual([]);
      expect((await journal.readRecovered?.(docId)) ?? []).toEqual([]);
      await until(() => journal.size === 0, 'the journal empties');
      expect((await journal.read(docId)).commits).toEqual([]);
    } finally {
      second.detach();
      await service.dispose();
    }
  });
});
