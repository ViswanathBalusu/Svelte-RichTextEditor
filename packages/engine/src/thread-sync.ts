/**
 * How the client learns where comment threads are (FE-048 criteria 1, 4 and 6; 05 §5.6, §6.2; 07 §6).
 *
 * The service reports a thread's range at a `seq`: in the list (`GET /documents/{id}/threads?seq=`,
 * `target.range.baseSeq`) and in `thread.*` notices (`data.seq`, `data.range` or `data.block`). The
 * positions refer to the confirmed document at that `seq`. The client may be ahead of it (it has
 * applied later commits) or behind it (the commit is still on its way). This module holds:
 *
 * - `ConfirmedLog`: the step maps of the confirmed commits the client applied, as presence keeps
 *   them (SYN-036), so that a range reported at an earlier `seq` is mapped forward through the same
 *   steps the authority applied;
 * - `ThreadSync`: the listing on attach, the `thread.*` notices, and the control-plane writes
 *   (create, resolve, reopen). A write is a request to the thread resource, never a commit: this
 *   module has no access to the document or to the sync queue (13 §5).
 *
 * It draws nothing and imports no DOM.
 */
import { mapRanges } from '@docedit/authority';
import type { StepMap } from 'prosemirror-transform';
import { DEFAULT_MAPPING_HISTORY } from './mapping-history.ts';
import type { Confirmed } from './sync/state.ts';

/** Where the service says a thread is, at `seq`: a range of text or one block. */
export interface ThreadReport {
  readonly seq: number;
  readonly range?: { readonly from: number; readonly to: number };
  readonly block?: string;
}

/** The step maps of the confirmed commits since the oldest one the client keeps. */
export class ConfirmedLog {
  readonly #history: { to: number; maps: readonly StepMap[] }[] = [];
  readonly #retain: number;
  #floor: number;

  constructor(floor: number, retain: number = DEFAULT_MAPPING_HISTORY) {
    this.#floor = floor;
    this.#retain = Math.max(0, retain);
  }

  /** The oldest `seq` a range can still be mapped from. */
  get floor(): number {
    return this.#floor;
  }

  /** A confirmed change: its steps are kept; a replacement of the whole document starts over. */
  record(change: Confirmed): void {
    if (change.steps === null) {
      this.#history.length = 0;
      this.#floor = change.to;
      return;
    }
    this.#history.push({ to: change.to, maps: change.steps.map((s) => s.getMap()) });
    while (this.#history.length > this.#retain) this.#floor = this.#history.shift()!.to;
  }

  /**
   * A range reported at `seq`, mapped through every confirmed commit after it, or null when `seq`
   * is older than the log reaches. It is the authority's own `mapRanges` (SYN-001), so the client and
   * the service agree.
   */
  mapFrom(range: { from: number; to: number }, seq: number): { from: number; to: number } | null {
    if (seq < this.#floor) return null;
    const maps = this.#history.filter((e) => e.to > seq).flatMap((e) => e.maps);
    if (maps.length === 0) return { from: range.from, to: range.to };
    const [mapped] = mapRanges([{ from: range.from, to: range.to }], maps);
    return { from: mapped!.from, to: mapped!.to };
  }
}

/** One thread as the list or `GET /threads/{tid}` gives it (05 §6.2 `Thread`). */
export interface ThreadItem {
  readonly id: string;
  readonly state?: 'open' | 'resolved';
  readonly target?:
    | { readonly range: { readonly from: number; readonly to: number; readonly baseSeq: number } }
    | { readonly block: string };
}

/** A thread with its entity tag, as the comment port answers (`Tagged<Thread>`). */
export interface TaggedThread {
  readonly value: ThreadItem;
  readonly etag: string;
}

/** The part of the comment port this module uses (05 §6.2). */
export interface ThreadsPortLike {
  threads(
    docId: string,
    query?: { seq?: number; cursor?: string; limit?: number },
  ): Promise<{ items: readonly ThreadItem[]; nextCursor: string | null; seq?: number }>;
  thread?(threadId: string): Promise<TaggedThread>;
  createThread?(docId: string, body: { target: unknown; comment: unknown }): Promise<TaggedThread>;
  updateThread?(
    threadId: string,
    patch: { state?: 'open' | 'resolved'; assignee?: string | null },
    opts: { ifMatch: string },
  ): Promise<TaggedThread>;
}

/** What `ThreadSync` tells the core. */
export interface ThreadHost {
  /** The service's place for a thread, at a `seq`. */
  report(id: string, report: ThreadReport): void;
  /** The thread was deleted. */
  remove(id: string): void;
  /** The confirmed `seq` of the client. */
  seq(): number;
  /** Something the listing or a notice could not do. */
  failed(message: string): void;
}

/** A notice of a channel, as far as this module reads it (05 §5.6). */
export interface NoticeLike {
  readonly type: string;
  readonly resource: string;
  readonly data?: { readonly [key: string]: unknown } | undefined;
}

const PAGE = 100;

function threadIdOf(resource: string): string | null {
  const m = /^\/threads\/([^/]+)$/.exec(resource);
  return m ? m[1]! : null;
}

function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** The report a `thread.*` notice carries, or null when it does not carry one. */
export function reportOfNotice(data: NoticeLike['data']): ThreadReport | null {
  if (!data || !isCount(data['seq'])) return null;
  const range = data['range'] as { from?: unknown; to?: unknown } | undefined;
  if (range && isCount(range.from) && isCount(range.to) && range.from <= range.to)
    return { seq: data['seq'], range: { from: range.from, to: range.to } };
  if (typeof data['block'] === 'string') return { seq: data['seq'], block: data['block'] };
  return null;
}

/** The report a listed thread carries. */
export function reportOfItem(item: ThreadItem, fallbackSeq: number): ThreadReport | null {
  const t = item.target;
  if (!t) return null;
  if ('block' in t) return { seq: fallbackSeq, block: t.block };
  return { seq: t.range.baseSeq, range: { from: t.range.from, to: t.range.to } };
}

export class ThreadSync {
  readonly #port: ThreadsPortLike;
  readonly #docId: string;
  readonly #host: ThreadHost;
  #ended = false;
  /** Counts listings, so that the answer of an older one is not applied after a newer one started. */
  #generation = 0;

  constructor(port: ThreadsPortLike, docId: string, host: ThreadHost) {
    this.#port = port;
    this.#docId = docId;
    this.#host = host;
  }

  end(): void {
    this.#ended = true;
  }

  /** Lists the threads at the client's confirmed `seq`, page by page, and reports each one. */
  async load(): Promise<void> {
    const generation = ++this.#generation;
    const seq = this.#host.seq();
    let cursor: string | undefined;
    try {
      for (;;) {
        const page = await this.#port.threads(this.#docId, {
          seq,
          limit: PAGE,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (this.#ended || generation !== this.#generation) return;
        for (const item of page.items) {
          const report = reportOfItem(item, page.seq ?? seq);
          if (report) this.#host.report(item.id, report);
        }
        if (page.nextCursor === null) return;
        cursor = page.nextCursor;
      }
    } catch (e) {
      if (!this.#ended) this.#host.failed(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * A `thread.*` notice (05 §5.6). One that carries a range and its `seq` replaces the client's copy
   * at once; the core maps it forward from that `seq`. One that does not is a request to fetch.
   */
  onNotice(notice: NoticeLike): void {
    if (this.#ended || !notice.type.startsWith('thread.')) return;
    const id = threadIdOf(notice.resource);
    if (id === null) return;
    if (notice.type === 'thread.deleted') {
      this.#host.remove(id);
      return;
    }
    const report = reportOfNotice(notice.data);
    if (report) {
      this.#host.report(id, report);
      return;
    }
    const fetch = this.#port.thread;
    if (!fetch) return;
    void fetch
      .call(this.#port, id)
      .then((tagged) => {
        const r = reportOfItem(tagged.value, this.#host.seq());
        if (r && !this.#ended) this.#host.report(id, r);
      })
      .catch((e: unknown) => {
        if (!this.#ended) this.#host.failed(e instanceof Error ? e.message : String(e));
      });
  }

  /**
   * Starts a thread on a range or a block (05 §6.2). A control-plane request: the document, the sync
   * queue and the commit log are not touched (FE-048 criterion 6). The thread's own place arrives
   * as a `thread.created` notice or in the answer.
   */
  async create(
    target: { range: { from: number; to: number; baseSeq: number } } | { block: string },
    comment: unknown,
  ): Promise<string> {
    const make = this.#port.createThread;
    if (!make) throw new Error('the backend cannot create threads');
    const { value: item } = await make.call(this.#port, this.#docId, { target, comment });
    const report = reportOfItem(item, this.#host.seq());
    if (report && !this.#ended) this.#host.report(item.id, report);
    return item.id;
  }

  /** Resolves or reopens a thread (05 §6.2 `PATCH /threads/{tid}`): a request, never a commit. */
  async setState(threadId: string, state: 'open' | 'resolved'): Promise<void> {
    const patch = this.#port.updateThread;
    if (!patch) throw new Error('the backend cannot update threads');
    // The write carries the tag of the thread as it is now (`If-Match`, PRO-060 criterion 2).
    const read = this.#port.thread;
    if (!read) throw new Error('the backend cannot read threads');
    const { etag } = await read.call(this.#port, threadId);
    await patch.call(this.#port, threadId, { state }, { ifMatch: etag });
  }
}
