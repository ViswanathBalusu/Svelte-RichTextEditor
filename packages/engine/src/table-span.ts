/**
 * Merge and split of table cells (02 §5.2; 03 §4.3, I6; FE-040 criterion 3).
 *
 * A table row holds only the cells that start in it. A cell with `rowspan` above 1 covers slots in
 * the rows below, which hold no cell for those slots. The module reads the rows as a map of slots
 * (`cellEntries`), changes the map, and writes the rows again (`rebuildTable`), so that the
 * `colspan`, `rowspan` and `grid` of the table stay consistent (I6) after every change.
 *
 * Merge takes a rectangle of whole cells, given in grid columns and rows. The top-left cell keeps
 * its identifier and receives the spans; the other cells of the rectangle are removed, and their
 * non-empty blocks are appended to it in reading order (Word's rule; the spec does not say what
 * happens to the content of merged cells, see FE-040 Notes). Split resets a merged cell to one
 * slot and adds empty cells for the slots it covered.
 *
 * Both are entries of the core's command table (`mergeCells` with `cells`, and `splitCell`), so
 * `exec` and `queryCommand` run and query them through {@link mergeCellsCommand},
 * {@link splitCellCommand} and {@link spanRefusal}. Both are unavailable (with a reason) where the
 * scope is not editable, where the caret is outside a table, and where the result would leave a
 * row with no cell (the table schema needs at least one cell in each row).
 */
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { type Command, type EditorState, Selection, type Transaction } from 'prosemirror-state';
import type { CellRectArgs, CommandUnavailable } from './api.ts';
import { locateCell } from './table.ts';
import { scopeAt, trimKey } from './trim.ts';

/** A rectangle of grid slots, zero based and inclusive at both ends. */
export type CellRect = CellRectArgs;

/** Why a span change is refused: a subset of the reasons `queryCommand` gives. */
export type SpanRefusal = Extract<
  CommandUnavailable,
  | 'not-in-table'
  | 'no-access'
  | 'bad-rect'
  | 'span-crosses'
  | 'empty-row'
  | 'single-cell'
  | 'not-merged'
>;

export type SpanResult = { ok: true; tr: Transaction } | { ok: false; reason: SpanRefusal };

/** A cell of a table with the slot it starts at and its spans, read from the rows as they stand. */
export interface Entry {
  cell: PMNode;
  /** The row the cell is in (its origin row). */
  row: number;
  /** The grid column the cell starts at. */
  col: number;
  colspan: number;
  rowspan: number;
  /** The document position before the cell. */
  pos: number;
}

/** The position before the cell at child index `index` of row `row`. */
function cellPosOf(table: PMNode, tablePos: number, row: number, index: number): number {
  let pos = tablePos + 1;
  for (let r = 0; r < row; r++) pos += table.child(r).nodeSize;
  pos += 1;
  for (let j = 0; j < index; j++) pos += table.child(row).child(j).nodeSize;
  return pos;
}

/**
 * The cells of a table as slots, or null when the rows do not cover the grid exactly (a span that
 * runs past the grid or the last row, or a slot covered twice or not at all).
 */
export function cellEntries(table: PMNode, tablePos: number, columns: number): Entry[] | null {
  const rows = table.childCount;
  const covered: boolean[][] = Array.from({ length: rows }, () =>
    Array<boolean>(columns).fill(false),
  );
  const entries: Entry[] = [];
  for (let r = 0; r < rows; r++) {
    const row = table.child(r);
    let c = 0;
    for (let k = 0; k < row.childCount; k++) {
      const cell = row.child(k);
      const colspan = cell.attrs['colspan'];
      const rowspan = cell.attrs['rowspan'];
      if (typeof colspan !== 'number' || typeof rowspan !== 'number') return null;
      while (c < columns && covered[r]![c]) c++;
      if (c + colspan > columns || r + rowspan > rows) return null;
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          if (covered[r + dr]![c + dc]) return null;
          covered[r + dr]![c + dc] = true;
        }
      }
      entries.push({
        cell,
        row: r,
        col: c,
        colspan,
        rowspan,
        pos: cellPosOf(table, tablePos, r, k),
      });
      c += colspan;
    }
  }
  for (const line of covered) if (line.some((v) => !v)) return null;
  return entries;
}

/** A cell with one empty paragraph, the content a new or emptied cell has. */
function isEmptyCell(cell: PMNode): boolean {
  return (
    cell.childCount === 1 &&
    cell.child(0).type.name === 'paragraph' &&
    cell.child(0).content.size === 0
  );
}

/**
 * The table node rebuilt from its final cells. Each cell is given with its row and grid column.
 * Null when a row would have no cell.
 */
export function rebuildTable(
  schema: Schema,
  table: PMNode,
  finals: readonly { row: number; col: number; cell: PMNode }[],
): PMNode | null {
  const byRow: { col: number; cell: PMNode }[][] = Array.from(
    { length: table.childCount },
    () => [],
  );
  for (const f of finals) byRow[f.row]!.push({ col: f.col, cell: f.cell });
  const rows: PMNode[] = [];
  for (let r = 0; r < table.childCount; r++) {
    const cells = byRow[r]!.sort((a, b) => a.col - b.col).map((x) => x.cell);
    if (cells.length === 0) return null;
    rows.push(table.child(r).type.create(table.child(r).attrs, cells));
  }
  return schema.nodes['table']!.create(table.attrs, rows);
}

function tableEditable(state: EditorState, tablePos: number): boolean {
  const canEdit = trimKey.getState(state);
  return !canEdit || canEdit(scopeAt(state.doc, tablePos));
}

/** The table at the caret with its slots, or the reason there is none. */
function caretTable(
  state: EditorState,
): { tablePos: number; table: PMNode; entries: Entry[]; columns: number } | SpanRefusal {
  const loc = locateCell(state.selection.$from);
  if (!loc) return 'not-in-table';
  if (!tableEditable(state, loc.tablePos)) return 'no-access';
  const columns = (loc.table.attrs['grid'] as number[]).length;
  const entries = cellEntries(loc.table, loc.tablePos, columns);
  if (!entries) return 'span-crosses';
  return { tablePos: loc.tablePos, table: loc.table, entries, columns };
}

/** The selection at the start of the first block of the cell at (row, index), after a change. */
function selectionIn(tr: Transaction, tablePos: number, row: number, index: number): Selection {
  const table = tr.doc.nodeAt(tablePos)!;
  const pos = cellPosOf(table, tablePos, row, index);
  return Selection.near(tr.doc.resolve(pos + 1));
}

/**
 * Merges the cells of a rectangle of the caret's table into one. The rectangle must hold whole
 * cells only: a cell that starts outside it and reaches into it is refused (`span-crosses`).
 */
export function mergeTableCells(state: EditorState, rect: CellRect): SpanResult {
  const found = caretTable(state);
  if (typeof found === 'string') return { ok: false, reason: found };
  const { tablePos, table, entries, columns } = found;
  const rows = table.childCount;
  const { top, left, bottom, right } = rect;
  if (
    !Number.isInteger(top) ||
    !Number.isInteger(left) ||
    !Number.isInteger(bottom) ||
    !Number.isInteger(right) ||
    top < 0 ||
    left < 0 ||
    bottom >= rows ||
    right >= columns ||
    top > bottom ||
    left > right
  ) {
    return { ok: false, reason: 'bad-rect' };
  }
  if (top === bottom && left === right) return { ok: false, reason: 'single-cell' };
  const inside = (e: Entry) =>
    e.col >= left &&
    e.col + e.colspan - 1 <= right &&
    e.row >= top &&
    e.row + e.rowspan - 1 <= bottom;
  const touches = (e: Entry) =>
    e.col <= right &&
    e.col + e.colspan - 1 >= left &&
    e.row <= bottom &&
    e.row + e.rowspan - 1 >= top;
  for (const e of entries) {
    if (touches(e) && !inside(e)) return { ok: false, reason: 'span-crosses' };
  }
  const members = entries.filter(inside).sort((a, b) => a.row - b.row || a.col - b.col);
  const anchorEntry = members[0]!;
  const sources = members.filter((e) => !isEmptyCell(e.cell));
  const contributing = sources.length > 0 ? sources : [anchorEntry];
  const blocks: PMNode[] = [];
  for (const e of contributing) e.cell.forEach((block) => blocks.push(block));
  const anchor = anchorEntry.cell.type.create(
    { ...anchorEntry.cell.attrs, colspan: right - left + 1, rowspan: bottom - top + 1 },
    blocks,
  );
  const finals: { row: number; col: number; cell: PMNode }[] = [];
  for (const e of entries) {
    if (e === anchorEntry) finals.push({ row: e.row, col: e.col, cell: anchor });
    else if (!inside(e)) finals.push({ row: e.row, col: e.col, cell: e.cell });
  }
  const next = rebuildTable(state.schema, table, finals);
  if (!next || !cellEntries(next, tablePos, columns)) return { ok: false, reason: 'empty-row' };
  const tr = state.tr.replaceWith(tablePos, tablePos + table.nodeSize, next);
  const index = finals.filter((f) => f.row === top && f.col < left).length;
  tr.setSelection(selectionIn(tr, tablePos, top, index));
  return { ok: true, tr };
}

/**
 * Splits the merged cell at the caret back into one slot. The cell keeps its content and
 * identifier; each slot it covered gets an empty cell.
 */
export function splitTableCell(state: EditorState): SpanResult {
  const found = caretTable(state);
  if (typeof found === 'string') return { ok: false, reason: found };
  const { tablePos, table, entries, columns } = found;
  const loc = locateCell(state.selection.$from);
  const origin = entries.find((e) => e.pos === loc?.cellPos);
  if (!origin) return { ok: false, reason: 'not-in-table' };
  if (origin.colspan === 1 && origin.rowspan === 1) return { ok: false, reason: 'not-merged' };
  const finals: { row: number; col: number; cell: PMNode }[] = [];
  for (const e of entries) {
    if (e === origin) {
      finals.push({
        row: e.row,
        col: e.col,
        cell: e.cell.type.create({ ...e.cell.attrs, colspan: 1, rowspan: 1 }, e.cell.content),
      });
    } else {
      finals.push({ row: e.row, col: e.col, cell: e.cell });
    }
  }
  const schema = state.schema;
  for (let r = origin.row; r < origin.row + origin.rowspan; r++) {
    for (let c = origin.col; c < origin.col + origin.colspan; c++) {
      if (r === origin.row && c === origin.col) continue;
      finals.push({
        row: r,
        col: c,
        cell: schema.nodes['table_cell']!.createAndFill({ colspan: 1, rowspan: 1 })!,
      });
    }
  }
  const next = rebuildTable(schema, table, finals);
  if (!next || !cellEntries(next, tablePos, columns)) return { ok: false, reason: 'empty-row' };
  const tr = state.tr.replaceWith(tablePos, tablePos + table.nodeSize, next);
  const index = finals.filter((f) => f.row === origin.row && f.col < origin.col).length;
  tr.setSelection(selectionIn(tr, tablePos, origin.row, index));
  return { ok: true, tr };
}

/**
 * Why `mergeCells` (with `rect`) or `splitCell` is unavailable at the caret, or null when it is
 * available. The core reports it in `queryCommand`. A rectangle that is not an object of four
 * numbers is `bad-rect`, since `exec` may be called from a script with any value.
 */
export function spanRefusal(
  state: EditorState,
  name: 'mergeCells' | 'splitCell',
  rect?: unknown,
): SpanRefusal | null {
  const result =
    name === 'splitCell'
      ? splitTableCell(state)
      : isCellRect(rect)
        ? mergeTableCells(state, rect)
        : (caretRefusal(state) ?? ({ ok: false, reason: 'bad-rect' } as const));
  return result.ok ? null : result.reason;
}

/** Whether a value has the four numeric fields of a {@link CellRect}. */
export function isCellRect(value: unknown): value is CellRect {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return ['top', 'left', 'bottom', 'right'].every((k) => typeof v[k] === 'number');
}

/** The caret's own refusal (outside a table, no access, a broken grid) as a result, or null. */
function caretRefusal(state: EditorState): SpanResult | null {
  const found = caretTable(state);
  return typeof found === 'string' ? { ok: false, reason: found } : null;
}

/** A merge of a rectangle as a command: unavailable (false) where {@link mergeTableCells} refuses. */
export function mergeCellsCommand(rect: CellRect): Command {
  return (state, dispatch) => {
    const result = mergeTableCells(state, rect);
    if (!result.ok) return false;
    dispatch?.(result.tr.scrollIntoView());
    return true;
  };
}

/** A split of the caret's merged cell as a command: unavailable (false) where it is refused. */
export function splitCellCommand(): Command {
  return (state, dispatch) => {
    const result = splitTableCell(state);
    if (!result.ok) return false;
    dispatch?.(result.tr.scrollIntoView());
    return true;
  };
}
