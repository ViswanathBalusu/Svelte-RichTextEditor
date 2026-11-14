/**
 * FE-026 criterion 3: `selectionScope()` returns the scope of the selection (body, region, the
 * definitions or a story) and the block identifier. Node.js, the headless core on the spike document.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/core.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
}

function caretIn(c: DocumentCore, blockId: string, offset = 0): void {
  const i = internals(c);
  let found = -1;
  i.state.doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === blockId) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no block ${blockId}`);
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, found + 1 + offset)));
}

describe('FE-026 criterion 3: selectionScope()', () => {
  it('reports the body and the block identifier for a caret in a body paragraph', () => {
    const c = core();
    caretIn(c, SPIKE_IDS.after, 2);
    expect(c.selectionScope()).toEqual({ scope: 'body', blockId: SPIKE_IDS.after });
  });

  it('reports the region the caret lies in', () => {
    const c = core();
    caretIn(c, SPIKE_IDS.legal, 1);
    expect(c.selectionScope()).toEqual({
      scope: `region:${SPIKE_IDS.region}`,
      blockId: SPIKE_IDS.legal,
    });
  });

  it('keeps the main selection out of a story: a caret set in the header is clamped to the body', () => {
    // The definitions and stories are isolating; a header is edited in its own sub-editor state,
    // which the core does not report as its selection (see the story's Notes).
    const c = core();
    caretIn(c, SPIKE_IDS.headerParagraph, 0);
    expect(c.selectionScope().scope).toBe('body');
  });
});
