/**
 * The recovery journal in the browser's IndexedDB (FE-008; 02 §2.2; 10 §3.1). It implements the
 * engine's `JournalPort`: commits are stored under `[docId, commit id]`, the queue of unsent steps
 * under the document identifier. Only commits and steps are stored, never tokens.
 *
 * A database that cannot be opened (no IndexedDB, a private window, blocked site data) gives no
 * journal: `openIdbJournal` rejects, and the caller carries on without one.
 */
import type {
  Discarded,
  JournalContents,
  JournalEntry,
  JournalPort,
  QueueAt,
} from '@docedit/engine';

/** The database name: one per origin, shared by every document the origin edits. */
export const JOURNAL_DB_NAME = 'docedit-journal';
// Version 2 adds the recovered-edits store (FE-010); version 1 databases are upgraded in place.
const VERSION = 2;
const COMMITS = 'commits';
const QUEUES = 'queues';
const RECOVERED = 'recovered';

export interface IdbJournal extends JournalPort {
  /** Releases the database handle (FE-006: the journal is closed when the element is destroyed). */
  close(): void;
}

type Steps = JournalEntry['steps'];

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error ?? new Error('IndexedDB transaction failed'));
    t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** Opens (and, on first use, creates) the journal database. */
export async function openIdbJournal(
  factory: IDBFactory | undefined,
  name: string = JOURNAL_DB_NAME,
): Promise<IdbJournal> {
  if (!factory) throw new Error('IndexedDB is not available');
  const open = factory.open(name, VERSION);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains(COMMITS))
      db.createObjectStore(COMMITS, { keyPath: ['docId', 'id'] });
    if (!db.objectStoreNames.contains(QUEUES)) db.createObjectStore(QUEUES, { keyPath: 'docId' });
    if (!db.objectStoreNames.contains(RECOVERED))
      db.createObjectStore(RECOVERED, { keyPath: 'docId' });
  };
  const db = await request(open);
  const range = (docId: string) => IDBKeyRange.bound([docId, ''], [docId, '￿']);
  return {
    async put(entry: JournalEntry) {
      const t = db.transaction(COMMITS, 'readwrite');
      t.objectStore(COMMITS).put(JSON.parse(JSON.stringify(entry)));
      await done(t);
    },
    async remove(docId: string, id: string) {
      const t = db.transaction(COMMITS, 'readwrite');
      t.objectStore(COMMITS).delete([docId, id]);
      await done(t);
    },
    async setQueue(docId: string, steps: readonly unknown[], at?: QueueAt) {
      const t = db.transaction(QUEUES, 'readwrite');
      if (steps.length === 0) t.objectStore(QUEUES).delete(docId);
      else
        t.objectStore(QUEUES).put({
          docId,
          steps: JSON.parse(JSON.stringify(steps)),
          ...(at
            ? {
                at: {
                  seq: at.seq,
                  incarnation: at.incarnation,
                  ...(at.user === undefined ? {} : { user: at.user }),
                },
              }
            : {}),
        });
      await done(t);
    },
    async read(docId: string): Promise<JournalContents> {
      const t = db.transaction([COMMITS, QUEUES], 'readonly');
      const commits = request(t.objectStore(COMMITS).getAll(range(docId)));
      const queue = request(t.objectStore(QUEUES).get(docId));
      await done(t);
      const rows = (await commits) as JournalEntry[];
      const q = (await queue) as { steps: Steps; at?: QueueAt } | undefined;
      // The key range sorts by identifier: UUID version 7 identifiers sort in the order they were made.
      return { commits: rows, queue: q?.steps ?? [], ...(q?.at ? { queueAt: q.at } : {}) };
    },
    async setRecovered(docId: string, items: readonly Discarded[]) {
      const t = db.transaction(RECOVERED, 'readwrite');
      if (items.length === 0) t.objectStore(RECOVERED).delete(docId);
      else t.objectStore(RECOVERED).put({ docId, items: JSON.parse(JSON.stringify(items)) });
      await done(t);
    },
    async readRecovered(docId: string): Promise<readonly Discarded[]> {
      const t = db.transaction(RECOVERED, 'readonly');
      const row = request(t.objectStore(RECOVERED).get(docId));
      await done(t);
      const r = (await row) as { items: Discarded[] } | undefined;
      return r?.items ?? [];
    },
    close() {
      db.close();
    },
  };
}
