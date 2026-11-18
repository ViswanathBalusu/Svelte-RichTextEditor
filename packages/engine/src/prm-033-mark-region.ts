/**
 * `markRegion` (PRM-033 criterion 1, lane V-PRM-018-034): the selected whole body blocks are wrapped
 * in a region with a new identifier, the given title and policy `inherit`, as one transaction. The
 * command is refused when the selection is inside a region (regions do not nest, PRM-033 criterion
 * 2, whose disabled state and reason are not built here), when the title is empty, or when the user
 * lacks `structure` and `edit` in the body (`allowed`, computed by the core). A selection that
 * holds a whole region would put one region inside another, so it is refused too, and so is a
 * document that already has the most regions it may (I7, `LIMITS.regions`; criterion 3).
 */
import { LIMITS } from '@docedit/model/validate';
import type { Command, EditorState } from 'prosemirror-state';

/** How many regions the document holds. */
export function regionCount(state: EditorState): number {
  let n = 0;
  state.doc.descendants((node) => {
    if (node.type.name === 'region') n += 1;
    return node.type.name !== 'region';
  });
  return n;
}

/** Whether the document is at the most regions it may hold (I7). */
export function atRegionLimit(state: EditorState): boolean {
  return regionCount(state) >= LIMITS.regions;
}

/** Whether the selected blocks include a whole region (a nested region would result). */
export function selectionHoldsRegion(state: EditorState): boolean {
  const range = state.selection.$from.blockRange(state.selection.$to);
  if (!range) return false;
  let found = false;
  state.doc.nodesBetween(range.start, range.end, (node) => {
    if (node.type.name === 'region') found = true;
    return !found;
  });
  return found;
}

export function markRegion(title: string, nextId: () => string, allowed: boolean): Command {
  return (state, dispatch) => {
    if (!allowed || title.trim() === '') return false;
    const type = state.schema.nodes['region'];
    if (!type) return false;
    const range = state.selection.$from.blockRange(state.selection.$to);
    if (!range || range.parent.type.name !== 'body') return false;
    if (selectionHoldsRegion(state) || atRegionLimit(state)) return false;
    if (dispatch) {
      const blocks = state.doc.slice(range.start, range.end).content;
      const region = type.create({ id: nextId(), title, policy: 'inherit' }, blocks);
      dispatch(state.tr.replaceWith(range.start, range.end, region).scrollIntoView());
    }
    return true;
  };
}
