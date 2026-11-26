/**
 * What the table size dialog shows and the arguments it makes (FE-104 criterion 1; 02 §10): the
 * keyboard form of dragging a column border or a row edge. It sets the same widths and height through
 * `setTableSize`, so a change made here stores what the drag would store. No DOM here.
 *
 * Lengths are typed in centimetres and stored in twips. A blank row height means the natural height.
 */
import type { TableSizeView } from '../core-api.ts';
import { MAX_TWIPS, centimetres } from './ruler.ts';
import { parseCentimetres } from './paragraph-dialog.ts';

/** The narrowest column the core accepts, in twips (the core's `MIN_COLUMN_WIDTH`). */
export const MIN_COLUMN_TWIPS = 15;

export interface TableSizeFields {
  /** Centimetres, as typed, one per column. */
  columns: string[];
  /** Centimetres, as typed; blank for the natural height. */
  rowHeight: string;
}

export type TableSizeField = 'rowHeight' | `column${number}`;

/** What the dialog starts with. */
export function tableSizeFields(view: TableSizeView): TableSizeFields {
  return {
    columns: view.columnWidths.map((w) => String(centimetres(w))),
    rowHeight: view.rowHeight === null ? '' : String(centimetres(view.rowHeight)),
  };
}

export interface TableSizeResult {
  /** The arguments for `setTableSize`; null when nothing changes. */
  readonly args: { columnWidths?: number[]; rowHeight?: number | null } | null;
  /** The fields that do not hold a length the CDM can store. */
  readonly invalid: readonly TableSizeField[];
}

/** The arguments that take the table from `view` to the dialog's fields: only what changed. */
export function tableSizeArgs(view: TableSizeView, fields: TableSizeFields): TableSizeResult {
  const invalid: TableSizeField[] = [];
  const widths: number[] = [];
  fields.columns.forEach((text, i) => {
    const twips = parseCentimetres(text);
    if (twips === null || twips < MIN_COLUMN_TWIPS || twips > MAX_TWIPS) invalid.push(`column${i}`);
    else widths.push(twips);
  });
  let rowHeight: number | null | undefined;
  if (fields.rowHeight.trim() === '') rowHeight = null;
  else {
    const twips = parseCentimetres(fields.rowHeight);
    if (twips === null || twips < 1 || twips > MAX_TWIPS) invalid.push('rowHeight');
    else rowHeight = twips;
  }
  if (invalid.length > 0) return { args: null, invalid };
  const args: { columnWidths?: number[]; rowHeight?: number | null } = {};
  if (widths.some((w, i) => w !== view.columnWidths[i])) args.columnWidths = widths;
  if (rowHeight !== undefined && rowHeight !== view.rowHeight) args.rowHeight = rowHeight;
  return { args: Object.keys(args).length > 0 ? args : null, invalid };
}
