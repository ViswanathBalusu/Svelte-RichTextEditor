/**
 * The command that moves the caret to the next region the user may edit (PRM-027; 07 §7).
 *
 * - "Next" is in document order: the first region whose start lies after the caret.
 * - A region is a candidate when its scope `region:<id>` may be edited (the guard's answer, passed in
 *   as `canEdit`). A region with no text position is skipped.
 * - The caret goes to the first text position inside that region.
 * - The command does not wrap from the last region to the first: the story does not say that it
 *   should, so this is the default reading (PRM-027 Notes).
 * - As a query (`dispatch` absent) it answers whether such a region exists.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { type Command, Selection, TextSelection } from 'prosemirror-state';

/** The first text position inside the region spanning `start`..`end`, or null when there is none. */
function firstTextPosition(doc: PMNode, start: number, end: number): number | null {
  const found = Selection.findFrom(doc.resolve(start), 1, true);
  if (!found || found.from < start || found.to > end) return null;
  return found.from;
}

/**
 * The first text position of the next region after `from` that `canEdit` accepts, or null when no
 * such region exists.
 */
export function nextEditableRegionStart(
  doc: PMNode,
  from: number,
  canEdit: (scope: string) => boolean,
): number | null {
  let target: number | null = null;
  doc.descendants((node, pos) => {
    if (target !== null) return false;
    if (node.type.name !== 'region') return true;
    if (pos <= from) return true;
    const id = typeof node.attrs['id'] === 'string' ? node.attrs['id'] : '';
    if (!canEdit(`region:${id}`)) return false;
    const found = firstTextPosition(doc, pos + 1, pos + node.nodeSize - 1);
    if (found !== null) target = found;
    return false;
  });
  return target;
}

/** The next-editable-region command, for the core's `queryCommand` and `run` (PRM-027). */
export function nextEditableRegion(canEdit: (scope: string) => boolean): Command {
  return (state, dispatch) => {
    const target = nextEditableRegionStart(state.doc, state.selection.head, canEdit);
    if (target === null) return false;
    if (dispatch) {
      dispatch(state.tr.setSelection(TextSelection.create(state.doc, target)).scrollIntoView());
    }
    return true;
  };
}
