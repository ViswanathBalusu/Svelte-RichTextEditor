/**
 * The comment range decorations of the body (FE-048 criteria 1 and 5; 02 §5.2).
 *
 * A thread's range is drawn as an inline decoration over its text on every draw, from the ranges the
 * core holds (`DocumentCore.threadRanges`, mapped through every change by `comment-ranges.ts`). The
 * document is never changed to draw it. A detached thread (its text was deleted, so the range has
 * collapsed) has no width and draws nothing: its decoration disappears (FE-048 criterion 5).
 *
 * The class is the cue that is not colour: the stylesheet draws a dotted underline for it
 * (element.css). The thread's identifier is in `data-thread-id`, so the threads UI can reach it.
 *
 * This module imports `prosemirror-view` for `Decoration` only; it builds no DOM. The web view passes
 * `commentDecorations` into its `decorations` prop (view/web.ts).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';

/** The class of a thread's range over its text. The element's style sheet names it. */
export const COMMENT_RANGE_CLASS = 'de-comment-range';

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
): DecorationSet {
  const size = doc.content.size;
  const decorations: Decoration[] = [];
  for (const r of ranges) {
    if (r.detached) continue;
    const from = Math.min(Math.max(0, r.from), size);
    const to = Math.min(Math.max(0, r.to), size);
    if (to <= from) continue;
    decorations.push(
      Decoration.inline(from, to, { class: COMMENT_RANGE_CLASS, 'data-thread-id': r.id }),
    );
  }
  return DecorationSet.create(doc, decorations);
}
