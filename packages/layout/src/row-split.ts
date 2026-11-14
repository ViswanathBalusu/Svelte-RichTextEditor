/**
 * Splits a table row at paragraph boundaries (FE-083 criteria 1 and 4; 03 §10). A row that does not
 * fit the space left in its column is cut between two paragraphs of its cells: the head goes on the
 * current piece and the tail on the next one. The same cut index applies to every cell of the row;
 * a cell with fewer paragraphs is taken whole into the head. A row whose cells hold a single
 * paragraph each cannot be cut, and the caller moves it whole (a limit: a line-level split is not
 * built).
 *
 * Heights follow `tableItem`: a cell's height is its top margin, its paragraphs with their spacing,
 * and its bottom margin. The head keeps the top margin, and its bottom margin only where a cell has
 * no paragraphs left for the tail; the tail keeps the bottom margin and has no top margin.
 */
import type { FlowInsets } from './flow.ts';
import type { ParagraphItem, TableCellItem, TableRowItem } from './page-items.ts';

const NO_MARGINS: FlowInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The height of a cell's paragraphs with their spacing, between the given top and bottom margins. */
function stackHeight(paragraphs: readonly ParagraphItem[], top: number, bottom: number): number {
  let h = top + bottom;
  for (const p of paragraphs) h += p.spaceBefore + p.fragment.height + p.spaceAfter;
  return h;
}

/** The row cut so that each cell keeps its first `index` paragraphs in the head. */
function cut(row: TableRowItem, index: number): { head: TableRowItem; tail: TableRowItem } {
  const headCells: TableCellItem[] = [];
  const tailCells: TableCellItem[] = [];
  for (const cell of row.cells) {
    const headParas = cell.paragraphs.slice(0, index);
    const tailParas = cell.paragraphs.slice(index);
    const headMargins: FlowInsets = {
      top: cell.margins.top,
      right: cell.margins.right,
      bottom: tailParas.length === 0 ? cell.margins.bottom : 0,
      left: cell.margins.left,
    };
    const tailMargins: FlowInsets =
      tailParas.length === 0
        ? { ...NO_MARGINS }
        : {
            top: 0,
            right: cell.margins.right,
            bottom: cell.margins.bottom,
            left: cell.margins.left,
          };
    headCells.push({
      cellId: cell.cellId,
      x: cell.x,
      width: cell.width,
      margins: headMargins,
      paragraphs: headParas,
    });
    tailCells.push({
      cellId: cell.cellId,
      x: cell.x,
      width: cell.width,
      margins: tailMargins,
      paragraphs: tailParas,
    });
  }
  const height = (cells: readonly TableCellItem[]): number =>
    Math.max(0, ...cells.map((c) => stackHeight(c.paragraphs, c.margins.top, c.margins.bottom)));
  const head: TableRowItem = {
    rowId: row.rowId,
    header: false,
    cantSplit: false,
    height: height(headCells),
    cells: headCells,
  };
  const tail: TableRowItem = {
    rowId: row.rowId,
    header: false,
    cantSplit: false,
    height: height(tailCells),
    cells: tailCells,
  };
  return { head, tail };
}

/**
 * The largest cut of `row` at a paragraph boundary whose head is no taller than `fit`, or null when
 * no cut leaves a head with a paragraph and a tail with one. Heads grow with the index, so the
 * search stops at the first cut that is too tall.
 */
export function splitRowAt(
  row: TableRowItem,
  fit: number,
): { head: TableRowItem; tail: TableRowItem } | null {
  if (row.header || row.cantSplit) return null;
  const longest = Math.max(0, ...row.cells.map((c) => c.paragraphs.length));
  let best = 0;
  for (let i = 1; i < longest; i++) {
    if (cut(row, i).head.height > fit + 1e-6) break;
    best = i;
  }
  return best === 0 ? null : cut(row, best);
}
