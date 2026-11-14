/**
 * `renameRegion` (PRM-034 criterion 1, lane V-PRM-018-034): the region with the given identifier
 * takes the given title in one transaction. The command is refused when `allowed` is false (the user
 * lacks `structure` or `edit` in the region, computed by the core), when no region has the
 * identifier, when the title is empty, or when the region already has that title (nothing to change,
 * so nothing is queued). The authority decides the same rule again on the server (`region.retitle`).
 */
import type { Command } from 'prosemirror-state';

export function renameRegion(region: string, title: string, allowed: boolean): Command {
  return (state, dispatch) => {
    if (!allowed || title.trim() === '') return false;
    let found: { pos: number; title: unknown } | null = null;
    state.doc.descendants((node, pos) => {
      if (found !== null) return false;
      if (node.type.name === 'region' && node.attrs['id'] === region)
        found = { pos, title: node.attrs['title'] };
      return found === null;
    });
    const hit = found as { pos: number; title: unknown } | null;
    if (hit === null || hit.title === title) return false;
    if (dispatch) {
      const node = state.doc.nodeAt(hit.pos);
      if (!node) return false;
      dispatch(
        state.tr.setNodeMarkup(hit.pos, undefined, { ...node.attrs, title }).scrollIntoView(),
      );
    }
    return true;
  };
}
