/**
 * FE-031 criterion 5: a local transaction never changes a node's non-null identifier (03 §9, I2).
 * Node.js, the headless core with the spike document; no browser.
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/core.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { changesExistingId, REMOTE } from '../src/ids.ts';

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
}

function posOf(doc: ReturnType<typeof internals>['state']['doc'], id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

describe('FE-031 criterion 5: a local change of a non-null id is refused', () => {
  it('a local change of a set id to another value leaves the document unchanged', () => {
    const c = core();
    const i = internals(c);
    const pos = posOf(i.state.doc, SPIKE_IDS.after);
    const before = i.state.doc;
    i.dispatch(i.state.tr.setNodeAttribute(pos, 'id', 'AAAAAAAAAAAAAAAA'));
    expect(i.state.doc.eq(before)).toBe(true);
    expect(posOf(i.state.doc, SPIKE_IDS.after)).toBe(pos);
  });

  it('a local change of a set id to null is refused too', () => {
    const c = core();
    const i = internals(c);
    const pos = posOf(i.state.doc, SPIKE_IDS.after);
    i.dispatch(i.state.tr.setNodeAttribute(pos, 'id', null));
    expect(i.state.doc.nodeAt(pos)!.attrs['id']).toBe(SPIKE_IDS.after);
  });

  it('the predicate refuses a change of a set id and allows a fill, a same value and a remote change', () => {
    const c = core();
    const i = internals(c);
    const pos = posOf(i.state.doc, SPIKE_IDS.after);
    const change = i.state.tr.setNodeAttribute(pos, 'id', 'BBBBBBBBBBBBBBBB');
    expect(changesExistingId(change)).toBe(true);
    const same = i.state.tr.setNodeAttribute(pos, 'id', SPIKE_IDS.after);
    expect(changesExistingId(same)).toBe(false);
    const other = i.state.tr.insertText('x');
    expect(changesExistingId(other)).toBe(false);
  });

  it('typing next to a set identifier still leaves every identifier unchanged', () => {
    const c = core();
    const i = internals(c);
    const before = i.state.doc.nodeAt(posOf(i.state.doc, SPIKE_IDS.after))!.attrs['id'];
    i.dispatch(i.state.tr.insertText('Q'));
    expect(i.state.doc.nodeAt(posOf(i.state.doc, SPIKE_IDS.after))!.attrs['id']).toBe(before);
  });
});

// Review of group 3, round 3: an identifier changed through a replace step (setNodeMarkup is a
// ReplaceAroundStep; a leaf's setNodeMarkup and a swap are ReplaceSteps) is refused too.
describe('FE-031 criterion 5: a change of a set id through a replace step is refused', () => {
  const OTHER = 'ZZZZZZZZZZZZZZZZ';

  /** The paragraph `after`, its position and a non-id attribute with a value to set. */
  function target(c: DocumentCore) {
    const i = internals(c);
    const pos = posOf(i.state.doc, SPIKE_IDS.after);
    const node = i.state.doc.nodeAt(pos)!;
    return { i, pos, node };
  }

  it('setNodeMarkup with another id leaves the document unchanged', () => {
    const { i, pos, node } = target(core());
    const before = i.state.doc;
    const tr = i.state.tr.setNodeMarkup(pos, null, { ...node.attrs, id: OTHER });
    expect(tr.steps[0]!.constructor.name).toBe('ReplaceAroundStep');
    expect(changesExistingId(tr)).toBe(true);
    i.dispatch(tr);
    expect(i.state.doc.eq(before)).toBe(true);
    expect(posOf(i.state.doc, SPIKE_IDS.after)).toBe(pos);
  });

  it('setNodeMarkup with a null id, or with the id of another node, is refused', () => {
    const { i, pos, node } = target(core());
    const toNull = i.state.tr.setNodeMarkup(pos, null, { ...node.attrs, id: null });
    expect(changesExistingId(toNull)).toBe(true);
    const toTaken = i.state.tr.setNodeMarkup(pos, null, { ...node.attrs, id: SPIKE_IDS.last });
    expect(changesExistingId(toTaken)).toBe(true);
    const before = i.state.doc;
    i.dispatch(toNull);
    expect(i.state.doc.eq(before)).toBe(true);
  });

  it('setNodeMarkup on an empty paragraph with another id is refused', () => {
    const c = core();
    const i = internals(c);
    // An empty paragraph after `after`, given its identifier by the plugin.
    const at =
      posOf(i.state.doc, SPIKE_IDS.after) +
      i.state.doc.nodeAt(posOf(i.state.doc, SPIKE_IDS.after))!.nodeSize;
    i.dispatch(i.state.tr.insert(at, i.state.schema.nodes['paragraph']!.create()));
    const empty = i.state.doc.nodeAt(at)!;
    expect(empty.content.size).toBe(0);
    expect(typeof empty.attrs['id']).toBe('string');
    const tr = i.state.tr.setNodeMarkup(at, null, { ...empty.attrs, id: OTHER });
    expect(changesExistingId(tr)).toBe(true);
    i.dispatch(tr);
    expect(i.state.doc.nodeAt(at)!.attrs['id']).toBe(empty.attrs['id']);
  });

  it('a replace that swaps a node for an equal one with another id is refused', () => {
    const { i, pos, node } = target(core());
    const swap = node.type.create({ ...node.attrs, id: OTHER }, node.content, node.marks);
    const tr = i.state.tr.replaceWith(pos, pos + node.nodeSize, swap);
    expect(tr.steps[0]!.constructor.name).toBe('ReplaceStep');
    expect(changesExistingId(tr)).toBe(true);
    const before = i.state.doc;
    i.dispatch(tr);
    expect(i.state.doc.eq(before)).toBe(true);
  });

  it('setBlockType without the id is refused, and with the id kept is accepted', () => {
    const { i, pos, node } = target(core());
    const paragraph = i.state.schema.nodes['paragraph']!;
    const key = Object.keys(node.attrs).find((k) => k !== 'id' && k === 'style');
    expect(key).toBe('style');
    const dropped = i.state.tr.setBlockType(pos + 1, pos + 1, paragraph, { style: 'Heading1' });
    expect(dropped.steps.length).toBe(1);
    expect(changesExistingId(dropped)).toBe(true);
    const before = i.state.doc;
    i.dispatch(dropped);
    expect(i.state.doc.eq(before)).toBe(true);

    const kept = i.state.tr.setBlockType(pos + 1, pos + 1, paragraph, {
      ...node.attrs,
      style: 'Heading1',
    });
    expect(changesExistingId(kept)).toBe(false);
  });

  it('setNodeMarkup that keeps the id is not a change', () => {
    const { i, pos, node } = target(core());
    const tr = i.state.tr.setNodeMarkup(pos, null, { ...node.attrs, style: 'Heading1' });
    expect(changesExistingId(tr)).toBe(false);
  });

  it('deleting, joining and replacing with new content are not changes of an id', () => {
    const { i, pos, node } = target(core());
    // Deleting the paragraph.
    expect(changesExistingId(i.state.tr.delete(pos, pos + node.nodeSize))).toBe(false);
    // Joining the next paragraph into it (Backspace at the start of the next): it keeps its id.
    expect(changesExistingId(i.state.tr.join(pos + node.nodeSize))).toBe(false);
    // The same into an empty paragraph, whose id the joined content then carries.
    const at = pos + node.nodeSize;
    i.dispatch(i.state.tr.insert(at, i.state.schema.nodes['paragraph']!.create()));
    const empty = i.state.doc.nodeAt(at)!;
    expect(typeof empty.attrs['id']).toBe('string');
    const joined = i.state.tr.join(at + empty.nodeSize);
    expect(joined.doc.nodeAt(at)!.attrs['id']).toBe(empty.attrs['id']);
    expect(changesExistingId(joined)).toBe(false);
    // Replacing it with a pasted paragraph of other content (null id, filled by the plugin).
    const pasted = node.type.create({ ...node.attrs, id: null }, i.state.schema.text('Pasted'));
    expect(changesExistingId(i.state.tr.replaceWith(pos, pos + node.nodeSize, pasted))).toBe(false);
    // Moving it after the next paragraph, with its id.
    const next = i.state.doc.nodeAt(pos + node.nodeSize)!;
    const move = i.state.tr.delete(pos, pos + node.nodeSize);
    move.insert(pos + next.nodeSize, node);
    expect(changesExistingId(move)).toBe(false);
  });

  it('a remote setNodeMarkup is exempt', () => {
    const { i, pos, node } = target(core());
    const tr = i.state.tr
      .setNodeMarkup(pos, null, { ...node.attrs, id: OTHER })
      .setMeta(REMOTE, true);
    expect(changesExistingId(tr)).toBe(false);
  });
});
