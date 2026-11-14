/**
 * Numbered captions and cross-references (FE-134 criteria 1, 2, 3 and 5; 03 §4.3, §4.4; CDM-036,
 * CDM-042). The numbers come from the model's shared computation, and the tests check them there.
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  insertCaption,
  insertReference,
  isReferenceTarget,
  refreshCaches,
  staleCaches,
} from '../src/captions-refs.ts';
import { LAYOUT_IDS, caretIn, layoutState, posOfNode } from './layout-doc.ts';

const writable = () => true;

/** The id of a figure added by these tests: 16 characters, as a `node:` target needs. */
const NEW_FIGURE = 'figNew0000000001';

function dispatching<R>(
  state: EditorState,
  run: (dispatch: (tr: Transaction) => void) => R,
): { result: R; next: EditorState; dispatched: boolean } {
  let next: EditorState = state;
  let dispatched = false;
  const result = run((tr) => {
    dispatched = true;
    next = state.apply(tr);
  });
  return { result, next, dispatched };
}

/** The `seq` and `ref` fields of a document as `[kind, cached]`, in order. */
function numbered(doc: PMNode): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  doc.descendants((node) => {
    if (
      node.type.name === 'field' &&
      (node.attrs['kind'] === 'seq' || node.attrs['kind'] === 'ref')
    ) {
      out.push([String(node.attrs['kind']), node.attrs['cached']]);
    }
    return true;
  });
  return out;
}

/** A state with a new figure (no caption) inserted before the second figure of the layout. */
function withNewFigure(state: EditorState): EditorState {
  const { schema } = state;
  const figure = schema.nodes['figure']!.create({ id: NEW_FIGURE });
  const at = posOfNode(state.doc, LAYOUT_IDS.figure2);
  return state.apply(state.tr.insert(at, figure));
}

describe('a figure caption carries a seq field that numbers it (FE-134 criterion 1, figures)', () => {
  it('adds a caption to a figure that has none, numbered in the Figure sequence', () => {
    const state = layoutState();
    const { result, next } = dispatching(state, (dispatch) =>
      insertCaption(state, LAYOUT_IDS.figure2, { writable }, dispatch),
    );
    expect(result).toEqual({ ok: true, number: '1' });
    expect(numbered(next.doc)).toEqual([['seq', '1']]);
    const figure = next.doc.nodeAt(posOfNode(next.doc, LAYOUT_IDS.figure2))!;
    expect(figure.textContent).toBe('Figure 1');
    expect(figure.firstChild!.type.name).toBe('caption');
    next.doc.check();
  });

  it('refuses a figure that already has a caption, a missing figure, and a protected position', () => {
    const state = layoutState();
    expect(insertCaption(state, LAYOUT_IDS.figure, { writable })).toEqual({
      ok: false,
      reason: 'has-caption',
    });
    expect(insertCaption(state, 'nosuchfigure00001', { writable })).toEqual({
      ok: false,
      reason: 'no-figure',
    });
    const { result, dispatched } = dispatching(state, (dispatch) =>
      insertCaption(state, LAYOUT_IDS.figure2, { writable: () => false }, dispatch),
    );
    expect(result).toEqual({ ok: false, reason: 'read-only' });
    expect(dispatched).toBe(false);
  });
});

describe('numbers follow the content (FE-134 criterion 3, the labels)', () => {
  it('renumbers a captioned figure when a figure is inserted before it, and refreshes its cache', () => {
    let state = layoutState();
    state = dispatching(state, (dispatch) =>
      insertCaption(state, LAYOUT_IDS.figure2, { writable }, dispatch),
    ).next;
    expect(numbered(state.doc)).toEqual([['seq', '1']]);

    // A new captioned figure before the old one: the old one becomes figure 2.
    let withNew = withNewFigure(state);
    withNew = dispatching(withNew, (dispatch) =>
      insertCaption(withNew, NEW_FIGURE, { writable }, dispatch),
    ).next;
    const stale = staleCaches(withNew.doc);
    expect(stale.map((s) => [s.kind, s.cached, s.text])).toEqual([['seq', '1', '2']]);
    const refreshed = refreshCaches(withNew)!;
    const after = withNew.apply(refreshed);
    expect(staleCaches(after.doc)).toEqual([]);
    expect(numbered(after.doc)).toEqual([
      ['seq', '1'],
      ['seq', '2'],
    ]);
    expect(refreshCaches(after)).toBeNull();
  });
});

describe('cross-references point at numbered targets (FE-134 criterion 2, the command)', () => {
  it('inserts a ref to a captioned figure, with the number as its cached text', () => {
    let state = withNewFigure(layoutState());
    state = dispatching(state, (dispatch) =>
      insertCaption(state, NEW_FIGURE, { writable }, dispatch),
    ).next;
    const caret = caretIn(state, LAYOUT_IDS.pB, 2);
    const { result, next } = dispatching(caret, (dispatch) =>
      insertReference(caret, `node:${NEW_FIGURE}`, null, { writable }, dispatch),
    );
    expect(result).toEqual({ ok: true, cached: '1' });
    expect(numbered(next.doc)).toContainEqual(['ref', '1']);
    // The reference is a field of its own target, and stays valid.
    next.doc.check();
  });

  it('refuses a target outside the CDM forms and the reference schemes, a target with no label, a bad format and a protected position', () => {
    const caret = caretIn(layoutState(), LAYOUT_IDS.pB, 2);
    const opts = { writable };
    expect(insertReference(caret, 'style:Heading1', null, opts)).toEqual({
      ok: false,
      reason: 'bad-target',
    });
    expect(insertReference(caret, 'field:tenant.name', null, opts)).toEqual({
      ok: false,
      reason: 'bad-target',
    });
    expect(insertReference(caret, `node:${'z'.repeat(16)}`, null, opts)).toEqual({
      ok: false,
      reason: 'no-target',
    });
    expect(insertReference(caret, `node:${NEW_FIGURE}`, '<x>', opts)).toEqual({
      ok: false,
      reason: 'bad-format',
    });
    // A target that has a label, at a position the guard protects.
    const base = withNewFigure(layoutState());
    const labelled = dispatching(base, (dispatch) =>
      insertCaption(base, NEW_FIGURE, { writable }, dispatch),
    ).next;
    const protectedCaret = caretIn(labelled, LAYOUT_IDS.pB, 2);
    expect(
      insertReference(protectedCaret, `node:${NEW_FIGURE}`, null, { writable: () => false }),
    ).toEqual({ ok: false, reason: 'read-only' });
  });

  it('accepts only node, bookmark and eq targets (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (text) => {
        if (isReferenceTarget(text)) {
          expect(/^(node|bookmark|eq):/.test(text)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});
