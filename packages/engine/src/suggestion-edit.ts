/**
 * Recording edits as suggestions (FE-042 and FE-043; 02 §5.2; 03 §5; 07 §5.2 P4). Pure transaction
 * builders over an editor state: each returns the transaction that records one user's edit as
 * suggestion marks, so the caller decides when to dispatch it and how the commit is sent.
 *
 * The marks follow the schema's suggestion marks (CDM-040 and 03 §5):
 * - `ins` { id, user } on text the user inserted;
 * - `del` { id, user } on baseline or other users' text the user deleted; the text stays;
 * - `fmt` { id, user, before } on text whose formatting the user changed, where `before` records the
 *   non-suggestion marks the text had, so that a rejection can put them back (P4).
 *
 * The suggestion identifier comes from `nextId`, which the caller supplies (the same identifier
 * source as the rest of the core). The builder does not check that no other user has used it; the
 * authority does on commit (FE-042 criterion 1).
 *
 * `recordAsSuggestion` is what the core calls (FE-041, FE-042, FE-043): it takes a local transaction
 * made while suggestion mode is on and rebuilds it through these builders, so that typing, deleting,
 * typing over a selection and the formatting commands all produce suggestion marks.
 *
 * Decisions taken here, not in the spec (see the story Notes and docs/adr/0132-engine-3-backlog-batch.md):
 * - deleting text that carries the user's own `ins` removes it outright, since P4 lets a user take back
 *   their own insertion; deleting text that also carries another user's `ins` marks it `del` instead,
 *   so that the other user's inserted text is never removed by this user;
 * - a formatting suggestion applies to every text run in the range whose formatting changes,
 *   including text carrying an `ins`; a run that already carries the user's own `fmt` keeps it, so
 *   that its `before` still records the formatting before any of the user's changes;
 * - typing next to the user's own `ins`, or deleting next to the user's own `del`, reuses that mark
 *   and its identifier, so that a typed word is one suggestion, not one per keystroke;
 * - a change that is not text typed, deleted or replaced inside one paragraph, or a change of
 *   character formatting, is not recorded (block suggestions are FE-044): the core refuses it.
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */
import { Fragment, Mark, type Node as PMNode } from 'prosemirror-model';
import { type EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import {
  AddMarkStep,
  AttrStep,
  RemoveMarkStep,
  ReplaceStep,
  type Step,
} from 'prosemirror-transform';
import { suggestBlockFormat } from './suggestion-block.ts';
import { paragraphSuggestion } from './suggestion-paragraph.ts';
import type { SuggestionAuthor } from './suggestion-author.ts';

export type { SuggestionAuthor } from './suggestion-author.ts';

/** The suggestion marks of the schema (03 §5). */
const SUGGESTION_TYPES: ReadonlySet<string> = new Set(['ins', 'del', 'fmt']);

const isSuggestion = (m: Mark): boolean => SUGGESTION_TYPES.has(m.type.name);

/** What is inserted: plain text, or inline content (text with its formatting) from a typed slice. */
export type SuggestedContent = string | Fragment;

/** The author's own suggestion mark of `type` on the text just before or just after `pos`, if any. */
function ownMarkNear(
  state: EditorState,
  before: number,
  after: number,
  type: 'ins' | 'del',
  user: string,
): Mark | null {
  const own = (node: { marks: readonly Mark[] } | null | undefined): Mark | null =>
    node?.marks.find((m) => m.type.name === type && m.attrs['user'] === user) ?? null;
  return own(state.doc.resolve(before).nodeBefore) ?? own(state.doc.resolve(after).nodeAfter);
}

/** The inserted content with one `ins` mark and no other suggestion mark. */
function withIns(state: EditorState, content: SuggestedContent, ins: Mark): Fragment {
  if (typeof content === 'string') return Fragment.from(state.schema.text(content, [ins]));
  const nodes: PMNode[] = [];
  content.forEach((n) => nodes.push(n.mark(ins.addToSet(n.marks.filter((m) => !isSuggestion(m))))));
  return Fragment.from(nodes);
}

/** The text runs of `[from, to)`, each with the marks it carries, in document order. */
function textRuns(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number; marks: readonly Mark[] }[] {
  const runs: { from: number; to: number; marks: readonly Mark[] }[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const start = Math.max(pos, from);
    const end = Math.min(pos + node.nodeSize, to);
    if (start < end) runs.push({ from: start, to: end, marks: node.marks });
    return false;
  });
  return runs;
}

/**
 * Records typed text as an insertion by `author` at `pos` (FE-042 criterion 1). The text carries one
 * `ins` mark naming the user: the author's own `ins` next to `pos` when there is one, so that typing
 * continues the same suggestion, otherwise a fresh suggestion identifier. Inline content keeps its
 * formatting and loses any other suggestion mark.
 */
export function suggestInsert(
  state: EditorState,
  pos: number,
  text: SuggestedContent,
  author: SuggestionAuthor,
): Transaction {
  const ins =
    ownMarkNear(state, pos, pos, 'ins', author.user) ??
    state.schema.marks['ins']!.create({ id: author.nextId(), user: author.user });
  return state.tr.insert(pos, withIns(state, text, ins));
}

/**
 * Records a deletion of `[from, to)` by `author` (FE-042 criteria 2 and 3). Baseline text gains a
 * `del` mark and stays. Text with another user's `ins` gains the author's `del` and keeps the other
 * user's mark and text. Text with only the author's own `ins` is removed. Text the author already
 * deleted is left as it is. The `del` is the author's own `del` next to the range when there is one,
 * so that deleting character by character continues the same suggestion. Returns the transaction and
 * how many text runs it marked or removed.
 */
export function suggestDelete(
  state: EditorState,
  from: number,
  to: number,
  author: SuggestionAuthor,
): { tr: Transaction; handled: number } {
  const tr = state.tr;
  const ownDel = (marks: readonly Mark[]): boolean =>
    marks.some((m) => m.type.name === 'del' && m.attrs['user'] === author.user);
  const runs = textRuns(state, from, to).filter((run) => !ownDel(run.marks));
  if (runs.length === 0) return { tr, handled: 0 };
  const del =
    ownMarkNear(state, from, to, 'del', author.user) ??
    state.schema.marks['del']!.create({ id: author.nextId(), user: author.user });
  // Right to left, so that removing a run never moves a run still to be handled.
  for (const run of [...runs].reverse()) {
    const ins = run.marks.filter((m) => m.type.name === 'ins');
    const ownOnly = ins.length > 0 && ins.every((m) => m.attrs['user'] === author.user);
    if (ownOnly) tr.delete(run.from, run.to);
    else tr.addMark(run.from, run.to, del);
  }
  return { tr, handled: runs.length };
}

/**
 * Records typing over a selection as a replacement (FE-042 criterion 5): the selected text gains a
 * `del` mark and the new text is inserted, with an `ins` mark, after it.
 */
export function suggestReplace(
  state: EditorState,
  from: number,
  to: number,
  text: SuggestedContent,
  author: SuggestionAuthor,
): Transaction {
  const { tr } = suggestDelete(state, from, to, author);
  const at = tr.mapping.map(to, 1);
  const ins = state.schema.marks['ins']!.create({ id: author.nextId(), user: author.user });
  return tr.insert(at, withIns(state, text, ins));
}

/**
 * Records a change of formatting over `[from, to)` by `author` (FE-043). `change` is the mark to
 * apply, or the mark steps a formatting command made over the range. Each text run whose formatting
 * the change alters gains an `fmt` mark with the author's user and one identifier, whose `before`
 * records the run's non-suggestion marks; then the change is made. A run that already carries the
 * author's own `fmt` keeps it, so that `before` still records the formatting before any of the
 * author's changes. Other users' `fmt` marks stay, so two users' suggestions coexist (FE-043
 * criterion 2). Rejecting the suggestion puts `before` back (FE-043 criterion 3).
 */
export function suggestFormat(
  state: EditorState,
  from: number,
  to: number,
  change: Mark | readonly Step[],
  author: SuggestionAuthor,
): { tr: Transaction; handled: number } {
  const steps: readonly Step[] =
    change instanceof Mark ? state.tr.addMark(from, to, change).steps : change;
  const tr = state.tr;
  const after = state.tr;
  for (const step of steps) if (after.maybeStep(step).failed) return { tr, handled: 0 };
  // The run boundaries of both documents: a change may split a run or join two.
  const cuts = new Set<number>([from, to]);
  for (const doc of [state.doc, after.doc])
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return true;
      cuts.add(Math.max(pos, from));
      cuts.add(Math.min(pos + node.nodeSize, to));
      return false;
    });
  const points = [...cuts].sort((a, b) => a - b);
  const plain = (marks: readonly Mark[]): readonly Mark[] => marks.filter((m) => !isSuggestion(m));
  let id: string | null = null;
  let handled = 0;
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const was = state.doc.nodeAt(a);
    const now = after.doc.nodeAt(a);
    if (!was?.isText || !now?.isText) continue;
    if (Mark.sameSet(plain(was.marks), plain(now.marks))) continue;
    handled++;
    if (was.marks.some((m) => m.type.name === 'fmt' && m.attrs['user'] === author.user)) continue;
    id ??= author.nextId();
    const before = { marks: plain(was.marks).map((m) => m.toJSON() as unknown), attrs: {} };
    tr.addMark(a, b, state.schema.marks['fmt']!.create({ id, user: author.user, before }));
  }
  for (const step of steps) tr.step(step);
  return { tr, handled };
}

/** The metadata of an input transaction that the recorded one keeps (history, the view's input). */
const KEPT_META: readonly string[] = ['addToHistory', 'uiEvent', 'paste', 'composition', 'pointer'];

/**
 * Rebuilds a local transaction made from `state` as suggestions by `author` (FE-042, FE-043), or
 * returns null when it cannot be recorded as suggestions. The core calls it for every local change
 * while suggestion mode is on in a scope the change touches (FE-041).
 *
 * - One replace step inside one paragraph whose content is inline: a deletion goes through
 *   `suggestDelete`, an insertion through `suggestInsert`, typing over a selection through
 *   `suggestReplace`. The caret goes where the user expects it: after the inserted text; before the
 *   deleted text, or after it when the user deleted forwards.
 * - Mark steps only (a formatting command): `suggestFormat` with those steps. A step that adds or
 *   removes a suggestion mark is not formatting and is not recorded.
 */
export function recordAsSuggestion(
  state: EditorState,
  input: Transaction,
  author: SuggestionAuthor,
): Transaction | null {
  const steps = input.steps;
  const first = steps[0];
  if (first === undefined) return input;
  let out: Transaction | null = null;
  const paragraph =
    steps.length === 1 && first instanceof ReplaceStep
      ? paragraphSuggestion(state, first, author)
      : undefined;
  if (paragraph !== undefined) {
    // Whole paragraphs added or removed (FE-044 criteria 1 and 2): node marks, or refused.
    if (paragraph === null) return null;
    out = paragraph.tr;
  } else if (steps.every((s) => s instanceof AddMarkStep || s instanceof RemoveMarkStep)) {
    // Mark steps move no position, so the selection the state had still holds.
    const markSteps = steps as readonly (AddMarkStep | RemoveMarkStep)[];
    if (markSteps.some((s) => isSuggestion(s.mark))) return null;
    const from = Math.min(...markSteps.map((s) => s.from));
    const to = Math.max(...markSteps.map((s) => s.to));
    out = suggestFormat(state, from, to, markSteps, author).tr;
  } else if (steps.every((s) => s instanceof AttrStep)) {
    // Attribute steps on paragraphs: a style, alignment or list level change (FE-044 criterion 3).
    const block = suggestBlockFormat(state, steps as readonly AttrStep[], author);
    if (block === null) return null;
    out = block.tr;
  } else if (steps.length === 1 && first instanceof ReplaceStep) {
    const { from, to, slice } = first;
    const $from = state.doc.resolve(from);
    if (!$from.sameParent(state.doc.resolve(to)) || !$from.parent.inlineContent) return null;
    let content = slice.content;
    if (slice.openStart > 0 || slice.openEnd > 0) {
      // Inline content cut from one paragraph (a paste, a drop): the paragraph's content.
      const only = content.childCount === 1 ? content.firstChild : null;
      if (slice.openStart !== 1 || slice.openEnd !== 1 || !only?.isTextblock) return null;
      content = only.content;
    }
    let inline = true;
    content.forEach((n) => {
      if (!n.isInline) inline = false;
    });
    if (!inline) return null;
    if (content.size === 0) {
      if (from === to) return input;
      out = suggestDelete(state, from, to, author).tr;
      const sel = state.selection;
      const forwards = sel.empty && sel.head === from;
      const caret = forwards ? out.mapping.map(to, 1) : out.mapping.map(from, -1);
      out.setSelection(TextSelection.create(out.doc, caret));
    } else {
      out =
        from === to
          ? suggestInsert(state, from, content, author)
          : suggestReplace(state, from, to, content, author);
      out.setSelection(TextSelection.create(out.doc, out.mapping.map(to, 1)));
    }
  }
  if (out === null) return null;
  for (const key of KEPT_META) {
    const value: unknown = input.getMeta(key);
    if (value !== undefined) out.setMeta(key, value);
  }
  if (input.scrolledIntoView) out.scrollIntoView();
  return out;
}
