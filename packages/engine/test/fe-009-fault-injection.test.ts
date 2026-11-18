/**
 * FE-009 criterion 7 (lane w1, 2026-11-17), the client half of the phase 1b exit run: dropped
 * answers, a tab closed at any moment and a document opened again, in random order. When the last
 * visit has drained, every word typed is in the document once, or in the recovered edits once: none
 * is missing and none is applied twice.
 *
 * Each round is one visit. The visit types, lets the channel answer as the round says (the room, no
 * answer, or an answer lost after the room stored the commit), flushes the journal as the page does
 * when it is hidden (FE-011), and is closed. A last visit answers normally and drains. Backend-mock's
 * real Room is the server; the journal outlives the visits, as IndexedDB does. This is not the
 * process kill or the dropped sockets of the exit criterion on a real service: those are the
 * server's part of the run.
 */
import { MockService } from '@docedit/backend-mock';
import type { Content, SyncChannel } from '@docedit/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DocumentCore, readRestorePlan, restoreBase } from '../src/headless.ts';
import { type JournalPort, memoryJournal } from '../src/index.ts';
import { IDS, LEGAL_GRANT_FOR_TESTS, contractDocument } from './fixtures.ts';
import { caret, sleep, type, until } from './support.ts';

type Mode = 'pass' | 'hold' | 'lose-ack';

/** One visit: how the channel answers, how many words are typed, and whether another person writes first. */
const round = fc.record({
  mode: fc.constantFrom<Mode>('pass', 'hold', 'lose-ack'),
  words: fc.integer({ min: 1, max: 3 }),
  elsewhere: fc.boolean(),
});

async function open(
  service: MockService,
  docId: string,
  journal: JournalPort,
  sub: string,
  mode: Mode,
) {
  const backend = service.backend({ sub }, { [docId]: 'editor' });
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
  const submit = channel.submit.bind(channel);
  (channel as { submit: SyncChannel['submit'] }).submit = (commit) => {
    if (mode === 'hold') return new Promise(() => {});
    if (mode === 'lose-ack') {
      void submit(commit).catch(() => {});
      return new Promise(() => {});
    }
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
  return { core, detach, backend };
}

describe('FE-009 criterion 7: nothing typed is missing and nothing is applied twice', () => {
  it('holds over random sequences of visits that end with an unanswered or a lost commit', async () => {
    let restored = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(round, { minLength: 1, maxLength: 4 }), async (rounds) => {
        const service = new MockService({ presence: false });
        const docId = service.createDocument(contractDocument(), {
          grants: [LEGAL_GRANT_FOR_TESTS],
        });
        const journal = memoryJournal();
        const typed: string[] = [];
        let n = 0;
        for (const r of rounds) {
          if (r.elsewhere) {
            const other = await open(service, docId, memoryJournal(), 'ada', 'pass');
            caret(other.core, IDS.intro, 0);
            type(other.core, `Else${n++} `);
            await until(() => other.core.saveState.get() === 'saved', 'the other write is saved');
            other.detach();
          }
          const v = await open(service, docId, journal, 'grace', r.mode);
          if ((await journal.read(docId)).commits.length === 0) {
            // nothing to restore
          } else restored++;
          for (let w = 0; w < r.words; w++) {
            const word = `Word${n++}x `;
            typed.push(word);
            caret(v.core, IDS.intro, 'end');
            type(v.core, word);
            await sleep(1);
          }
          await sleep(3);
          // The page is hidden, then closed.
          await v.core.flushJournal();
          v.detach();
        }
        // The last visit answers normally and drains.
        const last = await open(service, docId, journal, 'grace', 'pass');
        await until(() => last.core.saveState.get() === 'saved', 'the last visit is saved', 8000);
        await last.core.flushJournal();
        const server = JSON.stringify((await last.backend.sync.loadContent(docId)).doc);
        const recovered = (await journal.readRecovered?.(docId)) ?? [];
        const recoveredText = recovered.map((x) => x.text).join('\u0000');
        for (const word of typed) {
          const inDocument = server.split(word).length - 1;
          const inRecovered = recoveredText.split(word).length - 1;
          expect(inDocument + inRecovered, `${word} in ${rounds.length} rounds`).toBe(1);
        }
        expect(journal.size).toBe(0);
        last.detach();
        await service.dispose();
      }),
      { numRuns: 30 },
    );
    // Not vacuous: some visits found work to put back.
    expect(restored).toBeGreaterThan(0);
  }, 120_000);
});
