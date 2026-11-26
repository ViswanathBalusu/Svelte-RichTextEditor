/**
 * Column widths and row height of the table at the caret, set by a command (FE-104 criterion 1; 03
 * §4.3, I6). It is the keyboard form of dragging a column border or a row edge: the stored values are
 * the ones a drag would store, `grid` (the widths in twips, one per column) and `height` and
 * `heightRule` of the row (twips).
 *
 * - `columnWidths` replaces the whole grid, so the number of widths is the number of columns (I6);
 *   a width is a whole number of twips from {@link MIN_COLUMN_WIDTH} to the CDM's largest length;
 * - `rowHeight` sets the height of the caret's row, which then holds at least that height (the rule
 *   becomes `atLeast`, so the row never clips its text); `null` returns the row to its natural
 *   height.
 *
 * A table with merged cells takes both: the grid keeps its length and the spans refer to columns, not
 * to widths. The command is unavailable outside a table, where the scope is one the user may not
 * change, and for a value outside the CDM's range (`bad-size`).
 */
import type { Command, EditorState } from 'prosemirror-state';
import type { CommandUnavailable } from './api.ts';
import { gridOf, locateCell } from './table.ts';
import { scopeAt, trimKey } from './trim.ts';

/** The narrowest column a command sets, in twips (one CSS pixel at 96 to the inch). */
export const MIN_COLUMN_WIDTH = 15;

/** The CDM's largest length, in twips (`ULENGTH`). */
export const MAX_LENGTH = 31680;

export interface TableSizeArgs {
  /** The width of every column, in twips. */
  readonly columnWidths?: readonly number[];
  /** The height of the caret's row, in twips, or null for the natural height. */
  readonly rowHeight?: number | null;
}

export type TableSizeRefusal = Extract<
  CommandUnavailable,
  'not-in-table' | 'no-access' | 'bad-size' | 'no-column'
>;

function whole(value: unknown, min: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= MAX_LENGTH
  );
}

/** Why the sizes cannot be set at the caret, or null when they can. Builds no transaction. */
export function tableSizeRefusal(
  state: EditorState,
  args: TableSizeArgs | undefined,
): TableSizeRefusal | null {
  const loc = locateCell(state.selection.$from);
  if (!loc) return 'not-in-table';
  const canEdit = trimKey.getState(state);
  if (canEdit && !canEdit(scopeAt(state.doc, loc.tablePos))) return 'no-access';
  if (!args || (args.columnWidths === undefined && args.rowHeight === undefined)) return 'bad-size';
  const widths = args.columnWidths;
  if (widths !== undefined) {
    if (widths.length !== gridOf(loc.table).length) return 'no-column';
    if (!widths.every((w) => whole(w, MIN_COLUMN_WIDTH))) return 'bad-size';
  }
  const height = args.rowHeight;
  if (height !== undefined && height !== null && !whole(height, 1)) return 'bad-size';
  return null;
}

/** Sets the column widths and the row height of the table at the caret (FE-104 criterion 1). */
export function setTableSize(args: TableSizeArgs): Command {
  return (state, dispatch) => {
    if (tableSizeRefusal(state, args) !== null) return false;
    if (!dispatch) return true;
    const loc = locateCell(state.selection.$from)!;
    const tr = state.tr;
    if (args.rowHeight !== undefined) {
      const row = loc.table.child(loc.row);
      const height = args.rowHeight;
      // A height set here is the least the row has: a row never clips its text.
      const rule = height === null ? 'auto' : 'atLeast';
      if ((row.attrs['height'] ?? null) !== height || row.attrs['heightRule'] !== rule)
        tr.setNodeMarkup(loc.rowPos, undefined, { ...row.attrs, height, heightRule: rule });
    }
    if (args.columnWidths !== undefined) {
      const same = gridOf(loc.table).every((w, i) => w === args.columnWidths![i]);
      if (!same)
        tr.setNodeMarkup(loc.tablePos, undefined, {
          ...loc.table.attrs,
          grid: [...args.columnWidths],
        });
    }
    if (tr.docChanged) dispatch(tr.scrollIntoView());
    return true;
  };
}

/** What the caret's table holds now: the dialog's starting values. Null outside a table. */
export interface TableSizeInfo {
  /** The width of every column, in twips. */
  readonly columnWidths: readonly number[];
  /** The height of the caret's row, in twips, or null for the natural height. */
  readonly rowHeight: number | null;
  /** The caret's row and column, zero based. */
  readonly row: number;
  readonly column: number;
  /** Whether `setTableSize` may change this table now. */
  readonly editable: boolean;
}

export function tableSizeInfo(state: EditorState, locked: boolean): TableSizeInfo | null {
  const loc = locateCell(state.selection.$from);
  if (!loc) return null;
  const rowHeight = loc.table.child(loc.row).attrs['height'];
  return {
    columnWidths: gridOf(loc.table),
    rowHeight: typeof rowHeight === 'number' ? rowHeight : null,
    row: loc.row,
    column: loc.col,
    editable:
      !locked &&
      tableSizeRefusal(state, { rowHeight: typeof rowHeight === 'number' ? rowHeight : null }) ===
        null,
  };
}
