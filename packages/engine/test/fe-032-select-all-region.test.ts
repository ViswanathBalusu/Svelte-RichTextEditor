/**
 * FE-032 criterion 5 (02 §5.2; 07 §7; owner decision 4 of 2026-11-15): Select all selects the whole
 * body, also when the caret is inside a region. 07 §7 clamps a selection that starts inside a region
 * to it; a body selection is not such a selection, and the clamp must leave it alone whenever it
 * looks at the selection again.
 *
 * Node.js, the core without a browser: the key binding the web view installs (`Mod-a`), the command
 * by name, and the two plugins that look at every selection (the body guard and the region clamp).
 * The browser run is packages/element/e2e/fe-032-select-all-region.spec.ts.
 */
import { TextSelection, type EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { BodySelection, bodyRange } from '../src/body.ts';
import { DocumentCore } from '../src/core.ts';
import { clampToRegion } from '../src/regions.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals, press } from '../src/testing.ts';

const microtask = (run: () => void) => queueMicrotask(run);
const state = (c: DocumentCore): EditorState => internals(c).state;

function posOf(s: EditorState, id: string): number {
  let found = -1;
  s.doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no node ${id}`);
  return found;
}

function caret(c: DocumentCore, id: string, offset: number): void {
  const i = internals(c);
  const pos = posOf(i.state, id) + 1 + offset;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
}

const key = (c: DocumentCore, name: string): boolean => {
  const i = internals(c);
  return press(i.schema, name, i.state, i.dispatch);
};

function expectWholeBody(c: DocumentCore): void {
  const s = state(c);
  const b = bodyRange(s.doc);
  expect(s.selection).toBeInstanceOf(BodySelection);
  expect([s.selection.from, s.selection.to]).toEqual([b.start, b.end]);
}

/** A body that starts with a region and ends with one (but for the paragraph that follows it). */
function regionsAtTheEdges(): CdmEnvelope {
  const p = (id: string, text: string) => ({
    type: 'paragraph',
    attrs: { id },
    ...(text ? { content: [{ type: 'text', text }] } : {}),
  });
  return {
    cdm: 1,
    requires: [],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            {
              type: 'region',
              attrs: { id: 'rFirst0000000001', title: 'First', policy: 'restricted' },
              content: [p('pFirstA000000001', 'First region, one.'), p('pFirstB000000001', 'two.')],
            },
            p('pMiddle000000001', 'Between the regions.'),
            {
              type: 'region',
              attrs: { id: 'rLast00000000001', title: 'Last', policy: 'inherit' },
              content: [p('pLastA0000000001', 'Last region.')],
            },
            p('pTrailing0000001', ''),
          ],
        },
      ],
    },
  } as unknown as CdmEnvelope;
}

describe('Select all from inside a region selects the whole body (FE-032 criterion 5; owner decision 4)', () => {
  it('by the key binding and by the command, from any offset in the region', () => {
    const length = 'Liability is limited to direct damages.'.length;
    for (const offset of [0, 5, length]) {
      for (const how of ['key', 'command'] as const) {
        const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
        caret(c, SPIKE_IDS.legal, offset);
        // Not vacuous: the caret is inside the region, where a selection would be clamped.
        expect(state(c).selection.$from.node(-1).type.name).toBe('region');
        if (how === 'key') expect(key(c, 'Mod-a')).toBe(true);
        else expect(c.run('selectAll')).toBe(true);
        expectWholeBody(c);
      }
    }
  });

  it('from a selection inside the region, not only from a caret', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const i = internals(c);
    const at = posOf(i.state, SPIKE_IDS.legal) + 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, at + 2, at + 9)));
    expect(key(c, 'Mod-a')).toBe(true);
    expectWholeBody(c);
  });

  it('where the body starts with a region and ends with one', () => {
    for (const inside of ['pFirstA000000001', 'pFirstB000000001', 'pLastA0000000001']) {
      const c = new DocumentCore({ doc: regionsAtTheEdges(), schedule: microtask });
      caret(c, inside, 1);
      expect(key(c, 'Mod-a')).toBe(true);
      expectWholeBody(c);
      // The selection covers what is outside the region the caret was in.
      const text = state(c).doc.textBetween(state(c).selection.from, state(c).selection.to, '|');
      expect(text).toContain('First region, one.');
      expect(text).toContain('Between the regions.');
      expect(text).toContain('Last region.');
    }
  });

  it('stays the whole body when the plugins look at the selection again', () => {
    const c = new DocumentCore({ doc: regionsAtTheEdges(), schedule: microtask });
    caret(c, 'pFirstB000000001', 1);
    key(c, 'Mod-a');
    const i = internals(c);
    // A transaction that sets the same selection again, as the view does after it read the DOM.
    i.dispatch(state(c).tr.setSelection(new BodySelection(state(c).doc)));
    expectWholeBody(c);
    // A transaction that only carries a mark of its own passes the plugins as well.
    i.dispatch(state(c).tr.setMeta('fe-032-probe', true));
    expectWholeBody(c);
  });

  it('stays the whole body when someone else changes the document meanwhile', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    caret(c, SPIKE_IDS.legal, 3);
    key(c, 'Mod-a');
    const i = internals(c);
    // Text arrives in the paragraph after the region: the selection is mapped, and the clamp of
    // 07 §7 runs because the document changed.
    const after = posOf(state(c), SPIKE_IDS.after) + 1;
    i.dispatch(state(c).tr.insertText('Remote. ', after));
    expectWholeBody(c);
    expect(state(c).doc.textBetween(state(c).selection.from, state(c).selection.to, '|')).toContain(
      'Remote. Remote target paragraph.',
    );
  });

  it('the clamp still holds for a text selection that starts in the region (07 §7)', () => {
    // The control: what Select all is the exception to.
    const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const doc = state(c).doc;
    const inside = posOf(state(c), SPIKE_IDS.legal) + 3;
    const outside = posOf(state(c), SPIKE_IDS.last) + 2;
    const clamped = clampToRegion(doc, inside, outside);
    expect(clamped).not.toBeNull();
    expect(clamped!.$head.node(-1).type.name).toBe('region');
    // A selection made that way through the core is clamped too.
    const i = internals(c);
    i.dispatch(state(c).tr.setSelection(TextSelection.create(doc, inside, outside)));
    expect(state(c).selection).toBeInstanceOf(TextSelection);
    expect(state(c).selection.$to.node(-1).type.name).toBe('region');
    // And Select all from that clamped selection is the whole body again.
    key(c, 'Mod-a');
    expectWholeBody(c);
  });
});
