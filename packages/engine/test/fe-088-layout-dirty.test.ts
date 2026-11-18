/**
 * FE-088 criteria 1 and 6: an applied edit, local or remote, marks its block dirty for the layout.
 * Node.js, headless core. A remote commit is modelled as a transaction marked `REMOTE`, as in
 * fe-035-rebuild-decorations.test.ts; remote.ts builds the rebuild's transaction the same way, from
 * steps, and the plugin reads steps, so the marks do not depend on how the steps arrived.
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { REMOTE } from '../src/meta.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { microtask, posOf } from './support.ts';

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), schedule: microtask });
}

describe('FE-088 criterion 1: an edit marks its block dirty', () => {
  it('marks nothing before any edit', () => {
    expect([...core().takeLayoutDirty()]).toEqual([]);
  });

  it('marks the paragraph that typing changes, and only that one', () => {
    const c = core();
    const i = internals(c);
    const at = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
    i.dispatch(i.state.tr.insertText('hello ', at));
    expect([...c.takeLayoutDirty()]).toEqual([SPIKE_IDS.intro]);
    // The marks are taken once.
    expect([...c.takeLayoutDirty()]).toEqual([]);
  });

  it('marks the paragraph at either edge of its text, not the neighbour', () => {
    const c = core();
    const i = internals(c);
    const start = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
    i.dispatch(i.state.tr.insertText('x', start));
    expect([...c.takeLayoutDirty()]).toEqual([SPIKE_IDS.intro]);
    const end =
      posOf(i.state.doc, SPIKE_IDS.intro) +
      i.state.doc.nodeAt(posOf(i.state.doc, SPIKE_IDS.intro))!.nodeSize -
      1;
    i.dispatch(i.state.tr.insertText('y', end));
    expect([...c.takeLayoutDirty()]).toEqual([SPIKE_IDS.intro]);
  });

  it('marks the paragraph that a deletion shortens', () => {
    const c = core();
    const i = internals(c);
    const at = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
    i.dispatch(i.state.tr.delete(at, at + 2));
    expect([...c.takeLayoutDirty()]).toEqual([SPIKE_IDS.intro]);
  });

  it('marks the paragraph of a format change, which moves no position', () => {
    const c = core();
    const i = internals(c);
    const at = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
    const bold = i.schema.marks['strong'] ?? i.schema.marks['bold'];
    expect(bold).toBeDefined();
    i.dispatch(i.state.tr.addMark(at, at + 3, bold!.create()));
    expect([...c.takeLayoutDirty()]).toEqual([SPIKE_IDS.intro]);
  });

  it('collects the blocks of several edits until they are taken', () => {
    const c = core();
    const i = internals(c);
    i.dispatch(i.state.tr.insertText('a', posOf(i.state.doc, SPIKE_IDS.intro) + 1));
    i.dispatch(i.state.tr.insertText('b', posOf(i.state.doc, SPIKE_IDS.after) + 1));
    expect([...c.takeLayoutDirty()].sort()).toEqual([SPIKE_IDS.after, SPIKE_IDS.intro].sort());
  });

  it('marks a change that undo reverses', () => {
    const c = core();
    const i = internals(c);
    i.dispatch(i.state.tr.insertText('a', posOf(i.state.doc, SPIKE_IDS.intro) + 1));
    c.takeLayoutDirty();
    c.run('undo');
    expect([...c.takeLayoutDirty()]).toEqual([SPIKE_IDS.intro]);
  });
});

describe('FE-088 criterion 6: a remote commit marks its blocks the same way', () => {
  it('marks the paragraph that a remote insertion changes', () => {
    const c = core();
    const i = internals(c);
    const at = posOf(i.state.doc, SPIKE_IDS.after) + 1;
    i.dispatch(i.state.tr.insertText('Remote ', at).setMeta(REMOTE, true));
    expect([...c.takeLayoutDirty()]).toEqual([SPIKE_IDS.after]);
  });

  it('marks a paragraph that a remote step list changes in two places, and one other', () => {
    const c = core();
    const i = internals(c);
    const tr = i.state.tr;
    tr.insertText('one ', posOf(tr.doc, SPIKE_IDS.after) + 1);
    tr.insertText('two ', posOf(tr.doc, SPIKE_IDS.after) + 1);
    tr.insertText('three ', posOf(tr.doc, SPIKE_IDS.last) + 1);
    i.dispatch(tr.setMeta(REMOTE, true));
    expect([...c.takeLayoutDirty()].sort()).toEqual([SPIKE_IDS.after, SPIKE_IDS.last].sort());
  });

  it('marks the blocks of a remote commit applied through the stand-in of the sync client', () => {
    const c = core();
    const i = internals(c);
    const at = posOf(i.state.doc, SPIKE_IDS.title) + 1;
    const steps = i.state.tr.insertText('Far ', at).steps;
    expect(i.applyRemote(steps, 'rebase')).toBe('applied');
    expect([...c.takeLayoutDirty()]).toEqual([SPIKE_IDS.title]);
  });
});
