/**
 * What the local backend needs of a store (PRO-100): documents as rows, commits as rows, and
 * conditional writes, so that two tabs on one store cannot both extend the same log. Two
 * implementations: `IndexedDbStore` (the browser's) and `MemoryStore` (the same rules in a
 * process, for tests and for a page without IndexedDB).
 */
import {
  unpackPerms,
  type DocumentRecord,
  type RestoredDocument,
  type SegmentRecord,
  type StoredEntry,
  type StoredPerms,
} from '@docedit/backend-mock';
import type { WriteRequest, WriteResult } from '@docedit/authority';

export interface LocalStore {
  /** Creates the document row; false when the document exists already. */
  create(record: DocumentRecord): Promise<boolean>;
  /** The document and its commits, or undefined. */
  read(id: string): Promise<RestoredDocument | undefined>;
  /** The identifiers of every stored document. */
  list(): Promise<string[]>;
  /** Appends the commits of `req` to segment `segment`, whose start is `offset` (04 §5 step 9). */
  append(id: string, segment: number, offset: number, req: WriteRequest): Promise<WriteResult>;
  /** Adds a segment (a snapshot commit); false when the head is not `expectHead`. */
  addSegment(id: string, segment: SegmentRecord, expectHead: number): Promise<boolean>;
  /** Stores the permission state; false unless its revision follows the stored one (04 G7). */
  putPerms(id: string, perms: StoredPerms): Promise<boolean>;
  /** Removes a document and its commits. */
  remove(id: string): Promise<void>;
  /** Releases the store. */
  close(): void;
}

/** The ownership epoch of a local document: there is one writer at a time, the store (04 §5). */
export const LOCAL_EPOCH = 1;

export interface AppendPlan {
  result: WriteResult;
  /** The document row after the write, and the rows to add; absent when nothing is written. */
  record?: DocumentRecord;
  entries?: StoredEntry[];
}

/**
 * The rules of a conditional append, in one place so that both stores follow them: the epoch, the
 * segment and the head the write extends, and the grants revision it was checked against (G7).
 */
export function planAppend(
  rec: DocumentRecord,
  segment: number,
  offset: number,
  req: WriteRequest,
): AppendPlan {
  if (req.epoch !== LOCAL_EPOCH) return { result: { status: 'fenced' } };
  if (rec.segments.length - 1 !== segment) return { result: { status: 'fenced' } };
  if (rec.head !== req.fromSeq - 1 + offset) return { result: { status: 'fenced' } };
  if (rec.perms.revision !== req.revision)
    return { result: { status: 'revision_moved', perms: unpackPerms(rec.perms) } };
  const entries: StoredEntry[] = req.commits.map((commit) => ({
    ext: commit.seq + offset,
    commit: structuredClone(commit),
  }));
  const head = entries.length ? entries[entries.length - 1]!.ext : rec.head;
  return { result: { status: 'ok' }, record: { ...rec, head }, entries };
}

/** The same rules for a new segment. */
export function planSegment(
  rec: DocumentRecord,
  segment: SegmentRecord,
  expectHead: number,
): DocumentRecord | undefined {
  if (rec.head !== expectHead || segment.start !== expectHead + 1) return undefined;
  return { ...rec, segments: [...rec.segments, structuredClone(segment)], head: segment.start };
}

/** The same rule for permissions. */
export function planPerms(rec: DocumentRecord, perms: StoredPerms): DocumentRecord | undefined {
  if (perms.revision !== rec.perms.revision + 1) return undefined;
  return { ...rec, perms: structuredClone(perms) };
}

/** A store in memory. Several services may share one, as two tabs share a database. */
export class MemoryStore implements LocalStore {
  private readonly records = new Map<string, DocumentRecord>();
  private readonly rows = new Map<string, StoredEntry[]>();

  async create(record: DocumentRecord): Promise<boolean> {
    if (this.records.has(record.id)) return false;
    this.records.set(record.id, structuredClone(record));
    this.rows.set(record.id, []);
    return true;
  }

  async read(id: string): Promise<RestoredDocument | undefined> {
    const record = this.records.get(id);
    if (!record) return undefined;
    return {
      record: structuredClone(record),
      commits: structuredClone(this.rows.get(id) ?? []),
    };
  }

  async list(): Promise<string[]> {
    return [...this.records.keys()];
  }

  async append(
    id: string,
    segment: number,
    offset: number,
    req: WriteRequest,
  ): Promise<WriteResult> {
    const rec = this.records.get(id);
    if (!rec) return { status: 'lost' };
    const plan = planAppend(rec, segment, offset, req);
    if (plan.record && plan.entries) {
      this.records.set(id, plan.record);
      this.rows.get(id)!.push(...plan.entries);
    }
    return plan.result;
  }

  async addSegment(id: string, segment: SegmentRecord, expectHead: number): Promise<boolean> {
    const rec = this.records.get(id);
    const next = rec && planSegment(rec, segment, expectHead);
    if (!next) return false;
    this.records.set(id, next);
    return true;
  }

  async putPerms(id: string, perms: StoredPerms): Promise<boolean> {
    const rec = this.records.get(id);
    const next = rec && planPerms(rec, perms);
    if (!next) return false;
    this.records.set(id, next);
    return true;
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
    this.rows.delete(id);
  }

  close(): void {}
}
