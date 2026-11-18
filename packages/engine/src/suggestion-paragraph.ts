/**
 * Paragraphs added and removed as suggestions (FE-044 criteria 1 and 2; 02 §5.2; 03 §5). A pure
 * transaction builder over an editor state, like the text builders of `suggestion-edit.ts`: it
 * returns the transaction that records the whole-paragraph step as block suggestions (entries of the
 * suggest attribute, owner decision 92), and the caller
 * decides when to dispatch it.
 *
 * - A paragraph the user adds carries one `ins` entry naming the user, with one identifier. It
 *   is added in three shapes: a closed slice of paragraphs at a block boundary (a paste of whole
 *   paragraphs), and the Enter key at the end of a paragraph, whose new paragraph is empty.
 * - A whole paragraph the user deletes stays in the document and carries one `del` entry naming
 *   the user (03 §5), as a deleted table row does (FE-045).
 *
 * Decisions taken here, not in the spec (see the story Notes and docs/adr/0302-lane-V-FE-033-048.md):
 * - Enter in the middle of a paragraph is not recorded: it would move text into a paragraph the
 *   user did not add. Pressing Enter at the start of a paragraph is refused for the same reason.
 * - Deleting a whole paragraph that the same user inserted removes it, as a deleted row does; a
 *   selection that mixes the user's own paragraphs with others is refused.
 * - A paragraph already marked `del` is refused a second deletion.
 * - Changes inside a table, and blocks other than paragraphs, are refused (the table commands and
 *   FE-044 criterion 5 say so).
 *
 * Returns `undefined` when the step is not a whole-paragraph step (the other builders decide), and
 * `null` when it is one that cannot be recorded.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */
import type { Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { type EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { ReplaceStep } from 'prosemirror-transform';
import {
  addBlockEntry,
  entry,
  hasKind,
  hasOwn,
  withEntry,
  type SuggestionEntry,
} from './block-suggestion.ts';
import type { SuggestionAuthor } from './suggestion-author.ts';

const entryOf = (type: 'ins' | 'del', author: SuggestionAuthor): SuggestionEntry =>
  entry(type, author.nextId(), author.user);

/** Whether the position lies in a table, where paragraph suggestions are not defined (FE-045). */
function inTable($pos: ResolvedPos): boolean {
  for (let d = $pos.depth; d > 0; d--) {
    const name = $pos.node(d).type.name;
    if (name === 'table' || name === 'table_cell' || name === 'table_row') return true;
  }
  return false;
}

/**
 * The suggestion for a whole-paragraph replace step, or `undefined` when the step is not one (text
 * inside a paragraph, a join, or a split in the middle of text).
 */
export function paragraphSuggestion(
  state: EditorState,
  step: ReplaceStep,
  author: SuggestionAuthor,
): { tr: Transaction } | null | undefined {
  const { from, to, slice } = step;
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);

  // Enter at the end of a paragraph: the step opens both sides of a split and the new paragraph is
  // empty. The new paragraph follows the current one and carries the user's `ins`.
  if (
    from === to &&
    slice.openStart === 1 &&
    slice.openEnd === 1 &&
    slice.content.childCount === 2
  ) {
    if ($from.parent.type.name !== 'paragraph') return undefined;
    const first = slice.content.child(0);
    const second = slice.content.child(1);
    if (first.type.name !== 'paragraph' || second.type.name !== 'paragraph') return undefined;
    if (first.content.size !== 0 || second.content.size !== 0) return undefined;
    if (inTable($from)) return null;
    if ($from.parentOffset !== $from.parent.content.size) return null; // a split inside text
    const at = $from.after();
    const tr = state.tr.insert(at, withEntry(second, entryOf('ins', author)));
    tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
    return { tr };
  }

  // Whole blocks inserted at a block boundary, closed on both sides (a paste of paragraphs).
  if (!$from.parent.inlineContent && from === to && slice.openStart === 0 && slice.openEnd === 0) {
    if (slice.size === 0) return undefined;
    const nodes: PMNode[] = [];
    slice.content.forEach((n) => nodes.push(n));
    // A whole table is one block suggestion: its own `ins`, and none on its rows (FE-045 criterion 3).
    if (inTable($from) || nodes.some((n) => n.type.name !== 'paragraph' && n.type.name !== 'table'))
      return null;
    const marked = nodes.map((n) => withEntry(n, entryOf('ins', author)));
    const tr = state.tr.insert(from, marked);
    const size = marked.reduce((sum, n) => sum + n.nodeSize, 0);
    // The caret goes to the end of pasted paragraphs, and into the first cell of an inserted table.
    tr.setSelection(
      nodes.some((n) => n.type.name === 'table')
        ? TextSelection.near(tr.doc.resolve(from + 1))
        : TextSelection.near(tr.doc.resolve(from + size - 1)),
    );
    return { tr };
  }

  // Whole blocks removed between two block boundaries of the same container.
  if (slice.size === 0 && from < to && !$from.parent.inlineContent && $from.sameParent($to)) {
    if (inTable($from)) return null;
    const container = $from.parent;
    const base = $from.start();
    const hits: { pos: number; node: PMNode }[] = [];
    container.forEach((child, offset) => {
      if (offset >= $from.parentOffset && offset + child.nodeSize <= $to.parentOffset)
        hits.push({ pos: base + offset, node: child });
    });
    if (hits.length === 0) return null;
    if (hits.some((h) => h.node.type.name !== 'paragraph')) return null;
    if (hits.some((h) => hasKind(h.node, 'del'))) return null;
    const own = hits.map((h) => hasOwn(h.node, 'ins', author.user));
    if (own.every(Boolean)) return { tr: state.tr.delete(from, to) };
    if (own.some(Boolean)) return null;
    const tr = state.tr;
    for (const h of hits) addBlockEntry(tr, h.pos, entryOf('del', author));
    return { tr };
  }

  return undefined;
}
