// Block suggestions in the tests (03 §5; owner decision 92): a paragraph, a table row and a table
// keep their suggestions in the `suggest` attribute, so a step that suggests a change to a whole
// block is an attribute step. These helpers build those steps from the suggestion marks the tests
// already create, and read the entries back.
import type { Mark, Node } from 'prosemirror-model';
import { AttrStep } from 'prosemirror-transform';

export interface SuggestEntry {
  type: string;
  attrs: { id: string; user: string; before?: unknown };
}

/** The `suggest` entry that says what a suggestion mark would say. */
export function entryOf(mark: Mark): SuggestEntry {
  const { id, user, before } = mark.attrs as { id: string; user: string; before?: unknown };
  const attrs: SuggestEntry['attrs'] = { id, user };
  if (before !== undefined && before !== null) attrs.before = before;
  return { type: mark.type.name, attrs };
}

/** The entries of the block at `pos`. */
export function entriesAt(doc: Node, pos: number): SuggestEntry[] {
  const s = doc.nodeAt(pos)?.attrs['suggest'];
  return Array.isArray(s) ? (s as SuggestEntry[]) : [];
}

/** The step that adds one suggestion (a mark that says what it suggests) to the block at `pos`. */
export function addSuggestion(doc: Node, pos: number, mark: Mark): AttrStep {
  return new AttrStep(pos, 'suggest', [...entriesAt(doc, pos), entryOf(mark)]);
}

/** The step that takes the suggestion with this identifier off the block at `pos`. */
export function removeSuggestion(doc: Node, pos: number, id: string): AttrStep {
  const rest = entriesAt(doc, pos).filter((e) => e.attrs.id !== id);
  return new AttrStep(pos, 'suggest', rest.length ? rest : null);
}
