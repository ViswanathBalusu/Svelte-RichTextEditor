/**
 * The shell's thread service over the backend's comments port (05 §6.2; ADR 0015; ADR 0417; UX-028
 * to UX-032, UX-037; FE-048). The shell reads threads, comments and tags from here and never calls the
 * network; this file is the one place where the wire shapes meet the shell's.
 *
 * - The threads come from `GET /documents/{id}/threads`. The service tells a reader only the threads
 *   it may see (ADR 0019), so this file filters nothing.
 * - A `thread.*` or `comment.*` notice makes the service read that thread again, and the shell's
 *   `changes` moves, so a reply or a state change of another client shows without a reload.
 * - Where a thread lies in the document, and what the reader may do there, come from the editing
 *   core (`threadPlacement`, `commentAnchor`): the core maps each range through every change.
 * - Every write is a request to a thread or a comment resource. None makes a commit (13 §5).
 */
import type { CommentsPort, Comment as WireComment, Thread as WireThread } from '@docedit/protocol';
import { PortError } from '@docedit/protocol';
import type { DocumentCore } from '@docedit/engine';
import type {
  Capability,
  CommentAnchor,
  CommentBodyPart,
  CommentView,
  ReactionName,
  ReadView,
  ThreadDetail,
  ThreadOutcome,
  ThreadRequest,
  ThreadSummary,
  ThreadsService,
  ThreadWrite,
} from '@docedit/ui';

export interface ThreadsSource {
  readonly port: CommentsPort;
  readonly docId: string;
  /** The signed-in user's identifier, as the service names authors (`user:<id>`), or null. */
  readonly self: () => string | null;
  /** Whether the backend announced the feature 
eactions (UX-033); without it no reaction is offered. */
  readonly reactions?: boolean;
  /**
   * Called when the user asks for a comment's link (UX-034; owner decision 88): the element raises
   * de-comment-link-request and the host builds the address. Absent: no control is offered.
   */
  readonly onLinkRequest?: (request: { thread: string; comment: string }) => void;
}

/** A thread as the service last gave it. */
interface Held {
  thread: WireThread;
}

const PAGE = 100;

/** The code the shell reads for a refusal of the backend (05 §5.8; UX-028 criterion 3). */
function codeOf(e: unknown): string {
  if (!(e instanceof PortError)) return 'unavailable';
  if (e.code === 'forbidden') return 'permission_denied';
  if (e.code === 'validation_failed') {
    const violations = (e.details?.['violations'] ?? []) as ReadonlyArray<{ path?: unknown }>;
    if (violations.some((v) => typeof v.path === 'string' && v.path.endsWith('/baseSeq')))
      return 'stale_base';
  }
  return e.code;
}

const toParts = (body: readonly CommentBodyPart[]): WireComment['body'] =>
  body.map((p) =>
    p.type === 'text'
      ? { type: 'text' as const, text: p.text }
      : { type: 'mention' as const, principal: p.principal },
  );

/** The part of the editing core the thread service reads and calls. */
export type ThreadsCore = Pick<
  DocumentCore,
  | 'threadRanges'
  | 'threadBlocks'
  | 'onThreadNotice'
  | 'threadPlacement'
  | 'commentAnchor'
  | 'createThread'
  | 'selectThread'
  | 'pickedThread'
>;

/** The thread service, and the element's way to say what became of the address the host gave. */
export type ElementThreads = ThreadsService & { linkResult(ok: boolean): void };

export function threadsService(core: ThreadsCore, source: ThreadsSource): ElementThreads {
  const { port, docId } = source;
  const held = new Map<string, Held>();
  const listeners = new Set<() => void>();
  let version = 0;
  let generation = 0;

  const bump = (): void => {
    version++;
    for (const listener of [...listeners]) listener();
  };

  // The shell's `changes` also moves when the core moves a range or places a thread: the pane lists
  // threads in document order and shows the commented words.
  const changes: ReadView<number> = {
    get: () => version,
    subscribe(listener) {
      listeners.add(listener);
      const stops = [core.threadRanges.subscribe(listener), core.threadBlocks.subscribe(listener)];
      return () => {
        listeners.delete(listener);
        for (const stop of stops) stop();
      };
    },
  };

  /** Lists every page and replaces what is held. A listing that a newer one overtook is dropped. */
  const load = async (): Promise<void> => {
    const mine = ++generation;
    const all: WireThread[] = [];
    let cursor: string | undefined;
    try {
      for (;;) {
        const page = await port.threads(docId, {
          limit: PAGE,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        all.push(...page.items);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
    } catch {
      // The core reports a failed listing as a problem; the pane shows what it has.
      return;
    }
    if (mine !== generation) return;
    held.clear();
    for (const thread of all) held.set(thread.id, { thread });
    bump();
  };

  /** Reads one thread again after a notice or a write; a thread that is gone is dropped. */
  const refresh = async (id: string): Promise<WireThread | null> => {
    try {
      const { value, etag } = await port.thread(id);
      const thread = { ...value, etag: value.etag === '' ? etag : value.etag };
      held.set(id, { thread });
      bump();
      return thread;
    } catch (e) {
      if (e instanceof PortError && (e.code === 'not_found' || e.code === 'forbidden')) {
        if (held.delete(id)) bump();
      }
      return null;
    }
  };

  core.onThreadNotice((n) => {
    if (n.type === 'thread.deleted') {
      const id = /^\/threads\/([^/]+)$/.exec(n.resource)?.[1];
      if (id !== undefined && held.delete(id)) bump();
      return;
    }
    const id =
      n.type.startsWith('comment.') && typeof n.data?.['thread'] === 'string'
        ? n.data['thread']
        : /^\/threads\/([^/]+)$/.exec(n.resource)?.[1];
    if (id !== undefined) void refresh(id);
  });
  // The core clears its copy of the thread ranges when it replaces the document; read the list again.
  void load();

  const principal = (): string => source.self() ?? '';

  const commentView = (c: WireComment): CommentView => ({
    id: c.id,
    author: c.author,
    createdAt: c.createdAt,
    body: c.body.map((p) => ({ ...p })),
    edited: c.editedAt !== null,
    ...(c.reactions && c.reactions.length > 0
      ? { reactions: c.reactions.map((r) => ({ reaction: r.reaction, users: [...r.users] })) }
      : {}),
  });

  const detailOf = (id: string): ThreadDetail | null => {
    const h = held.get(id);
    if (!h) return null;
    const t = h.thread;
    const place = core.threadPlacement(id);
    const collapsed =
      t.target !== undefined && 'range' in t.target && t.target.range.from === t.target.range.to;
    return {
      id: t.id,
      state: t.state,
      author: t.createdBy,
      detached: place?.detached ?? collapsed,
      assignee: t.assignee ?? null,
      caps: (place?.caps ?? ['view']) as readonly Capability[],
      comments: t.comments.map(commentView),
      etag: t.etag,
    };
  };

  /** The answer to a write: the thread as it is now, or the refusal with the latest thread. */
  const failed = async (id: string, e: unknown): Promise<ThreadWrite> => {
    const code = codeOf(e);
    if (code === 'precondition_failed' || code === 'conflict') {
      await refresh(id);
      const latest = detailOf(id);
      return latest ? { ok: false, code, latest } : { ok: false, code };
    }
    return { ok: false, code };
  };

  const written = async (id: string): Promise<ThreadWrite> => {
    await refresh(id);
    const detail = detailOf(id);
    return detail ? { ok: true, detail } : { ok: false, code: 'not_found' };
  };

  const commentOf = (id: string, commentId: string): WireComment | undefined =>
    held.get(id)?.thread.comments.find((c) => c.id === commentId);

  const summaryOf = (t: WireThread): ThreadSummary => {
    const place = core.threadPlacement(t.id);
    const target: ThreadRequest['target'] = t.target === undefined ? { block: '' } : t.target;
    return {
      id: t.id,
      position: place?.position ?? Number.MAX_SAFE_INTEGER,
      state: t.state,
      author: t.createdBy,
      createdAt: t.createdAt,
      replyCount: Math.max(0, t.comments.length - 1),
      assignee: t.assignee ?? null,
      target,
      excerpt: place?.excerpt ?? null,
      blockKind: place?.blockKind ?? null,
    };
  };

  let copies = 0;
  const linkListeners = new Set<() => void>();
  let lastCopy: { n: number; ok: boolean } | null = null;
  const linkCopied: ReadView<{ n: number; ok: boolean } | null> = {
    get: () => lastCopy,
    subscribe(listener) {
      linkListeners.add(listener);
      return () => void linkListeners.delete(listener);
    },
  };

  return {
    self: principal,
    // The address of a comment is the host's to build (owner decision 88); this asks for it.
    ...(source.onLinkRequest
      ? {
          requestLink(id: string, commentId: string) {
            if (!commentOf(id, commentId)) return false;
            source.onLinkRequest?.({ thread: id, comment: commentId });
            return true;
          },
          linkCopied,
        }
      : {}),
    linkResult(ok: boolean) {
      lastCopy = { n: ++copies, ok };
      for (const listener of [...linkListeners]) listener();
    },
    changes,
    reveal(thread) {
      const t = held.get(thread.id)?.thread.target;
      const block = t !== undefined && 'block' in t ? t.block : null;
      core.selectThread({ id: thread.id, block });
    },
    picked: core.pickedThread,
    detail: detailOf,

    async reply(id, body) {
      try {
        await port.reply(id, { body: toParts(body) });
        return await written(id);
      } catch (e) {
        return failed(id, e);
      }
    },

    async editComment(id, commentId, body) {
      const c = commentOf(id, commentId);
      if (!c) return { ok: false, code: 'not_found' };
      try {
        await port.updateComment(commentId, { body: toParts(body) }, { ifMatch: c.etag });
        return await written(id);
      } catch (e) {
        return failed(id, e);
      }
    },

    async deleteComment(id, commentId) {
      const c = commentOf(id, commentId);
      if (!c) return { ok: false, code: 'not_found' };
      try {
        await port.deleteComment(commentId, { ifMatch: c.etag });
        return await written(id);
      } catch (e) {
        return failed(id, e);
      }
    },

    // A reaction (UX-033): idempotent, no tag, no commit; the notice comment.reacted makes every
    // client, this one included, read the thread again.
    ...(source.reactions
      ? {
          async react(id: string, commentId: string, reaction: ReactionName, on: boolean) {
            if (!commentOf(id, commentId)) return { ok: false as const, code: 'not_found' };
            try {
              await (on
                ? port.addReaction(commentId, reaction)
                : port.removeReaction(commentId, reaction));
              return await written(id);
            } catch (e) {
              return failed(id, e);
            }
          },
        }
      : {}),

    async deleteThread(id, etag) {
      try {
        await port.deleteThread(id, etag === '' ? {} : { ifMatch: etag });
        if (held.delete(id)) bump();
        return { ok: true };
      } catch (e) {
        return { ok: false, code: codeOf(e) };
      }
    },

    async setState(id, state, etag) {
      try {
        await port.updateThread(id, { state }, { ifMatch: etag });
        return await written(id);
      } catch (e) {
        return failed(id, e);
      }
    },

    async assign(id, assignee, etag) {
      try {
        await port.updateThread(id, { assignee }, { ifMatch: etag });
        return await written(id);
      } catch (e) {
        return failed(id, e);
      }
    },

    anchor(): CommentAnchor | null {
      return core.commentAnchor();
    },

    count: () => held.size,

    list: () => [...held.values()].map((h) => summaryOf(h.thread)),

    async create(request): Promise<ThreadOutcome> {
      try {
        const id = await core.createThread(request.target, { body: toParts(request.body) });
        await refresh(id);
        return { ok: true, id };
      } catch (e) {
        return { ok: false, code: codeOf(e) };
      }
    },
  };
}
