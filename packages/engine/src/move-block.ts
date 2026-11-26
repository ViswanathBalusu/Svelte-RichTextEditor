/**
 * Moves the block at the caret up or down among its siblings (FE-104 criterion 3). It is the
 * keyboard form of dragging a block: the selected blocks keep their identifiers and their content,
 * and change places with the block above or below them.
 *
 * The blocks that move are the children of the body or of a region that the selection touches, so a
 * caret inside a table cell moves the whole table, and a caret in a paragraph moves the paragraph. A
 * selection that reaches into two containers moves nothing. A block stays in its container: the first
 * block of a region cannot move above it, and the last cannot move below it (`first-block` and
 * `last-block`). The scope of the container must be one the user may change (`no-access`).
 */
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { type Command, type EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import type { CommandUnavailable } from './api.ts';
import { scopeAt, trimKey } from './trim.ts';

export type MoveDirection = 'up' | 'down';

export type MoveBlockRefusal = Extract<
  CommandUnavailable,
  'no-access' | 'first-block' | 'last-block' | 'not-movable'
>;

interface Run {
  /** The depth of the container (the body or a region). */
  containerDepth: number;
  /** Child indexes of the first and last block of the run, in the container. */
  first: number;
  last: number;
  container: PMNode;
  /** The position inside the container before its first child. */
  start: number;
}

/** The blocks of the container that the selection touches, or null where there is none. */
function selectedRun(state: EditorState): Run | null {
  const { $from, $to } = state.selection;
  let depth = $from.depth;
  while (depth >= 1 && !['body', 'region'].includes($from.node(depth).type.name)) depth--;
  if (depth < 1) return null;
  // A selection of a whole block of the container (a node selection) has the container as parent.
  if ($to.depth < depth || $to.node(depth) !== $from.node(depth)) return null;
  const first = $from.index(depth);
  // The selection ends between blocks (a node selection) or inside one; one that ends at the very
  // start of a block does not touch that block.
  const index = $to.index(depth);
  const last =
    $to.depth === depth
      ? index - 1
      : $to.depth === depth + 1 && $to.parentOffset === 0
        ? index - 1
        : index;
  return {
    containerDepth: depth,
    first,
    last: Math.max(first, last),
    container: $from.node(depth),
    start: $from.start(depth),
  };
}

/** Why the blocks at the selection cannot move `direction`, or null when they can. */
export function moveBlockRefusal(
  state: EditorState,
  direction: MoveDirection,
): MoveBlockRefusal | null {
  const run = selectedRun(state);
  if (!run) return 'not-movable';
  const canEdit = trimKey.getState(state);
  if (canEdit && !canEdit(scopeAt(state.doc, run.start))) return 'no-access';
  if (direction === 'up' && run.first === 0) return 'first-block';
  if (direction === 'down' && run.last === run.container.childCount - 1) return 'last-block';
  return null;
}

/** Moves the blocks at the selection one place up or down (FE-104 criterion 3). */
export function moveBlock(direction: MoveDirection): Command {
  return (state, dispatch) => {
    if (moveBlockRefusal(state, direction) !== null) return false;
    if (!dispatch) return true;
    const run = selectedRun(state)!;
    const { container } = run;
    const at = (index: number): number => {
      let pos = run.start;
      for (let i = 0; i < index; i++) pos += container.child(i).nodeSize;
      return pos;
    };
    const moved: PMNode[] = [];
    for (let i = run.first; i <= run.last; i++) moved.push(container.child(i));
    const movedSize = moved.reduce((n, node) => n + node.nodeSize, 0);
    const up = direction === 'up';
    const neighbour = container.child(up ? run.first - 1 : run.last + 1);
    const from = up ? at(run.first - 1) : at(run.first);
    const to = from + neighbour.nodeSize + movedSize;
    const ordered = up ? [...moved, neighbour] : [neighbour, ...moved];
    const tr = state.tr.replaceWith(from, to, Fragment.from(ordered));
    // The selection travels with the blocks.
    const shift = up ? -neighbour.nodeSize : neighbour.nodeSize;
    const doc = tr.doc;
    const clamp = (pos: number): number => Math.max(0, Math.min(doc.content.size, pos));
    const anchor = clamp(state.selection.anchor + shift);
    const head = clamp(state.selection.head + shift);
    const old = state.selection;
    tr.setSelection(
      old instanceof NodeSelection
        ? NodeSelection.create(doc, clamp(old.from + shift))
        : TextSelection.between(doc.resolve(anchor), doc.resolve(head)),
    );
    dispatch(tr.scrollIntoView());
    return true;
  };
}
