/**
 * The controller that creates a comment thread (UX-028 criterion 2, with the refusal rules of
 * criteria 3 and 5; 05 §6.2; 07 §12; ADR 0015).
 *
 * It decides whether the comment command is offered for the scopes a selection covers, builds the
 * thread's target and first comment, and keeps the typed text when a refusal comes back. It sends
 * nothing itself: the comment command (`review.comment`, `commands/builtin.ts`) opens the comment
 * box (`components/CommentBox.svelte`), which calls `createCommentThread` and then the core's
 * `threads.create`. The document's `thread.created` event and the highlight belong to the core.
 *
 * Commenting does not read the document's state (locked, approved, workflow). The rule takes the
 * capabilities of each covered scope and nothing else, so a locked document keeps its comment command
 * when the scope grants `comment` (UX-028 criterion 4 is the core's to confirm).
 */
import type { Capability } from '../core-api.ts';
import { canReply, type Decision } from './comment-rules.ts';
import {
  threadLimitGate,
  threadTarget,
  type TargetSelection,
  type ThreadTarget,
} from './thread-target.ts';

/** Why a thread is not created. The draft is always kept by the caller on any of these. */
export type CreateRefusal =
  | 'noComment'
  | 'badRange'
  | 'emptyBlock'
  | 'emptyBody'
  | 'threadLimit'
  | 'permissionsChanged'
  | 'baseSeqOutOfWindow';

export type CreateResult =
  | { readonly ok: true; readonly target: ThreadTarget; readonly body: string }
  | { readonly ok: false; readonly reason: CreateRefusal; readonly draft: string };

export interface CreateInput {
  readonly selection: TargetSelection;
  /** The capabilities of each scope the selection covers (07 §12: `comment` in every such scope). */
  readonly scopes: ReadonlyArray<readonly Capability[]>;
  /** The threads the document holds now. */
  readonly threadCount: number;
  /** The first comment, as typed. */
  readonly draft: string;
}

/**
 * Whether the comment command is offered for a selection: `comment` must hold in every covered
 * scope, and a selection that covers no scope is refused (UX-028 criterion 3). The reason is
 * `noComment`; the shell shows it beside the disabled command.
 */
export function commentCommandDecision(scopes: ReadonlyArray<readonly Capability[]>): Decision {
  if (scopes.length === 0) return { allowed: false, reason: 'noComment' };
  for (const caps of scopes) {
    const decision = canReply(caps);
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}

/**
 * Creates the request for a new thread, or the reason it is refused. The checks run in this order:
 * the command's scopes, the thread limit (UX-028 criterion 5), the target (criterion 2), then the
 * first comment, which must not be empty. The input is not changed.
 */
export function createCommentThread(input: CreateInput): CreateResult {
  const { draft } = input;
  const offered = commentCommandDecision(input.scopes);
  if (!offered.allowed) return { ok: false, reason: 'noComment', draft };
  const limit = threadLimitGate(input.threadCount);
  if (!limit.allowed) return { ok: false, reason: 'threadLimit', draft };
  const target = threadTarget(input.selection);
  if (!target.ok) return { ok: false, reason: target.reason, draft };
  if (draft.trim().length === 0) return { ok: false, reason: 'emptyBody', draft };
  return { ok: true, target: target.target, body: draft };
}

/**
 * The server refused the request the core sent (permissions changed, or `baseSeq` outside the rebase
 * window; UX-028 criterion 3). The typed text is returned unchanged with the reason.
 */
export function refuseFromServer(
  draft: string,
  reason: 'permissionsChanged' | 'baseSeqOutOfWindow',
): { readonly ok: false; readonly reason: CreateRefusal; readonly draft: string } {
  return { ok: false, reason, draft };
}

/**
 * The refusal for a code the service answered a thread request with (05 §5.8): `permission_denied`
 * means the permissions changed, `stale_base` that `baseSeq` is outside the rebase window. The
 * 5,000-thread limit is refused by the room with `quota_exceeded` (05 §5.8; PRM-040 criterion 2),
 * which is `threadLimit` here; `threadLimit` itself is kept as the editor's working name. Any other
 * code is `failed`. The typed text is kept in every case.
 */
export function serverRefusal(code: string): CreateRefusal | 'failed' {
  if (code === 'permission_denied') return 'permissionsChanged';
  if (code === 'stale_base') return 'baseSeqOutOfWindow';
  if (code === 'threadLimit' || code === 'quota_exceeded') return 'threadLimit';
  return 'failed';
}

/**
 * The state of the comment command for the current selection (UX-028 criterion 3): no anchor
 * (nothing that can carry a thread is selected) gives `noCommentTarget`; otherwise the rule of
 * `commentCommandDecision`.
 */
export function commentCommandState(
  anchor: { readonly scopes: ReadonlyArray<readonly Capability[]> } | null,
):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'noComment' | 'noCommentTarget' } {
  if (anchor === null) return { allowed: false, reason: 'noCommentTarget' };
  const decision = commentCommandDecision(anchor.scopes);
  return decision.allowed ? { allowed: true } : { allowed: false, reason: 'noComment' };
}
