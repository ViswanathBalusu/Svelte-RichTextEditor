/**
 * A thread is reached from the keyboard, and a thread on a block is marked on the block (FE-048
 * criteria 1 and 7). Node.js, headless core: `stepThread` is what the keys Alt+F8 and Shift+Alt+F8
 * run. The real key presses in a browser are in src/view/fe-048-block-thread.universal.test.ts.
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../src/api.ts';
import { commentDecorations } from '../src/comment-decorations.ts';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { LAYOUT_IDS, layoutEnvelope, posOfNode } from './layout-doc.ts';
import { microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const OWNER: Access = {
  rev: 1,
  asOfSeq: 0,
  docRole: 'owner',
  caps: [...EDIT, 'structure', 'manage'],
  scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT] },
  leases: {},
  fill: null,
  restrictions: [],
};

function setup() {
  const doc = {
    cdm: 1,
    requires: [],
    doc: layoutEnvelope() as unknown as CdmJsonNode,
  } as CdmEnvelope;
  const core = new DocumentCore({ doc, access: OWNER, schedule: microtask });
  const i = internals(core);
  const a = posOfNode(i.state.doc, LAYOUT_IDS.pA) + 1;
  const b = posOfNode(i.state.doc, LAYOUT_IDS.pB) + 1;
  return { core, i, a, b };
}

describe('a thread is reached from the keyboard (FE-048 criterion 7)', () => {
  it('moves through the threads in document order, wrapping at both ends, with no commit', () => {
    const { core, i, a, b } = setup();
    expect(core.stepThread('next')).toBeNull();
    // Set in reverse order: the order of the document decides, not the order they came in.
    core.setThreadRange('later', { from: b, to: b + 3 }, 1);
    core.setThreadRange('earlier', { from: a, to: a + 3 }, 1);
    const docBefore = i.state.doc;
    // The caret starts at the first thread; the next one is the later one, then it wraps.
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, a)));

    expect(core.stepThread('next')).toBe('later');
    expect(i.state.selection.from).toBe(b);
    expect(core.selectedThread.get()).toEqual({ id: 'later', block: null });
    expect(core.stepThread('next')).toBe('earlier');
    expect(i.state.selection.from).toBe(a);
    expect(core.stepThread('previous')).toBe('later');
    expect(core.stepThread('previous')).toBe('earlier');
    // The document did not change: the keys make no step and no commit.
    expect(i.state.doc.eq(docBefore)).toBe(true);
    expect(core.saveState.get()).toBe('saved');
  });

  it('a detached thread has no stop, and a thread on a block selects the block', () => {
    const { core, i, a } = setup();
    core.setThreadRange('gone', { from: a, to: a }, 1);
    expect(core.stepThread('next')).toBeNull();
    expect(core.reportThread('fig', { seq: 0, block: LAYOUT_IDS.figure })).toBe('placed');
    expect(core.stepThread('next')).toBe('fig');
    expect(i.state.selection.from).toBe(posOfNode(i.state.doc, LAYOUT_IDS.figure));
    expect(core.selectedThread.get()).toEqual({ id: 'fig', block: LAYOUT_IDS.figure });
  });
});

describe('a thread on a block is drawn on the block (FE-048 criterion 1)', () => {
  it('draws a node decoration over the figure, and over a table, and none once the thread is removed', () => {
    const { core, i } = setup();
    core.reportThread('fig', { seq: 0, block: LAYOUT_IDS.figure });
    expect(core.threadBlocks.get()).toEqual([{ id: 'fig', block: LAYOUT_IDS.figure }]);
    const set = commentDecorations(i.state.doc, [], null, core.threadBlocks.get());
    const found = set.find();
    expect(found).toHaveLength(1);
    const figure = posOfNode(i.state.doc, LAYOUT_IDS.figure);
    expect(found[0]!.from).toBe(figure);
    expect(found[0]!.to).toBe(figure + i.state.doc.nodeAt(figure)!.nodeSize);
    expect(
      (found[0] as unknown as { type: { attrs: Record<string, string> } }).type.attrs,
    ).toMatchObject({
      class: 'de-comment-block',
      'data-thread-id': 'fig',
    });
    core.removeThreadRange('fig');
    expect(core.threadBlocks.get()).toEqual([]);
    expect(commentDecorations(i.state.doc, [], null, core.threadBlocks.get()).find()).toEqual([]);
  });

  it('a block that is no longer in the document draws nothing', () => {
    const { core, i } = setup();
    core.reportThread('gone', { seq: 0, block: 'noSuchBlock00000001' });
    expect(commentDecorations(i.state.doc, [], null, core.threadBlocks.get()).find()).toEqual([]);
  });
});
