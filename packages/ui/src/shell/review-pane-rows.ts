/**
 * The review pane's rows (UX-037 criteria 1 and 5; 13 section 3 and 5; 08 section 14).
 *
 * Pure: the pane renders these rows, and the core supplies the positions and commit times. The
 * kind labels, the pane's chrome and the excerpt's ellipsis are the string tables' and the view's;
 * nothing here builds text.
 *
 * - The rows are the suggestions in document order, filtered to one author when one is chosen
 *   (`listSuggestions`, UX-037 criterion 2). An assistant author is filtered like any other.
 * - Each row carries the kind, the author, the server time of the introducing commit and the
 *   excerpt, and an accessible name made of those four parts (UX-037 criterion 5). An empty excerpt
 *   is `null` rather than an empty string, so the view can show "no text" instead of nothing.
 *
 * Not built here: the live update (`applySuggestionChange` in review-bulk-live.ts), the pane's
 * rendering, and the keys that move to a suggestion (UX-037 criterion 3).
 */
import { listSuggestions, type SuggestionKind, type SuggestionRow } from './review-rules.ts';

export interface ReviewPaneRow {
  readonly id: string;
  readonly kind: SuggestionKind;
  readonly author: string;
  readonly committedAt: string;
  /** The suggested text, or null when the suggestion has none (a block change, say). */
  readonly excerpt: string | null;
  readonly position: number;
  /** The four parts a screen reader names the item with (UX-037 criterion 5). */
  readonly accessibleName: {
    readonly kind: SuggestionKind;
    readonly author: string;
    readonly committedAt: string;
    readonly excerpt: string;
  };
}

/** The pane's rows: `author` null lists everyone's suggestions. The input is not changed. */
export function reviewPaneRows(
  rows: readonly SuggestionRow[],
  author: string | null = null,
): ReviewPaneRow[] {
  return listSuggestions(rows, author).map((r) => ({
    id: r.id,
    kind: r.kind,
    author: r.author,
    committedAt: r.committedAt,
    excerpt: r.excerpt.length > 0 ? r.excerpt : null,
    position: r.position,
    accessibleName: {
      kind: r.kind,
      author: r.author,
      committedAt: r.committedAt,
      excerpt: r.excerpt,
    },
  }));
}
