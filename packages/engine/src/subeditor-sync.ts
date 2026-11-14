/**
 * The pure parts of the sub-editors (FE-056; 02 §5.2, §8). They take editor states and steps and
 * return transactions, so that they run in Node.js without a view. `subeditor.ts` mounts the view
 * and calls these functions.
 *
 * - `forwardToMain` maps the steps of a sub-editor onto the one document, at the story's or the
 *   footnote's position. The result is an ordinary transaction, so the identifier plugin, the guard
 *   and the sync client see it as any local edit. It is null when a step does not apply.
 * - `replaceInner` makes a sub-editor's document equal to the node of its target in the main
 *   document, so remote commits and identifier fills appear in the sub-editor. It is null when the
 *   two are already equal.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { AttrStep, DocAttrStep, type Step, StepMap } from 'prosemirror-transform';

/** Metadata on sub-editor transactions that come from the main state. */
export const FROM_MAIN = 'docedit.fromMain';
/** Metadata on main transactions forwarded from a sub-editor. */
export const FROM_SUB = 'docedit.fromSubEditor';

export interface SubEditorTarget {
  kind: 'footnote' | 'story';
  id: string;
}

/** Position of the node of a target in the document, or -1. */
export function locate(doc: PMNode, target: SubEditorTarget): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if (node.type.name === target.kind && node.attrs['id'] === target.id) found = pos;
    return found < 0;
  });
  return found;
}

/**
 * The main transaction for `steps` made in a sub-editor whose node sits at `nodePos` in the main
 * document. The steps of the sub-editor's document are offset by the node's content start; an
 * attribute of the sub-editor's root is an attribute of the node itself.
 */
export function forwardToMain(
  main: EditorState,
  target: SubEditorTarget,
  nodePos: number,
  steps: readonly Step[],
): Transaction | null {
  const offset = StepMap.offset(nodePos + 1);
  const outer = main.tr.setMeta(FROM_SUB, target);
  for (const step of steps) {
    const mapped =
      step instanceof DocAttrStep ? new AttrStep(nodePos, step.attr, step.value) : step.map(offset);
    if (!mapped || outer.maybeStep(mapped).failed) return null;
  }
  return outer;
}

function sameAttr(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The transaction that changes the sub-editor's document `inner` into `node`, the node of its
 * target in the main document. Only the differing range and the attributes that differ are
 * replaced, as the footnote example of ProseMirror does.
 */
export function replaceInner(inner: EditorState, node: PMNode): Transaction | null {
  if (node.eq(inner.doc)) return null;
  const tr = inner.tr.setMeta(FROM_MAIN, true).setMeta('addToHistory', false);
  const start = node.content.findDiffStart(inner.doc.content);
  if (start !== null) {
    const end = node.content.findDiffEnd(inner.doc.content)!;
    let endA = end.a;
    let endB = end.b;
    const overlap = start - Math.min(endA, endB);
    if (overlap > 0) {
      endA += overlap;
      endB += overlap;
    }
    tr.replace(start, endB, node.slice(start, endA));
  }
  for (const [name, value] of Object.entries(node.attrs))
    if (!sameAttr(inner.doc.attrs[name], value)) tr.setDocAttribute(name, value);
  return tr;
}
