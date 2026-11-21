/**
 * The comment range decorations of the body (FE-048 criteria 1 and 5; 02 §5.2).
 *
 * A thread's range is drawn as an inline decoration over its text on every draw, from the ranges the
 * core holds (`DocumentCore.threadRanges`, mapped through every change by `comment-ranges.ts`). The
 * document is never changed to draw it. A detached thread (its text was deleted, so the range has
 * collapsed) has no width and draws nothing: its decoration disappears (FE-048 criterion 5).
 *
 * The class is the cue that is not colour: the stylesheet draws a dotted underline for it, and a
 * dashed outline for a block (element.css). The thread's identifier is in `data-thread-id`, so the threads UI can reach it.
 *
 * This module imports `prosemirror-view` for `Decoration` only; it builds no DOM. The web view passes
 * `commentDecorations` into its `decorations` prop (view/web.ts).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';

/** The class of a thread's range over its text. The element's style sheet names it. */
export const COMMENT_RANGE_CLASS = 'de-comment-range';

/** The class of a thread on a block (a figure, a table or an equation): a dashed outline, not colour alone. */
export const COMMENT_BLOCK_CLASS = 'de-comment-block';

/** The class of the thread the comments pane chose (UX-030); a heavier line, not a colour alone. */
export const COMMENT_SELECTED_CLASS = 'de-comment-selected';

/** The thread chosen in the comments pane: its id, and the block it targets when it has no range. */
export interface ThreadSelection {
  readonly id: string;
  readonly block: string | null;
}

/** A thread range as the core holds it: the thread, its range in document positions, and detached. */
export interface CommentRangeDraw {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly detached: boolean;
}

/**
 * The decorations of the comment ranges in `doc`. A range that is detached, or that has no width
 * after mapping, draws nothing. Positions outside the document are clamped to it.
 */
export function commentDecorations(
  doc: PMNode,
  ranges: readonly CommentRangeDraw[],
  selected: ThreadSelection | null = null,
  blocks: readonly { readonly id: string; readonly block: string }[] = [],
): DecorationSet {
  const size = doc.content.size;
  const decorations: Decoration[] = [];
  for (const r of ranges) {
    if (r.detached) continue;
    const from = Math.min(Math.max(0, r.from), size);
    const to = Math.min(Math.max(0, r.to), size);
    if (to <= from) continue;
    const chosen = selected !== null && selected.id === r.id;
    decorations.push(
      Decoration.inline(from, to, {
        class: chosen ? `${COMMENT_RANGE_CLASS} ${COMMENT_SELECTED_CLASS}` : COMMENT_RANGE_CLASS,
        'data-thread-id': r.id,
      }),
    );
  }
  // A thread on a block (a figure, a table or an equation) is drawn on the whole block, as a node
  // decoration (FE-048 criterion 1); the one the comments pane chose is marked more heavily (UX-030).
  const onBlock = new Map<string, string>();
  for (const b of blocks) onBlock.set(b.block, b.id);
  if (selected !== null && selected.block !== null && !onBlock.has(selected.block))
    onBlock.set(selected.block, selected.id);
  if (onBlock.size > 0) {
    doc.descendants((node, pos) => {
      const block = node.attrs['id'] as string | undefined;
      const thread = block === undefined ? undefined : onBlock.get(block);
      if (thread === undefined) return true;
      const chosen = selected !== null && selected.id === thread;
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: chosen ? `${COMMENT_BLOCK_CLASS} ${COMMENT_SELECTED_CLASS}` : COMMENT_BLOCK_CLASS,
          'data-thread-id': thread,
        }),
      );
      return false;
    });
  }
  return DecorationSet.create(doc, decorations);
}
