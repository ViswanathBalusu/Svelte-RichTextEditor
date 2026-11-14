/**
 * The four markup views over tracked suggestions (UX-035 criterion 1; 13 §5 names the views, 08 §14).
 *
 * The spec names `all`, `simple`, `none` and `original` but does not define them. The definitions
 * here are the editor's inference, recorded in ADR 0233 and needing the designer's confirmation:
 *   - all:      every run, with its change (insertion, deletion or formatting) and author;
 *   - simple:   the accepted text, with a marker before each run that carries a change;
 *   - none:     the text as if every suggestion were accepted (deletions gone);
 *   - original: the text as if every suggestion were rejected (insertions gone).
 *
 * A view is a read of the runs. `viewSegments` changes nothing it is given and sends nothing; the
 * document and the commit log are not touched by choosing a view (UX-035 criterion 2 is the
 * shell's, and only its pure part is checked here).
 */

export type MarkupView = 'all' | 'simple' | 'none' | 'original';

export const MARKUP_VIEWS: readonly MarkupView[] = ['all', 'simple', 'none', 'original'];

export type ChangeKind = 'insertion' | 'deletion' | 'formatting';

/** One tracked suggestion over a run of text: its kind, who made it, and its identifier. */
export interface Change {
  readonly id: string;
  readonly kind: ChangeKind;
  readonly author: string;
}

/** A run of text in the document. `change` is null for text no suggestion touches. */
export interface Run {
  readonly text: string;
  readonly change: Change | null;
}

export type Segment =
  | { readonly kind: 'text'; readonly text: string; readonly change: Change | null }
  | { readonly kind: 'marker'; readonly changeId: string };

/** The segments a view shows for the runs, in document order. */
export function viewSegments(runs: readonly Run[], view: MarkupView): Segment[] {
  const out: Segment[] = [];
  for (const run of runs) {
    const change = run.change;
    switch (view) {
      case 'all':
        if (run.text.length > 0) out.push({ kind: 'text', text: run.text, change });
        break;
      case 'simple':
        if (change !== null) out.push({ kind: 'marker', changeId: change.id });
        if (change?.kind !== 'deletion' && run.text.length > 0) {
          out.push({ kind: 'text', text: run.text, change: null });
        }
        break;
      case 'none':
        if (change?.kind !== 'deletion' && run.text.length > 0) {
          out.push({ kind: 'text', text: run.text, change: null });
        }
        break;
      case 'original':
        if (change?.kind !== 'insertion' && run.text.length > 0) {
          out.push({ kind: 'text', text: run.text, change: null });
        }
        break;
    }
  }
  return out;
}

/** The plain text a view shows, with markers left out. */
export function viewText(runs: readonly Run[], view: MarkupView): string {
  return viewSegments(runs, view)
    .map((s) => (s.kind === 'text' ? s.text : ''))
    .join('');
}
