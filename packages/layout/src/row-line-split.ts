/**
 * Splits a table row inside one of its paragraphs, at a line (FE-083 criterion 1; 03 §10). It is the
 * fallback of `splitRowAt`, which cuts only between paragraphs: a row whose cells hold one paragraph
 * each has no such boundary, so it is cut between two of its lines instead. A cut at position
 * (p, l) takes, in every cell, the paragraphs before index p whole, and the first l lines of
 * paragraph p; the tail takes the rest. A cell with fewer paragraphs goes whole into the head, and a
 * cell whose paragraph p has fewer than l lines keeps that paragraph whole in the head.
 *
 * Heights follow `tableItem` and `row-split.ts`: a cell's height is its top margin, its paragraphs
 * with their spacing, and its bottom margin. The head keeps the top margin, and its bottom margin
 * only where a cell has nothing left for the tail; the tail keeps the bottom margin and has no top
 * margin. A paragraph cut in two loses its space after in the head and its space before in the tail.
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

/** The first `count` lines of a paragraph, as a paragraph of their own (no space after). */
function headOf(p: ParagraphItem, count: number): ParagraphItem {
  const lines = p.fragment.lines.slice(0, count);
  return {
    ...p,
    spaceAfter: 0,
    fragment: {
      ...p.fragment,
      to: lines[lines.length - 1]?.to ?? p.fragment.from,
      height: lines.reduce((sum, l) => sum + l.height, 0),
      lines,
    },
  };
}

/** The lines of a paragraph from `from` on, rebased to their first line (no space before). */
function tailOf(p: ParagraphItem, from: number): ParagraphItem {
  const lines = p.fragment.lines.slice(from);
  const base = lines[0]?.y ?? 0;
  return {
    ...p,
    spaceBefore: 0,
    keepLines: false,
    pageBreakBefore: false,
    fragment: {
      ...p.fragment,
      from: lines[0]?.from ?? p.fragment.to,
      height: lines.reduce((sum, l) => sum + l.height, 0),
      lines: lines.map((l) => ({ ...l, y: l.y - base })),
    },
  };
}

/** The cell cut at position (p, l), as its head and tail paragraphs. */
function cutCell(
  cell: TableCellItem,
  p: number,
  l: number,
): { head: ParagraphItem[]; tail: ParagraphItem[] } {
  const paras = cell.paragraphs;
  if (p >= paras.length) return { head: [...paras], tail: [] };
  const target = paras[p]!;
  const before = paras.slice(0, p);
  const after = paras.slice(p + 1);
  if (l >= target.fragment.lines.length) return { head: [...before, target], tail: after };
  return {
    head: [...before, headOf(target, l)],
    tail: [tailOf(target, l), ...after],
  };
}

/** The row cut at position (p, l), with the heights its head and tail take. */
function cutAt(
  row: TableRowItem,
  p: number,
  l: number,
): { head: TableRowItem; tail: TableRowItem } {
  const headCells: TableCellItem[] = [];
  const tailCells: TableCellItem[] = [];
  for (const cell of row.cells) {
    const { head: headParas, tail: tailParas } = cutCell(cell, p, l);
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
 * The largest cut of `row` inside a paragraph, at a line, whose head is no taller than `fit`; null
 * when no such cut exists (a row that is not cut, or a head that would hold no line). Positions run
 * in reading order, and a head grows with its position, so the search stops at the first cut that
 * is too tall. Cuts at a paragraph boundary are `splitRowAt`'s and are not tried here.
 */
export function splitRowAtLine(
  row: TableRowItem,
  fit: number,
): { head: TableRowItem; tail: TableRowItem } | null {
  if (row.header || row.cantSplit) return null;
  const longest = Math.max(0, ...row.cells.map((c) => c.paragraphs.length));
  let best: { p: number; l: number } | null = null;
  outer: for (let p = 0; p < longest; p++) {
    const maxLines = Math.max(
      0,
      ...row.cells.map((c) => c.paragraphs[p]?.fragment.lines.length ?? 0),
    );
    for (let l = 1; l < maxLines; l++) {
      if (cutAt(row, p, l).head.height > fit + 1e-6) break outer;
      best = { p, l };
    }
  }
  return best ? cutAt(row, best.p, best.l) : null;
}
