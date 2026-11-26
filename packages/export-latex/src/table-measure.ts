/**
 * The measure of table rows that the converter and the preflight take (EXP-039; owner decision
 * 114): heights in points from the editor's own page layout, with no first compile pass. The shape
 * is the one `measureTables` of `@docedit/layout` returns; it is declared here as plain data so
 * that this package does not import the layout engine, and a caller passes the result across.
 *
 * Without a measure nothing is split and nothing is reported: the converter cannot know a height.
 * The measure is an estimate. It comes from the layout's measurer, which is the editor's canvas
 * measurer in the editor and whatever the worker injects, not from the fonts the compile uses, so a
 * row close to the page height may be set differently by LaTeX.
 */
import { splitRow, type RowSplit } from './tables.split.ts';

export interface BlockHeight {
  readonly blockId: string;
  readonly height: number;
}

export interface CellHeights {
  readonly cellId: string;
  readonly blocks: readonly BlockHeight[];
}

export interface RowHeight {
  readonly rowId: string;
  readonly height: number;
  /** The row's height less its tallest cell's blocks: margins and spacing. */
  readonly overhead: number;
  readonly cells: readonly CellHeights[];
}

export interface TableHeights {
  readonly tableId: string;
  /** The page body height where the table starts, in points. */
  readonly body: number;
  readonly rows: readonly RowHeight[];
}

export interface TableMeasure {
  readonly engine: string;
  readonly measurer: string;
  readonly tables: readonly TableHeights[];
}

/** The measured table, or undefined. */
export function tableHeights(
  measure: TableMeasure | undefined,
  tableId: string | null,
): TableHeights | undefined {
  return tableId ? measure?.tables.find((t) => t.tableId === tableId) : undefined;
}

/** Whether a measured row is taller than the page body it starts on. */
export function rowTooTall(table: TableHeights, row: RowHeight): boolean {
  return row.height > table.body;
}

/**
 * How a row that is taller than the page body is cut (EXP-039): at block boundaries, by `splitRow`,
 * with the measured heights. The converter and the preflight both call this, so that the editor
 * reports exactly the row and the blocks the export then splits or cannot split.
 *
 * `cells` holds, for each cell of the row in order, its blocks and the cell's identifier. A part
 * fits when its tallest cell's blocks and the row's overhead are no taller than the body. A block
 * the measure does not know has no height. Null when the table or the row is not measured, the row
 * fits the body, or a cell is not in the measure.
 */
export function planRowSplit<T>(
  measure: TableMeasure | undefined,
  tableId: string | null,
  rowId: string | null,
  cells: readonly { readonly cellId: string | null; readonly blocks: readonly T[] }[],
  blockId: (block: T) => string | null,
): RowSplit<T> | null {
  const table = tableHeights(measure, tableId);
  const row = table?.rows.find((r) => r.rowId === rowId);
  if (!table || !row || !rowTooTall(table, row)) return null;
  const heights = cells.map((c) => row.cells.find((m) => m.cellId === c.cellId));
  if (heights.some((h) => h === undefined)) return null;
  const byBlock = heights.map((h) => new Map(h!.blocks.map((b) => [b.blockId, b.height])));
  const fits = (part: readonly (readonly T[])[]): boolean =>
    row.overhead +
      Math.max(
        0,
        ...part.map((blocks, c) =>
          blocks.reduce((sum, b) => sum + (byBlock[c]!.get(blockId(b) ?? '') ?? 0), 0),
        ),
      ) <=
    table.body;
  return splitRow(
    cells.map((c) => c.blocks),
    fits,
  );
}
