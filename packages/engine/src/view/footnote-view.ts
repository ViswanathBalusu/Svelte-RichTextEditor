/**
 * Footnotes in the web view (02 §8; FE-058): the reference mark in the body and its number. The
 * content is edited in a sub-editor panel (subeditor.ts).
 */
import type { Node as PMNode, Slice } from 'prosemirror-model';
import { Plugin, PluginKey, type Transaction } from 'prosemirror-state';
import {
  AddMarkStep,
  AddNodeMarkStep,
  AttrStep,
  RemoveMarkStep,
  RemoveNodeMarkStep,
  ReplaceAroundStep,
  ReplaceStep,
} from 'prosemirror-transform';
import {
  Decoration,
  DecorationSet,
  type NodeView,
  type NodeViewConstructor,
} from 'prosemirror-view';
import { bodyRange } from '../body.ts';

export const footnoteNumbersKey = new PluginKey<DecorationSet>('docedit-footnote-numbers');

const isFootnote = (n: PMNode): boolean => n.type.name === 'footnote';

function sliceHolds(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((n) => {
    if (isFootnote(n)) found = true;
    return !found;
  });
  return found;
}

/**
 * Whether replacing `from`–`to` can remove a footnote: the range reaches one, other than by lying
 * inside its content (typing in the footnote panel); footnotes do not nest (I10).
 */
function rangeHolds(doc: PMNode, from: number, to: number): boolean {
  let found = false;
  doc.nodesBetween(from, to, (n, pos) => {
    if (found) return false;
    if (!isFootnote(n)) return true;
    if (!(from > pos && to < pos + n.nodeSize)) found = true;
    return false;
  });
  return found;
}

/**
 * Whether a transaction may add, remove or reorder footnotes. When it cannot, the numbers stay
 * what they were and only move with the text (FE-118: renumbering walked the whole body on every
 * keystroke). Steps of other kinds than these are taken to renumber.
 */
export function mayRenumber(tr: Transaction): boolean {
  for (let i = 0; i < tr.steps.length; i++) {
    const step = tr.steps[i]!;
    if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
      if (sliceHolds(step.slice)) return true;
      if (step.from < step.to && rangeHolds(tr.docs[i]!, step.from, step.to)) return true;
      continue;
    }
    const keepsNodes =
      step instanceof AddMarkStep ||
      step instanceof RemoveMarkStep ||
      step instanceof AddNodeMarkStep ||
      step instanceof RemoveNodeMarkStep ||
      step instanceof AttrStep;
    if (!keepsNodes) return true;
  }
  return false;
}

function numberDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = [];
  const b = bodyRange(doc);
  let n = 0;
  doc.nodesBetween(b.start, b.end, (node, pos) => {
    if (node.type.name !== 'footnote') return true;
    n++;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        'data-n': String(n),
        'aria-label': `Footnote ${n}`,
      }),
    );
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * Footnote numbers as node decorations, shown by CSS (`attr(data-n)`): no inline style and no
 * HTML string. Numbering formats and restarts come from the shared algorithm later (FE-058).
 */
export function footnoteNumbers(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: footnoteNumbersKey,
    state: {
      init: (_config, state) => numberDecorations(state.doc),
      apply: (tr, value) => {
        if (!tr.docChanged) return value;
        return mayRenumber(tr) ? numberDecorations(tr.doc) : value.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return footnoteNumbersKey.getState(state) ?? null;
      },
    },
  });
}

/** The reference mark in the body: a `sup` without content; activating it opens the panel. */
export function footnoteRefView(open: (id: string) => void): NodeViewConstructor {
  return (initial): NodeView => {
    let node = initial;
    const dom = document.createElement('sup');
    dom.className = 'de-footnote-ref';
    dom.setAttribute('role', 'button');
    const activate = (event: Event) => {
      event.preventDefault();
      const id = node.attrs['id'];
      if (typeof id === 'string') open(id);
    };
    dom.addEventListener('mousedown', activate);
    return {
      dom,
      update(next) {
        if (next.type !== node.type) return false;
        node = next;
        return true;
      },
      ignoreMutation: () => true,
      destroy() {
        dom.removeEventListener('mousedown', activate);
      },
    };
  };
}
