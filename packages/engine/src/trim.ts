/**
 * Trimmed deletion (FE-037; 07 §7): a deletion across protected content removes only the text the
 * user may change, and reports how many scopes it kept, so that the interface can say so. Without
 * it, the region guard (FE-036) would refuse the whole deletion.
 *
 * The plan works on text only: each textblock that the selection covers is cut where it is, and
 * only when the scope the block lies in is one the user may change. Nothing is joined, so no
 * region boundary, paragraph boundary or whole node is removed (FE-037 criterion 5, P3). A
 * deletion that is entirely editable has no protected scope, so `trimmedDeletion` returns null and
 * the ordinary deletion runs. Paragraphs that the deletion empties stay in the document (the
 * decision recorded in docs/adr/0108-engine-backlog-batch.md).
 */
import type { Node as PMNode } from 'prosemirror-model';
import {
  type EditorState,
  Plugin,
  PluginKey,
  Selection,
  type Transaction,
} from 'prosemirror-state';
import { regionAt } from './regions.ts';

/** Whether the user may change a DEP scope (`body` or `region:<id>`). */
export type CanEdit = (scope: string) => boolean;

/** The plugin state is the checker, so that a key binding can ask the live access without a view. */
export const trimKey = new PluginKey<CanEdit>('docedit-trim');

/** What a trimmed deletion kept: the scopes it left alone. */
export interface TrimNotice {
  readonly skipped: readonly string[];
}

/** The notice as the core publishes it, numbered. */
export interface TrimReport extends TrimNotice {
  readonly n: number;
}

export function trimPlugin(canEdit: CanEdit): Plugin<CanEdit> {
  return new Plugin<CanEdit>({
    key: trimKey,
    state: {
      init: () => canEdit,
      apply: (_tr, previous) => previous,
    },
  });
}

/** The DEP scope of the text at `pos`: `region:<id>` inside a region, otherwise `body`. */
export function scopeAt(doc: PMNode, pos: number): string {
  const region = regionAt(doc.resolve(pos));
  return region?.id ? `region:${region.id}` : 'body';
}

/**
 * The transaction that deletes the editable text of the selection, or null when no protected scope
 * lies in it (then the ordinary deletion applies). When the selection lies wholly in protected
 * scopes, the transaction changes nothing and only carries the notice.
 */
export function trimmedDeletion(state: EditorState, canEdit: CanEdit): Transaction | null {
  const { from, to, empty } = state.selection;
  if (empty) return null;
  const ranges: Array<[number, number]> = [];
  const skipped = new Set<string>();
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    const start = pos + 1;
    const end = pos + node.nodeSize - 1;
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (a >= b) return false;
    const scope = scopeAt(state.doc, start);
    if (canEdit(scope)) ranges.push([a, b]);
    else skipped.add(scope);
    return false;
  });
  if (skipped.size === 0) return null;
  const tr = state.tr;
  // Last range first: a deletion does not move the ranges before it.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [a, b] = ranges[i]!;
    tr.delete(a, b);
  }
  if (ranges.length > 0) {
    tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(from))));
  }
  const notice: TrimNotice = { skipped: [...skipped].sort() };
  return tr.setMeta(trimKey, notice);
}
