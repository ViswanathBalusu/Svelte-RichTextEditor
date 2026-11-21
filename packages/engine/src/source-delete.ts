/**
 * Deleting a source definition, and finding where a source is cited (UX-103 criterion 2; 07 §5.3; CDM-052).
 *
 * - A source that a citation still names cannot be deleted. The command refuses with `cited` and
 *   returns the positions of the citing nodes, so the sources pane can show where the source is cited.
 * - Deleting an unused source removes its `source_def` node from the document's definitions. The pane
 *   turns this into a commit through the log (UX-103 criterion 1); this module only changes the state.
 * - Changing a source definition needs `structure` (07 §4). The caller checks that before it calls
 *   this module; it is not checked here.
 */
import type { EditorState, Transaction } from 'prosemirror-state';
import { citationsCiting } from './source-read.ts';

export { citationsCiting } from './source-read.ts';

export type DeleteSourceRefusal = 'not-defined' | 'cited';

export type DeleteSourceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'not-defined' }
  | { readonly ok: false; readonly reason: 'cited'; readonly citedAt: readonly number[] };

/**
 * Deletes the source definition `sourceId`, unless a citation still names it. With `dispatch` absent,
 * only checks whether the deletion is allowed.
 */
export function deleteSource(
  state: EditorState,
  sourceId: string,
  dispatch?: (tr: Transaction) => void,
): DeleteSourceResult {
  const defs = state.doc.firstChild;
  let found = -1;
  let size = 0;
  defs?.forEach((child, childOffset) => {
    if (found >= 0) return;
    if (child.type.name === 'source_def' && child.attrs['id'] === sourceId) {
      found = childOffset;
      size = child.nodeSize;
    }
  });
  if (!defs || found < 0) return { ok: false, reason: 'not-defined' };

  const citedAt = citationsCiting(state.doc, sourceId);
  if (citedAt.length > 0) return { ok: false, reason: 'cited', citedAt };

  if (dispatch) {
    // The definitions node opens at position 0, so its first child starts at position 1.
    const from = 1 + found;
    dispatch(state.tr.delete(from, from + size));
  }
  return { ok: true };
}
