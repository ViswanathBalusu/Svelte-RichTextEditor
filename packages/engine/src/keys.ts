/**
 * The editing core's key bindings (02 §5.2; 13 §4), as plain commands: the web view installs them
 * with `prosemirror-keymap` before the base keymap, and tests run them without a view (FE-121).
 */
import { baseKeymap, chainCommands, toggleMark } from 'prosemirror-commands';
import type { Schema } from 'prosemirror-model';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import { moveToBodyEdge, selectAllInBody, stopAtBodyEdge } from './body.ts';
import { insertLineBreak } from './footnote.ts';
import { stopAtRegionEdge } from './regions.ts';
import { trimKey, trimmedDeletion } from './trim.ts';
import { enterAtStart, enterWithNextStyle } from './styles.ts';
import { moveToCell } from './table.ts';
import { exitEmptyListItem, listIndentAtStart } from './list-commands.ts';

/**
 * Deletes the editable text of a selection that spans protected content, and nothing else (FE-037).
 * It does nothing when no protected scope lies in the selection, so the ordinary deletion runs.
 */
export const deleteTrimmed: Command = (state, dispatch) => {
  const canEdit = trimKey.getState(state);
  if (!canEdit) return false;
  const tr = trimmedDeletion(state, canEdit);
  if (!tr) return false;
  dispatch?.(tr);
  return true;
};

/** Bindings that run before ProseMirror's base keymap in the body view. */
export function coreKeys(schema: Schema): Record<string, Command> {
  return {
    'Mod-a': selectAllInBody,
    'Mod-Home': moveToBodyEdge('start'),
    'Mod-End': moveToBodyEdge('end'),
    'Shift-Mod-Home': moveToBodyEdge('start', true),
    'Shift-Mod-End': moveToBodyEdge('end', true),
    // FE-032 and FE-038: nothing is joined with definitions, stories or across a region boundary.
    Backspace: chainCommands(deleteTrimmed, stopAtBodyEdge('start'), stopAtRegionEdge('start')),
    Delete: chainCommands(deleteTrimmed, stopAtBodyEdge('end'), stopAtRegionEdge('end')),
    Enter: chainCommands(exitEmptyListItem, enterAtStart, enterWithNextStyle),
    // FE-040: Tab and Shift+Tab move between cells; outside a table they fall through to a list
    // item's level at its start (FE-130).
    Tab: chainCommands(moveToCell(1), listIndentAtStart(1)),
    'Shift-Tab': chainCommands(moveToCell(-1), listIndentAtStart(-1)),
    // Undo and redo (Mod-z, Shift-Mod-z, Mod-y) are not bound here: the core binds them itself,
    // through the command registry and its checks (core.ts; FE-049 criterion 7).
    'Mod-b': toggleMark(schema.marks['bold']!, { value: true }),
    'Mod-i': toggleMark(schema.marks['italic']!, { value: true }),
    'Shift-Enter': insertLineBreak(schema),
  };
}

/**
 * Runs what a key press runs in the body view: the core's binding, then the base keymap's, the
 * first that applies. For tests without a browser (FE-121).
 */
export function press(
  schema: Schema,
  key: string,
  state: EditorState,
  dispatch: (tr: Transaction) => void,
): boolean {
  const core = coreKeys(schema)[key];
  if (core?.(state, dispatch)) return true;
  const base = baseKeymap[key];
  return base ? base(state, dispatch) : false;
}
