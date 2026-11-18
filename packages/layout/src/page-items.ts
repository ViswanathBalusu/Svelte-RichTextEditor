/**
 * The item and page types that pagination shares with its helpers: `notes.ts` (FE-084) and
 * `row-split.ts` (FE-083). They live in this leaf module so that the helpers do not import
 * `paginate.ts`, which imports them (no import cycle; `.dependency-cruiser.cjs` no-circular).
 * `paginate.ts` re-exports every type here, so the package's public names do not change.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import type { FlowInsets } from './flow.ts';
import type { LayoutPage, ParagraphFragment } from './tree.ts';

export interface PageMargins {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface ParagraphItem {
  readonly kind: 'paragraph';
  readonly fragment: ParagraphFragment;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  readonly keepNext: boolean;
  readonly keepLines: boolean;
  readonly pageBreakBefore: boolean;
  readonly widowControl: boolean;
  /** Footnote references in the paragraph, by CDM offset (FE-084). Absent when there are none. */
  readonly notes?: readonly NoteRef[];
}

/** A footnote reference: the CDM offset of its mark and the footnote it names (FE-084). */
export interface NoteRef {
  readonly offset: number;
  readonly id: string;
}

/** A footnote as pagination sees it: its paragraphs, already broken into lines (FE-084). */
export interface NoteItem {
  readonly id: string;
  readonly paragraphs: readonly ParagraphItem[];
}

/** A cell of a table row: its paragraphs, broken at the cell's width (FE-083). */
export interface TableCellItem {
  readonly cellId: string;
  /** The cell's left edge, from the table's left edge, in points. */
  readonly x: number;
  readonly width: number;
  readonly margins: FlowInsets;
  readonly paragraphs: readonly ParagraphItem[];
  /** The cell's CDM range inside its table (FE-078 criterion 2). */
  readonly from?: number;
  readonly to?: number;
}

/**
 * A table row. A row that does not fit is cut between its cells' paragraphs (`splitRowAt`), and the
 * row moves whole when no such cut exists (FE-083, see `placeTable` in paginate.ts).
 */
export interface TableRowItem {
  readonly rowId: string;
  /** Whether the row is a header row, repeated at the top of a continuation piece. */
  readonly header: boolean;
  readonly cantSplit: boolean;
  /** The row's height: its tallest cell with the cell margins, or the row's own height rule. */
  readonly height: number;
  readonly cells: readonly TableCellItem[];
  /** The row's CDM range inside its table; a cut row's pieces keep the whole row's (FE-078). */
  readonly from?: number;
  readonly to?: number;
}

export interface PaginatedPage extends LayoutPage {
  /** The page's number in its section's numbering. */
  readonly number: number;
  /** The number as text, in the section's `pageNumberFormat`. */
  readonly label: string;
  readonly orientation: 'portrait' | 'landscape';
  readonly margins: PageMargins;
  /** Present and true when the page's typeset pin was dropped: estimated until the next compile. */
  readonly estimated?: true;
}

/** What `placeNotes` needs of a page of a pass (FE-084). */
export interface PageFrame {
  /** The body height with no footnote area. */
  readonly full: number;
  /** The most the page's footnote area may take: the space below the page's body. */
  readonly area: number;
  /** The bottom inset without the footnote area: the footer and the margin. */
  readonly bottomFree: number;
  /** The page number format, for a page the footnotes add. */
  readonly format: string;
}

/** The `from` and `to` of a node that has them, as properties to spread into a copy (FE-078). */
export function rangeOf(node: { readonly from?: number; readonly to?: number }): {
  from?: number;
  to?: number;
} {
  return {
    ...(node.from !== undefined ? { from: node.from } : {}),
    ...(node.to !== undefined ? { to: node.to } : {}),
  };
}
