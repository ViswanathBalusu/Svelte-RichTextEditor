/**
 * Footnotes (02 §5.2, §8; 03 §4.4, §13; CDM-001; FE-058). CDM-001 chose option B of 03 §13: a
 * footnote's content is `paragraph+`, exactly one paragraph in version 1 (`validate()` enforces it).
 * The body shows only a reference mark (footnote-view.ts); the content is edited in a sub-editor
 * whose document is the footnote node, limited to one paragraph by `oneParagraphLimit`.
 */
import type { Node, Schema } from 'prosemirror-model';
import { type Command, Plugin, PluginKey } from 'prosemirror-state';
import type { FootnoteModel } from './schema.ts';

/** Inserts an empty footnote at the selection (FE-058). The identifier plugin gives it an id. */
export function insertFootnote(schema: Schema): Command {
  return (state, dispatch) => {
    const type = schema.nodes['footnote']!;
    const { $from } = state.selection;
    if (!$from.parent.inlineContent || !$from.parent.type.contentMatch.matchType(type))
      return false;
    // I10: no footnote inside a footnote or a caption.
    for (let d = $from.depth; d >= 0; d--)
      if ($from.node(d).type.name === 'footnote' || $from.node(d).type.name === 'caption')
        return false;
    // `createAndFill` gives the one paragraph option B needs, with a null id the plugin fills.
    const node = type.createAndFill();
    if (!node) return false;
    if (dispatch) dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
    return true;
  };
}

export const paragraphLimitKey = new PluginKey('docedit-footnote-paragraph-limit');

/**
 * The one-paragraph limit of version 1, for a sub-editor whose document is the footnote: refuses any
 * transaction that leaves more than one paragraph. Lifting the limit later is a configuration
 * change, not a new CDM major version (03 §13).
 */
export function oneParagraphLimit(limit = 1): Plugin {
  return new Plugin({
    key: paragraphLimitKey,
    filterTransaction: (tr) => !tr.docChanged || tr.doc.childCount <= limit,
  });
}

export const noNestedFootnoteKey = new PluginKey('docedit-no-nested-footnote');

function holdsFootnote(doc: Node): boolean {
  let found = false;
  doc.descendants((n) => {
    if (n.type.name === 'footnote') found = true;
    return !found;
  });
  return found;
}

/**
 * I10 in the footnote panel, whose document is the footnote itself: refuses any transaction that
 * leaves a footnote inside it (a paste of content that holds one, for example). `model.validate()`
 * refuses such a document (`footnote_in_footnote`).
 */
export function noNestedFootnote(): Plugin {
  return new Plugin({
    key: noNestedFootnoteKey,
    filterTransaction: (tr) => !tr.docChanged || !holdsFootnote(tr.doc),
  });
}

export const noBlockersInNoteKey = new PluginKey('docedit-no-blockers-in-note');

function holdsBlocker(doc: Node): boolean {
  let found = false;
  doc.descendants((n) => {
    if (n.type.name === 'table' || (n.type.name === 'break' && n.attrs['kind'] !== 'line'))
      found = true;
    return !found;
  });
  return found;
}

/**
 * I10 in the footnote panel (FE-058 criterion 4): refuses any transaction that leaves a table or a
 * page or column break in the footnote, whatever inserted it (a paste, a command). Line breaks stay
 * allowed. The guard refuses the same steps in the document (`guard.ts`).
 */
export function noBlockersInNote(): Plugin {
  return new Plugin({
    key: noBlockersInNoteKey,
    filterTransaction: (tr) => !tr.docChanged || !holdsBlocker(tr.doc),
  });
}

/** Line break command for the sub-editors (Shift-Enter). */
export function insertLineBreak(schema: Schema): Command {
  return (state, dispatch) => {
    const type = schema.nodes['break']!;
    if (!state.selection.$from.parent.type.contentMatch.matchType(type)) return false;
    if (dispatch)
      dispatch(state.tr.replaceSelectionWith(type.create({ kind: 'line' })).scrollIntoView());
    return true;
  };
}

/**
 * What Enter does in a footnote sub-editor: nothing of its own; the base keymap splits and the
 * one-paragraph limit refuses the second paragraph.
 *
 * @deprecated The argument is ignored: the CDM has one footnote model (CDM-001).
 */
export function footnoteEnter(_model?: FootnoteModel): Command | null {
  return null;
}
