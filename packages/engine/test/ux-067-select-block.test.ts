/**
 * UX-067 criterion 1, the core's half: `selectBlock` moves the caret to the start of a block, or
 * selects a block that holds no text, and asks the view to scroll it into view. A block that is
 * not there, is in a header or a footnote, or is in a scope the reader may not view, changes nothing.
 * The scroll itself is checked in browsers in src/view/ux-067-select-block.universal.test.ts.
 */
import { NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { internals } from '../src/testing.ts';
import { SPIKE_IDS, editorAccess, spikeDocument } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

function setup() {
  const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const state = () => internals(core).state;
  const scrolled: boolean[] = [];
  internals(core).onTransaction((tr) => scrolled.push(tr.scrolledIntoView));
  return { core, state, scrolled };
}

describe('UX-067 criterion 1: choosing an issue moves to its block', () => {
  it('puts the caret at the start of a paragraph and asks for it to be scrolled into view', () => {
    const { core, state, scrolled } = setup();
    expect(core.selectBlock(SPIKE_IDS.last)).toBe(true);
    const at = posOf(state().doc, SPIKE_IDS.last);
    expect(state().selection.empty).toBe(true);
    expect(state().selection.from).toBe(at + 1);
    expect(scrolled.at(-1)).toBe(true);
    expect(core.selection.get().empty).toBe(true);
  });

  it('works for a block in a region, and moves between blocks', () => {
    const { core, state } = setup();
    core.setAccess(editorAccess());
    expect(core.selectBlock(SPIKE_IDS.legal)).toBe(true);
    expect(state().selection.from).toBe(posOf(state().doc, SPIKE_IDS.legal) + 1);
    expect(core.selectBlock(SPIKE_IDS.title)).toBe(true);
    expect(state().selection.from).toBe(posOf(state().doc, SPIKE_IDS.title) + 1);
  });

  it('selects a block with no text as a whole', () => {
    const { core, state } = setup();
    const at = posOf(state().doc, SPIKE_IDS.intro);
    const block = state().schema.nodes['extension_block']!.create({
      id: 'xBlock0000000001',
      extension: 'com.example.chart',
      payload: {},
      fallbackText: 'x',
    });
    internals(core).dispatch(state().tr.insert(at, block));
    expect(core.selectBlock('xBlock0000000001')).toBe(true);
    expect(state().selection).toBeInstanceOf(NodeSelection);
    expect(state().selection.from).toBe(posOf(state().doc, 'xBlock0000000001'));
  });

  it('changes nothing for a block that is not there, in a header, in a footnote, or hidden', () => {
    const { core, state } = setup();
    const doc = state().doc;
    const before = state().selection;
    expect(core.selectBlock('nope000000000000')).toBe(false);
    expect(core.selectBlock(SPIKE_IDS.headerParagraph)).toBe(false);
    expect(core.selectBlock(SPIKE_IDS.footnoteParagraph)).toBe(false);
    core.setAccess(
      editorAccess({
        scopes: {
          doc: ['view'],
          body: ['view', 'edit'],
          defs: ['view'],
          [`region:${SPIKE_IDS.region}`]: [],
        },
      }),
    );
    expect(core.selectBlock(SPIKE_IDS.legal)).toBe(false);
    expect(state().doc).toBe(doc);
    expect(state().selection.eq(before)).toBe(true);
  });
});
