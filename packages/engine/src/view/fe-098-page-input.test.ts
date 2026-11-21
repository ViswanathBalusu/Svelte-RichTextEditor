/**
 * FE-098 criterion 1 (the document side of the bridge): the page view reads and changes the core
 * through block identifiers and offsets, and every change goes through the core's transaction path.
 * Runs in Node.js with no view mounted.
 */
import { describe, expect, it } from 'vitest';
import { SPIKE_IDS, spikeDocument } from '../spike-document.ts';
import { EditorCore } from './web.ts';

function setup() {
  const core = new EditorCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
  const updates: Array<{ docChanged: boolean; replaced: boolean }> = [];
  const handle = core.attachPageView({
    update: (docChanged, replaced) => updates.push({ docChanged, replaced }),
    focus: () => {},
  });
  return { core, handle, updates };
}

describe('the page view handle (FE-098)', () => {
  it('reads the text of a block and the blocks in order', () => {
    const { handle } = setup();
    expect(handle.text(SPIKE_IDS.title)).not.toBeNull();
    expect(handle.text('nope')).toBeNull();
    const ids = handle.blocks().map((b) => b.id);
    expect(ids).toContain(SPIKE_IDS.title);
    expect(ids).toContain(SPIKE_IDS.last);
    // Text blocks inside a footnote or a header story belong to their panel, not to the page view.
    expect(ids).not.toContain(SPIKE_IDS.footnoteParagraph);
    expect(ids).not.toContain(SPIKE_IDS.headerParagraph);
  });

  it('places a caret and reads it back as a block point', () => {
    const { handle } = setup();
    expect(handle.select({ blockId: SPIKE_IDS.title, offset: 2 })).toBe(true);
    expect(handle.selection()).toEqual({
      anchor: { blockId: SPIKE_IDS.title, offset: 2 },
      head: { blockId: SPIKE_IDS.title, offset: 2 },
    });
    expect(handle.select({ blockId: 'nope', offset: 0 })).toBe(false);
  });

  it('types text at the caret and moves the caret after it', () => {
    const { handle, updates } = setup();
    const before = handle.text(SPIKE_IDS.title)!;
    handle.select({ blockId: SPIKE_IDS.title, offset: 1 });
    updates.length = 0;
    expect(handle.replace(SPIKE_IDS.title, 1, 1, 'XY')).toBe(true);
    expect(handle.text(SPIKE_IDS.title)).toBe(before.slice(0, 1) + 'XY' + before.slice(1));
    expect(handle.selection()?.head).toEqual({ blockId: SPIKE_IDS.title, offset: 3 });
    expect(updates.some((u) => u.docChanged)).toBe(true);
  });

  it('deletes a range and replaces a range', () => {
    const { handle } = setup();
    const before = handle.text(SPIKE_IDS.title)!;
    expect(handle.replace(SPIKE_IDS.title, 0, 2, '')).toBe(true);
    expect(handle.text(SPIKE_IDS.title)).toBe(before.slice(2));
    expect(handle.replace(SPIKE_IDS.title, 0, 1, 'Q', 1)).toBe(true);
    expect(handle.text(SPIKE_IDS.title)!.startsWith('Q')).toBe(true);
    expect(handle.replace(SPIKE_IDS.title, 0, 9999, 'x')).toBe(false);
  });

  it('runs the body view’s key bindings: Enter splits the block, Backspace joins it again', () => {
    const { handle } = setup();
    const count = handle.blocks().length;
    handle.select({ blockId: SPIKE_IDS.title, offset: 3 });
    expect(handle.key('Enter')).toBe(true);
    expect(handle.blocks().length).toBe(count + 1);
    expect(handle.key('Backspace')).toBe(true);
    expect(handle.blocks().length).toBe(count);
  });

  it('steps left and right across block edges in reading order', () => {
    const { handle } = setup();
    const ids = handle.blocks().map((b) => b.id);
    const first = ids[0]!;
    const size = handle.blocks()[0]!.size;
    expect(handle.step({ blockId: first, offset: size }, 'right')).toEqual({
      blockId: ids[1],
      offset: 0,
    });
    expect(handle.step({ blockId: ids[1]!, offset: 0 }, 'left')).toEqual({
      blockId: first,
      offset: size,
    });
    expect(handle.step({ blockId: first, offset: 0 }, 'left')).toEqual({
      blockId: first,
      offset: 0,
    });
  });

  it('refuses edits while the core is read-only', () => {
    const { core, handle } = setup();
    core.setMode('view');
    expect(handle.readOnly()).toBe(true);
    expect(handle.replace(SPIKE_IDS.title, 0, 0, 'z')).toBe(false);
    expect(handle.key('Enter')).toBe(false);
  });

  it('holds back nothing for a remote change when no composition is open', () => {
    const { handle } = setup();
    handle.composing(SPIKE_IDS.title);
    handle.composing(null);
    expect(handle.text(SPIKE_IDS.title)).not.toBeNull();
  });
});
