/**
 * The target a new comment thread is created with (UX-028 criterion 2; 05 §6.2 `target`; ADR 0015).
 *
 * A text range targets `{ range: { from, to, baseSeq } }`; a figure, table or equation selected as a
 * block targets `{ block: id }`. This module builds and checks that shape. It sends nothing and
 * creates no thread: the request is the core's and the service's.
 *
 * The 5,000-thread limit (UX-028 criterion 5) is a gate here only. The spec does not name the error
 * code for it; the code `threadLimit` is the editor's working name (ADR 0233, open).
 */

/** The most threads one document may hold (UX-028 criterion 5; the number is the story's). */
export const THREAD_LIMIT = 5000;

export type ThreadTarget =
  | { readonly range: { readonly from: number; readonly to: number; readonly baseSeq: number } }
  | { readonly block: string };

/** What the author selected: a text range with the sequence it was read at, or one block. */
export type TargetSelection =
  | { readonly kind: 'range'; readonly from: number; readonly to: number; readonly baseSeq: number }
  | { readonly kind: 'block'; readonly id: string };

export type TargetRefusal = 'badRange' | 'emptyBlock';

export type TargetResult =
  | { readonly ok: true; readonly target: ThreadTarget }
  | { readonly ok: false; readonly reason: TargetRefusal };

const isNonNegativeInteger = (n: number): boolean => Number.isInteger(n) && n >= 0;

/**
 * The target for a selection. A range needs whole, non-negative positions with `from <= to` and a
 * whole `baseSeq`; a block needs a non-empty identifier. The result holds exactly one of the two
 * keys, `range` or `block`, never both.
 */
export function threadTarget(selection: TargetSelection): TargetResult {
  if (selection.kind === 'block') {
    if (selection.id.length === 0) return { ok: false, reason: 'emptyBlock' };
    return { ok: true, target: { block: selection.id } };
  }
  const { from, to, baseSeq } = selection;
  if (!isNonNegativeInteger(from) || !isNonNegativeInteger(to) || from > to) {
    return { ok: false, reason: 'badRange' };
  }
  if (!isNonNegativeInteger(baseSeq)) return { ok: false, reason: 'badRange' };
  return { ok: true, target: { range: { from, to, baseSeq } } };
}

/**
 * Whether a document that already holds `threadCount` threads may take one more (UX-028
 * criterion 5). At the limit the creation is refused, with the code `threadLimit`.
 */
export function threadLimitGate(
  threadCount: number,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: 'threadLimit' } {
  if (!Number.isInteger(threadCount) || threadCount < 0) {
    return { allowed: false, reason: 'threadLimit' };
  }
  return threadCount < THREAD_LIMIT ? { allowed: true } : { allowed: false, reason: 'threadLimit' };
}
