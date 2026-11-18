/**
 * Sub-editor steps and their mapping onto the one document (FE-056 criteria 1 to 3). The view is
 * not mounted here (no DOM in Node.js), so the functions of `subeditor-sync.ts` stand for the
 * sub-editor's dispatch and sync. Criterion 4 (two users converge in one footer) needs two
 * sessions and is not tested here; criterion 5 (input methods) needs a browser; criterion 6 (a
 * user who cannot change stories) is not tested because `openStory` does not check the rights.
 */
import fc from 'fast-check';
import { validate } from '@docedit/model/validate';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { forwardToMain, locate, replaceInner } from '../src/subeditor-sync.ts';
import { ownerAccess } from './fixtures.ts';
import { microtask } from './support.ts';

const TARGET = { kind: 'story' as const, id: SPIKE_IDS.header };

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), access: ownerAccess(), schedule: microtask });
}

/** The header story in the core's document: its position and node. */
function storyOf(c: DocumentCore): { pos: number; node: PMNode } {
  const doc = internals(c).state.doc;
  const pos = locate(doc, TARGET);
  expect(pos).toBeGreaterThanOrEqual(0);
  return { pos, node: doc.nodeAt(pos)! };
}

/** The sub-editor's own state, as `SubEditor` creates it: its document is the story node. */
function subState(node: PMNode): EditorState {
  return EditorState.create({ doc: node });
}

/** The text of the story's first paragraph, in the sub-editor's coordinates. */
function paragraphSize(doc: PMNode): number {
  return doc.firstChild!.content.size;
}

/**
 * Makes a sub-editor edit: the transaction is applied to the sub-editor's state at once, then its
 * steps are forwarded to the core as `SubEditor` does. Returns the sub-editor's new state.
 */
function subEdit(c: DocumentCore, inner: EditorState, build: (tr: Transaction) => Transaction) {
  const tr = build(inner.tr);
  const next = inner.apply(tr);
  const { pos } = storyOf(c);
  const outer = forwardToMain(internals(c).state, TARGET, pos, tr.steps);
  expect(outer).not.toBeNull();
  internals(c).dispatch(outer!);
  return next;
}

describe('the sub-editor state (FE-056 criterion 1)', () => {
  it('holds the story alone as its document', () => {
    const { node } = storyOf(core());
    const inner = subState(node);
    expect(inner.doc.type.name).toBe('story');
    expect(inner.doc.eq(node)).toBe(true);
  });

  it('keeps the body selection when the panel opens', () => {
    const c = core();
    const before = internals(c).state.selection;
    c.openStory(SPIKE_IDS.header);
    expect(internals(c).state.selection.eq(before)).toBe(true);
    expect(c.panel.get()).toEqual({
      kind: 'story',
      id: SPIKE_IDS.header,
      label: 'Header',
      part: 'header',
      variant: 'default',
    });
  });
});

describe('the steps of a sub-editor are mapped onto the document (FE-056 criterion 2)', () => {
  it('an insertion in the sub-editor is one local edit of the document at the story position', () => {
    const c = core();
    const { node } = storyOf(c);
    const inner = subState(node);
    const bodyBefore = internals(c).state.doc.lastChild!;
    expect(bodyBefore.type.name).toBe('body');
    const next = subEdit(c, inner, (tr) => tr.insertText('Q', 1));

    const after = storyOf(c).node;
    expect(after.eq(next.doc)).toBe(true);
    expect(after.textContent).toContain('Q');
    // The body is unchanged and the document is valid (I1 to I12).
    expect(internals(c).state.doc.lastChild!.eq(bodyBefore)).toBe(true);
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('forwards no steps for a transaction that changes nothing', () => {
    const c = core();
    const { pos, node } = storyOf(c);
    expect(forwardToMain(internals(c).state, TARGET, pos, [])).not.toBeNull();
    expect(storyOf(c).node.eq(node)).toBe(true);
  });

  it('property: after each sub-editor edit the sub-editor and the story in the document are equal', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            insert: fc.boolean(),
            at: fc.nat(1000),
            ch: fc.constantFrom('a', 'b', 'é', 'z'),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        (ops) => {
          const c = core();
          let inner = subState(storyOf(c).node);
          for (const op of ops) {
            const size = paragraphSize(inner.doc);
            const at = 1 + (op.at % (size + 1));
            if (op.insert || size === 0) {
              inner = subEdit(c, inner, (tr) => tr.insertText(op.ch, at));
            } else {
              const from = Math.min(at, 1 + size - 1);
              inner = subEdit(c, inner, (tr) => tr.delete(from, from + 1));
            }
            expect(storyOf(c).node.eq(inner.doc)).toBe(true);
          }
          expect(validate(c.getContent()).violations).toEqual([]);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('remote commits reach the open sub-editor (FE-056 criterion 3)', () => {
  it('a change of the story in the document appears in the sub-editor, and the caret is mapped', () => {
    const c = core();
    let inner = subState(storyOf(c).node);
    // The caret at the end of the sub-editor's paragraph.
    const end = 1 + paragraphSize(inner.doc);
    inner = inner.apply(inner.tr.setSelection(TextSelection.create(inner.doc, end)));

    // A remote commit adds text at the start of the story's first paragraph (the story opens at
    // `pos`, its paragraph at `pos + 1`, and the paragraph's text starts at `pos + 2`).
    const { pos } = storyOf(c);
    internals(c).dispatch(internals(c).state.tr.insertText('R', pos + 2));
    const story = storyOf(c).node;
    const tr = replaceInner(inner, story);
    expect(tr).not.toBeNull();
    inner = inner.apply(tr!);

    expect(inner.doc.eq(story)).toBe(true);
    expect(inner.doc.textContent.startsWith('R')).toBe(true);
    // The caret stayed at the end of the text, so it moved past the inserted character.
    expect(inner.selection.from).toBe(1 + paragraphSize(inner.doc));
  });

  it('a sub-editor that already shows the document has no transaction to apply', () => {
    const c = core();
    const { node } = storyOf(c);
    expect(replaceInner(subState(node), node)).toBeNull();
  });
});
