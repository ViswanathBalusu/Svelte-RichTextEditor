/**
 * FE-008 criteria 1, 3, 5 and the reopening of a journal after a closed tab, against the browser's
 * own IndexedDB in Chromium, Firefox and WebKit (`pnpm vitest run --project browser <file>`). Each
 * run uses its own database name (U-FE-001-016) and deletes it afterwards.
 */
import type { JournalEntry } from '@docedit/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { openIdbJournal } from './journal-idb.ts';

// Node.js has no IndexedDB: the suite is skipped there and runs in the browsers (`pnpm test:browsers`).
const hasIndexedDb = typeof indexedDB !== 'undefined';

const names: string[] = [];
function freshName(): string {
  const n = `docedit-U-FE-001-016-${Math.random().toString(36).slice(2)}`;
  names.push(n);
  return n;
}

const step = (text: string) =>
  ({ stepType: 'replace', text, from: 1, to: 1 }) as unknown as JournalEntry['steps'][number];

function entry(docId: string, id: string, text: string): JournalEntry {
  return { docId, id, base: 3, steps: [step(text)] };
}

afterEach(async () => {
  if (!hasIndexedDb) return;
  for (const n of names.splice(0)) {
    await new Promise<void>((resolve) => {
      const r = indexedDB.deleteDatabase(n);
      r.onsuccess = () => resolve();
      r.onerror = () => resolve();
      r.onblocked = () => resolve();
    });
  }
});

describe.skipIf(!hasIndexedDb)('the IndexedDB journal (FE-008)', () => {
  it('stores a commit under its identifier and keeps it when the handle is closed', async () => {
    const name = freshName();
    const j = await openIdbJournal(indexedDB, name);
    await j.put(entry('doc-U-FE-001-016', '0190-a', 'first'));
    j.close();
    // A second handle, as after a closed tab: the commit is still there (criterion 6).
    const again = await openIdbJournal(indexedDB, name);
    const { commits } = await again.read('doc-U-FE-001-016');
    expect(commits.map((c) => c.id)).toEqual(['0190-a']);
    expect(commits[0]!.steps).toEqual([step('first')]);
    again.close();
  });

  it('reads commits oldest first and removes an acknowledged one', async () => {
    const j = await openIdbJournal(indexedDB, freshName());
    await j.put(entry('doc-U-FE-001-016', '0190-c', 'third'));
    await j.put(entry('doc-U-FE-001-016', '0190-a', 'first'));
    await j.put(entry('doc-U-FE-001-016', '0190-b', 'second'));
    expect((await j.read('doc-U-FE-001-016')).commits.map((c) => c.id)).toEqual([
      '0190-a',
      '0190-b',
      '0190-c',
    ]);
    await j.remove('doc-U-FE-001-016', '0190-b');
    await j.remove('doc-U-FE-001-016', 'never-written');
    expect((await j.read('doc-U-FE-001-016')).commits.map((c) => c.id)).toEqual([
      '0190-a',
      '0190-c',
    ]);
    j.close();
  });

  it('keeps each document apart', async () => {
    const j = await openIdbJournal(indexedDB, freshName());
    await j.put(entry('doc-one-U-FE-001-016', '0190-a', 'one'));
    await j.put(entry('doc-two-U-FE-001-016', '0190-a', 'two'));
    await j.setQueue('doc-one-U-FE-001-016', [step('queued')]);
    const one = await j.read('doc-one-U-FE-001-016');
    expect(one.commits.map((c) => c.docId)).toEqual(['doc-one-U-FE-001-016']);
    expect(one.queue).toEqual([step('queued')]);
    expect((await j.read('doc-two-U-FE-001-016')).queue).toEqual([]);
    j.close();
  });

  it('replaces the queue, and an empty queue clears it', async () => {
    const j = await openIdbJournal(indexedDB, freshName());
    await j.setQueue('doc-U-FE-001-016', [step('a')]);
    await j.setQueue('doc-U-FE-001-016', [step('a'), step('b')]);
    expect((await j.read('doc-U-FE-001-016')).queue).toEqual([step('a'), step('b')]);
    await j.setQueue('doc-U-FE-001-016', []);
    expect((await j.read('doc-U-FE-001-016')).queue).toEqual([]);
    j.close();
  });
});

describe('the IndexedDB journal without IndexedDB (FE-008)', () => {
  it('rejects when there is no IndexedDB, so the caller can carry on without a journal', async () => {
    await expect(openIdbJournal(undefined)).rejects.toThrow('IndexedDB is not available');
  });
});
