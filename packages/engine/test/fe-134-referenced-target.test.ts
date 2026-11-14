/**
 * Deletion of a referenced target (FE-134 criterion 4, FE-133 criterion 4; I4 of 03 §8). A `ref`
 * field names its target. Removing the target while a reference still names it is refused whole;
 * removing the reference, or both in one step, or a remote transaction, is allowed.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { REMOTE } from '../src/meta.ts';
import { referenceGuardPlugin, removedReferencedTargets } from '../src/referenced-targets.ts';
import { LAYOUT_IDS, inside, layoutState, posOfNode } from './layout-doc.ts';

const BOOKMARK_NAME = 'Clause9';
const BOOKMARK_ID = 'anc0000000000001';

/** The layout document, with the reference filter installed and nothing else. */
function guarded(): EditorState {
  const base = layoutState();
  return EditorState.create({
    doc: base.doc,
    schema: base.schema,
    plugins: [referenceGuardPlugin()],
  });
}

/** Inserts a `ref` field that names `target`, at the start of the paragraph `pB`. */
function withRef(state: EditorState, target: string): EditorState {
  const field = state.schema.nodes['field']!.create({
    kind: 'ref',
    target,
    format: null,
    cached: '1',
  });
  return state.apply(state.tr.insert(inside(state.doc, LAYOUT_IDS.pB, 0), field));
}

/** The position and size of the first node of a type that holds the given attribute value. */
function locate(
  doc: PMNode,
  type: string,
  attr: string,
  value: unknown,
): { pos: number; size: number } {
  let found: { pos: number; size: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === type && node.attrs[attr] === value) {
      found = { pos, size: node.nodeSize };
      return false;
    }
    return true;
  });
  if (!found) throw new Error(`no ${type} with ${attr} ${String(value)}`);
  return found;
}

/** A transaction that deletes the figure `figure2` of the layout document. */
function deleteFigure(state: EditorState): Transaction {
  const pos = posOfNode(state.doc, LAYOUT_IDS.figure2);
  const size = state.doc.nodeAt(pos)!.nodeSize;
  return state.tr.delete(pos, pos + size);
}

const figureTarget = `node:${LAYOUT_IDS.figure2}`;

describe('a referenced target cannot be deleted while a reference still names it (FE-134 criterion 4)', () => {
  it('refuses to delete a figure that a ref field names, and leaves the document as it was', () => {
    const state = withRef(guarded(), figureTarget);
    const next = state.apply(deleteFigure(state));
    expect(next.doc.eq(state.doc)).toBe(true);
    expect(removedReferencedTargets(state.doc, deleteFigure(state).doc)).toEqual([figureTarget]);
  });

  it('allows the deletion of a figure that no ref field names', () => {
    const state = guarded();
    const next = state.apply(deleteFigure(state));
    expect(next.doc.eq(state.doc)).toBe(false);
    expect(removedReferencedTargets(state.doc, deleteFigure(state).doc)).toEqual([]);
  });

  it('allows the deletion of the reference alone, which leaves its target in place', () => {
    const state = withRef(guarded(), figureTarget);
    const ref = locate(state.doc, 'field', 'target', figureTarget);
    const next = state.apply(state.tr.delete(ref.pos, ref.pos + ref.size));
    expect(next.doc.eq(state.doc)).toBe(false);
    expect(next.doc.eq(withRefRemoved(state))).toBe(true);
  });

  it('allows the reference and its target to be deleted in one step', () => {
    const state = withRef(guarded(), figureTarget);
    const ref = locate(state.doc, 'field', 'target', figureTarget);
    const figPos = posOfNode(state.doc, LAYOUT_IDS.figure2);
    const figSize = state.doc.nodeAt(figPos)!.nodeSize;
    // The figure comes before the paragraph, so its position does not move when the field goes.
    const tr = state.tr.delete(ref.pos, ref.pos + ref.size).delete(figPos, figPos + figSize);
    const next = state.apply(tr);
    expect(next.doc.eq(state.doc)).toBe(false);
    expect(removedReferencedTargets(state.doc, tr.doc)).toEqual([]);
  });

  it('refuses to delete a bookmark that a ref field names', () => {
    let state = guarded();
    state = state.apply(
      state.tr.insert(
        inside(state.doc, LAYOUT_IDS.pB, 0),
        state.schema.nodes['anchor']!.create({ id: BOOKMARK_ID, name: BOOKMARK_NAME }),
      ),
    );
    state = withRef(state, `bookmark:${BOOKMARK_NAME}`);
    const anchor = locate(state.doc, 'anchor', 'name', BOOKMARK_NAME);
    const next = state.apply(state.tr.delete(anchor.pos, anchor.pos + anchor.size));
    expect(next.doc.eq(state.doc)).toBe(true);
  });

  it('lets a remote transaction delete a referenced figure, since the authority decides those', () => {
    const state = withRef(guarded(), figureTarget);
    const tr = deleteFigure(state).setMeta(REMOTE, true);
    const next = state.apply(tr);
    expect(next.doc.eq(state.doc)).toBe(false);
  });
});

/** The document with the `ref` field of the test removed, built from the same starting point. */
function withRefRemoved(state: EditorState): PMNode {
  const ref = locate(state.doc, 'field', 'target', figureTarget);
  return state.tr.delete(ref.pos, ref.pos + ref.size).doc;
}

const EQUATION_ID = 'eqLayout00000001';
const EQUATION_LABEL = 'energy';
const equationTarget = `eq:${EQUATION_LABEL}`;

/** The guarded layout document with a numbered, labelled display equation before `pB`. */
function withEquation(label: string | null = EQUATION_LABEL): EditorState {
  const state = guarded();
  const block = state.schema.nodes['equation_block']!.create({
    id: EQUATION_ID,
    latex: 'E = mc^2',
    numbered: true,
    label,
  });
  return state.apply(state.tr.insert(posOfNode(state.doc, LAYOUT_IDS.pB), block));
}

/** A transaction that deletes the display equation. */
function deleteEquation(state: EditorState): Transaction {
  const eq = locate(state.doc, 'equation_block', 'id', EQUATION_ID);
  return state.tr.delete(eq.pos, eq.pos + eq.size);
}

describe('a referenced equation label cannot be removed while a ref names it (FE-134 criterion 4)', () => {
  it('refuses to delete a numbered equation that a ref names as eq:energy', () => {
    const state = withRef(withEquation(), equationTarget);
    expect(locate(state.doc, 'equation_block', 'label', EQUATION_LABEL).size).toBe(1);
    expect(removedReferencedTargets(state.doc, deleteEquation(state).doc)).toEqual([
      equationTarget,
    ]);
    const next = state.apply(deleteEquation(state));
    expect(next.doc.eq(state.doc)).toBe(true);
  });

  it('allows the deletion of a numbered equation that no ref names', () => {
    const state = withEquation();
    expect(removedReferencedTargets(state.doc, deleteEquation(state).doc)).toEqual([]);
    const next = state.apply(deleteEquation(state));
    expect(next.doc.eq(state.doc)).toBe(false);
    expect(() => locate(next.doc, 'equation_block', 'id', EQUATION_ID)).toThrow();
  });

  it('allows the deletion of an equation when the refs name a different label', () => {
    const state = withRef(withEquation(), 'eq:mass');
    const next = state.apply(deleteEquation(state));
    expect(next.doc.eq(state.doc)).toBe(false);
  });

  it('refuses to change the label of an equation away from the name a ref uses', () => {
    const state = withRef(withEquation(), equationTarget);
    const eq = locate(state.doc, 'equation_block', 'id', EQUATION_ID);
    const node = state.doc.nodeAt(eq.pos)!;
    const tr = state.tr.setNodeMarkup(eq.pos, undefined, { ...node.attrs, label: 'other' });
    expect(removedReferencedTargets(state.doc, tr.doc)).toEqual([equationTarget]);
    expect(state.apply(tr).doc.eq(state.doc)).toBe(true);
  });

  it('allows a referenced equation and its ref to be deleted in one step', () => {
    const state = withRef(withEquation(), equationTarget);
    const ref = locate(state.doc, 'field', 'target', equationTarget);
    const eq = locate(state.doc, 'equation_block', 'id', EQUATION_ID);
    // The equation comes before the paragraph that holds the ref, so delete the ref first.
    const tr = state.tr.delete(ref.pos, ref.pos + ref.size).delete(eq.pos, eq.pos + eq.size);
    expect(removedReferencedTargets(state.doc, tr.doc)).toEqual([]);
    expect(state.apply(tr).doc.eq(state.doc)).toBe(false);
  });
});
