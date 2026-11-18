/**
 * Character value commands (FE-128 criteria 2, 3, 5 and 6; 03 §5, §4.5; 01 §8).
 *
 * - Font family, size, colour, highlight and language are set as marks with one value each. A value
 *   of `null` removes the mark, so the same command clears a value. Sizes are integers in twentieths
 *   of a point (01 §8), colours `#RRGGBB`, languages BCP 47 tags.
 * - A character style sets the `charStyle` mark and leaves the direct formatting marks alone.
 * - Clear formatting removes the direct formatting marks and keeps the paragraph style, character
 *   styles, links, suggestions and preserved runs.
 *
 * A collapsed caret changes the stored marks, so the next typed text carries them (as the toggles
 * do). The core asks for an editable selection before it runs these commands (`#needsEditableSelection`).
 */
import type { Mark, MarkType, Node as PMNode, Schema } from 'prosemirror-model';
import type { Command, EditorState } from 'prosemirror-state';
import type { CommandArgs, CommandName } from './api.ts';
import { stylesOf } from './styles.ts';

/** The commands of this module. */
export type ValueFormatName =
  'fontFamily' | 'fontSize' | 'color' | 'highlight' | 'lang' | 'charStyle' | 'clearFormatting';

export const VALUE_FORMAT_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'fontFamily',
  'fontSize',
  'color',
  'highlight',
  'lang',
  'charStyle',
  'clearFormatting',
]);

/** The highlight colours of the CDM (03 §5), in the order the schema lists them. */
export const HIGHLIGHT_COLOURS: readonly string[] = [
  'yellow',
  'green',
  'cyan',
  'magenta',
  'blue',
  'red',
  'darkBlue',
  'darkCyan',
  'darkGreen',
  'darkMagenta',
  'darkRed',
  'darkYellow',
  'darkGray',
  'lightGray',
  'black',
  'white',
];

/** The same family grammar the web view checks before it applies a font (view-support.ts). */
const FONT_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/;
const COLOUR = /^#[0-9A-Fa-f]{6}$/;
/** A BCP 47 tag, checked for shape only; the registry of tags is not in the core. */
const LANGUAGE_TAG = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;
/** Sizes in twentieths of a point: 1 pt to 1638 pt, the range the web view accepts. */
const SIZE_MIN = 20;
const SIZE_MAX = 32760;

/** The direct formatting marks that clear formatting removes (03 §5). */
export const DIRECT_MARKS: readonly string[] = [
  'bold',
  'italic',
  'underline',
  'strike',
  'smallCaps',
  'allCaps',
  'vertAlign',
  'fontFamily',
  'fontSize',
  'color',
  'highlight',
  'lang',
  'hidden',
];

/** The marks the format painter copies: the direct formatting and the character style (UX-009). */
export const PAINTED_MARKS: readonly string[] = [...DIRECT_MARKS, 'charStyle'];

export function isValueFormat(name: CommandName): name is ValueFormatName {
  return VALUE_FORMAT_COMMANDS.has(name);
}

/**
 * The value a command was given, or undefined when the command was not given its argument. `null`
 * is a value: it removes the mark.
 */
function givenValue(name: ValueFormatName, args: CommandArgs): unknown {
  switch (name) {
    case 'fontFamily':
      return args.fontFamily;
    case 'fontSize':
      return args.fontSize;
    case 'color':
      return args.color;
    case 'highlight':
      return args.highlight;
    case 'lang':
      return args.lang;
    case 'charStyle':
      return args.charStyle;
    case 'clearFormatting':
      return null;
  }
}

/** The checked value to store, `null` to remove the mark, or undefined when it is not allowed. */
function checkedValue(name: ValueFormatName, value: unknown): string | number | null | undefined {
  if (value === null) return null;
  switch (name) {
    case 'fontFamily':
      return typeof value === 'string' && FONT_FAMILY.test(value) ? value : undefined;
    case 'fontSize':
      return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= SIZE_MIN &&
        value <= SIZE_MAX
        ? value
        : undefined;
    case 'color':
      // Stored in upper case, as the rest of the model writes `#RRGGBB` (01 §8).
      return typeof value === 'string' && COLOUR.test(value) ? value.toUpperCase() : undefined;
    case 'highlight':
      return typeof value === 'string' && HIGHLIGHT_COLOURS.includes(value) ? value : undefined;
    case 'lang':
      return typeof value === 'string' && LANGUAGE_TAG.test(value) ? value : undefined;
    case 'charStyle':
      return typeof value === 'string' && value !== '' ? value : undefined;
    case 'clearFormatting':
      return null;
  }
}

/** Whether the document defines `id` as a character style (03 §4.1). */
function isCharacterStyle(doc: PMNode, id: string): boolean {
  const attrs = stylesOf(doc).styles.get(id);
  return attrs !== undefined && attrs['kind'] === 'character';
}

/** The marks that apply at a collapsed caret: the stored marks, else the marks around the caret. */
function caretMarks(state: EditorState): readonly Mark[] {
  return state.storedMarks ?? state.selection.$from.marks();
}

/** The marks of every text node in a range. */
function rangeMarks(doc: PMNode, from: number, to: number): Mark[] {
  const out: Mark[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (node.isText) out.push(...node.marks);
    return true;
  });
  return out;
}

/**
 * The command for one character value (FE-128). Returns null when the argument is missing or not
 * allowed, so the core reports the command as unavailable.
 */
export function valueFormatCommand(
  name: ValueFormatName,
  args: CommandArgs,
  schema: Schema,
): Command | null {
  const given = givenValue(name, args);
  if (given === undefined) return null;
  const value = checkedValue(name, given);
  if (value === undefined) return null;
  if (name === 'clearFormatting') return clearDirectFormatting(schema);

  const type: MarkType | undefined = schema.marks[name === 'charStyle' ? 'charStyle' : name];
  if (type === undefined) return null;
  const attr = name === 'charStyle' ? 'style' : 'value';

  return (state, dispatch) => {
    if (typeof value === 'string' && name === 'charStyle' && !isCharacterStyle(state.doc, value))
      return false;
    if (!dispatch) return true;
    const { from, to, empty } = state.selection;
    const mark = value === null ? null : type.create({ [attr]: value });
    const tr = state.tr;
    if (empty) {
      // A caret changes the stored marks: the next typed text carries the value, or drops it.
      tr.removeStoredMark(type);
      if (mark !== null) tr.addStoredMark(mark);
    } else {
      tr.removeMark(from, to, type);
      if (mark !== null) tr.addMark(from, to, mark);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/**
 * Removes the direct formatting marks from the selection, or from the stored marks at a caret. The
 * paragraph's style, character styles, links and suggestion marks stay.
 */
function clearDirectFormatting(schema: Schema): Command {
  const types = DIRECT_MARKS.map((n) => schema.marks[n]).filter(
    (t): t is MarkType => t !== undefined,
  );
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const present = empty ? caretMarks(state) : rangeMarks(state.doc, from, to);
    if (!present.some((m) => types.includes(m.type))) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const type of types) {
      if (empty) tr.removeStoredMark(type);
      else tr.removeMark(from, to, type);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}
