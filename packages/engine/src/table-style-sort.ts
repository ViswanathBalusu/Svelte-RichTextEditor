/**
 * Table styles and row sorting (FE-131; 13 §2; 03 §4.3, §4.5).
 *
 * - A table style sets the `style` attribute of the table at the caret to a table style the document
 *   defines (`kind: 'table'`, 03 §4.1). Borders and shading then come from the model's cascade, where
 *   a cell or table override still wins; this module stores the reference and does not compute the
 *   cascade. `null` removes the reference.
 * - Sorting a column reorders the body rows (the rows after the header rows, 03 §4.3) by that
 *   column's text. Header rows stay at the top. Rows are moved as the same nodes, so their identifiers
 *   stay with them and the change is one transaction, which one undo reverts (FE-131 criterion 5).
 * - Sorting is unavailable in a table with merged cells, with the reason `merged-cells`. That is
 *   stricter than the story asks (it names only merged cells that cross the sorted rows); the
 *   stricter rule is the one this module can check cheaply (see the story's Notes).
 * - Empty cells sort after every non-empty cell, in both directions; equal keys keep their order.
 *   Text compares with a numeric-aware collator, so "10" follows "9". These are the decisions of
 *   this module, recorded in docs/adr/0131-engine-2-backlog-batch.md, not the spec's.
 *
 * The commands are unavailable (false) where {@link tableStyleRefusal} or {@link sortRefusal} gives a
 * reason, and build no transaction in that case.
 */
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import { stylesOf } from './styles.ts';
import { isRegular, locateCell, type CellLocation } from './table.ts';
import { scopeAt, trimKey } from './trim.ts';

export type SortDirection = 'ascending' | 'descending';

/** Why a table style cannot be set at the caret. */
export type TableStyleRefusal = 'not-in-table' | 'no-access' | 'unknown-style';

/** Why rows cannot be sorted at the caret. */
export type SortRefusal = 'not-in-table' | 'no-access' | 'merged-cells' | 'no-column';

/** Whether the scope of a table is one the user may change (as `table.ts` checks it). */
function tableEditable(state: EditorState, tablePos: number): boolean {
  const canEdit = trimKey.getState(state);
  return !canEdit || canEdit(scopeAt(state.doc, tablePos));
}

/** Whether `id` is a table style the document defines. */
function isTableStyle(state: EditorState, id: string): boolean {
  const attrs = stylesOf(state.doc).styles.get(id);
  return attrs !== undefined && (attrs['kind'] ?? 'paragraph') === 'table';
}

/** Why a table style cannot be set at the caret, or null when it can. Builds no transaction. */
export function tableStyleRefusal(
  state: EditorState,
  styleId: string | null,
): TableStyleRefusal | null {
  const loc = locateCell(state.selection.$from);
  if (!loc) return 'not-in-table';
  if (!tableEditable(state, loc.tablePos)) return 'no-access';
  if (styleId !== null && !isTableStyle(state, styleId)) return 'unknown-style';
  return null;
}

/** Sets (or with `null`, clears) the table style of the table at the caret (FE-131 criterion 1). */
export function setTableStyle(styleId: string | null): Command {
  return (state, dispatch) => {
    if (tableStyleRefusal(state, styleId) !== null) return false;
    const loc = locateCell(state.selection.$from)!;
    if (dispatch && (loc.table.attrs['style'] ?? null) !== styleId) {
      dispatch(state.tr.setNodeAttribute(loc.tablePos, 'style', styleId).scrollIntoView());
    }
    return true;
  };
}

/**
 * Why the rows of the table at the caret cannot be sorted by `column` (default: the caret's column),
 * or null when they can. Builds no transaction.
 */
export function sortRefusal(state: EditorState, column?: number): SortRefusal | null {
  const loc = locateCell(state.selection.$from);
  if (!loc) return 'not-in-table';
  if (!tableEditable(state, loc.tablePos)) return 'no-access';
  if (!isRegular(loc.table)) return 'merged-cells';
  const col = column ?? loc.col;
  if (!Number.isInteger(col) || col < 0 || col >= loc.table.child(0).childCount) return 'no-column';
  return null;
}

const collator = new Intl.Collator('en-GB', { numeric: true, sensitivity: 'base' });

/** The order of the body rows after a sort, as indexes into those rows. */
export function sortedOrder(keys: readonly string[], direction: SortDirection): number[] {
  const order = keys.map((_, i) => i);
  order.sort((a, b) => {
    const ka = keys[a]!;
    const kb = keys[b]!;
    if ((ka === '') !== (kb === '')) return ka === '' ? 1 : -1;
    if (ka !== '') {
      const c = collator.compare(ka, kb);
      if (c !== 0) return direction === 'ascending' ? c : -c;
    }
    return a - b;
  });
  return order;
}

/** The rows of a table in the order they stand. */
function rowsOf(table: PMNode): PMNode[] {
  const rows: PMNode[] = [];
  table.forEach((row) => rows.push(row));
  return rows;
}

/** The position before the row at `index`, given the table as it stands. */
function rowPosition(loc: CellLocation, rows: readonly PMNode[], index: number): number {
  let at = loc.tablePos + 1;
  for (let i = 0; i < index; i++) at += rows[i]!.nodeSize;
  return at;
}

/**
 * Sorts the body rows of the table at the caret by one column (FE-131 criterion 2). The header rows
 * stay where they are. Unavailable (false) where {@link sortRefusal} gives a reason.
 */
export function sortTableRows(direction: SortDirection, column?: number): Command {
  return (state, dispatch) => {
    if (sortRefusal(state, column) !== null) return false;
    const loc = locateCell(state.selection.$from)!;
    const col = column ?? loc.col;
    const rows = rowsOf(loc.table);
    const headers = loc.table.attrs['headerRows'] as number;
    const body = rows.slice(headers);
    const keys = body.map((row) => row.child(col).textContent.trim());
    const order = sortedOrder(keys, direction);
    const unchanged = order.every((from, to) => from === to);
    if (unchanged || body.length < 2) return true;
    if (dispatch) {
      const start = rowPosition(loc, rows, headers);
      const end = loc.tablePos + loc.table.nodeSize - 1;
      const sorted = Fragment.fromArray(order.map((i) => body[i]!));
      dispatch(state.tr.replaceWith(start, end, sorted).scrollIntoView());
    }
    return true;
  };
}
