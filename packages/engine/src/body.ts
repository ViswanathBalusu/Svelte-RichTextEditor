/**
 * Body-scoped commands and the body guard (02 §5.2; 03 §3; review F10; FE-032).
 *
 * The CDM document is `defs story* body`. Definitions and stories share the ProseMirror document
 * with the body, so ProseMirror's own "select all" (an AllSelection over the whole document), its
 * default initial selection (`Selection.atStart`, which lands in the first header story) and a DOM
 * selection that touches the hidden definition and story wrappers would all reach them. Everything
 * here keeps the selection inside the body.
 */
import { type Node as PMNode, Slice } from 'prosemirror-model';
import {
  type Command,
  Plugin,
  PluginKey,
  Selection,
  type SelectionBookmark,
  TextSelection,
  type Transaction,
} from 'prosemirror-state';
import type { Mappable } from 'prosemirror-transform';

export interface BodyRange {
  /** Position before the body node. */
  pos: number;
  /** First position inside the body. */
  start: number;
  /** Last position inside the body. */
  end: number;
}

/** Where the body is. The body is always the last child of `doc` (03 §3). */
export function bodyRange(doc: PMNode): BodyRange {
  const body = doc.lastChild;
  if (!body || body.type.name !== 'body') throw new Error('the document has no body');
  const pos = doc.content.size - body.nodeSize;
  return { pos, start: pos + 1, end: pos + body.nodeSize - 1 };
}

/** Whether a range lies inside the body. */
export function withinBody(doc: PMNode, from: number, to: number): boolean {
  const b = bodyRange(doc);
  return from >= b.start && to <= b.end;
}

/** The first or last text position of the body, or null when the body has no textblock. */
export function bodyTextEdge(doc: PMNode, side: 'start' | 'end'): TextSelection | null {
  const b = bodyRange(doc);
  const found =
    side === 'start'
      ? Selection.findFrom(doc.resolve(b.start), 1, true)
      : Selection.findFrom(doc.resolve(b.end), -1, true);
  // findFrom climbs out of the body when it finds nothing inside it; never accept that.
  if (!(found instanceof TextSelection) || !withinBody(doc, found.from, found.to)) return null;
  return found;
}

const bodyBookmark: SelectionBookmark = {
  map() {
    return bodyBookmark;
  },
  resolve(doc) {
    return new BodySelection(doc);
  },
};

/**
 * "Select all" limited to the body: like ProseMirror's AllSelection, but from the first to the last
 * position inside the body, so that deleting or typing over it never reaches definitions or stories.
 */
export class BodySelection extends Selection {
  constructor(doc: PMNode) {
    const b = bodyRange(doc);
    super(doc.resolve(b.start), doc.resolve(b.end));
  }

  override map(doc: PMNode, _mapping: Mappable): Selection {
    return new BodySelection(doc);
  }

  override eq(other: Selection): boolean {
    return other instanceof BodySelection;
  }

  override toJSON(): { type: 'body' } {
    return { type: 'body' };
  }

  static override fromJSON(doc: PMNode): BodySelection {
    return new BodySelection(doc);
  }

  override getBookmark(): SelectionBookmark {
    return bodyBookmark;
  }

  override replace(tr: Transaction, content: Slice = Slice.empty): void {
    if (content !== Slice.empty) return super.replace(tr, content);
    // The body needs at least one block: replacing its content with nothing lets the fitter
    // create one empty paragraph, as AllSelection does for the document.
    const b = bodyRange(tr.doc);
    tr.delete(b.start, b.end);
    const caret = bodyTextEdge(tr.doc, 'start');
    if (caret) tr.setSelection(caret);
  }
}

Selection.jsonID('body', BodySelection);

/** Select all, limited to the body (Mod-a). */
export const selectAllInBody: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.setSelection(new BodySelection(state.doc)));
  return true;
};

/** Move to the start or the end of the body (Mod-Home, Mod-End), optionally extending (Shift). */
export function moveToBodyEdge(side: 'start' | 'end', extend = false): Command {
  return (state, dispatch) => {
    const edge = bodyTextEdge(state.doc, side);
    if (!edge) return false;
    if (dispatch) {
      const sel = extend
        ? TextSelection.create(state.doc, clampAnchor(state.selection, state.doc), edge.head)
        : edge;
      dispatch(state.tr.setSelection(sel).scrollIntoView());
    }
    return true;
  };
}

function clampAnchor(sel: Selection, doc: PMNode): number {
  const start = bodyTextEdge(doc, 'start')?.from ?? sel.anchor;
  const end = bodyTextEdge(doc, 'end')?.to ?? sel.anchor;
  return Math.min(Math.max(sel.anchor, start), end);
}

/**
 * Backspace at the first body position and Delete at the last: consumed, so that no join or
 * node selection reaches a story or the definitions (FE-032). ProseMirror's joinBackward would
 * otherwise delete an empty first paragraph and put the caret at the end of the last header story.
 */
export function stopAtBodyEdge(side: 'start' | 'end'): Command {
  return (state) => {
    const sel = state.selection;
    if (!(sel instanceof TextSelection) || !sel.empty) return false;
    const edge = bodyTextEdge(state.doc, side);
    return edge !== null && edge.head === sel.head;
  };
}

/** A selection clamped into the body, or null when the body has no text position. */
export function clampToBody(doc: PMNode, anchor: number, head: number): Selection | null {
  const start = bodyTextEdge(doc, 'start');
  const end = bodyTextEdge(doc, 'end');
  if (!start || !end) return null;
  const clamp = (p: number) => Math.min(Math.max(p, start.from), end.to);
  const $anchor = doc.resolve(clamp(anchor));
  const $head = doc.resolve(clamp(head));
  const sel = TextSelection.between($anchor, $head);
  return withinBody(doc, sel.from, sel.to) ? sel : start;
}

/** The selection a new editor starts with: the start of the body, never `Selection.atStart`. */
export function initialSelection(doc: PMNode): Selection {
  return bodyTextEdge(doc, 'start') ?? Selection.atStart(doc);
}

export const bodyGuardKey = new PluginKey('docedit-body-guard');

/**
 * Keeps every selection inside the body: through the view's selection hook when the DOM selection
 * touches the hidden wrappers, and after any transaction that would leave it outside.
 */
export function bodyGuard(): Plugin {
  return new Plugin({
    key: bodyGuardKey,
    appendTransaction(_trs, _old, state) {
      const sel = state.selection;
      if (sel instanceof BodySelection || withinBody(state.doc, sel.from, sel.to)) return null;
      const clamped = clampToBody(state.doc, sel.anchor, sel.head);
      return clamped ? state.tr.setSelection(clamped).setMeta(bodyGuardKey, true) : null;
    },
    props: {
      createSelectionBetween(view, $anchor, $head) {
        const { doc } = view.state;
        if (withinBody(doc, Math.min($anchor.pos, $head.pos), Math.max($anchor.pos, $head.pos)))
          return null;
        return clampToBody(doc, $anchor.pos, $head.pos);
      },
    },
  });
}
