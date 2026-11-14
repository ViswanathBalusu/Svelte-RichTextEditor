/**
 * Recording a change of paragraph style, alignment or list level as a block suggestion (FE-044
 * criterion 3; 02 §5.2; 03 §5; CDM-040). A pure transaction builder over an editor state, like the
 * text builders of `suggestion-edit.ts`: it returns the transaction, and the caller decides when to
 * dispatch it.
 *
 * The paragraph gains one `fmt` node mark naming the user, with one identifier, and its `before`
 * records the previous values of the attributes the change alters, from
 * `{ attrs: { style, align, numbering } }` (CDM-040; the list level is the `numbering` attribute's
 * `level`; the validator checks that shape). The attribute change is then made, so the paragraph
 * shows the new value and the rejection of the suggestion restores `before` (authority, 03 §5).
 *
 * Decisions taken here, not in the spec (see the story Notes and docs/adr/0132-engine-3-backlog-batch.md):
 * - only `style`, `align` and `numbering` may change under a block suggestion; any other attribute, the
 *   identifier above all (I2), makes the builder return null, so the core refuses the change;
 * - a paragraph that already carries this user's `fmt` keeps one `fmt` for the user: the old mark is
 *   replaced by one whose `before` also records any attribute the earlier suggestion did not, so that
 *   `before` still holds the values from before any of the user's changes;
 * - a step that sets an attribute to the value it already has is no change and is not recorded.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */
import type { Mark } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { AddNodeMarkStep, type AttrStep, RemoveNodeMarkStep } from 'prosemirror-transform';
import type { SuggestionAuthor } from './suggestion-author.ts';

/** The paragraph attributes a block suggestion may record and change (CDM-040). */
export const BLOCK_FORMAT_ATTRS: ReadonlySet<string> = new Set(['style', 'align', 'numbering']);

/** Equality of two attribute values as JSON, which is how the document stores them. */
const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Records the attribute steps of paragraphs as a block formatting suggestion by `author`. Returns
 * null when a step is not a paragraph's style, alignment or list level change, or when it names a
 * node that is not a paragraph. `handled` counts the paragraphs whose formatting was recorded.
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
    if (!node || node.type.name !== 'paragraph') return null;
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
  const fmt = state.schema.marks['fmt'];
  if (!fmt) return null;
  for (const [pos, changed] of groups) {
    const node = state.doc.nodeAt(pos)!;
    const own: Mark | undefined = node.marks.find(
      (m) => m.type.name === 'fmt' && m.attrs['user'] === author.user,
    );
    const recorded = new Map<string, unknown>();
    let id: string;
    if (own) {
      id = String(own.attrs['id']);
      const before = own.attrs['before'] as { attrs?: Record<string, unknown> } | null | undefined;
      for (const [k, v] of Object.entries(before?.attrs ?? {})) recorded.set(k, v);
      for (const [k, v] of changed) if (!recorded.has(k)) recorded.set(k, v);
      tr.step(new RemoveNodeMarkStep(pos, own));
    } else {
      id = author.nextId();
      for (const [k, v] of changed) recorded.set(k, v);
    }
    const before = { attrs: Object.fromEntries(recorded) };
    tr.step(new AddNodeMarkStep(pos, fmt.create({ id, user: author.user, before })));
  }
  for (const step of changing) tr.step(step);
  return { tr, handled: groups.size };
}
