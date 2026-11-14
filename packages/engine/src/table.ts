/**
 * Table structure commands (02 §5.2; 03 §4.3, I6, I7, I10; FE-040).
 *
 * The commands are the project's own: the standard ones know nothing about suggestions. They work
 * on regular tables, where every row has one cell per grid column and no cell spans another. A
 * table with merged cells is left alone (the command is unavailable), because moving rows and
 * columns through spans is not defined here; merge and split are in table-span.ts (FE-040
 * criterion 3).
 *
 * Every command builds one transaction, so the identifier plugin (ids.ts; FE-031) gives the new
 * table, row and cell their identifiers in the same step. A command is unavailable when the caret
 * is outside a table, when the table lies in a scope the access does not let the user change
 * (`canEdit`, read from the trim plugin as the sub-editors do), when the table would pass the 63
 * column limit (I7), or when the change would leave the table with no row or no column.
 * {@link tableRefusal} names the reason, which the core reports in `queryCommand` (FE-040
 * criterion 2).
 */
import type { Node as PMNode, ResolvedPos, Schema } from 'prosemirror-model';
import {
  type Command,
  type EditorState,
  Selection,
  TextSelection,
  type Transaction,
} from 'prosemirror-state';
import type { CommandUnavailable, TableCommandName, TableSpanCommandName } from './api.ts';
import { withinBody } from './body.ts';
import { scopeAt, trimKey } from './trim.ts';

/** The most columns a table may have (I7). */
export const MAX_TABLE_COLUMNS = 63;

/** The row, column and table operations; merge and split are table-span.ts's. */
export type TableOp = Exclude<TableCommandName, TableSpanCommandName>;

/** Every table operation, in the order the registry lists them. */
export const TABLE_OPS: readonly TableOp[] = [
  'insertRowAbove',
  'insertRowBelow',
  'insertColumnLeft',
  'insertColumnRight',
  'deleteRow',
  'deleteColumn',
  'deleteTable',
];

/** Why a table operation is unavailable at the caret. */
export type TableRefusal = Exclude<CommandUnavailable, 'read-only'>;

export function isTableOp(name: string): name is TableOp {
  return (TABLE_OPS as readonly string[]).includes(name);
}

/** Where the caret is inside a table. Positions are the ones before each node. */
export interface CellLocation {
  tablePos: number;
  table: PMNode;
  row: number;
  col: number;
  rowPos: number;
  cellPos: number;
}

/** The table cell around a position, or null when the position is not inside a table cell. */
export function locateCell($pos: ResolvedPos): CellLocation | null {
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name !== 'table') continue;
    // Tables do not nest (I10), so the innermost table is the only one. The caret must be in a row
    // and in a cell of it.
    if (d + 2 > $pos.depth) return null;
    return {
      tablePos: $pos.before(d),
      table: $pos.node(d),
      row: $pos.index(d),
      col: $pos.index(d + 1),
      rowPos: $pos.before(d + 1),
      cellPos: $pos.before(d + 2),
    };
  }
  return null;
}

/** The grid of a table: the column widths in twips (03 §4.3). */
export function gridOf(table: PMNode): number[] {
  return [...(table.attrs['grid'] as number[])];
}

/** The rows of a table in the order they stand. */
function rowsOf(table: PMNode): PMNode[] {
  const rows: PMNode[] = [];
  table.forEach((row) => rows.push(row));
  return rows;
}

/**
 * Whether every row has one cell per grid column and no cell spans another, so that a row or a
 * column is the same cells in every row.
 */
export function isRegular(table: PMNode): boolean {
  const columns = gridOf(table).length;
  let regular = columns >= 1;
  table.forEach((row) => {
    if (row.childCount !== columns) regular = false;
    row.forEach((cell) => {
      if (cell.attrs['colspan'] !== 1 || cell.attrs['rowspan'] !== 1) regular = false;
    });
  });
  return regular;
}

/** The header rows of a table (03 §4.3). */
function headerRowsOf(table: PMNode): number {
  return table.attrs['headerRows'] as number;
}

/** A new cell with one empty paragraph, which the identifier plugin gives an identifier. */
function emptyCell(schema: Schema): PMNode {
  return schema.nodes['table_cell']!.createAndFill()!;
}

function emptyRow(schema: Schema, columns: number): PMNode {
  return schema.nodes['table_row']!.create(
    null,
    Array.from({ length: columns }, () => emptyCell(schema)),
  );
}

/**
 * Whether the scope of a table is one the user may change, as the trim plugin's `canEdit` says.
 * Without the plugin every scope is allowed, as in the headless tests.
 */
function tableEditable(state: EditorState, tablePos: number): boolean {
  const canEdit = trimKey.getState(state);
  return !canEdit || canEdit(scopeAt(state.doc, tablePos));
}

/**
 * Why a table operation is unavailable at the caret, or null when it is available. It builds no
 * transaction, so a query costs one walk of the table.
 */
export function tableRefusal(state: EditorState, op: TableOp): TableRefusal | null {
  const loc = locateCell(state.selection.$from);
  if (!loc) return 'not-in-table';
  if (!tableEditable(state, loc.tablePos)) return 'no-access';
  if (!isRegular(loc.table)) return 'merged-cells';
  switch (op) {
    case 'insertColumnLeft':
    case 'insertColumnRight':
      return gridOf(loc.table).length >= MAX_TABLE_COLUMNS ? 'column-limit' : null;
    case 'deleteRow':
      return loc.table.childCount <= 1 ? 'last-row' : null;
    case 'deleteColumn':
      return gridOf(loc.table).length <= 1 ? 'last-column' : null;
    case 'insertRowAbove':
    case 'insertRowBelow':
    case 'deleteTable':
      return null;
  }
}

/**
 * The transaction that applies a table operation at the caret, or null when the operation is
 * unavailable there ({@link tableRefusal} says why).
 */
export function tableTransaction(state: EditorState, op: TableOp): Transaction | null {
  if (tableRefusal(state, op) !== null) return null;
  const loc = locateCell(state.selection.$from);
  if (!loc) return null;
  const grid = gridOf(loc.table);
  const columns = grid.length;
  const rows = rowsOf(loc.table);
  const headers = headerRowsOf(loc.table);
  const { schema } = state;
  const tr = state.tr;

  switch (op) {
    case 'insertRowAbove':
    case 'insertRowBelow': {
      const above = op === 'insertRowAbove';
      const at = above ? loc.rowPos : loc.rowPos + rows[loc.row]!.nodeSize;
      const index = above ? loc.row : loc.row + 1;
      tr.insert(at, emptyRow(schema, columns));
      // A row inserted among the header rows is a header row too, so the header block stays
      // together at the top of the table.
      if (index < headers) setTableAttrs(tr, loc.tablePos, loc.table, { headerRows: headers + 1 });
      return tr;
    }

    case 'deleteRow': {
      tr.delete(loc.rowPos, loc.rowPos + rows[loc.row]!.nodeSize);
      if (loc.row < headers)
        setTableAttrs(tr, loc.tablePos, loc.table, { headerRows: headers - 1 });
      return tr;
    }

    case 'insertColumnLeft':
    case 'insertColumnRight': {
      const left = op === 'insertColumnLeft';
      const index = left ? loc.col : loc.col + 1;
      // Rows are changed from the last to the first, so that the positions of the rows above
      // stay valid while the cells below them change.
      for (let r = rows.length - 1; r >= 0; r--) {
        tr.insert(rowStart(loc, rows, r) + cellOffset(rows[r]!, index), emptyCell(schema));
      }
      const next = [...grid.slice(0, index), grid[loc.col]!, ...grid.slice(index)];
      setTableAttrs(tr, loc.tablePos, loc.table, { grid: next });
      return tr;
    }

    case 'deleteColumn': {
      for (let r = rows.length - 1; r >= 0; r--) {
        const cell = rows[r]!.child(loc.col);
        const at = rowStart(loc, rows, r) + cellOffset(rows[r]!, loc.col);
        tr.delete(at, at + cell.nodeSize);
      }
      const next = grid.filter((_, i) => i !== loc.col);
      setTableAttrs(tr, loc.tablePos, loc.table, { grid: next });
      return tr;
    }

    case 'deleteTable': {
      const end = loc.tablePos + loc.table.nodeSize;
      const parent = tr.doc.resolve(loc.tablePos).parent;
      // A body or a region needs at least one block: a table that is its only block is replaced
      // by an empty paragraph rather than removed.
      if (parent.childCount === 1) {
        tr.replaceWith(loc.tablePos, end, schema.nodes['paragraph']!.create());
      } else {
        tr.delete(loc.tablePos, end);
      }
      const near = Selection.near(tr.doc.resolve(tr.mapping.map(loc.tablePos)));
      tr.setSelection(near);
      return tr;
    }
  }
}

/** The position before row `r`, given the table as it stood before the transaction. */
function rowStart(loc: CellLocation, rows: readonly PMNode[], r: number): number {
  let at = loc.tablePos + 1;
  for (let i = 0; i < r; i++) at += rows[i]!.nodeSize;
  return at;
}

/** The offset, from the start of a row's content, of the cell at child index `index`. */
function cellOffset(row: PMNode, index: number): number {
  let offset = 1;
  for (let i = 0; i < index; i++) offset += row.child(i).nodeSize;
  return offset;
}

function setTableAttrs(
  tr: Transaction,
  tablePos: number,
  table: PMNode,
  changes: Record<string, unknown>,
): void {
  tr.setNodeMarkup(tablePos, undefined, { ...table.attrs, ...changes });
}

/** A table operation as a command: unavailable (false) where {@link tableRefusal} gives a reason. */
export function tableCommand(op: TableOp): Command {
  return (state, dispatch) => {
    if (!dispatch) return tableRefusal(state, op) === null;
    const tr = tableTransaction(state, op);
    if (!tr) return false;
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/**
 * Inserts a table at the caret's block in the body, with the given grid and row count (03 §4.3).
 * Unavailable inside a table cell, because tables cannot contain tables in version 1 (I10), and
 * outside the body, and when the grid is empty or has more than 63 columns (I7).
 */
export function insertTable(grid: readonly number[], rows: number): Command {
  return (state, dispatch) => {
    if (grid.length < 1 || grid.length > MAX_TABLE_COLUMNS || !Number.isInteger(rows) || rows < 1)
      return false;
    const { $from, from, to } = state.selection;
    if (locateCell($from)) return false;
    if (!withinBody(state.doc, from, to) || $from.depth < 2) return false;
    if (!tableEditable(state, $from.before(2))) return false;
    const { schema } = state;
    const table = schema.nodes['table']!.create(
      { grid: [...grid] },
      Array.from({ length: rows }, () => emptyRow(schema, grid.length)),
    );
    const at = $from.after(2);
    const tr = state.tr.insert(at, table);
    const first = Selection.findFrom(tr.doc.resolve(at + 1), 1, true);
    if (first instanceof TextSelection) tr.setSelection(first);
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

/**
 * Moves the caret to the start of the next (`1`) or previous (`-1`) cell in document order, which
 * is Tab and Shift+Tab in a table (FE-040). Outside a table, or past its last or first cell, it
 * does nothing and returns false, so that the browser's own Tab handling applies.
 */
export function moveToCell(delta: 1 | -1): Command {
  return (state, dispatch) => {
    const loc = locateCell(state.selection.$from);
    if (!loc) return false;
    const cells: number[] = [];
    loc.table.forEach((row, rowOffset) => {
      row.forEach((_cell, cellOff) => {
        cells.push(loc.tablePos + 1 + rowOffset + 1 + cellOff);
      });
    });
    const target = cells[cells.indexOf(loc.cellPos) + delta];
    if (target === undefined) return false;
    const sel = Selection.findFrom(state.doc.resolve(target + 1), 1, true);
    if (!(sel instanceof TextSelection)) return false;
    if (dispatch) dispatch(state.tr.setSelection(sel).scrollIntoView());
    return true;
  };
}
