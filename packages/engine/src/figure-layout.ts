/**
 * Figure size and layout (FE-132 criteria 2 and 3; 03 §4.3 `figure`, §8 I10).
 *
 * - Resizing stores `width` and `height` of a figure in twips, which are the twentieths of a point
 *   (03 §4.3). With the aspect ratio locked (the default), a width sets the height in proportion and
 *   a height sets the width; when both are given and the ratio is locked, the width is used and the
 *   height is worked out from it. Unlocked, the given values are stored as they are. A value outside
 *   1 to 31680 twips is refused, as the CDM allows (I6).
 * - Placement (`here` or `float`) and alignment are stored on the figure. A floating figure inside a
 *   table cell is refused (I10); the refusal is `float-in-cell`.
 * - The command is unavailable (false) where {@link figureRefusal} gives a reason, and then builds no
 *   transaction. Scope access is the trim plugin's `canEdit`, as in `table.ts`.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import { scopeAt, trimKey } from './trim.ts';

/** The largest length the CDM stores for a display size, in twips (03 §4.3). */
export const MAX_FIGURE_TWIPS = 31680;

export type FigurePlacement = 'here' | 'float';
export type FigureAlign = 'start' | 'center' | 'end';

export type FigureRefusal =
  'not-a-figure' | 'no-access' | 'bad-size' | 'bad-placement' | 'float-in-cell';

export interface FigureSize {
  width?: number;
  height?: number;
  /** Keep the aspect ratio (default true). */
  lockAspect?: boolean;
}

export interface FigureLayout {
  placement?: FigurePlacement;
  align?: FigureAlign | null;
}

/** The figure node at `pos`, and whether it stands inside a table cell. */
function figureAt(
  state: EditorState,
  pos: number,
  orImage = false,
): { node: PMNode; inCell: boolean } | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  if (node.type.name !== 'figure' && !(orImage && node.type.name === 'image')) return null;
  const $pos = state.doc.resolve(pos);
  let inCell = false;
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name === 'table_cell') inCell = true;
  }
  return { node, inCell };
}

function editable(state: EditorState, pos: number): boolean {
  const canEdit = trimKey.getState(state);
  return !canEdit || canEdit(scopeAt(state.doc, pos));
}

function validTwips(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_FIGURE_TWIPS
  );
}

/**
 * The new width and height of a figure for a size change, or null when the values are not allowed.
 * `current` is the figure's size before the change.
 */
export function sizeFor(
  current: { width: number; height: number },
  size: FigureSize,
): { width: number; height: number } | null {
  const lock = size.lockAspect ?? true;
  let width = current.width;
  let height = current.height;
  if (lock) {
    if (size.width !== undefined) {
      if (!validTwips(size.width)) return null;
      width = size.width;
      height = Math.round((size.width * current.height) / current.width);
    } else if (size.height !== undefined) {
      if (!validTwips(size.height)) return null;
      height = size.height;
      width = Math.round((size.height * current.width) / current.height);
    }
  } else {
    if (size.width !== undefined) {
      if (!validTwips(size.width)) return null;
      width = size.width;
    }
    if (size.height !== undefined) {
      if (!validTwips(size.height)) return null;
      height = size.height;
    }
  }
  if (!validTwips(width) || !validTwips(height)) return null;
  return { width, height };
}

/** Why a figure cannot be resized or laid out as asked, or null when it can. Builds no transaction. */
export function figureRefusal(
  state: EditorState,
  pos: number,
  change: { size?: FigureSize; layout?: FigureLayout },
): FigureRefusal | null {
  const { size, layout } = change;
  // A size change also applies to an inline image (FE-132 criterion 2); a layout change does not.
  const fig = figureAt(state, pos, layout === undefined);
  if (!fig) return 'not-a-figure';
  if (!editable(state, pos)) return 'no-access';
  if (size) {
    const current = {
      width: fig.node.attrs['width'] as number,
      height: fig.node.attrs['height'] as number,
    };
    if (sizeFor(current, size) === null) return 'bad-size';
  }
  if (layout) {
    const placement = layout.placement ?? (fig.node.attrs['placement'] as FigurePlacement);
    if (placement !== 'here' && placement !== 'float') return 'bad-placement';
    if (placement === 'float' && fig.inCell) return 'float-in-cell';
  }
  return null;
}

/** Stores a new size on the figure or inline image at `pos` (FE-132 criterion 2). */
export function resizeFigure(pos: number, size: FigureSize): Command {
  return (state, dispatch) => {
    if (figureRefusal(state, pos, { size }) !== null) return false;
    const node = state.doc.nodeAt(pos)!;
    const next = sizeFor(
      { width: node.attrs['width'] as number, height: node.attrs['height'] as number },
      size,
    )!;
    if (dispatch) {
      const tr: Transaction = state.tr.setNodeMarkup(pos, undefined, {
        ...node.attrs,
        width: next.width,
        height: next.height,
      });
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Stores the placement and alignment of the figure at `pos` (FE-132 criterion 3). */
export function setFigureLayout(pos: number, layout: FigureLayout): Command {
  return (state, dispatch) => {
    if (figureRefusal(state, pos, { layout }) !== null) return false;
    const node = state.doc.nodeAt(pos)!;
    if (dispatch) {
      const attrs = { ...node.attrs };
      if (layout.placement !== undefined) attrs['placement'] = layout.placement;
      if (layout.align !== undefined) attrs['align'] = layout.align;
      dispatch(state.tr.setNodeMarkup(pos, undefined, attrs).scrollIntoView());
    }
    return true;
  };
}
