/**
 * Comment threads and their first comments (PRO-059 criterion 1, PRO-060 criterion 3; 05 §6.2;
 * 06 §4.1 `threads` and `comments`, migration 0050). A thread here is anchored to a block by its
 * identifier, and carries the `scope` the block lay in when the thread was made. Range targets are
 * not stored yet: the room maps them to the head (PRO-059 criterion 2), and that mapping is not
 * wired into the control plane.
 *
 * The store checks shape only. The `comment` permission, the document's state and the caller's
 * identity are checked by `thread-routes.ts` before it calls `create` or `delete`.
 *
 * PostgreSQL: the rows are written under the tenant's row-level security (BE-011). The migration
 * grants `docedit_app` select, insert and update on `threads` and `comments` but not delete; a
 * delete by that role needs a grant in a later migration (see the PRO-060 Notes).
 *
 * A thread identifier is a UUID (`threads.id` is a `uuid` column). An identifier that is not one
 * names no thread: `get` returns undefined and `delete` false without a query, as the memory store
 * does, so a malformed path segment is `not_found` and never a database error (SEC-064).
 */
import { inTenant, isUuid, millis, type Pool, type PoolClient } from './db.ts';
import type { DocRef } from './types.ts';

/** A block target as stored: the block's identifier (05 §6.2 `BlockTarget`). */
export interface StoredBlockTarget {
  block: string;
}

/** A range target as stored: the range at the head, after mapping from the base seq (PRO-059 criterion 2). */
export interface StoredRangeTarget {
  range: { from: number; to: number };
}

export type StoredTarget = StoredBlockTarget | StoredRangeTarget;

/** One comment. `body` is the comment input as the caller sent it (G71: a placeholder shape). */
export interface StoredComment {
  id: string;
  author: string;
  body: unknown;
  createdAt: number;
  /** When the body was last edited (PRO-060 criterion 5); null while it never was. */
  editedAt: number | null;
}

/** A change to a thread's state or assignee (PRO-060 criterion 2). */
export interface ThreadChange {
  state?: 'open' | 'resolved';
  /** Present when the assignee changes; null clears it. */
  assignee?: string | null;
  /** The caller's surrogate, recorded as the resolver when the thread is resolved; null for a service. */
  by: string | null;
  at: number;
}

/** A comment's location: its thread, its document, and its author (PRO-060 criterion 5). */
export interface CommentLocation {
  threadId: string;
  docId: string;
  author: string;
}

export interface StoredThread {
  id: string;
  docId: string;
  /**
   * The scopes the target covered when the thread was made, for example `body` or `region:<id>`.
   * A range can cover several: they are joined with a newline (`scopesOf` reads them back).
   */
  scope: string;
  state: 'open' | 'resolved';
  target: StoredTarget;
  assignee: string | null;
  /** The creator's surrogate (never the host's `sub`; HIS-003). */
  createdBy: string;
  createdAt: number;
  /** Comments in the order they were made, without deleted ones. */
  comments: StoredComment[];
}

export interface NewThread {
  id: string;
  scope: string;
  target: StoredTarget;
  /** The head seq the range was mapped to, for a range target; null for a block (06 §4.1). */
  rangeSeq: number | null;
  createdBy: string;
  createdAt: number;
  comment: StoredComment;
}

export interface ThreadStore {
  /** Stores the thread and its first comment together. */
  create(ref: DocRef, thread: NewThread): Promise<StoredThread>;
  /** The thread with this identifier in the tenant, whatever its document (a bare identifier). */
  get(tenant: string, id: string): Promise<StoredThread | undefined>;
  /** Removes the thread and its comments; false when there was no such thread. */
  delete(tenant: string, id: string): Promise<boolean>;
  /** Changes the state or the assignee; undefined when there is no such thread. */
  update(tenant: string, id: string, change: ThreadChange): Promise<StoredThread | undefined>;
  /** Adds a comment to a thread; false when there is no such thread. */
  addComment(tenant: string, threadId: string, comment: StoredComment): Promise<boolean>;
  /** Where a live comment is; undefined for a deleted or unknown one. */
  findComment(tenant: string, cid: string): Promise<CommentLocation | undefined>;
  /** Replaces a live comment's body and sets its edit time; undefined when there is none. */
  editComment(
    tenant: string,
    cid: string,
    body: unknown,
    at: number,
  ): Promise<StoredComment | undefined>;
  /** Soft-deletes a live comment (its row stays, its body leaves reads); false when there is none. */
  deleteComment(tenant: string, cid: string): Promise<boolean>;
}

interface ThreadRow {
  id: string;
  doc_id: string;
  scope: string;
  state: 'open' | 'resolved';
  target: StoredTarget;
  assignee: string | null;
  created_by: string;
  created_at: Date;
}

interface CommentRow {
  id: string;
  author: string;
  body: unknown;
  created_at: Date;
  edited_at: Date | null;
}

/** Threads and comments in PostgreSQL, under the tenant's row-level security. */
export class PgThreadStore implements ThreadStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  create(ref: DocRef, thread: NewThread): Promise<StoredThread> {
    return inTenant(this.#pool, ref.tenant, async (c) => {
      const range = 'range' in thread.target ? thread.target.range : null;
      await c.query(
        `insert into threads (id, tenant_id, doc_id, scope, state, target, range_from, range_to,
           range_seq, detached, assignee, created_by, created_at)
         values ($1, $2, $3, $4, 'open', $5, $6, $7, $8, false, null, $9, $10)`,
        [
          thread.id,
          ref.tenant,
          ref.doc,
          thread.scope,
          JSON.stringify(thread.target),
          range?.from ?? null,
          range?.to ?? null,
          range === null ? null : thread.rangeSeq,
          thread.createdBy,
          new Date(thread.createdAt),
        ],
      );
      await c.query(
        `insert into comments (id, tenant_id, thread_id, author, body, created_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          thread.comment.id,
          ref.tenant,
          thread.id,
          thread.comment.author,
          JSON.stringify(thread.comment.body),
          new Date(thread.comment.createdAt),
        ],
      );
      return {
        id: thread.id,
        docId: ref.doc,
        scope: thread.scope,
        state: 'open',
        target: thread.target,
        assignee: null,
        createdBy: thread.createdBy,
        createdAt: thread.createdAt,
        comments: [thread.comment],
      };
    });
  }

  get(tenant: string, id: string): Promise<StoredThread | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<ThreadRow>(
          `select id, doc_id, scope, state, target, assignee, created_by, created_at
             from threads where id = $1`,
          [id],
        );
        const row = r.rows[0];
        if (!row) return undefined;
        const cs = await c.query<CommentRow>(
          `select id, author, body, created_at, edited_at from comments
            where thread_id = $1 and deleted_at is null order by created_at, id`,
          [id],
        );
        return {
          id: row.id,
          docId: row.doc_id,
          scope: row.scope,
          state: row.state,
          target: row.target,
          assignee: row.assignee,
          createdBy: row.created_by,
          createdAt: millis(row.created_at) ?? 0,
          comments: cs.rows.map((x) => ({
            id: x.id,
            author: x.author,
            body: x.body,
            createdAt: millis(x.created_at) ?? 0,
            editedAt: millis(x.edited_at),
          })),
        };
      },
      { readOnly: true },
    );
  }

  delete(tenant: string, id: string): Promise<boolean> {
    if (!isUuid(id)) return Promise.resolve(false);
    return inTenant(this.#pool, tenant, async (c) => {
      await c.query('delete from comments where thread_id = $1', [id]);
      const r = await c.query('delete from threads where id = $1', [id]);
      return (r.rowCount ?? 0) > 0;
    });
  }

  update(tenant: string, id: string, change: ThreadChange): Promise<StoredThread | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined);
    return inTenant(this.#pool, tenant, async (c) => {
      // A resolution keeps the first resolver while the thread stays resolved; a reopening clears it.
      const r = await c.query(
        `update threads set
           state = coalesce($2::text, state),
           assignee = case when $3::boolean then $4::text else assignee end,
           resolved_by = case when $2::text = 'resolved' and state <> 'resolved' then $5::text
             when $2::text = 'open' then null else resolved_by end,
           resolved_at = case when $2::text = 'resolved' and state <> 'resolved' then $6::timestamptz
             when $2::text = 'open' then null else resolved_at end
         where id = $1`,
        [
          id,
          change.state ?? null,
          change.assignee !== undefined,
          change.assignee ?? null,
          change.by,
          new Date(change.at),
        ],
      );
      if ((r.rowCount ?? 0) === 0) return undefined;
      return this.#readThread(c, id);
    });
  }

  addComment(tenant: string, threadId: string, comment: StoredComment): Promise<boolean> {
    if (!isUuid(threadId)) return Promise.resolve(false);
    return inTenant(this.#pool, tenant, async (c) => {
      const t = await c.query('select 1 from threads where id = $1', [threadId]);
      if ((t.rowCount ?? 0) === 0) return false;
      await c.query(
        `insert into comments (id, tenant_id, thread_id, author, body, created_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          comment.id,
          tenant,
          threadId,
          comment.author,
          JSON.stringify(comment.body),
          new Date(comment.createdAt),
        ],
      );
      return true;
    });
  }

  findComment(tenant: string, cid: string): Promise<CommentLocation | undefined> {
    if (!isUuid(cid)) return Promise.resolve(undefined);
    return inTenant(
      this.#pool,
      tenant,
      async (c) => {
        const r = await c.query<{ thread_id: string; doc_id: string; author: string }>(
          `select cm.thread_id, t.doc_id, cm.author from comments cm
             join threads t on t.id = cm.thread_id
            where cm.id = $1 and cm.deleted_at is null`,
          [cid],
        );
        const row = r.rows[0];
        if (!row) return undefined;
        return { threadId: row.thread_id, docId: row.doc_id, author: row.author };
      },
      { readOnly: true },
    );
  }

  editComment(
    tenant: string,
    cid: string,
    body: unknown,
    at: number,
  ): Promise<StoredComment | undefined> {
    if (!isUuid(cid)) return Promise.resolve(undefined);
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query<CommentRow>(
        `update comments set body = $2, edited_at = $3
          where id = $1 and deleted_at is null
          returning id, author, body, created_at, edited_at`,
        [cid, JSON.stringify(body), new Date(at)],
      );
      const row = r.rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        author: row.author,
        body: row.body,
        createdAt: millis(row.created_at) ?? 0,
        editedAt: millis(row.edited_at),
      };
    });
  }

  deleteComment(tenant: string, cid: string): Promise<boolean> {
    if (!isUuid(cid)) return Promise.resolve(false);
    return inTenant(this.#pool, tenant, async (c) => {
      const r = await c.query(
        'update comments set deleted_at = now() where id = $1 and deleted_at is null',
        [cid],
      );
      return (r.rowCount ?? 0) > 0;
    });
  }

  /** The thread with its live comments, read inside the caller's transaction. */
  async #readThread(c: PoolClient, id: string): Promise<StoredThread | undefined> {
    const r = await c.query<ThreadRow>(
      `select id, doc_id, scope, state, target, assignee, created_by, created_at
         from threads where id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return undefined;
    const cs = await c.query<CommentRow>(
      `select id, author, body, created_at, edited_at from comments
        where thread_id = $1 and deleted_at is null order by created_at, id`,
      [id],
    );
    return {
      id: row.id,
      docId: row.doc_id,
      scope: row.scope,
      state: row.state,
      target: row.target,
      assignee: row.assignee,
      createdBy: row.created_by,
      createdAt: millis(row.created_at) ?? 0,
      comments: cs.rows.map((x) => ({
        id: x.id,
        author: x.author,
        body: x.body,
        createdAt: millis(x.created_at) ?? 0,
        editedAt: millis(x.edited_at),
      })),
    };
  }
}

/** Threads in memory: nothing outlives the process (the memory parts of the service). */
export class MemoryThreadStore implements ThreadStore {
  readonly #threads = new Map<string, StoredThread & { tenant: string }>();

  async create(ref: DocRef, thread: NewThread): Promise<StoredThread> {
    const stored: StoredThread & { tenant: string } = {
      id: thread.id,
      tenant: ref.tenant,
      docId: ref.doc,
      scope: thread.scope,
      state: 'open',
      target: { ...thread.target },
      assignee: null,
      createdBy: thread.createdBy,
      createdAt: thread.createdAt,
      comments: [{ ...thread.comment }],
    };
    this.#threads.set(MemoryThreadStore.#key(ref.tenant, thread.id), stored);
    return MemoryThreadStore.#copy(stored);
  }

  /** Identifiers of comments that were soft-deleted; their rows stay in the thread, out of reads. */
  readonly #deleted = new Set<string>();

  async get(tenant: string, id: string): Promise<StoredThread | undefined> {
    const t = this.#threads.get(MemoryThreadStore.#key(tenant, id));
    return t === undefined ? undefined : this.#view(t);
  }

  async delete(tenant: string, id: string): Promise<boolean> {
    return this.#threads.delete(MemoryThreadStore.#key(tenant, id));
  }

  async update(
    tenant: string,
    id: string,
    change: ThreadChange,
  ): Promise<StoredThread | undefined> {
    const t = this.#threads.get(MemoryThreadStore.#key(tenant, id));
    if (t === undefined) return undefined;
    if (change.state !== undefined) t.state = change.state;
    if (change.assignee !== undefined) t.assignee = change.assignee;
    return this.#view(t);
  }

  async addComment(tenant: string, threadId: string, comment: StoredComment): Promise<boolean> {
    const t = this.#threads.get(MemoryThreadStore.#key(tenant, threadId));
    if (t === undefined) return false;
    t.comments.push({ ...comment });
    return true;
  }

  async findComment(tenant: string, cid: string): Promise<CommentLocation | undefined> {
    if (this.#deleted.has(cid)) return undefined;
    for (const t of this.#threads.values()) {
      if (t.tenant !== tenant) continue;
      const c = t.comments.find((x) => x.id === cid);
      if (c) return { threadId: t.id, docId: t.docId, author: c.author };
    }
    return undefined;
  }

  async editComment(
    tenant: string,
    cid: string,
    body: unknown,
    at: number,
  ): Promise<StoredComment | undefined> {
    if (this.#deleted.has(cid)) return undefined;
    for (const t of this.#threads.values()) {
      if (t.tenant !== tenant) continue;
      const c = t.comments.find((x) => x.id === cid);
      if (c) {
        c.body = body;
        c.editedAt = at;
        return { ...c };
      }
    }
    return undefined;
  }

  async deleteComment(tenant: string, cid: string): Promise<boolean> {
    if ((await this.findComment(tenant, cid)) === undefined) return false;
    this.#deleted.add(cid);
    return true;
  }

  /** The thread as a reader sees it: a copy without the soft-deleted comments. */
  #view(t: StoredThread & { tenant: string }): StoredThread {
    const copy = MemoryThreadStore.#copy(t);
    return { ...copy, comments: copy.comments.filter((c) => !this.#deleted.has(c.id)) };
  }

  static #key(tenant: string, id: string): string {
    return JSON.stringify([tenant, id]);
  }

  static #copy(t: StoredThread & { tenant: string }): StoredThread {
    return {
      id: t.id,
      docId: t.docId,
      scope: t.scope,
      state: t.state,
      target: { ...t.target },
      assignee: t.assignee,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      comments: t.comments.map((c) => ({ ...c })),
    };
  }
}
