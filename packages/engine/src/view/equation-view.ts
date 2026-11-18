/**
 * Node views and numbers of equations in the web view (FE-069; 02 §6; 03 §4.3, §4.4).
 *
 * - `equation` (inline) and `equation_block` (display) are drawn through the element's drawer
 *   (equation-draw.ts) once the node's DOM is in the page, so that the drawer can adopt its style
 *   sheet into the shadow root that holds it. Without a drawer, or until it has loaded, the LaTeX
 *   source is shown as text. The LaTeX is a text value: never markup, and never an HTML string.
 * - A numbered equation block shows its number as `(n)`. The number is the model's shared
 *   computation (`computeLabels`, CDM-042), read as a node decoration so that a block whose own
 *   node did not change still redraws its number when an earlier equation is added or removed.
 * - The view never changes the document. A drawn equation is not editable in place; the LaTeX
 *   source is edited through the equation's own editor (FE-100).
 */
import { computeLabels } from '@docedit/model';
import type { Node as PmNode } from 'prosemirror-model';
import { Plugin, PluginKey } from 'prosemirror-state';
import {
  Decoration,
  DecorationSet,
  type DecorationSource,
  type NodeView,
  type NodeViewConstructor,
} from 'prosemirror-view';
import type { EquationDrawer } from '../equation-draw.ts';
import { mayRelist } from './list-view.ts';

/** The class of the number shown beside a numbered equation block. */
export const EQUATION_NUMBER_CLASS = 'de-equation-number';

const NUMBER_ATTR = 'data-equation-number';

export const equationNumbersKey = new PluginKey<DecorationSet>('docedit-equation-numbers');

/** The numbers of the numbered equation blocks of `doc`, as node decorations. */
export function equationNumberDecorations(doc: PmNode): DecorationSet {
  const numbers = computeLabels(doc).equations;
  const out: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'equation_block' || node.attrs['numbered'] !== true) return true;
    const id = node.attrs['id'];
    const number = typeof id === 'string' ? numbers.get(id) : undefined;
    if (number !== undefined)
      out.push(
        Decoration.node(
          pos,
          pos + node.nodeSize,
          { [NUMBER_ATTR]: number },
          { equationNumber: number },
        ),
      );
    return false;
  });
  return DecorationSet.create(doc, out);
}

/** Keeps the numbers of equation blocks, recomputed when a transaction may change them. */
export function equationNumbersPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: equationNumbersKey,
    state: {
      init: (_config, state) => equationNumberDecorations(state.doc),
      apply: (tr, value) => {
        if (!tr.docChanged) return value;
        return mayRelist(tr) ? equationNumberDecorations(tr.doc) : value.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return equationNumbersKey.getState(state) ?? null;
      },
    },
  });
}

function numberOf(decorations: readonly Decoration[]): string | null {
  for (const d of decorations) {
    const n = (d.spec as { equationNumber?: unknown }).equationNumber;
    if (typeof n === 'string') return n;
  }
  return null;
}

function latexOf(node: PmNode): string {
  const latex = node.attrs['latex'];
  return typeof latex === 'string' ? latex : '';
}

/**
 * Draws `latex` into `container`: through the drawer once the container is in the page, and as
 * plain text first. A drawer that throws leaves the source as text.
 */
function paint(
  container: HTMLElement,
  latex: string,
  display: boolean,
  draw: EquationDrawer | undefined,
  alive: () => boolean,
): void {
  container.textContent = latex;
  if (!draw) return;
  queueMicrotask(() => {
    if (!alive() || !container.isConnected) return;
    try {
      draw(container, latex, display);
    } catch {
      container.textContent = latex;
    }
  });
}

/** The node view of an inline `equation`. */
export function equationView(draw: EquationDrawer | undefined): NodeViewConstructor {
  return (node): NodeView => {
    const dom = document.createElement('span');
    dom.className = 'de-equation';
    dom.setAttribute('contenteditable', 'false');
    let current = node;
    let alive = true;
    const set = (n: PmNode): void => {
      dom.setAttribute('data-latex', latexOf(n));
      paint(dom, latexOf(n), false, draw, () => alive && current === n);
    };
    set(node);
    return {
      dom,
      update: (next) => {
        if (next.type !== current.type) return false;
        if (latexOf(next) !== latexOf(current)) {
          current = next;
          set(next);
        } else current = next;
        return true;
      },
      ignoreMutation: () => true,
      stopEvent: () => false,
      destroy: () => {
        alive = false;
      },
    };
  };
}

/** The node view of a display `equation_block`, with the number of a numbered one. */
export function equationBlockView(draw: EquationDrawer | undefined): NodeViewConstructor {
  return (node, _view, _getPos, decorations): NodeView => {
    const dom = document.createElement('div');
    dom.className = 'de-equation-block';
    dom.setAttribute('contenteditable', 'false');
    const body = document.createElement('div');
    body.className = 'de-equation-body';
    const label = document.createElement('span');
    label.className = EQUATION_NUMBER_CLASS;
    dom.append(body, label);
    let current = node;
    let alive = true;
    const setNumber = (decos: readonly Decoration[]): void => {
      const n = numberOf(decos);
      label.textContent = n === null ? '' : `(${n})`;
      label.hidden = n === null;
    };
    const setLatex = (n: PmNode): void => {
      dom.setAttribute('data-latex', latexOf(n));
      paint(body, latexOf(n), true, draw, () => alive && current === n);
    };
    setNumber(decorations);
    setLatex(node);
    return {
      dom,
      update: (next, decos: readonly Decoration[], _inner: DecorationSource) => {
        if (next.type !== current.type) return false;
        const changed = latexOf(next) !== latexOf(current);
        current = next;
        if (changed) setLatex(next);
        setNumber(decos);
        return true;
      },
      ignoreMutation: () => true,
      stopEvent: () => false,
      destroy: () => {
        alive = false;
      },
    };
  };
}
