/**
 * Accepting and rejecting block-level suggestions (FE-047 criterion 4; 02 §5.2; 03 §5; CDM-040). The
 * text pass of `suggestion-resolve.ts` leaves node marks alone; this module plans and applies them.
 * The meaning follows the same P4 baseline as the text pass, applied to a block (a paragraph, a whole
 * table row or a whole table):
 * - `ins` accepted: the mark goes and the block stays; rejected: the block is removed.
 * - `del` accepted: the block is removed; rejected: the mark goes and the block stays.
 * - `fmt` accepted: the mark goes and the new attributes stay; rejected: the attributes return to the
 *   `before` recorded on the mark (`{ attrs: { style, align, list } }`, CDM-040).
 *
 * Decisions taken here, not in the spec (see the story Notes and docs/adr/0132-engine-3-backlog-batch.md):
 * - a block removed by an accepted `del` or a rejected `ins` takes its contents, and every suggestion
 *   mark inside it, with it; those marks are counted as resolved and the text pass leaves them alone;
 * - a block inside a removed block is not handled on its own; it goes with its parent;
 * - with several `fmt` marks on one block, the last one in the block's mark order gives `before`, as
 *   the text pass does for text (`recordedMarks`);
 * - the block must lie wholly inside the resolve range, so a selection that only overlaps a paragraph
 *   does not resolve its block marks.
 *
 * Pure: it plans from an editor state and applies to a transaction the caller builds. The positions
 * of the plan are those of the state the plan was made from; `applyBlockPlan` maps them through the
 * transaction's earlier steps. Universal logic over ProseMirror state only.
 */
import type { Mark, Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { ResolveAction, ResolveScope } from './suggestion-resolve-types.ts';

/** The block types that may carry suggestion node marks in version 1 (CDM-040). */
const BLOCK_TYPES: ReadonlySet<string> = new Set(['paragraph', 'table_row', 'table']);
const SUGGESTION_TYPES: ReadonlySet<string> = new Set(['ins', 'del', 'fmt']);

/** One block's operation: removal, or the removal of its marks with an optional restore. */
export interface BlockOp {
  /** Start of the block in the planned state. */
  readonly pos: number;
  /** End of the block in the planned state (`pos + nodeSize`). */
  readonly end: number;
  /** Whether the block goes. Its marks and contents go with it. */
  readonly removes: boolean;
  /** The suggestion marks taken off the block (empty when the block goes). */
  readonly marks: readonly Mark[];
  /** The attributes to set back to `before` (rejected `fmt` only), or null. */
  readonly restore: Readonly<Record<string, unknown>> | null;
}

export interface BlockPlan {
  /** The operations, last block first, so applying them keeps earlier positions valid. */
  readonly ops: readonly BlockOp[];
  /** The ranges of removed blocks, in the planned state; text inside them is not handled alone. */
  readonly claimed: readonly { readonly from: number; readonly to: number }[];
  /** Suggestion marks resolved by the plan (blocks, and the marks inside removed blocks). */
  readonly handled: number;
  /** Suggestion marks left alone because the user lacks `edit` in the block's scope. */
  readonly skipped: number;
}

const isSuggestion = (m: Mark): boolean => SUGGESTION_TYPES.has(m.type.name);

/** The `before` attributes recorded on an `fmt` mark, or null when it records none. */
function recordedAttrs(mark: Mark): Readonly<Record<string, unknown>> | null {
  const before: unknown = mark.attrs['before'];
  if (before === null || typeof before !== 'object') return null;
  const attrs: unknown = (before as { attrs?: unknown }).attrs;
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) return null;
  return attrs as Record<string, unknown>;
}

/** Plans the block suggestions of `scope` for `action`. Makes no change to the state. */
export function planBlockSuggestions(
  state: EditorState,
  action: ResolveAction,
  scope: ResolveScope,
): BlockPlan {
  const mineOf = (node: PMNode): Mark[] =>
    node.marks.filter(
      (m) => isSuggestion(m) && (scope.author === undefined || m.attrs['user'] === scope.author),
    );
  const found: { pos: number; node: PMNode }[] = [];
  state.doc.nodesBetween(scope.from, scope.to, (node, pos) => {
    const end = pos + node.nodeSize;
    if (node.isBlock && BLOCK_TYPES.has(node.type.name) && scope.from <= pos && end <= scope.to)
      found.push({ pos, node });
    return true;
  });
  found.sort((a, b) => a.pos - b.pos);

  const ops: BlockOp[] = [];
  const claimed: { from: number; to: number }[] = [];
  let handled = 0;
  let skipped = 0;
  for (const { pos, node } of found) {
    if (claimed.some((c) => pos >= c.from && pos < c.to)) continue;
    const mine = mineOf(node);
    if (mine.length === 0) continue;
    const end = pos + node.nodeSize;
    if (scope.editable && !scope.editable(pos, end)) {
      skipped += mine.length;
      continue;
    }
    const removes = mine.some(
      (m) =>
        (m.type.name === 'ins' && action === 'reject') ||
        (m.type.name === 'del' && action === 'accept'),
    );
    if (removes) {
      let inside = 0;
      node.descendants((child) => {
        inside += mineOf(child).length;
        return true;
      });
      handled += mine.length + inside;
      claimed.push({ from: pos, to: end });
      ops.push({ pos, end, removes: true, marks: [], restore: null });
      continue;
    }
    handled += mine.length;
    const fmts = mine.filter((m) => m.type.name === 'fmt');
    const last = fmts[fmts.length - 1];
    const restore = action === 'reject' && last !== undefined ? recordedAttrs(last) : null;
    ops.push({ pos, end, removes: false, marks: mine, restore });
  }
  ops.sort((a, b) => b.pos - a.pos);
  return { ops, claimed, handled, skipped };
}

/**
 * Applies a plan to `tr`, which must have been made from the state the plan was made from (its earlier
 * steps may have changed text). Each position is mapped through the steps already in `tr`.
 */
export function applyBlockPlan(tr: Transaction, plan: BlockPlan): void {
  for (const op of plan.ops) {
    const from = tr.mapping.map(op.pos, 1);
    if (op.removes) {
      tr.delete(from, tr.mapping.map(op.end, -1));
      continue;
    }
    if (op.restore) {
      for (const [attr, value] of Object.entries(op.restore))
        if (value !== undefined) tr.setNodeAttribute(from, attr, value);
    }
    for (const mark of op.marks) tr.removeNodeMark(from, mark);
  }
}
