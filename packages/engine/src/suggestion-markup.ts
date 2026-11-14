/**
 * The decoration sets of the review tools' markup views (FE-046 criterion 4; 02 §5.2; 13 §3): all,
 * simple, none and original. The core builds the set for the view it is asked for; the control that
 * picks the view and its labels are UX's, and the drawing of the classes is the view's and the
 * stylesheet's.
 *
 * The four views read the suggestion marks of the document as follows. The spec names the views and
 * does not say what each shows, so the rules below are the default taken here, recorded in
 * docs/adr/0132-engine-3-backlog-batch.md:
 * - `all`: every suggestion, with a class for its kind (`de-suggest-ins`, `de-suggest-del`,
 *   `de-suggest-fmt`), so the editing surface can tell the kinds apart without colour;
 * - `simple`: the document as it reads once every suggestion is accepted: a deleted run or block is
 *   hidden (`de-suggest-hidden`), and an insertion or formatting change carries the cue
 *   `de-suggest-changed`;
 * - `original`: the document as it reads once every suggestion is rejected: an inserted run or block
 *   is hidden, a deleted run is restored (`de-suggest-restored`), and a formatting change is shown
 *   at its previous value (`de-suggest-before`);
 * - `none`: no decoration at all.
 *
 * Every decoration carries the author and the identifier of the mark that made it
 * (`data-suggestion-user`, `data-suggestion-id`), so that a hover or focus can name the author
 * (FE-046 criterion 2). Inline marks give inline decorations on the run; block marks (on a paragraph,
 * a row or a table) give node decorations, which add no wrapper element (FE-045 criterion 1).
 *
 * Universal logic over ProseMirror state only: no Node.js or browser API.
 */
import type { Node as PMNode } from 'prosemirror-model';

/** The markup views of the review tools (13 §3). */
export type MarkupView = 'all' | 'simple' | 'none' | 'original';

/** The suggestion mark types and the block types that may carry them. */
const SUGGESTION_MARKS: ReadonlySet<string> = new Set(['ins', 'del', 'fmt']);

/** The classes a suggestion of `kind` gets in `view`; an empty list means no decoration. */
export function suggestionClasses(view: MarkupView, kind: 'ins' | 'del' | 'fmt'): string[] {
  switch (view) {
    case 'none':
      return [];
    case 'all':
      return [`de-suggest-${kind}`];
    case 'simple':
      return kind === 'del' ? ['de-suggest-hidden'] : ['de-suggest-changed'];
    case 'original':
      if (kind === 'ins') return ['de-suggest-hidden'];
      return kind === 'del' ? ['de-suggest-restored'] : ['de-suggest-before'];
  }
}

/**
 * One decoration of a markup view, as plain data: a block (node) decoration or an inline one over
 * `[from, to)`, with its attributes. The view turns these into ProseMirror decorations (view/).
 */
export interface SuggestionSpec {
  readonly from: number;
  readonly to: number;
  readonly block: boolean;
  readonly attrs: Readonly<Record<string, string>>;
}

/** The decorations of `doc` for `view` (FE-046 criterion 4), with no view module (FE-121). */
/** How many author tones the stylesheet defines (FE-046 criterion 1). */
export const AUTHOR_TONES = 4;

/**
 * The tone of an author, 0 to `AUTHOR_TONES - 1` (FE-046 criterion 1). Every author has a colour and a
 * second cue, a text-decoration style, both picked by the tone; the same user always gets the same
 * tone. A hash of the identifier, not a rule of the spec: the spec does not name the tones.
 */
export function authorTone(user: string): number {
  let h = 0;
  for (let i = 0; i < user.length; i++) h = (h * 31 + user.charCodeAt(i)) >>> 0;
  return h % AUTHOR_TONES;
}

export function suggestionSpecs(doc: PMNode, view: MarkupView): SuggestionSpec[] {
  if (view === 'none') return [];
  const specs: SuggestionSpec[] = [];
  doc.descendants((node, pos) => {
    for (const mark of node.marks) {
      const kind = mark.type.name;
      if (!SUGGESTION_MARKS.has(kind)) continue;
      const classes = suggestionClasses(view, kind as 'ins' | 'del' | 'fmt');
      if (classes.length === 0) continue;
      specs.push({
        from: pos,
        to: pos + node.nodeSize,
        block: node.isBlock,
        attrs: {
          class: classes.join(' '),
          'data-suggestion-user': String(mark.attrs['user'] ?? ''),
          'data-suggestion-id': String(mark.attrs['id'] ?? ''),
          'data-suggestion-tone': String(authorTone(String(mark.attrs['user'] ?? ''))),
        },
      });
    }
    return true;
  });
  return specs;
}
