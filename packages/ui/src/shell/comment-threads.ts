/**
 * Thread state rules for the comments pane and its commands (UX-029 criteria 3, 4 and 6; UX-030
 * criterion 1; UX-032 criteria 1 and 2; UX-034 criteria 1 and 3). Pure functions: nothing here
 * draws, sends, stores or announces anything. The controls, the live refresh, the scroll and
 * highlight, and the clipboard write are not built; the core and the service own the requests.
 *
 * Capability checks use the capabilities the core reports for the thread's scope (07 section 12:
 * "resolve, reopen or assign a thread: `comment` in its scope").
 */
import type { Capability } from '../core-api.ts';
import type { ThreadState } from './comment-rules.ts';

/* ----- resolve and reopen (UX-029 criterion 3) ----- */

export type ThreadRefusal = 'noComment';

export type StateChange<T> =
  | { readonly ok: true; readonly thread: T }
  | { readonly ok: false; readonly reason: ThreadRefusal };

/**
 * Resolve or reopen a thread: needs `comment` in its scope; otherwise the thread is returned
 * unchanged with the refusal. Returns a new object; the input is not changed.
 */
export function setThreadState<T extends { readonly state: ThreadState }>(
  thread: T,
  next: ThreadState,
  caps: readonly Capability[],
): StateChange<T> {
  if (!caps.includes('comment')) return { ok: false, reason: 'noComment' };
  return { ok: true, thread: { ...thread, state: next } };
}

/* ----- the commented range: detached threads (UX-029 criterion 4; ADR 0015) ----- */

/** A thread's anchor: a half-open text range, or detached once the commented text was removed. */
export type Anchor =
  | { readonly status: 'attached'; readonly from: number; readonly to: number }
  | { readonly status: 'detached' };

/** A removal of the old text `[from, to)`. Removal-only: an edit is a removal and an insertion. */
export interface Removal {
  readonly from: number;
  readonly to: number;
}

/** An insertion of `length` characters at `at`. */
export interface Insertion {
  readonly at: number;
  readonly length: number;
}

function mapRemoval(p: number, r: Removal): number {
  if (p <= r.from) return p;
  if (p >= r.to) return p - (r.to - r.from);
  return r.from;
}

/**
 * The anchor after a removal. A range that was not empty and is empty after the removal is
 * detached, and detached is final: nothing here re-attaches it (UX-029 criterion 4). An empty
 * range is never detached by a removal, since it had no text to lose.
 */
export function anchorAfterRemoval(anchor: Anchor, removal: Removal): Anchor {
  if (anchor.status === 'detached') return anchor;
  const from = mapRemoval(anchor.from, removal);
  const to = mapRemoval(anchor.to, removal);
  if (anchor.from < anchor.to && from === to) return { status: 'detached' };
  return { status: 'attached', from, to };
}

/** The anchor after an insertion. A detached anchor stays detached. */
export function anchorAfterInsertion(anchor: Anchor, insertion: Insertion): Anchor {
  if (anchor.status === 'detached') return anchor;
  const from = insertion.at <= anchor.from ? anchor.from + insertion.length : anchor.from;
  const to = insertion.at < anchor.to ? anchor.to + insertion.length : anchor.to;
  return { status: 'attached', from, to };
}

/**
 * Undo restores the document text, not the anchor. The anchor is passed back unchanged, so a
 * detached thread stays detached when the deletion is undone (UX-029 criterion 4).
 */
export function anchorAfterUndo(anchor: Anchor): Anchor {
  return anchor;
}

/* ----- write outcomes and the If-Match conflict (UX-029 criterion 6) ----- */

export type WriteOutcome<S, D> =
  | { readonly kind: 'saved'; readonly latest: S }
  | { readonly kind: 'conflict'; readonly shown: S; readonly draft: D };

/** The error code the core uses when `If-Match` fails (core-api.ts, GrantsService.save). */
export const PRECONDITION_FAILED = 'precondition_failed';

/**
 * The outcome of a write. A failed `If-Match` shows the latest state the service returned and keeps
 * the user's draft untouched; any other failure is not this function's to decide and is rethrown.
 */
export function writeOutcome<S, D>(
  draft: D,
  attempt:
    | { readonly ok: true; readonly latest: S }
    | { readonly ok: false; readonly code: string; readonly latest?: S },
): WriteOutcome<S, D> {
  if (attempt.ok) return { kind: 'saved', latest: attempt.latest };
  if (attempt.code !== PRECONDITION_FAILED || attempt.latest === undefined) {
    throw new Error(`write failed: ${attempt.code}`);
  }
  return { kind: 'conflict', shown: attempt.latest, draft };
}

/* ----- the pane's rows (UX-030 criterion 1, and the accessible name of criterion 6) ----- */

export type TargetInput =
  | { readonly range: { readonly from: number; readonly to: number; readonly baseSeq: number } }
  | { readonly block: string };

export interface ThreadInput {
  readonly id: string;
  readonly position: number;
  readonly state: ThreadState;
  readonly author: string;
  readonly createdAt: string;
  readonly replyCount: number;
  readonly target: TargetInput;
  /** The commented text, when the target is a range and the text is still there. */
  readonly excerpt: string | null;
  /** The block kind (figure, table, equation, ...), when the target is a block. */
  readonly blockKind: string | null;
}

export type TargetLabel =
  | { readonly kind: 'excerpt'; readonly text: string }
  | { readonly kind: 'block'; readonly blockKind: string }
  | { readonly kind: 'detached' };

/** One pane row. The strings are not built here: the shell's text comes from the string tables. */
export interface PaneRow {
  readonly id: string;
  readonly author: string;
  readonly createdAt: string;
  readonly state: ThreadState;
  readonly replyCount: number;
  readonly target: TargetLabel;
  /** The parts a screen reader name is made from (UX-030 criterion 6): author, state, replies. */
  readonly accessibleName: {
    readonly author: string;
    readonly state: ThreadState;
    readonly replyCount: number;
  };
}

function targetLabel(t: ThreadInput): TargetLabel {
  if ('block' in t.target) {
    return t.blockKind === null ? { kind: 'detached' } : { kind: 'block', blockKind: t.blockKind };
  }
  return t.excerpt === null ? { kind: 'detached' } : { kind: 'excerpt', text: t.excerpt };
}

/**
 * The rows the pane lists, in document order (`position`; ties keep the caller's order). A
 * thread with neither excerpt nor block kind is shown as detached rather than dropped.
 */
export function paneRows(threads: readonly ThreadInput[]): PaneRow[] {
  return threads
    .map((t, index) => ({ t, index }))
    .sort((a, b) => a.t.position - b.t.position || a.index - b.index)
    .map(({ t }) => ({
      id: t.id,
      author: t.author,
      createdAt: t.createdAt,
      state: t.state,
      replyCount: t.replyCount,
      target: targetLabel(t),
      accessibleName: { author: t.author, state: t.state, replyCount: t.replyCount },
    }));
}

/* ----- what changed in the list (UX-030 criterion 4: the change is announced) ----- */

export interface ChangeInput {
  readonly id: string;
  readonly state: ThreadState;
  readonly author: string;
  readonly replyCount: number;
}

/** What one refresh of the list changed, as a kind and the person it names. */
export interface ThreadChange {
  readonly kind: 'created' | 'reply' | 'resolved' | 'reopened' | 'deleted';
  /** The thread's author, which is who a created, resolved or reopened announcement names. */
  readonly author: string;
}

/**
 * Compares the list the pane showed with the list it reads now, and says what changed, one change
 * first: a new thread, then a reply, a state change, a deletion. Null when nothing the pane shows
 * changed. The strings come from the string tables; this only picks the kind.
 */
export function describeThreadChange(
  before: readonly ChangeInput[],
  after: readonly ChangeInput[],
): ThreadChange | null {
  const was = new Map(before.map((t) => [t.id, t]));
  const now = new Map(after.map((t) => [t.id, t]));
  for (const t of after) if (!was.has(t.id)) return { kind: 'created', author: t.author };
  for (const t of after) {
    const old = was.get(t.id);
    if (old && t.replyCount > old.replyCount) return { kind: 'reply', author: t.author };
  }
  for (const t of after) {
    const old = was.get(t.id);
    if (old && t.state !== old.state) {
      return { kind: t.state === 'resolved' ? 'resolved' : 'reopened', author: t.author };
    }
  }
  for (const t of before) if (!now.has(t.id)) return { kind: 'deleted', author: t.author };
  return null;
}

/* ----- assignment (UX-032 criteria 1 and 2) ----- */

export interface AssignEvent {
  readonly type: 'dep.task.assigned';
  readonly threadId: string;
  readonly assignee: string;
}

export interface AssignedThread {
  readonly id: string;
  readonly assignee: string | null;
}

export type AssignResult<T> =
  | { readonly ok: true; readonly thread: T; readonly event: AssignEvent | null }
  | { readonly ok: false; readonly reason: ThreadRefusal };

/**
 * Assign, reassign or clear a thread's assignee. Needs `comment` in its scope. Setting an assignee
 * that differs from the current one returns the `dep.task.assigned` event to send; setting the same
 * assignee, or clearing one, returns no event (clearing has no event name in 05 section 7: open,
 * see the notes of UX-032). `assignee` is a principal the caller found with `searchPrincipals`.
 */
export function assignThread<T extends AssignedThread>(
  thread: T,
  assignee: string | null,
  caps: readonly Capability[],
): AssignResult<T> {
  if (!caps.includes('comment')) return { ok: false, reason: 'noComment' };
  const changed = thread.assignee !== assignee;
  const next = { ...thread, assignee };
  const event: AssignEvent | null =
    assignee !== null && changed
      ? { type: 'dep.task.assigned', threadId: thread.id, assignee }
      : null;
  return { ok: true, thread: next, event };
}

/* ----- links to a comment (UX-034 criteria 1 and 3) ----- */

/** What the editor hands the host: the two identifiers, and nothing else. The host returns the address. */
export interface CommentLinkRequest {
  readonly document: string;
  readonly comment: string;
}

/** The request for a comment's link, or null when an identifier is empty. The editor builds no address. */
export function commentLinkRequest(document: string, comment: string): CommentLinkRequest | null {
  if (document.length === 0 || comment.length === 0) return null;
  return { document, comment };
}

export type LinkLookup =
  | {
      readonly status: 'visible';
      readonly thread: {
        readonly id: string;
        readonly author: string;
        readonly createdAt: string;
        readonly state: ThreadState;
      };
    }
  | { readonly status: 'deleted' }
  | { readonly status: 'forbidden' };

export type LinkOutcome =
  | {
      readonly kind: 'open';
      readonly thread: {
        readonly id: string;
        readonly author: string;
        readonly createdAt: string;
        readonly state: ThreadState;
      };
    }
  | { readonly kind: 'unavailable' };

/**
 * What following a link does. A deleted comment and a comment the user cannot view give the same
 * `unavailable` result, with no thread data, so nothing else is revealed (UX-034 criterion 3). The
 * shell shows the message; the text is not decided here.
 */
export function resolveCommentLink(lookup: LinkLookup): LinkOutcome {
  if (lookup.status === 'visible') return { kind: 'open', thread: lookup.thread };
  return { kind: 'unavailable' };
}
