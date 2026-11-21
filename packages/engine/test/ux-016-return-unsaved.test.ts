/**
 * UX-016 criterion 5 at the core (lane w3, 2026-11-20): a visit ends while the save state reads
 * `unsaved`, and on the next visit the state reads `unsaved`, then `saving`, then `saved`. It never
 * reads `saved` before the service has the work.
 *
 * `open` does what the element's session does (packages/element/src/session.ts): it reads the
 * journal, loads the content pinned at the commit's `base`, creates the core, which is told that
 * the journal holds work (`CoreConfig.journalHoldsWork`), and opens the channel. `attach` is the
 * step that follows in the same task as the channel opened. Between the two the editor is on
 * screen with no channel, and the test reads what the indicator would show there.
 *
 * The server is backend-mock's real Room, and the journal is in memory and outlives the visits, as
 * IndexedDB does. A visit ends with `kill`: the core is detached and writes nothing more, as when a
 * tab is closed. The browser runs are packages/element/e2e/ux-016-return-unsaved.spec.ts.
 */
import { MockService } from '@docedit/backend-mock';
import type { Content, SyncChannel, SyncReject } from '@docedit/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DocumentCore, readRestorePlan, restoreBase } from '../src/headless.ts';
import { type JournalPort, memoryJournal } from '../src/index.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, sleep, type, until } from './support.ts';

type Journal = JournalPort & { readonly size: number };

/** What the channel does with a commit: the room, never an answer, or the answer `unavailable`. */
type Answer = 'pass' | 'hold' | 'unavailable';

interface Opened {
  readonly core: DocumentCore;
  /** Every value the status view took, from the core's first moment, as `connection/sync`. */
  readonly seen: string[];
  /** The identifiers of the commits handed to the channel. */
  readonly sent: string[];
  /** Whether the journal held unconfirmed work when the visit began. */
  readonly returning: boolean;
  readonly backend: ReturnType<MockService['backend']>;
  /** Hands the open channel to the core; the element does this in the task the channel opened in. */
  attach(): void;
  /** The connection drops: the channel reports `resuming`, as a lost socket does. */
  drop(): void;
  /** How the channel answers from now on. */
  answer(next: Answer): void;
  /** The tab is closed: nothing more is written. */
  kill(): void;
}

function unavailable(commit: { id: string; base: number }): SyncReject {
  return {
    id: commit.id,
    code: 'unavailable',
    action: 'retry',
    head: commit.base,
    message: 'the database is unavailable',
    retryAfterMs: 2,
  };
}

async function open(
  service: MockService,
  docId: string,
  journal: Journal,
  opts: { answer?: Answer; sub?: string } = {},
): Promise<Opened> {
  const backend = service.backend({ sub: opts.sub ?? 'grace' }, { [docId]: 'editor' });
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
  // The views notify at once, so that every value the status takes is recorded, not one a frame.
  const core = new DocumentCore({
    doc: content,
    schedule: (run) => run(),
    ...(plan ? { journalHoldsWork: true } : {}),
  });
  const show = (): string => `${core.status.get().connection}/${core.status.get().sync}`;
  const seen = [show()];
  core.status.subscribe(() => {
    if (seen.at(-1) !== show()) seen.push(show());
  });
  const channel = await backend.sync.open(docId, {
    resume: { seq: content.seq, incarnation, ...(inflight ? { inflight } : {}) },
  });
  let mode: Answer = opts.answer ?? 'pass';
  const sent: string[] = [];
  const submit = channel.submit.bind(channel);
  (channel as { submit: SyncChannel['submit'] }).submit = (commit) => {
    sent.push(commit.id);
    if (mode === 'hold') return new Promise(() => {});
    if (mode === 'unavailable') {
      const reject = unavailable(commit);
      return Promise.reject(Object.assign(new Error(reject.message), reject));
    }
    return submit(commit);
  };
  let detach: (() => void) | null = null;
  const at = content;
  return {
    core,
    seen,
    sent,
    returning: plan !== null,
    backend,
    attach() {
      detach = core.attach(channel, {
        seq: at.seq,
        incarnation,
        sync: backend.sync,
        batchMs: 0,
        journal,
        retry: { minMs: 2, maxMs: 20 },
        ...(plan ? { restore: plan } : {}),
      });
    },
    drop() {
      const delivery = (channel as unknown as { delivery: { push(k: 'state', v: unknown): void } })
        .delivery;
      delivery.push('state', { status: 'resuming', reason: 'the socket dropped' });
    },
    answer(next) {
      mode = next;
    },
    kill() {
      detach?.();
    },
  };
}

/** The save states of a recorded visit, in order and without repeats. */
function syncs(seen: readonly string[]): string[] {
  const out: string[] = [];
  for (const s of seen) {
    const sync = s.split('/')[1]!;
    if (out.at(-1) !== sync) out.push(sync);
  }
  return out;
}

async function serverText(v: Opened, docId: string): Promise<string> {
  return JSON.stringify((await v.backend.sync.loadContent(docId)).doc);
}

const count = (text: string, token: string): number => text.split(token).length - 1;

function newDoc() {
  const service = new MockService({ presence: false });
  const docId = service.createDocument(contractDocument(), { grants: [LEGAL_GRANT_FOR_TESTS] });
  return { service, docId };
}

/** Ends a visit as a hidden and then closed page does: the journal is flushed, then nothing more. */
async function close(v: Opened): Promise<void> {
  await v.core.flushJournal();
  v.kill();
}

describe('UX-016 criterion 5: the visit ended unsaved, and the author returns', () => {
  it('a commit that was never answered, with the connection down at the end', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await open(service, docId, journal, { answer: 'hold' });
    first.attach();
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Unsent ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    first.drop();
    await until(() => first.core.saveState.get() === 'unsaved', 'the first visit reads unsaved');
    expect(first.core.status.get()).toEqual({ connection: 'reconnecting', sync: 'unsaved' });
    await close(first);
    expect(count(await serverText(first, docId), 'Unsent ')).toBe(0);

    const second = await open(service, docId, journal);
    // The editor is on screen and the channel is not attached yet: the work is only in the journal.
    expect(second.returning).toBe(true);
    expect(second.core.saveState.get()).toBe('unsaved');
    expect(second.core.status.get()).toEqual({ connection: 'offline', sync: 'unsaved' });
    expect(second.seen).toEqual(['offline/unsaved']);
    second.attach();
    // Attached: the work is back in the core as its in-flight commit, and it is being saved.
    expect(second.core.status.get()).toEqual({ connection: 'online', sync: 'saving' });
    await until(() => second.core.saveState.get() === 'saved', 'saved after the resubmission');
    expect(second.seen).toEqual(['offline/unsaved', 'online/saving', 'online/saved']);
    // The same commit, under its own identifier, and the service has the text once.
    expect(second.sent).toEqual([first.sent[0]]);
    expect(count(await serverText(second, docId), 'Unsent ')).toBe(1);
    await until(() => journal.size === 0, 'the journal empties');
    second.kill();
    await service.dispose();
  });

  it('work typed while the connection was down, which was never sent at all', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await open(service, docId, journal);
    first.attach();
    first.drop();
    await until(() => first.core.connection.get() === 'reconnecting', 'the connection is down');
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Offline ');
    await until(() => first.core.saveState.get() === 'unsaved', 'the first visit reads unsaved');
    await close(first);
    // Nothing was handed to the channel: the work is the journal's queue only.
    expect(first.sent).toEqual([]);
    const held = await journal.read(docId);
    expect(held.commits).toEqual([]);
    expect(JSON.stringify(held.queue)).toContain('Offline ');

    const second = await open(service, docId, journal);
    expect(second.core.status.get()).toEqual({ connection: 'offline', sync: 'unsaved' });
    second.attach();
    await until(() => second.core.saveState.get() === 'saved', 'saved after the queue was sent');
    expect(second.seen).toEqual(['offline/unsaved', 'online/saving', 'online/saved']);
    expect(second.sent).toHaveLength(1);
    expect(count(await serverText(second, docId), 'Offline ')).toBe(1);
    expect((await journal.read(docId)).queue).toEqual([]);
    second.kill();
    await service.dispose();
  });

  it('a commit the service answered `unavailable`, with more typed behind it', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await open(service, docId, journal, { answer: 'unavailable' });
    first.attach();
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Outage ');
    await until(() => first.sent.length >= 2, 'the commit is sent again');
    expect(first.core.status.get()).toEqual({ connection: 'online', sync: 'unsaved' });
    type(first.core, 'More ');
    await close(first);

    const second = await open(service, docId, journal);
    expect(second.core.saveState.get()).toBe('unsaved');
    second.attach();
    await until(() => second.core.saveState.get() === 'saved', 'saved after the outage');
    // The commit and then the queue: `saving` holds from the first to the last acknowledgement.
    expect(second.seen).toEqual(['offline/unsaved', 'online/saving', 'online/saved']);
    expect(second.sent.length).toBe(2);
    const text = await serverText(second, docId);
    expect(count(text, 'Outage ')).toBe(1);
    expect(count(text, 'More ')).toBe(1);
    expect(text.indexOf('Outage ')).toBeLessThan(text.indexOf('More '));
    second.kill();
    await service.dispose();
  });

  it('stays unsaved while the returning visit is offline too, and saves on the visit after', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await open(service, docId, journal, { answer: 'hold' });
    first.attach();
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Twice ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    first.drop();
    await until(() => first.core.saveState.get() === 'unsaved', 'unsaved');
    await close(first);

    // The second visit never gets an answer either, and its connection drops.
    const second = await open(service, docId, journal, { answer: 'hold' });
    second.attach();
    await until(() => second.sent.length === 1, 'the commit is sent again');
    second.drop();
    await until(() => second.core.saveState.get() === 'unsaved', 'unsaved again');
    expect(syncs(second.seen)).toEqual(['unsaved', 'saving', 'unsaved']);
    expect(second.seen.some((s) => s.endsWith('/saved'))).toBe(false);
    await close(second);

    const third = await open(service, docId, journal);
    third.attach();
    await until(() => third.core.saveState.get() === 'saved', 'saved on the third visit');
    expect(third.seen).toEqual(['offline/unsaved', 'online/saving', 'online/saved']);
    expect(third.sent).toEqual([first.sent[0]]);
    expect(count(await serverText(third, docId), 'Twice ')).toBe(1);
    third.kill();
    await service.dispose();
  });

  it('a first visit, with nothing in the journal, starts saved', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await open(service, docId, journal);
    expect(first.returning).toBe(false);
    expect(first.core.status.get()).toEqual({ connection: 'offline', sync: 'saved' });
    first.attach();
    expect(first.seen).toEqual(['offline/saved', 'online/saved']);
    first.kill();
    await service.dispose();
  });

  it('work that cannot be sent again is set aside, and the state returns to saved', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await open(service, docId, journal, { answer: 'hold' });
    first.attach();
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Elsewhere ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    first.drop();
    await until(() => first.core.saveState.get() === 'unsaved', 'unsaved');
    await close(first);
    await service.dispose();

    // The same document identifier on a service whose log is another incarnation (04 §9).
    const other = new MockService({ presence: false });
    other.createDocument(contractDocument(), { id: docId, grants: [LEGAL_GRANT_FOR_TESTS] });
    const second = await open(other, docId, journal);
    expect(second.core.saveState.get()).toBe('unsaved');
    second.attach();
    await until(() => second.core.recovered.get().count === 1, 'the work is set aside');
    await until(() => second.core.saveState.get() === 'saved', 'saved, with nothing unconfirmed');
    expect(second.core.recovered.get().items.map((i) => i.text)).toEqual(['Elsewhere ']);
    // It was never `saved` while the work was only in the journal.
    expect(second.seen[0]).toBe('offline/unsaved');
    expect(second.seen.at(-1)).toBe('online/saved');
    expect(count(await serverText(second, docId), 'Elsewhere ')).toBe(0);
    second.kill();
    await other.dispose();
  });
});

describe('UX-016 criteria 5 and 6: flush() on the return waits for the journalled work', () => {
  it('does not resolve before the channel is attached, and resolves when the service has the work', async () => {
    const { service, docId } = newDoc();
    const journal = memoryJournal();
    const first = await open(service, docId, journal, { answer: 'hold' });
    first.attach();
    caret(first.core, IDS.intro, 0);
    type(first.core, 'Flushed ');
    await until(() => first.sent.length === 1, 'the commit is sent');
    await close(first);

    const second = await open(service, docId, journal);
    let resolved = false;
    const flushed = second.core.flush({ timeoutMs: 5_000 }).then(() => {
      resolved = true;
    });
    // A flush with a short limit, asked for before the channel is attached, is refused: one
    // unconfirmed piece of work remains, the journal's.
    await expect(second.core.flush({ timeoutMs: 20 })).rejects.toMatchObject({ count: 1 });
    expect(resolved).toBe(false);
    expect(second.core.saveState.get()).toBe('unsaved');
    second.attach();
    await flushed;
    // The promise resolved: the indicator reads saved (criterion 6), and the service has the text.
    expect(second.core.status.get()).toEqual({ connection: 'online', sync: 'saved' });
    expect(count(await serverText(second, docId), 'Flushed ')).toBe(1);
    second.kill();
    await service.dispose();
  });
});

describe('UX-016 criterion 5: for any run of visits that end unsaved', () => {
  it('a returning visit never reads saved before its work is confirmed, and nothing typed is lost', async () => {
    const visit = fc.record({
      end: fc.constantFrom<'down' | 'unavailable' | 'typed-offline'>(
        'down',
        'unavailable',
        'typed-offline',
      ),
      words: fc.integer({ min: 1, max: 2 }),
    });
    let returns = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(visit, { minLength: 1, maxLength: 3 }), async (visits) => {
        const { service, docId } = newDoc();
        const journal = memoryJournal();
        const typed: string[] = [];
        let n = 0;
        for (const plan of visits) {
          const v = await open(service, docId, journal, {
            answer: plan.end === 'unavailable' ? 'unavailable' : 'hold',
          });
          v.attach();
          if (plan.end === 'typed-offline') {
            v.drop();
            await until(() => v.core.connection.get() === 'reconnecting', 'the connection is down');
          }
          for (let w = 0; w < plan.words; w++) {
            const word = `W${n++}x `;
            typed.push(word);
            caret(v.core, IDS.intro, 'end');
            type(v.core, word);
            await sleep(1);
          }
          if (plan.end === 'down') v.drop();
          await until(() => v.core.saveState.get() === 'unsaved', `unsaved (${plan.end})`);
          if (v.returning) {
            returns++;
            // Work was in the journal from the first moment: this visit was never saved.
            expect(v.seen[0]).toBe('offline/unsaved');
            expect(v.seen.some((s) => s.endsWith('/saved'))).toBe(false);
          }
          await close(v);
        }
        // The author returns once more, and this time the service answers.
        const last = await open(service, docId, journal);
        expect(last.core.status.get()).toEqual({ connection: 'offline', sync: 'unsaved' });
        last.attach();
        await until(() => last.core.saveState.get() === 'saved', 'the last visit is saved', 8_000);
        expect(syncs(last.seen)).toEqual(['unsaved', 'saving', 'saved']);
        await last.core.flushJournal();
        const server = await serverText(last, docId);
        const recovered = last.core.recovered
          .get()
          .items.map((i) => i.text)
          .join('\u0000');
        for (const word of typed)
          expect(count(server, word) + count(recovered, word), word).toBe(1);
        expect(journal.size).toBe(0);
        last.kill();
        await service.dispose();
      }),
      { numRuns: 25 },
    );
    // Not vacuous: some of the visits before the last one were returns.
    expect(returns).toBeGreaterThan(0);
  }, 120_000);
});
