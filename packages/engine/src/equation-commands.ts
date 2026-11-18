/**
 * Equation commands (FE-070 criteria 2 and 3; 03 §4.3, §4.4; 03 §8 I7; 09 §6.3).
 *
 * - An equation is an inline `equation` node or a block `equation_block` node. Both store their
 *   source in `latex`. The inline node has no identifier, so the caller names the node by its
 *   position in the document, as the editing core does for other commands.
 * - Setting the source is one transaction with one attribute step, so one undo takes it back and
 *   the authority sees one commit (criterion 2).
 * - A source longer than 4,000 characters (I7) or nested deeper than 50 braces is refused with its
 *   reason and nothing is dispatched (criterion 3). Length counts Unicode code points, as the CDM
 *   grammar does (model `grammar-check.ts`). The nesting limit is the one the spec names for the
 *   math gate; the measure used here is the deepest brace group, with `\{` and `\}` escaped and not
 *   counted. That measure is the default taken in this module, not a figure the spec gives in full
 *   (see the story notes).
 * - The math gate (I8) is the authority's; this module does not run it. A rejection by the
 *   authority is handled by the sync client, not here (FE-070 criterion 4 stays open).
 * - A scope the user cannot change refuses the write (`read-only`); the core passes the region
 *   guard's answer for the node's position, as `setPageSetup` does.
 */
import type { Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';

/** The longest LaTeX source an equation may store (I7). */
export const LATEX_MAX_CODE_POINTS = 4000;
/** The deepest brace nesting an equation source may have. */
export const MATH_NESTING_MAX = 50;

/** The node types that hold a LaTeX source. */
export const EQUATION_NODES: ReadonlySet<string> = new Set(['equation', 'equation_block']);

export type EquationRefusal = 'not-equation' | 'too-long' | 'too-deep' | 'read-only';

export type EquationResult =
  | { readonly ok: true; readonly pos: number }
  | { readonly ok: false; readonly reason: EquationRefusal };

/** The length of a LaTeX source in Unicode code points. */
export function latexLength(latex: string): number {
  return Array.from(latex).length;
}

/**
 * The deepest brace nesting of a LaTeX source. A backslash escapes the next character, so `\{`
 * and `\}` do not open or close a group, and `\\` does not escape the brace after it.
 */
export function latexNesting(latex: string): number {
  let depth = 0;
  let deepest = 0;
  for (let i = 0; i < latex.length; i++) {
    const c = latex.charAt(i);
    if (c === '\\') {
      i++;
    } else if (c === '{') {
      depth++;
      if (depth > deepest) deepest = depth;
    } else if (c === '}' && depth > 0) {
      depth--;
    }
  }
  return deepest;
}

/** The reason a LaTeX source may not be stored, or null when it may. */
export function latexRefusal(latex: string): 'too-long' | 'too-deep' | null {
  if (latexLength(latex) > LATEX_MAX_CODE_POINTS) return 'too-long';
  if (latexNesting(latex) > MATH_NESTING_MAX) return 'too-deep';
  return null;
}

export type EquationInsertRefusal = 'not-here' | 'read-only';

export type EquationInsertResult =
  | { readonly ok: true; readonly pos: number }
  | { readonly ok: false; readonly reason: EquationInsertRefusal };

/**
 * Inserts an empty equation (FE-136 criterion 5): an inline `equation` at the caret, replacing a
 * selection, or a block `equation_block` after the block the caret is in. The source is empty, which
 * the CDM admits; the shell then opens the math editor on it (the core does, `requestEquationEdit`).
 * `id` names the block (an inline equation has none). Nothing changes on a refusal, and without
 * `dispatch` the call only checks. The result's `pos` is the equation's position after the change.
 */
export function insertEquation(
  state: EditorState,
  display: boolean,
  options: { readonly writable: (pos: number) => boolean; readonly id: string },
  dispatch?: (tr: Transaction) => void,
): EquationInsertResult {
  const { $from } = state.selection;
  const type = state.schema.nodes[display ? 'equation_block' : 'equation'];
  if (!type) return { ok: false, reason: 'not-here' };
  let at = -1;
  if (display) {
    // The innermost ancestor block whose parent takes a block equation after it.
    for (let d = $from.depth; d >= 1 && at < 0; d--) {
      const parent = $from.node(d - 1);
      const index = $from.index(d - 1) + 1;
      if (parent.canReplaceWith(index, index, type)) at = $from.after(d);
    }
  } else if (
    $from.parent.inlineContent &&
    $from.parent.canReplaceWith($from.index(), $from.index(), type)
  ) {
    at = state.selection.from;
  }
  if (at < 0) return { ok: false, reason: 'not-here' };
  if (!options.writable($from.pos)) return { ok: false, reason: 'read-only' };
  if (dispatch) {
    const node = display ? type.create({ id: options.id, latex: '' }) : type.create({ latex: '' });
    const tr = display ? state.tr.insert(at, node) : state.tr.replaceSelectionWith(node);
    dispatch(tr.scrollIntoView());
  }
  return { ok: true, pos: at };
}

/**
 * Stores `latex` on the equation at `pos`. Nothing changes when the node is not an equation, the
 * source is refused, or `writable` refuses the position. With `dispatch` absent the call only
 * checks, so a caller can ask before it commits.
 */
export function setEquationLatex(
  state: EditorState,
  pos: number,
  latex: string,
  options: { readonly writable: (pos: number) => boolean },
  dispatch?: (tr: Transaction) => void,
): EquationResult {
  const node: Node | null = state.doc.nodeAt(pos);
  if (!node || !EQUATION_NODES.has(node.type.name)) return { ok: false, reason: 'not-equation' };
  const refused = latexRefusal(latex);
  if (refused !== null) return { ok: false, reason: refused };
  if (!options.writable(pos)) return { ok: false, reason: 'read-only' };
  if (dispatch) {
    dispatch(state.tr.setNodeAttribute(pos, 'latex', latex));
  }
  return { ok: true, pos };
}
