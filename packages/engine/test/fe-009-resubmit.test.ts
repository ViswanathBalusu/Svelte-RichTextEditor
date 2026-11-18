/**
 * FE-009 (lane w1, 2026-11-17): work that was not confirmed before the tab closed is sent again on
 * the next visit, on backend-mock's real Room with an in-memory journal that outlives the visits.
 *
 * `visit` does what the element's session does (packages/element/src/session.ts): read the journal,
 * load the content pinned at the commit's `base`, open the channel with a resume that names the
 * commit as in flight, and hand the plan to `attach`. A visit ends with `kill`: the core is detached
 * and nothing more is written, as when a tab is closed; the journal keeps what it had.
 */
import { MockService } from '@docedit/backend-mock';
import type { Content, SyncChannel, SyncReject } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { DocumentCore, readRestorePlan, restoreBase } from '../src/headless.ts';
import { type JournalPort, memoryJournal } from '../src/index.ts';
import { internals } from '../src/testing.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, sleep, textOfNode, type, until } from './support.ts';

type Journal = JournalPort & { readonly size: number };

/** What the channel does with a commit: the room, never an answer, an answer lost, or a refusal. */
type Answer = 'pass' | 'hold' | 'lose-ack' | SyncReject;

interface Visit {
  readonly core: DocumentCore;
  readonly sent: string[];
  readonly resume: { seq: number; incarnation: string; inflight?: string };
  readonly kill: () => void;
  readonly backend: ReturnType<MockService['backend']>;
}

async function visit(
  service: MockService,
  docId: string,
  journal: Journal,
  opts: {
    sub?: string;
    answer?: (commit: { id: string; base: number }) => Answer;
    restoreFrom?: Journal | null;
    pinned?: boolean;
  } = {},
): Promise<Visit> {
  const backend = service.backend({ sub: opts.sub ?? 'grace' }, { [docId]: 'editor' });
  await backend.connect();
  const plan = await readRestorePlan(journal, docId);
  const base = plan ? restoreBase(plan) : null;
  let content: Content | null = null;
  let incarnation = '';
  let inflight: string | undefined;
  if (plan && base && opts.pinned !== false) {
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
  const resume = {
    seq: content.seq,
    incarnation,
    ...(inflight ? { inflight } : {}),
  };
  const channel = await backend.sync.open(docId, { resume });
  const sent: string[] = [];
  const submit = channel.submit.bind(channel);
  (channel as { submit: SyncChannel['submit'] }).submit = (commit) => {
    sent.push(commit.id);
    const answer = opts.answer?.(commit) ?? 'pass';
    if (answer === 'hold') return new Promise(() => {});
    if (answer === 'lose-ack') {
      void submit(commit).catch(() => {});
      return new Promise(() => {});
    }
    if (answer !== 'pass') return Promise.reject(Object.assign(new Error(answer.message), answer));
    return submit(commit);
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
  return { core, sent, resume, backend, kill: detach };
}

const bodyText = (v: Visit): string => textOfNode(internals(v.core).state.doc, IDS.intro);

/** The text of the document on the server. */
async function serverText(visitor: Visit, docId: string): Promise<string> {
  const content = await visitor.backend.sync.loadContent(docId);
  return JSON.stringify(content.doc);
}

const count = (text: string, token: string): number => text.split(token).length - 1;

function newDoc() {
  const service = new MockService({ presence: false });
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  return { service, docId };
}

describe('FE-009 criterion 1: the journal holds a commit, and the next visit sends it again', () => {
  it('sends it after the channel is live, under its own identifier, and the journal is empty after', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await visit(service, docId, journal, { answer: () => 'hold' });
    caret(first.core, IDS.intro, 0);
    type(first.core, 'OneTwo ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    const id = first.sent[0]!;
    first.kill(); // the tab is closed; the commit was never answered

    expect((await journal.read(docId)).commits.map((c) => c.id)).toEqual([id]);
    const second = await visit(service, docId, journal);
    // The channel was opened naming the commit, at the commit's base.
    expect(second.resume.inflight).toBe(id);
    // The work is back in the editor at once, before anything is confirmed.
    expect(bodyText(second)).toContain('OneTwo ');
    await until(() => second.core.saveState.get() === 'saved', 'saved after the resubmission');
    expect(second.sent).toEqual([id]);
    expect(count(await serverText(second, docId), 'OneTwo ')).toBe(1);
    await until(() => journal.size === 0, 'the journal empties');
    expect((await journal.read(docId)).queue).toEqual([]);
    second.kill();
    await service.dispose();
  });

  it('puts the queue back behind the commit and sends both in their original order', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await visit(service, docId, journal, { answer: () => 'hold' });
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Alpha ');
    await until(() => first.sent.length === 1, 'the first commit is sent');
    type(first.core, 'Beta ');
    // The journal writes the queue behind the commit's own write: let it finish.
    await first.core.flushJournal();
    first.kill();
    const held = await journal.read(docId);
    expect(held.commits).toHaveLength(1);
    expect(held.queue.length).toBeGreaterThan(0);
    expect(held.queueAt?.seq).toBe(held.commits[0]!.base);

    const second = await visit(service, docId, journal);
    expect(bodyText(second)).toContain('Alpha ');
    expect(bodyText(second)).toContain('Beta ');
    await until(() => second.core.saveState.get() === 'saved', 'saved');
    // The commit under its own identifier first, then the queue as a commit of its own.
    expect(second.sent[0]).toBe(first.sent[0]);
    expect(second.sent).toHaveLength(2);
    const text = await serverText(second, docId);
    expect(count(text, 'Alpha ')).toBe(1);
    expect(count(text, 'Beta ')).toBe(1);
    expect(text.indexOf('Alpha ')).toBeLessThan(text.indexOf('Beta '));
    second.kill();
    await service.dispose();
  });
});

describe('FE-009 criterion 2: a commit the server accepted whose acknowledgement was lost appears once', () => {
  it('finds the stored commit in the catch-up stream and does not send it again', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await visit(service, docId, journal, { answer: () => 'lose-ack' });
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Stored ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    await sleep(40); // the room stores the commit; its answer is lost on the way
    first.kill();
    // The room stored it, so it is in the server's document already.
    expect(count(await serverText(first, docId), 'Stored ')).toBe(1);
    expect(journal.size).toBe(1);

    const second = await visit(service, docId, journal);
    await until(() => second.core.saveState.get() === 'saved', 'saved');
    await until(() => journal.size === 0, 'the journal empties');
    expect(second.sent).toEqual([]); // acknowledged by the stream, never sent again
    expect(count(await serverText(second, docId), 'Stored ')).toBe(1);
    expect(count(bodyText(second), 'Stored ')).toBe(1);
    second.kill();
    await service.dispose();
  });

  it('applies the commit once when it was waiting to be stored and the client sends it again', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const hold = service.holdWrites(docId);
    const first = await visit(service, docId, journal);
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Waiting ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    first.kill();
    expect(journal.size).toBe(1);
    const second = await visit(service, docId, journal);
    await hold.release();
    await until(() => second.core.saveState.get() === 'saved', 'saved');
    await until(() => journal.size === 0, 'the journal empties');
    expect(count(await serverText(second, docId), 'Waiting ')).toBe(1);
    second.kill();
    await service.dispose();
  });

  it('rebases the work over what another person wrote between the visits', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await visit(service, docId, journal, { answer: () => 'hold' });
    caret(first.core, IDS.intro, 'end');
    type(first.core, ' Mine');
    await until(() => first.sent.length === 1, 'the commit is sent');
    first.kill();
    // Someone else writes at the start of the same paragraph.
    const other = await visit(service, docId, memoryJournal(), { sub: 'ada' });
    caret(other.core, IDS.intro, 0);
    type(other.core, 'Theirs ');
    await until(() => other.core.saveState.get() === 'saved', 'the other write is saved');
    other.kill();

    const second = await visit(service, docId, journal);
    await until(() => second.core.saveState.get() === 'saved', 'saved');
    const text = await serverText(second, docId);
    expect(count(text, 'Theirs ')).toBe(1);
    expect(count(text, ' Mine')).toBe(1);
    expect(bodyText(second)).toMatch(/^Theirs .* Mine$/);
    second.kill();
    await service.dispose();
  });
});

describe('FE-009 criterion 4: work that no longer applies is kept as recovered edits', () => {
  it('a log of another incarnation answers reload, and the work is set aside, not dropped', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await visit(service, docId, journal, { answer: () => 'hold' });
    caret(first.core, IDS.intro, 0);
    // Typed a few keystrokes at a time, as one step each: the set-aside text reads as typed.
    type(first.core, 'Old');
    type(first.core, ' log');
    type(first.core, ' ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    await first.core.flushJournal();
    first.kill();
    // The journal was written under another incarnation of the log.
    const [entry] = (await journal.read(docId)).commits;
    await journal.put({ ...entry!, incarnation: 'an-older-incarnation' });

    const second = await visit(service, docId, journal);
    await until(() => second.core.recovered.get().count === 1, 'the work is set aside');
    expect(second.core.recovered.get().items[0]?.text).toContain('Old log ');
    expect(bodyText(second)).not.toContain('Old log ');
    expect(count(await serverText(second, docId), 'Old log ')).toBe(0);
    await until(() => journal.size === 0, 'the commit leaves the journal');
    // It survives in the journal's recovered edits for the next visit.
    expect(((await journal.readRecovered?.(docId)) ?? []).map((r) => r.text)).toEqual(['Old log ']);
    second.kill();
    await service.dispose();
  });

  it('content that cannot be loaded at the commit base sets the work aside and loads the head', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await visit(service, docId, journal, { answer: () => 'hold' });
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Unplaceable ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    first.kill();
    // Someone else moves the document on, so the head is no longer the commit's base.
    const other = await visit(service, docId, memoryJournal(), { sub: 'ada' });
    caret(other.core, IDS.intro, 0);
    type(other.core, 'Elsewhere ');
    await until(() => other.core.saveState.get() === 'saved', 'the other write is saved');
    other.kill();
    const second = await visit(service, docId, journal, { pinned: false });
    await until(() => second.core.recovered.get().count === 1, 'the work is set aside');
    expect(second.core.recovered.get().items[0]?.text).toContain('Unplaceable ');
    expect(second.sent).toEqual([]);
    await until(() => journal.size === 0, 'the commit leaves the journal');
    expect((await journal.read(docId)).queue).toEqual([]);
    second.kill();
    await service.dispose();
  });

  it('a queue made after another commit moved the document goes to recovered edits, not to wrong positions', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await visit(service, docId, journal, { answer: () => 'hold' });
    caret(first.core, IDS.intro, 'end');
    type(first.core, ' Sent');
    await until(() => first.sent.length === 1, 'the commit is sent');
    // Another person's commit reaches the first visit, moving its confirmed document.
    const other = await visit(service, docId, memoryJournal(), { sub: 'ada' });
    caret(other.core, IDS.intro, 0);
    type(other.core, 'Front ');
    await until(() => other.core.saveState.get() === 'saved', 'the other write is saved');
    other.kill();
    await until(() => first.core.confirmedSeq.get() > first.resume.seq, 'the commit arrives');
    type(first.core, ' Queued');
    await first.core.flushJournal();
    first.kill();
    const held = await journal.read(docId);
    expect(held.queueAt?.seq).not.toBe(held.commits[0]!.base);

    const second = await visit(service, docId, journal);
    await until(() => second.core.saveState.get() === 'saved', 'saved');
    expect(second.core.recovered.get().items.map((r) => r.text)).toEqual([' Queued']);
    const text = await serverText(second, docId);
    expect(count(text, ' Sent')).toBe(1);
    expect(count(text, ' Queued')).toBe(0);
    second.kill();
    await service.dispose();
  });
});

describe('FE-009 criterion 5: a commit refused when it is sent again is handled as SYN-020 says', () => {
  const refuse =
    (code: SyncReject['code'], action: SyncReject['action']) =>
    (c: { id: string; base: number }): Answer => ({
      id: c.id,
      code,
      action,
      head: c.base,
      message: `${code} in a test`,
    });

  for (const [code, action] of [
    ['invalid_op', 'drop'],
    ['rebase_failed', 'drop'],
  ] as const) {
    it(`${code} keeps the content as recovered edits and leaves the journal`, async () => {
      const { service, docId } = newDoc();
      const journal = memoryJournal();
      const first = await visit(service, docId, journal, { answer: () => 'hold' });
      caret(first.core, IDS.intro, 0);
      type(first.core, `Refused-${code} `);
      await until(() => first.sent.length === 1, 'the commit is sent');
      first.kill();
      const second = await visit(service, docId, journal, { answer: refuse(code, action) });
      await until(() => second.core.recovered.get().count === 1, 'the refusal sets it aside');
      expect(second.core.recovered.get().items[0]).toMatchObject({
        reason: code,
        commit: first.sent[0],
      });
      expect(second.core.recovered.get().items[0]?.text).toContain(`Refused-${code} `);
      await until(() => journal.size === 0, 'the commit leaves the journal');
      expect(bodyText(second)).not.toContain('Refused');
      second.kill();
      await service.dispose();
    });
  }

  it('permission_denied from the real Room, after the grant was withdrawn between the visits', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const backendOf = (v: Visit) => v;
    const first = await (async () => {
      const backend = service.backend({ sub: 'grace', groups: ['legal'] }, { [docId]: 'editor' });
      await backend.connect();
      const content = await backend.sync.loadContent(docId);
      const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
      const channel = await backend.sync.open(docId, {
        resume: { seq: content.seq, incarnation: content.incarnation },
      });
      const sent: string[] = [];
      (channel as { submit: SyncChannel['submit'] }).submit = (c) => {
        sent.push(c.id);
        return new Promise(() => {});
      };
      const detach = core.attach(channel, {
        seq: content.seq,
        incarnation: content.incarnation,
        sync: backend.sync,
        batchMs: 0,
        journal,
      });
      return backendOf({ core, sent, backend, kill: detach, resume: { seq: 0, incarnation: '' } });
    })();
    caret(first.core, IDS.lockedPara, 0);
    type(first.core, 'clause ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    first.kill();
    service.setGrants(docId, []); // the region is no longer grace's

    // The second visit needs the group again, for the same user.
    const backend = service.backend({ sub: 'grace', groups: ['legal'] }, { [docId]: 'editor' });
    await backend.connect();
    const plan = (await readRestorePlan(journal, docId))!;
    const base = restoreBase(plan)!;
    const content = await backend.sync.loadContent(docId, base.seq);
    const core = new DocumentCore({ doc: content, schedule: (run) => queueMicrotask(run) });
    const channel = await backend.sync.open(docId, {
      resume: {
        seq: content.seq,
        incarnation: base.incarnation ?? content.incarnation,
        inflight: plan.entry!.id,
      },
    });
    const detach = core.attach(channel, {
      seq: content.seq,
      incarnation: base.incarnation ?? content.incarnation,
      sync: backend.sync,
      batchMs: 0,
      journal,
      restore: plan,
      retry: { minMs: 2, maxMs: 20 },
    });
    await until(
      () => core.recovered.get().items.some((r) => r.reason === 'permission_denied'),
      'the refusal',
    );
    expect(core.recovered.get().items[0]?.text).toContain('clause ');
    await until(() => journal.size === 0, 'the commit leaves the journal');
    detach();
    await service.dispose();
  });
});

describe('FE-009 criterion 6: an entry for another document is not sent to this one', () => {
  it('reads nothing for a document the journal has no entry for, and leaves the other entry alone', async () => {
    const { service, docId } = newDoc();
    const other = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
    const journal = memoryJournal();
    await journal.put({
      docId: other,
      id: '01900000-0000-7000-8000-000000000001',
      base: 0,
      steps: [],
    });
    expect(await readRestorePlan(journal, docId)).toBeNull();
    const here = await visit(service, docId, journal);
    expect(here.resume.inflight).toBeUndefined();
    caret(here.core, IDS.intro, 0);
    type(here.core, 'Mine ');
    await until(() => here.core.saveState.get() === 'saved', 'saved');
    expect(here.sent).not.toContain('01900000-0000-7000-8000-000000000001');
    // The entry of the other document is still there.
    expect((await journal.read(other)).commits).toHaveLength(1);
    here.kill();
    await service.dispose();
  });
});
