/**
 * Hit testing, caret and selection geometry, and movement by line, all computed from the layout tree
 * (02 §9.6; FE-096 and FE-097). Nothing here reads the DOM: the page view draws what these functions
 * return, and the keyboard commands call them.
 *
 * Conventions, decided here and recorded in docs/adr/0120-layout-backlog-batch.md:
 * - the body is the paragraph fragments of `page.fragments`; headers, footers and footnotes are not
 *   hit tested (they are edited in panels, 02 §7);
 * - a line covers the offsets `from` (inclusive) to `to` (exclusive); an offset at a wrap point
 *   belongs to the line that starts there, and the end of a block belongs to its last line;
 * - so a line that is not the last of its block has `to - 1` as its last position (before the
 *   character at the wrap, usually the trailing space): a click beyond its end, Up or Down to it
 *   with a goal x beyond its end, and End on it all land there, and stay on that line;
 * - the tree holds no glyph advances, so the width of text inside a line comes from an injected
 *   `SpanWidth` (the same measurement as the paint, FE-079); a line's `x` and `y` are page points.
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import type { LayoutFragment, LayoutTree } from './tree.ts';

/** A position in the document: a CDM block identifier and an offset inside its text. */
export interface DocPosition {
  readonly blockId: string;
  readonly offset: number;
}

/** The painted width, in points, of the text of one block between two of its offsets. */
export type SpanWidth = (blockId: string, from: number, to: number) => number;

/**
 * The box of a table cell on a page, in page points: the cell's `x` and `width` and its row's `y`
 * and `height`. One object per laid-out cell, shared by every line of that cell.
 */
export interface CellBox {
  readonly cellId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A body line on a page, with its position in page points. */
export interface PaintedLine {
  /** Index of the page in `tree.pages`. */
  readonly page: number;
  readonly blockId: string;
  readonly from: number;
  readonly to: number;
  /** The left edge of the line, in page points. */
  readonly x: number;
  /** The top edge of the line, in page points. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * The table cells the line is in, outermost first; empty for a line outside any table. Hit
   * testing uses them to keep a click in a cell inside that cell (FE-096 criterion 2).
   */
  readonly cells: readonly CellBox[];
}

export interface CaretGeometry {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

export interface SelectionRect {
  readonly page: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The body lines of every page, in document order (pages in order, then the fragments on each). The
 * paragraphs of a table are included, cell by cell in reading order (FE-096 criterion 2, table cell).
 * Each line records the boxes of the cells it is in. A repeated header row is a copy of a row on an
 * earlier page, so it is not a place to click, and its lines are left out.
 */
export function paintedLines(tree: LayoutTree): PaintedLine[] {
  const out: PaintedLine[] = [];
  const add = (
    fragments: readonly LayoutFragment[],
    page: number,
    cells: readonly CellBox[],
  ): void => {
    for (const f of fragments) {
      if (f.kind === 'paragraph') {
        for (const l of f.lines)
          out.push({
            page,
            blockId: f.blockId,
            from: l.from,
            to: l.to,
            x: f.x + l.x,
            y: f.y + l.y,
            width: l.width,
            height: l.height,
            cells,
          });
      } else if (f.kind === 'table') {
        for (const row of f.rows) {
          if (row.repeated) continue;
          for (const cell of row.cells) {
            const box: CellBox = {
              cellId: cell.cellId,
              x: cell.x,
              y: row.y,
              width: cell.width,
              height: row.height,
            };
            add(cell.fragments, page, [...cells, box]);
          }
        }
      }
    }
  };
  tree.pages.forEach((page, index) => add(page.fragments, index, []));
  return out;
}

/** Whether a page point is inside a cell box: left and top edges included, right and bottom not. */
function inCell(box: CellBox, x: number, y: number): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

/**
 * The lines of a page that a click at (x, y) may land on. When the point is inside a table cell
 * that holds lines, only that cell's lines are candidates (the innermost such cell for a nested
 * table), so blank space in a cell never resolves to a neighbouring cell's text. Otherwise (outside
 * any table, in a cell with no line and not nested in one that has, or in a part of a table that no
 * cell box covers, such as the lower rows of a vertically merged cell, whose box is its first row's)
 * every line of the page is a candidate.
 */
function hitCandidates(
  lines: readonly PaintedLine[],
  page: number,
  x: number,
  y: number,
): number[] {
  const onPage: number[] = [];
  let cell: CellBox | null = null;
  let cellDepth = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.page !== page) continue;
    onPage.push(i);
    for (let depth = cellDepth + 1; depth < line.cells.length; depth++) {
      const box = line.cells[depth]!;
      if (inCell(box, x, y)) {
        cell = box;
        cellDepth = depth;
      }
    }
  }
  if (cell === null) return onPage;
  const chosen = cell;
  return onPage.filter((i) => lines[i]!.cells.includes(chosen));
}

/** The index of the line that holds a position, or -1 when the block has no line. */
function lineIndexFor(lines: readonly PaintedLine[], pos: DocPosition): number {
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.blockId !== pos.blockId) continue;
    if (pos.offset >= l.from && pos.offset < l.to) return i;
    if (pos.offset === l.to) end = i;
  }
  return end;
}

/**
 * The last position that belongs to line `i`: its `to` when that offset maps back to it (the last
 * line of its block), otherwise `to - 1`, since `to` is the start of the next line. Never less than
 * the line's `from`.
 */
function lastOffsetOf(lines: readonly PaintedLine[], i: number): number {
  const line = lines[i]!;
  if (lineIndexFor(lines, { blockId: line.blockId, offset: line.to }) === i) return line.to;
  return Math.max(line.from, line.to - 1);
}

/**
 * The offset of the position nearest to page point `x` inside line `i`. The candidates are the
 * offsets that belong to that line, so the result always maps back to it (`lineIndexFor`).
 */
function offsetAtX(lines: readonly PaintedLine[], i: number, x: number, span: SpanWidth): number {
  const line = lines[i]!;
  const last = lastOffsetOf(lines, i);
  const rel = x - line.x;
  let best = line.from;
  let bestDistance = Infinity;
  for (let o = line.from; o <= last; o++) {
    const w = o === line.from ? 0 : span(line.blockId, line.from, o);
    const distance = Math.abs(rel - w);
    if (distance < bestDistance) {
      best = o;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * The document position nearest to a page point (FE-096 criterion 1). The line is the one nearest
 * vertically (a point in a gap goes to the nearer line, the earlier one on a tie); horizontally the
 * position is the nearest offset of that line, so a point left of the text gives the line's start,
 * and a point beyond its end gives its last position (`to` for the last line of a block, `to - 1`
 * for a wrapped line, so the caret stays on the line clicked). A point inside a table cell only
 * considers that cell's lines (FE-096 criterion 2), so a click in the blank space of a cell, beside
 * or below its text, gives a position in that cell. Returns null for a page with no body line.
 */
export function hitTest(
  tree: LayoutTree,
  page: number,
  x: number,
  y: number,
  span: SpanWidth,
): DocPosition | null {
  const lines = paintedLines(tree);
  let chosen = -1;
  let chosenDistance = Infinity;
  let chosenAcross = Infinity;
  for (const i of hitCandidates(lines, page, x, y)) {
    const line = lines[i]!;
    const distance =
      y < line.y ? line.y - y : y > line.y + line.height ? y - (line.y + line.height) : 0;
    // Lines level with each other (two columns, or two cells of one table row) are told apart by
    // how far the point is from the line's text across the page, so the line the point is in wins.
    const across =
      x < line.x ? line.x - x : x > line.x + line.width ? x - (line.x + line.width) : 0;
    if (distance < chosenDistance || (distance === chosenDistance && across < chosenAcross)) {
      chosen = i;
      chosenDistance = distance;
      chosenAcross = across;
    }
  }
  if (chosen < 0) return null;
  return { blockId: lines[chosen]!.blockId, offset: offsetAtX(lines, chosen, x, span) };
}

/**
 * The caret for a collapsed selection at a position (FE-096 criterion 3): its page, the x of the
 * position inside its line, and the line's top and height. Null when the block has no line.
 */
export function caretGeometry(
  tree: LayoutTree,
  pos: DocPosition,
  span: SpanWidth,
): CaretGeometry | null {
  const lines = paintedLines(tree);
  const i = lineIndexFor(lines, pos);
  if (i < 0) return null;
  const line = lines[i]!;
  const offsetWidth = pos.offset === line.from ? 0 : span(line.blockId, line.from, pos.offset);
  return { page: line.page, x: line.x + offsetWidth, y: line.y, height: line.height };
}

/**
 * The rectangles of a selection between two positions (FE-096 criterion 4): one per line it
 * crosses, computed from the layout tree and so drawn per line and per page. The positions may come
 * in either order. An empty selection gives no rectangle.
 */
export function selectionRects(
  tree: LayoutTree,
  anchor: DocPosition,
  head: DocPosition,
  span: SpanWidth,
): SelectionRect[] {
  const lines = paintedLines(tree);
  const ia = lineIndexFor(lines, anchor);
  const ih = lineIndexFor(lines, head);
  if (ia < 0 || ih < 0) return [];
  const forward = ia <= ih;
  const startPos = forward ? anchor : head;
  const endPos = forward ? head : anchor;
  const first = Math.min(ia, ih);
  const last = Math.max(ia, ih);
  const out: SelectionRect[] = [];
  for (let i = first; i <= last; i++) {
    const line = lines[i]!;
    const a = i === first ? startPos.offset : line.from;
    const b = i === last ? endPos.offset : line.to;
    if (b <= a) continue;
    const left = a === line.from ? 0 : span(line.blockId, line.from, a);
    const right = b === line.from ? 0 : span(line.blockId, line.from, b);
    out.push({
      page: line.page,
      x: line.x + left,
      y: line.y,
      width: right - left,
      height: line.height,
    });
  }
  return out;
}

/**
 * Moves the caret one painted line up or down, keeping its horizontal position (FE-097 criterion
 * 1). The goal x is taken from the caret the first time and carried on by the caller, so a short
 * line does not pull the caret left for good. A goal x beyond the end of the target line gives that
 * line's last position, which stays on it even when the line is wrapped. Moves across pages: the
 * first line of the next page follows the last line of this one. At the first or last line the
 * caret does not move.
 */
export function moveVertical(
  tree: LayoutTree,
  pos: DocPosition,
  direction: 'up' | 'down',
  goalX: number | undefined,
  span: SpanWidth,
): { readonly pos: DocPosition; readonly goalX: number | undefined } {
  const lines = paintedLines(tree);
  const i = lineIndexFor(lines, pos);
  if (i < 0) return { pos, goalX };
  const j = direction === 'down' ? i + 1 : i - 1;
  if (j < 0 || j >= lines.length) return { pos, goalX };
  const here = lines[i]!;
  const x =
    goalX ?? here.x + (pos.offset === here.from ? 0 : span(here.blockId, here.from, pos.offset));
  return {
    pos: { blockId: lines[j]!.blockId, offset: offsetAtX(lines, j, x, span) },
    goalX: x,
  };
}

/**
 * The start and end positions of the painted line that holds a position (FE-097 criterion 2: the
 * targets of Home and End). The end is the line's last position, so on a wrapped line it is
 * `to - 1` and stays on that line. Null when the block has no line.
 */
export function lineBounds(
  tree: LayoutTree,
  pos: DocPosition,
): { readonly start: DocPosition; readonly end: DocPosition } | null {
  const lines = paintedLines(tree);
  const i = lineIndexFor(lines, pos);
  if (i < 0) return null;
  const line = lines[i]!;
  return {
    start: { blockId: line.blockId, offset: line.from },
    end: { blockId: line.blockId, offset: lastOffsetOf(lines, i) },
  };
}

/**
 * Moves the caret by one page of the layout (FE-097 criterion 3): to the body line on the next page
 * in `direction` (the previous one for `up`) whose top edge is nearest the caret's, so the caret
 * keeps its height on the page. Pages with no body line are passed over. With no such page, the
 * caret goes to the first or last body line of the document, and stays put when it is there
 * already. The horizontal position follows `moveVertical`: the goal x is taken from the caret the
 * first time and carried on by the caller. The layout holds no viewport, so this moves by a page of
 * the layout and not by a screen; a screenful needs the painter's visible height (FE-090). Decided
 * in docs/adr/0120-layout-backlog-batch.md (item 29, proposed).
 */
export function movePage(
  tree: LayoutTree,
  pos: DocPosition,
  direction: 'up' | 'down',
  goalX: number | undefined,
  span: SpanWidth,
): { readonly pos: DocPosition; readonly goalX: number | undefined } {
  const lines = paintedLines(tree);
  const i = lineIndexFor(lines, pos);
  if (i < 0) return { pos, goalX };
  const here = lines[i]!;
  const x =
    goalX ?? here.x + (pos.offset === here.from ? 0 : span(here.blockId, here.from, pos.offset));
  const step = direction === 'down' ? 1 : -1;
  let target = -1;
  for (let p = here.page + step; p >= 0 && p < tree.pages.length && target < 0; p += step) {
    let nearest = -1;
    let nearestDistance = Infinity;
    lines.forEach((line, k) => {
      if (line.page !== p) return;
      const distance = Math.abs(line.y - here.y);
      if (distance < nearestDistance) {
        nearest = k;
        nearestDistance = distance;
      }
    });
    target = nearest;
  }
  if (target < 0) {
    if (direction === 'down' && i === lines.length - 1) return { pos, goalX };
    if (direction === 'up' && i === 0) return { pos, goalX };
    target = direction === 'down' ? lines.length - 1 : 0;
  }
  return {
    pos: { blockId: lines[target]!.blockId, offset: offsetAtX(lines, target, x, span) },
    goalX: x,
  };
}
