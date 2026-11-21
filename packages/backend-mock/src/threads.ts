/**
 * Comment threads of the mock backend (05 §6.2; 07 §6, §12; ADR 0015; ADR 0417; gap G71). The
 * room keeps what is about the document: where each thread is (a range mapped through every commit,
 * or a block by identifier), the scopes it covers, who may see, reply, resolve and delete it, and
 * the 5,000-thread limit. This module keeps what is about the conversation: the comments, the state,
 * the assignee and the entity tags, and turns both into the wire shapes of `CommentsPort`.
 *
 * Rules the mock shares with the document service (`thread-routes.ts`):
 * - a thread is never part of the document: nothing here makes a commit;
 * - a reader gets a thread, and a notice about it, only when it may view every scope the thread
 *   covers (ADR 0019): a thread in a hidden region is `not_found` and is never announced to it;
 * - a change of state or assignee, and an edit of a comment, takes `If-Match`;
 * - a notice goes to every open channel that may read the thread, the actor's own included.
 *
 * What the mock does not do: it keeps threads in memory only, answers a listing at the head whatever
 * `seq` is asked (the room cannot unmap a range), ignores idempotency keys and raises no webhooks.
 */
import type { Connection, Room, ThreadAnchor, ThreadOutcome } from '@docedit/authority';
import { formatTimestamp, uuid7 } from '@docedit/model';
import {
  PortError,
  type Body,
  type Comment,
  type CommentBodyPart,
  type Notification,
  type Query,
  type Tagged,
  type Thread,
} from '@docedit/protocol';

interface CommentRecord {
  id: string;
  /** The author's `sub`. */
  author: string;
  body: CommentBodyPart[];
  createdAt: number;
  editedAt: number | null;
}

interface ThreadRecord {
  id: string;
  /** The creator's `sub`. */
  createdBy: string;
  createdAt: number;
  state: 'open' | 'resolved';
  assignee: string | null;
  comments: CommentRecord[];
}

/** What the threads of a document need from it. */
export interface ThreadsHost {
  now(): number;
  /** The room that serves the document now (it is replaced by a snapshot commit). */
  room(): Room;
  /** External seq = the room's seq plus this. */
  offset(): number;
  /** The external head seq. */
  head(): number;
  /** Tells every open channel whose connection `readable` accepts. */
  notify(n: Notification, readable: (conn: Connection) => boolean): void;
}

const MENTION = /^(user|group):\S+$/;

/** The limit of a page when the caller names none. */
const PAGE = 100;

const tagOfThread = (t: ThreadRecord): string =>
  `"${t.id}:${t.state}:${encodeURIComponent(t.assignee ?? '')}"`;
const tagOfComment = (c: CommentRecord): string => `"${c.id}:${c.editedAt ?? 0}"`;

const principal = (sub: string): string => `user:${sub}`;

/** The parts of a `CommentInput`, or a `validation_failed` refusal (ADR 0417). */
function parseInput(raw: unknown, path: string): CommentBodyPart[] {
  const parts = (raw as { body?: unknown } | null)?.body;
  const refuse = (): never => {
    throw new PortError(
      'validation_failed',
      'the comment body is a list of text and mention parts',
      {
        details: { violations: [{ path, rule: 'a non-empty list of text and mention parts' }] },
      },
    );
  };
  if (!Array.isArray(parts) || parts.length === 0) return refuse();
  const out: CommentBodyPart[] = [];
  for (const part of parts as unknown[]) {
    const p = part as { type?: unknown; text?: unknown; principal?: unknown } | null;
    if (p?.type === 'text' && typeof p.text === 'string' && p.text !== '')
      out.push({ type: 'text', text: p.text });
    else if (p?.type === 'mention' && typeof p.principal === 'string' && MENTION.test(p.principal))
      out.push({ type: 'mention', principal: p.principal });
    else return refuse();
  }
  return out;
}

/** Turns a refusal of the room into the error the control plane answers with (as thread-routes.ts). */
function refusal(out: Extract<ThreadOutcome, { ok: false }>): PortError {
  switch (out.code) {
    case 'permission_denied':
      return new PortError('forbidden', out.reason);
    case 'not_found':
      return new PortError('not_found', out.reason);
    case 'quota_exceeded':
      return new PortError('quota_exceeded', out.reason);
    case 'stale_base':
      return new PortError('validation_failed', out.reason, {
        details: {
          violations: [{ path: '/target/range/baseSeq', rule: 'within the rebase window' }],
        },
      });
    case 'invalid_op':
      return new PortError('validation_failed', out.reason);
    case 'unavailable':
      return new PortError('unavailable', out.reason);
    default:
      return new PortError('conflict', out.reason);
  }
}

export class MockThreads {
  private readonly host: ThreadsHost;
  private readonly records = new Map<string, ThreadRecord>();
  /** Comment identifier to its thread. */
  private readonly byComment = new Map<string, string>();

  constructor(host: ThreadsHost) {
    this.host = host;
  }

  /** The number of threads, for tests. */
  get size(): number {
    return this.records.size;
  }

  hasThread(id: string): boolean {
    return this.records.has(id);
  }

  hasComment(id: string): boolean {
    return this.byComment.has(id);
  }

  // --- The wire -------------------------------------------------------------------------------

  private anchors(): Map<string, ThreadAnchor> {
    return new Map(
      this.host
        .room()
        .threadAnchors()
        .map((a) => [a.id, a]),
    );
  }

  private commentWire(c: CommentRecord): Comment {
    return {
      id: c.id,
      author: principal(c.author),
      createdAt: formatTimestamp(c.createdAt),
      editedAt: c.editedAt === null ? null : formatTimestamp(c.editedAt),
      etag: tagOfComment(c),
      body: c.body.map((p) => ({ ...p })),
    };
  }

  private threadWire(t: ThreadRecord, a: ThreadAnchor | undefined): Thread {
    const wire: Thread = {
      id: t.id,
      state: t.state,
      assignee: t.assignee,
      createdBy: principal(t.createdBy),
      createdAt: formatTimestamp(t.createdAt),
      etag: tagOfThread(t),
      comments: t.comments.map((c) => this.commentWire(c)),
    };
    if (a) {
      const at = a.seq + this.host.offset();
      wire.target =
        'range' in a.target
          ? { range: { from: a.target.range.from, to: a.target.range.to, baseSeq: at } }
          : { block: a.target.block };
    }
    return wire;
  }

  /** What a thread notice carries: the state, the seq, and the range or the block (05 §5.6). */
  private noticeData(t: ThreadRecord, a: ThreadAnchor | undefined): Record<string, unknown> {
    const data: Record<string, unknown> = { state: t.state, seq: this.host.head() };
    if (!a) return data;
    if ('range' in a.target) {
      // The positions refer to the room's durable head, which is the seq the notice names.
      data['seq'] = a.seq + this.host.offset();
      data['range'] = { from: a.target.range.from, to: a.target.range.to };
    } else data['block'] = a.target.block;
    return data;
  }

  private canRead(c: Connection, id: string): boolean {
    return this.host.room().threadAccess(id, c, 'read').ok;
  }

  private announce(
    type: string,
    resource: string,
    data: Record<string, unknown>,
    readable: (c: Connection) => boolean,
  ): void {
    this.host.notify({ type, resource, data }, readable);
  }

  private readable(c: Connection, id: string): ThreadRecord {
    const t = this.records.get(id);
    if (!t || !this.canRead(c, id)) throw new PortError('not_found', 'no such thread');
    return t;
  }

  /** The right to do `action` on a thread, as the room decides it. */
  private allow(
    c: Connection,
    id: string,
    action: 'reply' | 'resolve' | 'reopen' | 'assign' | 'delete',
  ): void {
    const out = this.host.room().threadAccess(id, c, action);
    if (!out.ok) throw refusal(out);
  }

  // --- The port -------------------------------------------------------------------------------

  list(
    c: Connection,
    query: Query<'listThreads'> | undefined,
  ): { items: Thread[]; nextCursor: string | null; seq: number } {
    const head = this.host.head();
    if (query?.seq !== undefined && query.seq > head)
      throw new PortError('validation_failed', `seq is beyond the head (${head})`);
    const limit = Math.max(1, Math.min(query?.limit ?? PAGE, 1000));
    const anchors = this.anchors();
    const after = query?.cursor;
    const ids = [...this.records.keys()].sort();
    const items: Thread[] = [];
    let last: string | null = null;
    let more = false;
    for (const id of ids) {
      if (after !== undefined && id <= after) continue;
      if (!this.canRead(c, id)) continue;
      if (items.length === limit) {
        more = true;
        break;
      }
      items.push(this.threadWire(this.records.get(id)!, anchors.get(id)));
      last = id;
    }
    return { items, nextCursor: more ? last : null, seq: head };
  }

  create(c: Connection, body: Body<'createThread'>): Tagged<Thread> {
    const comment = parseInput(body.comment, '/comment');
    const target = body.target;
    const room = this.host.room();
    const id = uuid7(this.host.now());
    // The request names an external seq; the room counts from the start of its segment.
    const roomTarget =
      'range' in target
        ? { range: { ...target.range, baseSeq: target.range.baseSeq - this.host.offset() } }
        : target;
    if ('range' in roomTarget && roomTarget.range.baseSeq < 0)
      throw refusal({
        ok: false,
        code: 'stale_base',
        reason: 'the baseSeq lies before the content now served',
      });
    const out = room.createThread({ id, as: c, target: roomTarget });
    if (!out.ok) throw refusal(out);
    const now = this.host.now();
    const t: ThreadRecord = {
      id,
      createdBy: c.sub,
      createdAt: now,
      state: 'open',
      assignee: null,
      comments: [{ id: uuid7(now), author: c.sub, body: comment, createdAt: now, editedAt: null }],
    };
    this.records.set(id, t);
    this.byComment.set(t.comments[0]!.id, id);
    const a = this.anchors().get(id);
    this.announce('thread.created', `/threads/${id}`, this.noticeData(t, a), (x) =>
      this.canRead(x, id),
    );
    return { value: this.threadWire(t, a), etag: tagOfThread(t) };
  }

  get(c: Connection, id: string): Tagged<Thread> {
    const t = this.readable(c, id);
    return { value: this.threadWire(t, this.anchors().get(id)), etag: tagOfThread(t) };
  }

  update(c: Connection, id: string, patch: Body<'updateThread'>, ifMatch: string): Tagged<Thread> {
    const t = this.readable(c, id);
    if (ifMatch !== tagOfThread(t))
      throw new PortError('precondition_failed', 'the thread changed (If-Match)');
    if (patch.state !== undefined && patch.state !== 'open' && patch.state !== 'resolved')
      throw new PortError('validation_failed', 'state is open or resolved');
    if (
      patch.assignee !== undefined &&
      patch.assignee !== null &&
      typeof patch.assignee !== 'string'
    )
      throw new PortError('validation_failed', 'assignee is a principal or null');
    const state = patch.state;
    const changesState = state !== undefined && state !== t.state;
    const changesAssignee = patch.assignee !== undefined && patch.assignee !== t.assignee;
    if (changesState) this.allow(c, id, state === 'resolved' ? 'resolve' : 'reopen');
    if (changesAssignee) this.allow(c, id, 'assign');
    if (!changesState && !changesAssignee) this.allow(c, id, 'reply');
    if (changesState) t.state = state!;
    if (changesAssignee) t.assignee = patch.assignee ?? null;
    const a = this.anchors().get(id);
    const readable = (x: Connection): boolean => this.canRead(x, id);
    if (changesState)
      this.announce(
        state === 'resolved' ? 'thread.resolved' : 'thread.reopened',
        `/threads/${id}`,
        this.noticeData(t, a),
        readable,
      );
    if (changesAssignee)
      this.announce('thread.updated', `/threads/${id}`, this.noticeData(t, a), readable);
    return { value: this.threadWire(t, a), etag: tagOfThread(t) };
  }

  remove(c: Connection, id: string, ifMatch: string | undefined): void {
    const t = this.readable(c, id);
    if (ifMatch !== undefined && ifMatch !== tagOfThread(t))
      throw new PortError('precondition_failed', 'the thread changed (If-Match)');
    this.allow(c, id, 'delete');
    const a = this.anchors().get(id);
    const data = this.noticeData(t, a);
    // The readers are chosen while the thread is still known to the room.
    this.announce('thread.deleted', `/threads/${id}`, data, (x) => this.canRead(x, id));
    this.host.room().deleteThread(id);
    for (const cm of t.comments) this.byComment.delete(cm.id);
    this.records.delete(id);
  }

  reply(c: Connection, tid: string, body: Body<'createComment'>): Tagged<Comment> {
    const t = this.readable(c, tid);
    this.allow(c, tid, 'reply');
    const parts = parseInput(body, '/body');
    const now = this.host.now();
    const rec: CommentRecord = {
      id: uuid7(now),
      author: c.sub,
      body: parts,
      createdAt: now,
      editedAt: null,
    };
    t.comments.push(rec);
    this.byComment.set(rec.id, tid);
    this.announce('comment.created', `/comments/${rec.id}`, { thread: tid }, (x) =>
      this.canRead(x, tid),
    );
    return { value: this.commentWire(rec), etag: tagOfComment(rec) };
  }

  /** A live comment and its thread, for a reader; anything else is `not_found`. */
  private findComment(c: Connection, cid: string): { t: ThreadRecord; rec: CommentRecord } {
    const tid = this.byComment.get(cid);
    const t = tid === undefined ? undefined : this.records.get(tid);
    if (!t || !this.canRead(c, t.id)) throw new PortError('not_found', 'no such comment');
    const rec = t.comments.find((x) => x.id === cid);
    if (!rec) throw new PortError('not_found', 'no such comment');
    return { t, rec };
  }

  /** The author of a comment, or `manage`, may change it (05 §6.2). */
  private mayChange(c: Connection, t: ThreadRecord, rec: CommentRecord): void {
    this.allow(c, t.id, 'reply');
    // The mock grants `manage` to the owner role, as the backend's other manage checks do.
    if (rec.author !== c.sub && c.role !== 'owner')
      throw new PortError('forbidden', 'a comment is changed by its author or `manage`');
  }

  editComment(
    c: Connection,
    cid: string,
    body: Body<'updateComment'>,
    ifMatch: string,
  ): Tagged<Comment> {
    const { t, rec } = this.findComment(c, cid);
    if (ifMatch !== tagOfComment(rec))
      throw new PortError('precondition_failed', 'the comment changed (If-Match)');
    this.mayChange(c, t, rec);
    rec.body = parseInput(body, '/body');
    rec.editedAt = Math.max(this.host.now(), (rec.editedAt ?? 0) + 1);
    this.announce('comment.updated', `/comments/${cid}`, { thread: t.id }, (x) =>
      this.canRead(x, t.id),
    );
    return { value: this.commentWire(rec), etag: tagOfComment(rec) };
  }

  removeComment(c: Connection, cid: string, ifMatch: string | undefined): void {
    const { t, rec } = this.findComment(c, cid);
    if (ifMatch !== undefined && ifMatch !== tagOfComment(rec))
      throw new PortError('precondition_failed', 'the comment changed (If-Match)');
    this.mayChange(c, t, rec);
    t.comments = t.comments.filter((x) => x.id !== cid);
    this.byComment.delete(cid);
    this.announce('comment.deleted', `/comments/${cid}`, { thread: t.id }, (x) =>
      this.canRead(x, t.id),
    );
  }
}
