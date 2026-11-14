/**
 * `markRegion` (PRM-033 criterion 1, lane V-PRM-018-034): the selected whole body blocks are wrapped
 * in a region with a new identifier, the given title and policy `inherit`, as one transaction. The
 * command is refused when the selection is inside a region (regions do not nest, PRM-033 criterion
 * 2, whose disabled state and reason are not built here), when the title is empty, or when the user
 * lacks `structure` and `edit` in the body (`allowed`, computed by the core).
 */
import type { Command } from 'prosemirror-state';

export function markRegion(title: string, nextId: () => string, allowed: boolean): Command {
  return (state, dispatch) => {
    if (!allowed || title.trim() === '') return false;
    const type = state.schema.nodes['region'];
    if (!type) return false;
    const range = state.selection.$from.blockRange(state.selection.$to);
    if (!range || range.parent.type.name !== 'body') return false;
    if (dispatch) {
      const blocks = state.doc.slice(range.start, range.end).content;
      const region = type.create({ id: nextId(), title, policy: 'inherit' }, blocks);
      dispatch(state.tr.replaceWith(range.start, range.end, region).scrollIntoView());
    }
    return true;
  };
}
