/**
 * The cold segments of a document in the object store, for the recovery command (BE-078; HIS-029).
 *
 * A database restored to an earlier point can leave segment objects that were written after the
 * restored point: their range ends past the restored head, and the restored database has no row
 * for them (a row cannot name a commit the log does not have). Those payloads belong to commits the
 * log no longer holds, so the command lists them and, when it gives the document a new
 * incarnation, sets them aside: it copies each to `docs/{doc}/aside/{tag}/segments/` and deletes it
 * from the segments prefix. A segment whose range ends at or below the head is never touched.
 */
import type { DocRef } from '../storage/types.ts';
import { objectKeys, TenantObjects, type ObjectStore } from './store.ts';

export interface SegmentRange {
  from: number;
  to: number;
}

/** What the recovery command needs of the cold segments. */
export interface SegmentStore {
  /** The segments of the document whose range ends after `head`. */
  beyond(ref: DocRef, head: number): Promise<SegmentRange[]>;
  /** Sets those aside and returns them. */
  setAside(ref: DocRef, head: number): Promise<SegmentRange[]>;
  /** Every document that has a segment object (a listing of the whole store). */
  documents(): Promise<DocRef[]>;
}

const KEY =
  /^tenants\/([0-9a-f-]{36})\/docs\/([0-9a-f-]{36})\/segments\/(\d+)-(\d+)\.payloads\.zst$/;

/** The document and range a segment key names, or null for any other key. */
export function parseSegmentKey(key: string): (DocRef & SegmentRange) | null {
  const m = KEY.exec(key);
  if (!m) return null;
  const from = Number(m[3]);
  const to = Number(m[4]);
  return Number.isSafeInteger(from) && Number.isSafeInteger(to) && to >= from
    ? { tenant: m[1]!, doc: m[2]!, from, to }
    : null;
}

export class ObjectSegmentStore implements SegmentStore {
  readonly #store: ObjectStore;

  constructor(store: ObjectStore) {
    this.#store = store;
  }

  async #list(ref: DocRef): Promise<SegmentRange[]> {
    const out: SegmentRange[] = [];
    for (const key of await this.#store.list(objectKeys.segments(ref.tenant, ref.doc))) {
      const s = parseSegmentKey(key);
      if (s) out.push({ from: s.from, to: s.to });
    }
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
  }

  async beyond(ref: DocRef, head: number): Promise<SegmentRange[]> {
    return (await this.#list(ref)).filter((s) => s.to > head);
  }

  async setAside(ref: DocRef, head: number): Promise<SegmentRange[]> {
    const objects = new TenantObjects(this.#store, ref.tenant);
    const tag = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const moved: SegmentRange[] = [];
    for (const s of await this.beyond(ref, head)) {
      const key = objectKeys.segment(ref.tenant, ref.doc, s.from, s.to);
      const bytes = await objects.get(key);
      // The copy is written before the original goes, so a stop between the two loses nothing.
      if (bytes)
        await objects.put(objectKeys.segmentAside(ref.tenant, ref.doc, s.from, s.to, tag), bytes, {
          contentType: 'application/zstd',
        });
      await objects.delete(key);
      moved.push(s);
    }
    return moved;
  }

  async documents(): Promise<DocRef[]> {
    const seen = new Map<string, DocRef>();
    for (const key of await this.#store.list('tenants/')) {
      const s = parseSegmentKey(key);
      if (s) seen.set(`${s.tenant}/${s.doc}`, { tenant: s.tenant, doc: s.doc });
    }
    return [...seen.values()];
  }
}
