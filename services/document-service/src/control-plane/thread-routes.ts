/**
 * The thread routes `POST /documents/{id}/threads`, `GET`, `PATCH` and `DELETE /threads/{tid}`,
 * `POST /threads/{tid}/comments` and `PATCH` and `DELETE /comments/{cid}` (05 section 6.2; 07
 * sections 6 and 12, rows 4 and 5; ADR 0015; PRO-059 criterion 1, PRO-060 criteria 1 to 5; lanes
 * U-PRO-052-068 and V-PRO-052-068).
 *
 * The rules are in `@docedit/authority` (`comments.ts`, `authoriseThread`). These handlers read the
 * block's scope and the permission state at the head, and ask those rules. A thread is never part
 * of the document: it writes rows in the thread store and sends notices, nothing else.
 *
 * Decided here, not in the published operations (docs/adr/0312-lane-U-PRO-052-068.md):
 * - a range target is mapped from its `baseSeq` to the head through the commits between them, as
 *   the room maps ranges (PRO-059 criterion 2); its base must lie within `maxRebaseSteps` of the
 *   head (the room's own limit, read from DEFAULT_LIMITS, since the control plane has no other);
 *   a range that lost all its text is refused. The head seq is stored as `range_seq`;
 * - a thread's scope is the scope of its block when the thread is made; it is not re-derived on
 *   each read (07 section 6: a detached thread keeps the scopes it covered);
 * - a user token that does not cover the thread's document gets `not_found`, so that a thread's
 *   existence is not revealed to another document's readers (the rule of comments.ts);
 * - a service credential has no author, so it cannot start a thread (`forbidden`, as for leases);
 *   it may read and delete a thread, since it passes every gate (gate.ts);
 * - a thread's ETag names its identifier, state and assignee (`"<id>:<state>:<assignee>"`), so a
 *   change of state or assignee changes it and a PATCH with a stale tag is refused (PRO-060
 *   criterion 2). A comment's ETag names its identifier and its last edit (PRO-060 criterion 5).
 * - a comment's author is the connection's `sub`, as the thread's first comment is; a service
 *   credential writes no comment and edits none, but may delete one, as it may delete a thread.
 * - a thread's state notice and webhook: `resolved` and `reopened` have both; an assignee change
 *   has the `thread.updated` notice, since webhooks have no `thread.updated` (gaps.ts), and, when it
 *   names a person, the `dep.task.assigned` webhook (UX-032 criterion 1).
 * - mentions (PRO-060 criterion 4): the mention nodes of a new comment, and of the first comment of
 *   a new thread, raise `dep.comment.mentioned` once for each distinct principal (mentions.ts,
 *   docs/adr/0375-w5-PRO-060-comment-mentions.md). An edit of a comment raises none.
 */
import {
  authoriseComment,
  authoriseThread,
  DEFAULT_LIMITS,
  mapRangesThrough,
  rangeScopes,
  type ThreadAction,
} from '@docedit/authority';
import type { JsonNode } from '@docedit/model';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import type { StoredComment, StoredTarget, StoredThread } from '../storage/thread-store.ts';
import type { DocRef } from '../storage/types.ts';
import { accessOf, connectionOn, refuseSeqBelowGate, regionInfosOfJson } from './gate.ts';
import { checkIfMatch, pageLimit, seqParam } from './http.ts';
import { json, type Kit } from './kit.ts';
import { mentionsOf } from './mentions.ts';
import type { Ctx, Handler, Reply } from './pipeline.ts';
import { ApiError } from './problems.ts';
import { readerView } from './visibility.ts';

/** The body of `POST /documents/{id}/threads` as this module reads it (05 section 6.2). */
interface CreateThreadBody {
  target: { block?: unknown; range?: unknown };
  comment: unknown;
}

/** The body of `PATCH /threads/{tid}` (05 section 6.2 `UpdateThreadRequest`). */
interface UpdateThreadBody {
  state?: unknown;
  assignee?: unknown;
}

/** The thread as the REST surface shows it: the `Thread` of 05 section 6.2. */
function threadBody(t: StoredThread, at?: { range: { from: number; to: number }; seq: number }) {
  // A range target carries the seq it refers to as `baseSeq` (`RangeTarget`, 05 section 6.2).
  const target =
    'range' in t.target
      ? {
          range: {
            from: (at?.range ?? t.target.range).from,
            to: (at?.range ?? t.target.range).to,
            baseSeq: at?.seq ?? t.rangeSeq ?? 0,
          },
        }
      : { block: t.target.block };
  return { id: t.id, state: t.state, assignee: t.assignee, target };
}

/** The scopes a thread covers: one, or several for a range (`StoredThread.scope`). */
const scopesOf = (t: StoredThread): string[] => t.scope.split('\n');

/** A range target `{ from, to, baseSeq }` as sent, or null when it is not one. */
function parseRange(raw: unknown): { from: number; to: number; baseSeq: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { from, to, baseSeq } = raw as Record<string, unknown>;
  const whole = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (!whole(from) || !whole(to) || !whole(baseSeq) || from > to) return null;
  return { from, to, baseSeq };
}

/** The comment as the REST surface shows it (05 section 6.2 `Comment`, a placeholder shape). */
function commentBody(c: StoredComment) {
  return { id: c.id, body: c.body };
}

const threadTag = (t: StoredThread): string =>
  `"${t.id}:${t.state}:${encodeURIComponent(t.assignee ?? '')}"`;

const commentTag = (c: StoredComment): string => `"${c.id}:${c.editedAt ?? 0}"`;

/**
 * The scope of the block `id` at the head: `region:<rid>` when the block lies in a region of the
 * body, `body` when it lies in the body outside any region, and null when no block holds `id`.
 * The body is the last top-level node, as `regionsOfJson` reads it.
 */
export function scopeOfBlock(doc: JsonNode, id: string): string | null {
  const top = (
    doc as {
      content?: Array<{ type: string; attrs?: Record<string, unknown>; content?: unknown[] }>;
    }
  ).content;
  const body = top?.[top.length - 1];
  type Node = { type: string; attrs?: Record<string, unknown>; content?: unknown[] };
  const holds = (node: Node): boolean => {
    if (node.attrs?.['id'] === id) return true;
    return ((node.content ?? []) as Node[]).some(holds);
  };
  for (const child of (body?.content ?? []) as Node[]) {
    if (child.type === 'region' && holds(child))
      return `region:${String(child.attrs?.['id'] ?? '')}`;
  }
  return body && holds(body) ? 'body' : null;
}

/** Turns a refused decision into the problem it names (07 section 12). */
function refusal(code: string, reason: string): ApiError {
  if (code === 'permission_denied') return new ApiError('forbidden', reason);
  if (code === 'not_found') return new ApiError('not_found', reason);
  // `read_only`: an archived document takes no change to its threads.
  return new ApiError('conflict', reason);
}

export function threadRoutes(k: Kit): Record<string, Handler> {
  const { d, refOf, liveDocument, emit } = k;

  const store = () => {
    const s = d.threads;
    if (!s) throw new ApiError('not_found', 'threads are not offered by this service');
    return s;
  };

  /** A thread of the caller's tenant, whatever its document; a missing one is `not_found`. */
  const readThread = async (ctx: Ctx, tid: string): Promise<StoredThread> => {
    const t = await store().get(ctx.caller.tenant, tid);
    if (!t) throw new ApiError('not_found', 'no such thread');
    // A user token that does not cover the document does not learn that the thread exists.
    if (ctx.caller.kind === 'user' && ctx.caller.identity!.docs[t.docId] === undefined)
      throw new ApiError('not_found', 'no such thread');
    return t;
  };

  /**
   * The caller's connection on a thread's document, its access at the head and whether the document
   * is archived. A service credential has no connection and no access (it passes every gate).
   */
  const contextOf = async (ctx: Ctx, t: StoredThread) => {
    const conn = connectionOn(ctx.caller, t.docId);
    const record = await liveDocument(ctx, t.docId);
    const archived = record.state === 'archived';
    if (!conn) return { conn: undefined, access: undefined, archived, hidden: false };
    const ref = refOf(ctx, t.docId);
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    const perms = await d.grants.current(ref);
    // A thread on a region the reader may not see is not found (ADR 0019; PRO-060 criterion 1).
    const view = readerView(d.views, conn, full.doc, perms);
    const hidden = scopesOf(t).some(
      (s) => s.startsWith('region:') && view.hidden.regions.has(s.slice('region:'.length)),
    );
    return {
      conn,
      access: accessOf(conn, regionInfosOfJson(full.doc), perms, d.now()),
      archived,
      hidden,
    };
  };

  /**
   * A thread in a region the caller cannot see is not found. The write routes call this before
   * `checkIfMatch`, so a missing or wrong `If-Match` (428, 412) does not tell a reader that the
   * thread or comment exists (ADR 0019; PRO-060 criterion 1).
   */
  const mustSee = async (ctx: Ctx, t: StoredThread, what: 'thread' | 'comment'): Promise<void> => {
    if ((await contextOf(ctx, t)).hidden) throw new ApiError('not_found', `no such ${what}`);
  };

  /** Checks an action on an existing thread against its scope at the head (07 section 12). */
  const decide = async (ctx: Ctx, t: StoredThread, action: ThreadAction): Promise<void> => {
    const c = await contextOf(ctx, t);
    if (c.hidden) throw new ApiError('not_found', 'no such thread');
    if (!c.conn || !c.access) return;
    const verdict = authoriseThread(action, {
      access: c.access,
      user: c.conn.sub,
      scopes: scopesOf(t),
      author: t.createdBy,
      archived: c.archived,
    });
    if (!verdict.ok) throw refusal(verdict.code, verdict.reason);
  };

  /** Checks editing or deleting one comment: its author or `manage` (05 section 6.2; 07 section 12). */
  const decideComment = async (
    ctx: Ctx,
    t: StoredThread,
    c: StoredComment,
    action: 'edit' | 'delete',
  ): Promise<void> => {
    const cx = await contextOf(ctx, t);
    if (cx.hidden) throw new ApiError('not_found', 'no such comment');
    if (!cx.conn || !cx.access) {
      // A service credential writes no comment, so it cannot edit one; it may delete one.
      if (action === 'edit')
        throw new ApiError('forbidden', 'a comment has an author; a user edits it');
      return;
    }
    const verdict = authoriseComment(
      {
        access: cx.access,
        user: cx.conn.sub,
        scopes: scopesOf(t),
        author: t.createdBy,
        archived: cx.archived,
        commentAuthor: c.author,
      },
      action,
    );
    if (!verdict.ok) throw refusal(verdict.code, verdict.reason);
  };

  /** A live comment and its thread; a deleted or unknown comment is `not_found`. */
  const readComment = async (
    ctx: Ctx,
    cid: string,
  ): Promise<{ t: StoredThread; c: StoredComment }> => {
    const loc = await store().findComment(ctx.caller.tenant, cid);
    if (!loc) throw new ApiError('not_found', 'no such comment');
    // A comment of a thread the caller cannot see answers as an unknown comment does, not as a
    // thread (SEC-016 criterion 4: a refusal and a missing identifier look the same).
    const t = await readThread(ctx, loc.threadId).catch((e: unknown) => {
      if (e instanceof ApiError && e.code === 'not_found')
        throw new ApiError('not_found', 'no such comment');
      throw e;
    });
    const c = t.comments.find((x) => x.id === cid);
    if (!c) throw new ApiError('not_found', 'no such comment');
    return { t, c };
  };

  /**
   * Where a target lies at the head. A block is found by its identifier. A range is mapped from its
   * `baseSeq` to the head through the commits between them (SYN-032; `mapRangesThrough`); its base
   * must be no further back than the room's rebase window, and a range whose text was all deleted
   * is refused, since a thread on nothing is not made (PRO-059 criterion 2).
   */
  const placeTarget = async (
    ref: DocRef,
    headSeq: number,
    doc: JsonNode,
    raw: CreateThreadBody['target'],
  ): Promise<{ scopes: string[]; target: StoredTarget; rangeSeq: number | null }> => {
    const block = raw.block;
    if (typeof block === 'string' && block !== '') {
      const scope = scopeOfBlock(doc, block);
      if (scope === null) throw new ApiError('not_found', `no block ${block} at the head`);
      return { scopes: [scope], target: { block }, rangeSeq: null };
    }
    const range = parseRange(raw.range);
    if (range === null)
      throw new ApiError('validation_failed', 'the target is a block or a range with a baseSeq', {
        violations: [{ path: '/target', rule: 'a block identifier or { from, to, baseSeq }' }],
      });
    if (range.baseSeq > headSeq)
      throw new ApiError('validation_failed', 'the baseSeq is above the head', {
        violations: [{ path: '/target/range/baseSeq', rule: `at most ${headSeq}` }],
      });
    const window = d.rebaseWindow ?? DEFAULT_LIMITS.maxRebaseSteps;
    if (headSeq - range.baseSeq > window)
      throw new ApiError('validation_failed', 'the baseSeq is outside the rebase window', {
        violations: [{ path: '/target/range/baseSeq', rule: `within ${window} steps of the head` }],
      });
    const between =
      range.baseSeq < headSeq ? await d.logs.read(ref, range.baseSeq + 1, headSeq) : [];
    const commits = between.map((c) => ({ kind: c.kind, steps: 'steps' in c ? c.steps : [] }));
    const schema = cdmSchema();
    const [mapped] = mapRangesThrough([{ from: range.from, to: range.to }], commits, schema);
    if (mapped === undefined || (mapped.collapsed && range.from < range.to))
      throw new ApiError('validation_failed', 'the range no longer lies in the document', {
        violations: [{ path: '/target/range', rule: 'text still in the document' }],
      });
    return {
      scopes: rangeScopes(schema.nodeFromJSON(doc), mapped.from, mapped.to),
      target: { range: { from: mapped.from, to: mapped.to } },
      rangeSeq: headSeq,
    };
  };

  /**
   * `dep.comment.mentioned` once for each distinct principal a comment body mentions (PRO-060
   * criterion 4; 13 §5): the host sends the notification. The data names the principal as the
   * mention node holds it, `user:<sub>` or `group:<id>`.
   */
  const raiseMentions = (
    ctx: Ctx,
    doc: string,
    comment: string,
    thread: string,
    body: unknown,
    seq: number,
  ): void => {
    for (const principal of mentionsOf(body))
      emit(ctx, 'dep.comment.mentioned', doc, { comment, thread, principal, seq });
  };

  const createThread: Handler = async (ctx): Promise<Reply> => {
    const doc = ctx.params['id']!;
    const s = store();
    const conn = connectionOn(ctx.caller, doc);
    if (!conn) throw new ApiError('forbidden', 'a thread has an author; a user starts it');
    const body = (await ctx.body()) as CreateThreadBody;
    const record = await liveDocument(ctx, doc);
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    const full = await d.content.rebuild(ref, head.incarnation, head.seq);
    const placed = await placeTarget(ref, head.seq, full.doc, body.target);
    const perms = await d.grants.current(ref);
    const verdict = authoriseThread('create', {
      access: accessOf(conn, regionInfosOfJson(full.doc), perms, d.now()),
      user: conn.sub,
      scopes: placed.scopes,
      archived: record.state === 'archived',
    });
    if (!verdict.ok) throw refusal(verdict.code, verdict.reason);

    const now = d.now();
    const thread = await s.create(ref, {
      id: uuid7(now),
      scope: placed.scopes.join('\n'),
      target: placed.target,
      rangeSeq: placed.rangeSeq,
      createdBy: conn.sub,
      createdAt: now,
      comment: {
        id: uuid7(now),
        author: conn.sub,
        body: body.comment,
        createdAt: now,
        editedAt: null,
      },
    });
    emit(ctx, 'dep.thread.created', doc, { thread: thread.id, seq: head.seq });
    raiseMentions(ctx, doc, thread.comments[0]?.id ?? '', thread.id, body.comment, head.seq);
    const told = await eventOf(ctx.caller.tenant, thread);
    k.notify()?.(
      ref,
      { type: 'thread.created', resource: `/threads/${thread.id}`, data: told.data },
      { scopes: told.scopes },
    );
    return json(201, threadBody(thread), { ETag: threadTag(thread), 'Cache-Control': 'no-store' });
  };

  /**
   * What a thread event tells a channel (PRO-036 criterion 2; SYN-032): the thread's state, the
   * head `seq`, and for a range thread its range at that `seq`, mapped from the seq it was made
   * at, so that the client can place the decoration without a fetch. A block thread names its
   * block. The scopes go with the notice, so that a region the reader cannot see is not announced.
   */
  const eventOf = async (
    tenant: string,
    t: StoredThread,
  ): Promise<{ data: Record<string, unknown>; scopes: string[] }> => {
    const ref: DocRef = { tenant, doc: t.docId };
    const head = await d.logs.head(ref);
    const data: Record<string, unknown> = { state: t.state, seq: head.seq };
    if ('range' in t.target && t.rangeSeq !== null) {
      const between = t.rangeSeq < head.seq ? await d.logs.read(ref, t.rangeSeq + 1, head.seq) : [];
      const through = between.map((c) => ({ kind: c.kind, steps: 'steps' in c ? c.steps : [] }));
      const [mapped] = mapRangesThrough([t.target.range], through, cdmSchema());
      data['range'] = { from: mapped!.from, to: mapped!.to };
    } else if ('block' in t.target) data['block'] = t.target.block;
    return { data, scopes: scopesOf(t) };
  };

  /**
   * `GET /documents/{id}/threads?seq=` (05 section 6.2; PRO-059 criterion 4): the threads the
   * caller may read, with each range mapped from the seq it was made at to `seq` (the head when
   * absent) through the commits between them (SYN-032). A thread made after `seq` did not exist at
   * it and is left out. A range whose text was deleted by then comes back empty (`from` equals
   * `to`), which a client shows as detached. Threads in a region the caller cannot see are left
   * out, as in `getThread`.
   */
  const listThreads: Handler = async (ctx): Promise<Reply> => {
    const doc = ctx.params['id']!;
    const s = store();
    const record = await liveDocument(ctx, doc);
    if (ctx.caller.kind === 'user' && ctx.caller.identity!.docs[doc] === undefined)
      throw new ApiError('not_found', 'no such document');
    const ref = refOf(ctx, doc);
    const head = await d.logs.head(ref);
    const asked = seqParam(ctx.url, 'seq');
    const seq = asked ?? head.seq;
    if (seq > head.seq)
      throw new ApiError('validation_failed', `seq is beyond the head (${head.seq})`, {
        violations: [{ path: 'seq', rule: 'at most the head' }],
      });
    // The threads at a state reveal where text was, so a `seq` below the gate is refused (PRM-042).
    await refuseSeqBelowGate(d, ctx.caller, ref, record, head.seq, seq);
    const limit = pageLimit(ctx.url);
    const cursor = ctx.url.searchParams.get('cursor');
    const after = cursor !== null ? d.cursors.open(`threads/${doc}`, cursor) : undefined;
    const page = await s.list(ref, { ...(after !== undefined ? { after } : {}), limit });

    // The commits the ranges are mapped through: from the oldest range seq on this page.
    const from = Math.min(
      seq,
      ...page.flatMap((t) => (t.rangeSeq !== null && 'range' in t.target ? [t.rangeSeq] : [])),
    );
    const commits = from < seq ? await d.logs.read(ref, from + 1, seq) : [];
    const schema = cdmSchema();

    const items: ReturnType<typeof threadBody>[] = [];
    for (const t of page) {
      if ((await contextOf(ctx, t)).hidden) continue;
      if (!('range' in t.target) || t.rangeSeq === null) {
        items.push(threadBody(t));
        continue;
      }
      if (t.rangeSeq > seq) continue;
      const through = commits
        .filter((c) => c.seq > t.rangeSeq! && c.seq <= seq)
        .map((c) => ({ kind: c.kind, steps: 'steps' in c ? c.steps : [] }));
      const [mapped] = mapRangesThrough([t.target.range], through, schema);
      items.push(threadBody(t, { range: { from: mapped!.from, to: mapped!.to }, seq }));
    }
    const last = page[page.length - 1];
    return json(
      200,
      {
        items,
        nextCursor:
          page.length === limit && last ? d.cursors.issue(`threads/${doc}`, last.id) : null,
        seq,
      },
      { 'Cache-Control': 'private, no-cache' },
    );
  };

  const getThread: Handler = async (ctx): Promise<Reply> => {
    const t = await readThread(ctx, ctx.params['tid']!);
    await decide(ctx, t, 'read');
    return json(200, threadBody(t), { ETag: threadTag(t), 'Cache-Control': 'no-store' });
  };

  const deleteThread: Handler = async (ctx): Promise<Reply> => {
    const t = await readThread(ctx, ctx.params['tid']!);
    await decide(ctx, t, 'delete');
    const removed = await store().delete(ctx.caller.tenant, t.id);
    if (!removed) throw new ApiError('not_found', 'no such thread');
    // Every webhook carries the content head `seq` (05 §7; PRO-073 criterion 1, lane V-PRO-069-085).
    emit(ctx, 'dep.thread.deleted', t.docId, {
      thread: t.id,
      seq: (await d.logs.head(refOf(ctx, t.docId))).seq,
    });
    const told = await eventOf(ctx.caller.tenant, t);
    k.notify()?.(
      { tenant: ctx.caller.tenant, doc: t.docId },
      { type: 'thread.deleted', resource: `/threads/${t.id}`, data: told.data },
      { scopes: told.scopes },
    );
    return { status: 204, headers: { 'Cache-Control': 'no-store' } };
  };

  /** `PATCH /threads/{tid}`: a state or an assignee change, with `If-Match` (PRO-060 criterion 2). */
  const updateThread: Handler = async (ctx): Promise<Reply> => {
    const t = await readThread(ctx, ctx.params['tid']!);
    await mustSee(ctx, t, 'thread');
    checkIfMatch(ctx.req, threadTag(t));
    const body = (await ctx.body()) as UpdateThreadBody;
    const state = body.state === 'open' || body.state === 'resolved' ? body.state : undefined;
    if (body.state !== undefined && state === undefined)
      throw new ApiError('validation_failed', 'state is open or resolved', {
        violations: [{ path: '/state', rule: 'open or resolved' }],
      });
    if (body.assignee !== undefined && body.assignee !== null && typeof body.assignee !== 'string')
      throw new ApiError('validation_failed', 'assignee is a principal or null', {
        violations: [{ path: '/assignee', rule: 'a string or null' }],
      });
    const changesState = state !== undefined && state !== t.state;
    const changesAssignee = body.assignee !== undefined && body.assignee !== t.assignee;

    // Each change needs its own right: resolving, reopening and assigning all need `comment`.
    const actions: ThreadAction[] = [];
    if (changesState) actions.push(state === 'resolved' ? 'resolve' : 'reopen');
    if (changesAssignee) actions.push('assign');
    if (actions.length === 0) actions.push('reply');
    for (const a of actions) await decide(ctx, t, a);

    const conn = connectionOn(ctx.caller, t.docId);
    const updated = await store().update(ctx.caller.tenant, t.id, {
      ...(changesState ? { state } : {}),
      ...(changesAssignee ? { assignee: body.assignee as string | null } : {}),
      by: conn?.sub ?? null,
      at: d.now(),
    });
    if (!updated) throw new ApiError('not_found', 'no such thread');
    const scope = { tenant: ctx.caller.tenant, doc: t.docId };
    if (changesState) {
      emit(ctx, state === 'resolved' ? 'dep.thread.resolved' : 'dep.thread.reopened', t.docId, {
        thread: t.id,
        seq: (await d.logs.head(refOf(ctx, t.docId))).seq,
      });
      const told = await eventOf(ctx.caller.tenant, updated);
      k.notify()?.(
        scope,
        {
          type: state === 'resolved' ? 'thread.resolved' : 'thread.reopened',
          resource: `/threads/${t.id}`,
          data: told.data,
        },
        { scopes: told.scopes },
      );
    }
    if (changesAssignee) {
      const told = await eventOf(ctx.caller.tenant, updated);
      k.notify()?.(
        scope,
        { type: 'thread.updated', resource: `/threads/${t.id}`, data: told.data },
        { scopes: told.scopes },
      );
      // A thread given to a person is a task: the host sends the notification (UX-032 criterion 1;
      // 05 section 7). Clearing the assignee raises nothing, as 05 names no event for it.
      if (typeof body.assignee === 'string')
        emit(ctx, 'dep.task.assigned', t.docId, {
          thread: t.id,
          assignee: body.assignee,
          seq: (await d.logs.head(refOf(ctx, t.docId))).seq,
        });
    }
    return json(200, threadBody(updated), {
      ETag: threadTag(updated),
      'Cache-Control': 'no-store',
    });
  };

  /** `POST /threads/{tid}/comments`: a reply to a thread, by a user with `comment` (PRO-060 criterion 4). */
  const createComment: Handler = async (ctx): Promise<Reply> => {
    const t = await readThread(ctx, ctx.params['tid']!);
    const conn = connectionOn(ctx.caller, t.docId);
    if (!conn) throw new ApiError('forbidden', 'a comment has an author; a user writes it');
    await decide(ctx, t, 'reply');
    const now = d.now();
    const comment: StoredComment = {
      id: uuid7(now),
      author: conn.sub,
      body: await ctx.body(),
      createdAt: now,
      editedAt: null,
    };
    const added = await store().addComment(ctx.caller.tenant, t.id, comment);
    if (!added) throw new ApiError('not_found', 'no such thread');
    const seq = (await d.logs.head(refOf(ctx, t.docId))).seq;
    emit(ctx, 'dep.comment.created', t.docId, { comment: comment.id, thread: t.id, seq });
    raiseMentions(ctx, t.docId, comment.id, t.id, comment.body, seq);
    k.notify()?.(
      { tenant: ctx.caller.tenant, doc: t.docId },
      { type: 'comment.created', resource: `/comments/${comment.id}`, data: { thread: t.id } },
      { scopes: scopesOf(t) },
    );
    return json(201, commentBody(comment), {
      ETag: commentTag(comment),
      'Cache-Control': 'no-store',
    });
  };

  /** `PATCH /comments/{cid}`: an edit by the author or `manage`, with `If-Match` (PRO-060 criterion 5). */
  const updateComment: Handler = async (ctx): Promise<Reply> => {
    const { t, c } = await readComment(ctx, ctx.params['cid']!);
    await mustSee(ctx, t, 'comment');
    checkIfMatch(ctx.req, commentTag(c));
    await decideComment(ctx, t, c, 'edit');
    const updated = await store().editComment(ctx.caller.tenant, c.id, await ctx.body(), d.now());
    if (!updated) throw new ApiError('not_found', 'no such comment');
    k.notify()?.(
      { tenant: ctx.caller.tenant, doc: t.docId },
      { type: 'comment.updated', resource: `/comments/${c.id}`, data: { thread: t.id } },
      { scopes: scopesOf(t) },
    );
    return json(200, commentBody(updated), {
      ETag: commentTag(updated),
      'Cache-Control': 'no-store',
    });
  };

  /** `DELETE /comments/{cid}`: a soft delete by the author or `manage` (PRO-060 criterion 5). */
  const deleteComment: Handler = async (ctx): Promise<Reply> => {
    const { t, c } = await readComment(ctx, ctx.params['cid']!);
    await mustSee(ctx, t, 'comment');
    checkIfMatch(ctx.req, commentTag(c), false);
    await decideComment(ctx, t, c, 'delete');
    const removed = await store().deleteComment(ctx.caller.tenant, c.id);
    if (!removed) throw new ApiError('not_found', 'no such comment');
    k.notify()?.(
      { tenant: ctx.caller.tenant, doc: t.docId },
      { type: 'comment.deleted', resource: `/comments/${c.id}`, data: { thread: t.id } },
      { scopes: scopesOf(t) },
    );
    return { status: 204, headers: { 'Cache-Control': 'no-store' } };
  };

  return {
    listThreads,
    createThread,
    getThread,
    deleteThread,
    updateThread,
    createComment,
    updateComment,
    deleteComment,
  };
}
