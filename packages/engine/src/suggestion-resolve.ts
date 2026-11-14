/**
 * Accepting and rejecting text suggestions (FE-047; 02 §5.2; 03 §5). A pure transaction builder: it
 * reads an editor state and returns the transaction that resolves the suggestion marks in a range,
 * so the caller decides when to dispatch it. Everything in the range is one transaction, so it is
 * one atomic commit (FE-047 criterion 5).
 *
 * The meaning follows the baseline of the authority's P4 (`permissions/suggestions.ts`):
 * - `ins` accepted: the mark goes and the text stays; rejected: the text goes.
 * - `del` accepted: the text goes; rejected: the mark goes and the text stays.
 * - `fmt` accepted: the mark goes and the formatting stays; rejected: the formatting returns to the
 *   `before` recorded on the mark.
 *
 * Block-level marks (FE-047 criterion 4) sit on nodes, not on text: `suggestion-resolve-block.ts` plans
 * them, and this function applies that plan to the same transaction.
 * Permission (criterion 6) is the caller's: `editable` says whether the text may change, and a
 * suggestion where it may not is skipped and counted. `DocumentCore.resolveSuggestions` is that
 * caller: it asks for the user's `edit` in the scope and dispatches the transaction as one commit.
 * The authority still checks every commit.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */
import type { Mark } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { applyBlockPlan, planBlockSuggestions } from './suggestion-resolve-block.ts';
import type { ResolveAction, ResolveScope } from './suggestion-resolve-types.ts';

export type { ResolveAction, ResolveScope } from './suggestion-resolve-types.ts';

/**
 * Where "all" applies (FE-047 criterion 5): the selection, the whole document, or the block or
 * region with this identifier.
 */
export type SuggestionTarget = 'selection' | 'document' | { readonly id: string };

/** What the core's accept or reject did (FE-047 criteria 5 and 6). */
export interface SuggestionReport {
  /** Suggestion marks resolved by the commit. */
  readonly handled: number;
  /** Suggestion marks left alone because the user lacks `edit` in their scope. */
  readonly skipped: number;
  /** The scopes where suggestions were skipped, sorted. */
  readonly skippedScopes: readonly string[];
}

export interface ResolveResult {
  /** The transaction; it has no steps when nothing in the range was a suggestion. */
  readonly tr: Transaction;
  /** Suggestion marks resolved by the transaction. */
  readonly handled: number;
  /** Suggestion marks left alone because the text was not editable (FE-047 criterion 6). */
  readonly skipped: number;
}

const SUGGESTION_TYPES: ReadonlySet<string> = new Set(['ins', 'del', 'fmt']);

interface Segment {
  readonly from: number;
  readonly to: number;
  /** Every mark on the text, suggestion or not. */
  readonly marks: readonly Mark[];
  /** The suggestion marks in the scope's author filter. */
  readonly mine: readonly Mark[];
}

const isSuggestion = (m: Mark): boolean => SUGGESTION_TYPES.has(m.type.name);

/**
 * The marks recorded in the `before` of the last `fmt` mark that records any (03 §5), as the
 * baseline's `headOf` takes them, or undefined when none does: `before` may be null or record
 * only attributes.
 */
function recordedMarks(fmts: readonly Mark[]): readonly unknown[] | undefined {
  let found: readonly unknown[] | undefined;
  for (const m of fmts) {
    const before: unknown = m.attrs['before'];
    if (before === null || typeof before !== 'object') continue;
    const marks: unknown = (before as { marks?: unknown }).marks;
    if (Array.isArray(marks)) found = marks as readonly unknown[];
  }
  return found;
}

/**
 * Builds the transaction that accepts or rejects the suggestions in `scope`. Segments are processed
 * from the end of the document backwards, so the positions of the earlier ones stay valid.
 */
export function resolveSuggestions(
  state: EditorState,
  action: ResolveAction,
  scope: ResolveScope,
): ResolveResult {
  const segments: Segment[] = [];
  state.doc.nodesBetween(scope.from, scope.to, (node, pos) => {
    if (!node.isText) return true;
    const from = Math.max(pos, scope.from);
    const to = Math.min(pos + node.nodeSize, scope.to);
    if (from >= to) return false;
    const mine = node.marks.filter(
      (m) => isSuggestion(m) && (scope.author === undefined || m.attrs['user'] === scope.author),
    );
    if (mine.length > 0) segments.push({ from, to, marks: node.marks, mine });
    return false;
  });
  segments.sort((a, b) => b.from - a.from);

  const tr = state.tr;
  // Block suggestions (FE-047 criterion 4): their counts, and the text inside the blocks they remove.
  const blocks = planBlockSuggestions(state, action, scope);
  let handled = blocks.handled;
  let skipped = blocks.skipped;
  for (const seg of segments) {
    if (blocks.claimed.some((c) => seg.from >= c.from && seg.to <= c.to)) continue;
    const mine = seg.mine;
    if (scope.editable && !scope.editable(seg.from, seg.to)) {
      skipped += mine.length;
      continue;
    }
    handled += mine.length;
    // Accepting a deletion or rejecting an insertion removes the text; the other marks on it go with it.
    const removesText = mine.some(
      (m) =>
        (m.type.name === 'ins' && action === 'reject') ||
        (m.type.name === 'del' && action === 'accept'),
    );
    if (removesText) {
      tr.delete(seg.from, seg.to);
      continue;
    }
    // Rejecting a `fmt` whose `before` records marks puts those marks back in place of the direct
    // formatting, as the baseline does (P4, `headOf`). A `before` that is null or records only
    // attributes leaves the text's formatting unchanged: only the suggestion mark goes.
    const beforeMarks =
      action === 'reject' ? recordedMarks(mine.filter((m) => m.type.name === 'fmt')) : undefined;
    if (beforeMarks !== undefined) {
      for (const m of seg.marks) if (!isSuggestion(m)) tr.removeMark(seg.from, seg.to, m.type);
      for (const m of mine) tr.removeMark(seg.from, seg.to, m);
      for (const json of beforeMarks) {
        tr.addMark(seg.from, seg.to, state.schema.markFromJSON(json as Record<string, unknown>));
      }
      continue;
    }
    for (const m of mine) tr.removeMark(seg.from, seg.to, m);
  }
  applyBlockPlan(tr, blocks);
  return { tr, handled, skipped };
}
