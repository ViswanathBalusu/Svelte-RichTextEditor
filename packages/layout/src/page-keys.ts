/**
 * The keyboard commands that move or extend the selection in the page view, computed from the
 * layout tree (02 §9.6; FE-097 criteria 2 and 5; FE-096 criterion 6). The input bridge (FE-098)
 * maps a key event to a `PageKey` with `pageKeyOf` and calls `applyPageKey`; nothing here reads the
 * DOM.
 *
 * Rules, proposed in docs/adr/0120-layout-backlog-batch.md (item 28 for the line ends) and in the
 * Notes of FE-097:
 * - Home and End go to the first and last position of the painted line (`lineBounds`);
 * - the commands for the start and the end of the document go to the first and the last position
 *   of the body lines. The tree's painted lines are the body only (headers, footers, footnotes and
 *   the repeated header rows of a table are not among them), so these commands cannot leave the
 *   body (FE-032);
 * - Shift keeps the anchor and moves the head. A selection that starts inside a region stops at the
 *   region's edge, as in the web view (`clampToRegion` in `packages/engine/src/regions.ts`, FE-038,
 *   07 §7): only selections that start inside are clamped, a selection that starts outside may run
 *   into a region, and a collapsed caret (no Shift) crosses the boundary.
 *
 * The tree does not know regions, so the caller passes `regionOf`: the identifier of the region a
 * block is in, or null for a block outside any region (regions are children of the body, I3).
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */
import {
  lastOffsetOf,
  lineBounds,
  lineIndexFor,
  moveVertical,
  movePage,
  paintedLines,
  type DocPosition,
  type SpanWidth,
} from './caret.ts';
import type { LayoutTree } from './tree.ts';

/** The commands this module handles; Left and Right are the bridge's, which knows block text. */
export type PageKey =
  | 'ArrowUp'
  | 'ArrowDown'
  | 'PageUp'
  | 'PageDown'
  | 'Home'
  | 'End'
  | 'DocumentStart'
  | 'DocumentEnd';

/** The identifier of the region that holds a block, or null for a block outside any region. */
export type RegionOf = (blockId: string) => string | null;

/** A selection in the page view, with the goal x that vertical moves carry on. */
export interface PageSelection {
  readonly anchor: DocPosition;
  readonly head: DocPosition;
  /** The horizontal position, in page points, that Up, Down, Page Up and Page Down keep. */
  readonly goalX: number | undefined;
}

/** What a key event is, as a page-view command: the key and whether Shift extends the selection. */
export interface PageKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * The command a key event stands for, or null when it is not one (the bridge then leaves the key to
 * the input method or the command registry). Ctrl applies to Home and End only; Alt and Meta turn
 * a key into another command.
 */
export function pageKeyOf(
  e: PageKeyEvent,
): { readonly key: PageKey; readonly extend: boolean } | null {
  if (e.altKey || e.metaKey) return null;
  const extend = e.shiftKey;
  switch (e.key) {
    case 'ArrowUp':
    case 'ArrowDown':
    case 'PageUp':
    case 'PageDown':
      return e.ctrlKey ? null : { key: e.key, extend };
    case 'Home':
      return { key: e.ctrlKey ? 'DocumentStart' : 'Home', extend };
    case 'End':
      return { key: e.ctrlKey ? 'DocumentEnd' : 'End', extend };
    default:
      return null;
  }
}

const same = (a: DocPosition, b: DocPosition): boolean =>
  a.blockId === b.blockId && a.offset === b.offset;

/**
 * The first and the last position of the body, from its painted lines. Null for a tree with no body
 * line.
 */
export function bodyEdges(
  tree: LayoutTree,
): { readonly start: DocPosition; readonly end: DocPosition } | null {
  const lines = paintedLines(tree);
  const first = lines[0];
  if (!first) return null;
  const last = lines.length - 1;
  return {
    start: { blockId: first.blockId, offset: first.from },
    end: { blockId: lines[last]!.blockId, offset: lastOffsetOf(lines, last) },
  };
}

/**
 * Where the head of a selection may be, given its anchor (FE-096 criterion 6). A selection that
 * starts inside a region and reaches outside it stops at the first or the last position of that
 * region's lines; every other selection is returned as it is. Used for keys and for a pointer drag
 * (the head from `hitTest`).
 */
export function clampHead(
  tree: LayoutTree,
  anchor: DocPosition,
  head: DocPosition,
  regionOf: RegionOf,
): DocPosition {
  if (same(anchor, head)) return head;
  const lines = paintedLines(tree);
  const ia = lineIndexFor(lines, anchor);
  const ih = lineIndexFor(lines, head);
  if (ia < 0 || ih < 0) return head;
  const region = regionOf(lines[ia]!.blockId);
  if (region === null || regionOf(lines[ih]!.blockId) === region) return head;
  let first = -1;
  let last = -1;
  lines.forEach((line, i) => {
    if (regionOf(line.blockId) !== region) return;
    if (first < 0) first = i;
    last = i;
  });
  if (ih < first) return { blockId: lines[first]!.blockId, offset: lines[first]!.from };
  if (ih > last) return { blockId: lines[last]!.blockId, offset: lastOffsetOf(lines, last) };
  return head;
}

/**
 * Applies a key to a selection. Without `extend` the result is a caret at the new position; with it
 * the anchor stays and the head moves, clamped to the anchor's region when `regionOf` is given. A
 * block with no painted line leaves the selection as it was.
 */
export function applyPageKey(
  tree: LayoutTree,
  selection: PageSelection,
  key: PageKey,
  extend: boolean,
  span: SpanWidth,
  regionOf?: RegionOf,
): PageSelection {
  const from = selection.head;
  let pos: DocPosition = from;
  let goalX = selection.goalX;
  switch (key) {
    case 'ArrowUp':
    case 'ArrowDown': {
      const moved = moveVertical(tree, from, key === 'ArrowUp' ? 'up' : 'down', goalX, span);
      pos = moved.pos;
      goalX = moved.goalX;
      break;
    }
    case 'PageUp':
    case 'PageDown': {
      const moved = movePage(tree, from, key === 'PageUp' ? 'up' : 'down', goalX, span);
      pos = moved.pos;
      goalX = moved.goalX;
      break;
    }
    case 'Home':
    case 'End': {
      const bounds = lineBounds(tree, from);
      if (bounds) pos = key === 'Home' ? bounds.start : bounds.end;
      goalX = undefined;
      break;
    }
    case 'DocumentStart':
    case 'DocumentEnd': {
      const edges = bodyEdges(tree);
      if (edges) pos = key === 'DocumentStart' ? edges.start : edges.end;
      goalX = undefined;
      break;
    }
  }
  if (!extend) return { anchor: pos, head: pos, goalX };
  const head = regionOf ? clampHead(tree, selection.anchor, pos, regionOf) : pos;
  return { anchor: selection.anchor, head, goalX };
}
