/**
 * The browser's store: one IndexedDB database with a `documents` store (one row per document) and
 * a `commits` store (one row per commit, keyed by document and external sequence number). Every
 * conditional write is one read-write transaction, so IndexedDB itself decides between two tabs.
 * A transaction asks for strict durability: a commit is acknowledged only after it was flushed.
 */
import type { WriteRequest, WriteResult } from '@docedit/authority';
import type {
  DocumentRecord,
  RestoredDocument,
  SegmentRecord,
  StoredEntry,
  StoredPerms,
} from '@docedit/backend-mock';
import { planAppend, planPerms, planSegment, type LocalStore } from './store.ts';

const DOCUMENTS = 'documents';
const COMMITS = 'commits';

interface CommitRow extends StoredEntry {
  doc: string;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

export class IndexedDbStore implements LocalStore {
  private readonly opening: Promise<IDBDatabase>;

  /** Opens (and creates, when needed) the database `name`. */
  constructor(name = 'docedit-local', factory: IDBFactory = indexedDB) {
    this.opening = new Promise((resolve, reject) => {
      const open = factory.open(name, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore(DOCUMENTS, { keyPath: 'id' });
        db.createObjectStore(COMMITS, { keyPath: ['doc', 'ext'] });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('IndexedDB could not be opened'));
    });
  }

  /** Runs `body` in one read-write transaction and resolves with its result when it committed. */
  private async write<T>(
    body: (documents: IDBObjectStore, commits: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await this.opening;
    const tx = db.transaction([DOCUMENTS, COMMITS], 'readwrite', { durability: 'strict' });
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    const out = await body(tx.objectStore(DOCUMENTS), tx.objectStore(COMMITS));
    await done;
    return out;
  }

  async create(record: DocumentRecord): Promise<boolean> {
    return this.write(async (documents) => {
      if ((await request(documents.get(record.id))) !== undefined) return false;
      documents.put(record);
      return true;
    });
  }

  async read(id: string): Promise<RestoredDocument | undefined> {
    const db = await this.opening;
    const tx = db.transaction([DOCUMENTS, COMMITS], 'readonly');
    const record = (await request(tx.objectStore(DOCUMENTS).get(id))) as DocumentRecord | undefined;
    if (!record) return undefined;
    const rows = (await request(
      tx.objectStore(COMMITS).getAll(IDBKeyRange.bound([id, 0], [id, Infinity])),
    )) as CommitRow[];
    return { record, commits: rows.map((r) => ({ ext: r.ext, commit: r.commit })) };
  }

  async list(): Promise<string[]> {
    const db = await this.opening;
    const keys = await request(
      db.transaction(DOCUMENTS, 'readonly').objectStore(DOCUMENTS).getAllKeys(),
    );
    return keys.map(String);
  }

  async append(
    id: string,
    segment: number,
    offset: number,
    req: WriteRequest,
  ): Promise<WriteResult> {
    return this.write(async (documents, commits) => {
      const rec = (await request(documents.get(id))) as DocumentRecord | undefined;
      if (!rec) return { status: 'lost' } as const;
      const plan = planAppend(rec, segment, offset, req);
      if (plan.record && plan.entries) {
        for (const e of plan.entries) commits.put({ doc: id, ...e } satisfies CommitRow);
        documents.put(plan.record);
      }
      return plan.result;
    });
  }

  async addSegment(id: string, segment: SegmentRecord, expectHead: number): Promise<boolean> {
    return this.write(async (documents) => {
      const rec = (await request(documents.get(id))) as DocumentRecord | undefined;
      const next = rec && planSegment(rec, segment, expectHead);
      if (!next) return false;
      documents.put(next);
      return true;
    });
  }

  async putPerms(id: string, perms: StoredPerms): Promise<boolean> {
    return this.write(async (documents) => {
      const rec = (await request(documents.get(id))) as DocumentRecord | undefined;
      const next = rec && planPerms(rec, perms);
      if (!next) return false;
      documents.put(next);
      return true;
    });
  }

  async remove(id: string): Promise<void> {
    await this.write(async (documents, commits) => {
      documents.delete(id);
      commits.delete(IDBKeyRange.bound([id, 0], [id, Infinity]));
    });
  }

  close(): void {
    void this.opening.then((db) => db.close());
  }
}
