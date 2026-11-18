/**
 * Recording a change of paragraph style, alignment or list level as a block suggestion (FE-044
 * criterion 3; 02 §5.2; 03 §5; CDM-040). A pure transaction builder over an editor state, like the
 * text builders of `suggestion-edit.ts`: it returns the transaction, and the caller decides when to
 * dispatch it.
 *
 * The paragraph gains one `fmt` entry in its `suggest` attribute (03 §5; owner decision 92) naming the
 * user, with one identifier, and its `before`
 * records the previous values of the attributes the change alters, from
 * `{ attrs: { style, align, numbering } }` (CDM-040; the list level is the `numbering` attribute's
 * `level`; the validator checks that shape). The attribute change is then made, so the paragraph
 * shows the new value and the rejection of the suggestion restores `before` (authority, 03 §5).
 *
 * Decisions taken here, not in the spec (see the story Notes and docs/adr/0132-engine-3-backlog-batch.md):
 * - only `style`, `align` and `numbering` may change under a block suggestion; any other attribute, the
 *   identifier above all (I2), makes the builder return null, so the core refuses the change;
 * - a paragraph that already carries this user's `fmt` keeps one `fmt` for the user: the old entry is
 *   replaced by one whose `before` also records any attribute the earlier suggestion did not, so that
 *   `before` still holds the values from before any of the user's changes;
 * - a step that sets an attribute to the value it already has is no change and is not recorded.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */
import type { EditorState, Transaction } from 'prosemirror-state';
import type { AttrStep } from 'prosemirror-transform';
import { blockEntries, entry, setBlockEntries } from './block-suggestion.ts';
import type { SuggestionAuthor } from './suggestion-author.ts';

/** The paragraph attributes a block suggestion may record and change (CDM-040). */
export const BLOCK_FORMAT_ATTRS: ReadonlySet<string> = new Set(['style', 'align', 'numbering']);

/** Equality of two attribute values as JSON, which is how the document stores them. */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Records the attribute steps of paragraphs, and the style of a table, as a block formatting
 * suggestion by `author`. Returns null when a step is not a paragraph's style, alignment or list
 * level change or a table's style change, or when it names any other node. `handled` counts the paragraphs whose formatting was recorded.
 */
export function suggestBlockFormat(
  state: EditorState,
  steps: readonly AttrStep[],
  author: SuggestionAuthor,
): { tr: Transaction; handled: number } | null {
  // The changed attributes of each paragraph, with their values before any change in this transaction.
  const groups = new Map<number, Map<string, unknown>>();
  const changing: AttrStep[] = [];
  for (const step of steps) {
    if (!BLOCK_FORMAT_ATTRS.has(step.attr)) return null;
    const node = state.doc.nodeAt(step.pos);
    // A paragraph's style, alignment or list level; a table's style (UX-022 criterion 4).
    const recordable =
      node?.type.name === 'paragraph' || (node?.type.name === 'table' && step.attr === 'style');
    if (!node || !recordable) return null;
    const previous = node.attrs[step.attr];
    if (sameValue(previous, step.value)) continue;
    changing.push(step);
    let attrs = groups.get(step.pos);
    if (attrs === undefined) {
      attrs = new Map<string, unknown>();
      groups.set(step.pos, attrs);
    }
    if (!attrs.has(step.attr)) attrs.set(step.attr, previous);
  }
  const tr = state.tr;
  if (changing.length === 0) return { tr, handled: 0 };
  for (const [pos, changed] of groups) {
    const node = state.doc.nodeAt(pos)!;
    const entries = blockEntries(node);
    const own = entries.find((e) => e.type === 'fmt' && e.attrs.user === author.user);
    const recorded = new Map<string, unknown>();
    let id: string;
    if (own) {
      id = own.attrs.id;
      const before = own.attrs.before as { attrs?: Record<string, unknown> } | null | undefined;
      for (const [k, v] of Object.entries(before?.attrs ?? {})) recorded.set(k, v);
      for (const [k, v] of changed) if (!recorded.has(k)) recorded.set(k, v);
    } else {
      id = author.nextId();
      for (const [k, v] of changed) recorded.set(k, v);
    }
    const before = { attrs: Object.fromEntries(recorded) };
    setBlockEntries(tr, pos, [
      ...entries.filter((e) => e !== own),
      entry('fmt', id, author.user, before),
    ]);
  }
  for (const step of changing) tr.step(step);
  return { tr, handled: groups.size };
}
