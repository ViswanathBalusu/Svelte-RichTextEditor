/**
 * FE-026 criterion 3 (lane V-FE-017-032): the main selection never enters the definitions. A
 * selection set on a settings node is clamped to the body, so `selectionScope()` reports `body`
 * there; the `defs` scope is what the guard uses for a page setup (`#scopeIn`). Node.js, the
 * headless core on the spike document.
 */
import { NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/core.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';

describe('FE-026 criterion 3: selectionScope() and the definitions', () => {
  it('keeps a selection on a settings node out of the definitions (clamped to the body)', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
    const i = internals(c);
    let at = -1;
    i.state.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === 'settings') at = pos;
      return at < 0;
    });
    expect(at).toBeGreaterThanOrEqual(0);
    i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, at)));
    expect(i.state.doc.nodeAt(i.state.selection.from)?.type.name).not.toBe('settings');
    expect(c.selectionScope().scope).toBe('body');
  });
});
