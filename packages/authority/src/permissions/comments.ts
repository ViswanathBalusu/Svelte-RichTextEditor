/**
 * Who may do what with a comment thread (07 §6, §12 rows 4 and 5; PRM-037 to PRM-040; ADR 0050
 * item 6). The room supplies the scopes a thread covers now; these rules decide.
 *
 * - Creating a thread and replying need `comment` in every scope the target covers.
 * - Resolving, reopening and assigning need `comment` in every scope the target covers: 07 §12
 *   says "its scope", and a thread can span several, so the strictest reading is taken.
 * - Deleting a thread needs `comment` there and, besides, its author or `manage`; editing or
 *   deleting a comment needs that comment's author or `manage`.
 * - Nothing moves or re-points a thread (07 §6): a change of target is refused for everyone.
 * - A thread the caller cannot see (its target lies where they lack `view`, a hidden region under
 *   ADR 0019) is `not_found`, never `permission_denied`, so that its existence is not revealed.
 * - On an archived document every change is refused with `read_only`; a locked document and an
 *   approved region still take comments, since commenting never changes the document.
 */
import type { Access } from './access.ts';
import type { Capability } from './model.ts';

export type ThreadAction =
  'create' | 'reply' | 'resolve' | 'reopen' | 'assign' | 'delete' | 'retarget' | 'read';

export type ThreadDecision =
  | { ok: true }
  | {
      ok: false;
      code: 'permission_denied' | 'not_found' | 'read_only';
      reason: string;
      scopes?: string[];
    };

/** The capabilities of a connection in one scope; `doc`, `defs` and stories share theirs (07 §4). */
export function capsInScope(a: Access, scope: string): ReadonlySet<Capability> {
  if (scope === 'body') return a.body;
  if (scope.startsWith('region:')) return a.regions.get(scope.slice(7)) ?? new Set<Capability>();
  return a.structureScopes;
}

export interface ThreadContext {
  access: Access;
  /** The caller. */
  user: string;
  /** The scopes the thread's target covers now (or covered when it was last attached). */
  scopes: readonly string[];
  /** The thread's author (for `delete`). */
  author?: string;
  /** Whether the document is archived (07 §4 limit 1). */
  archived: boolean;
}

export function authoriseThread(action: ThreadAction, c: ThreadContext): ThreadDecision {
  const lacking = (cap: Capability) => c.scopes.filter((s) => !capsInScope(c.access, s).has(cap));
  if (c.scopes.length === 0 || lacking('view').length)
    return { ok: false, code: 'not_found', reason: 'no such thread' };
  if (action === 'read') return { ok: true };
  if (action === 'retarget')
    return {
      ok: false,
      code: 'permission_denied',
      reason: 'no route moves or re-points a thread (07 §6)',
    };
  if (c.archived) return { ok: false, code: 'read_only', reason: 'the document is archived' };
  const missing = lacking('comment');
  if (missing.length)
    return {
      ok: false,
      code: 'permission_denied',
      reason: 'needs `comment` in every scope the thread covers (07 §12)',
      scopes: missing,
    };
  if (action === 'delete' && c.author !== c.user && !c.access.docRole.has('manage'))
    return {
      ok: false,
      code: 'permission_denied',
      reason: 'deleting a thread needs its author or `manage` (07 §12)',
    };
  return { ok: true };
}

/** Editing or deleting one comment: its author or `manage` (05 §6.2; 07 §12 row 5). */
export function authoriseComment(
  c: ThreadContext & { commentAuthor: string },
  action: 'edit' | 'delete',
): ThreadDecision {
  const base = authoriseThread('reply', c);
  if (!base.ok) return base;
  if (c.commentAuthor !== c.user && !c.access.docRole.has('manage'))
    return {
      ok: false,
      code: 'permission_denied',
      reason: `${action === 'edit' ? 'editing' : 'deleting'} a comment needs its author or \`manage\``,
    };
  return { ok: true };
}
