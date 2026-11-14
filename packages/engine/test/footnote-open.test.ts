/**
 * The insert-footnote command in the headless core (FE-058 criterion 1, core part): a footnote with
 * a fresh identifier goes in at the caret of body text, holds one paragraph, and the core names it
 * as the panel's target, which is the state the sub-editor opens on. Mounting the sub-editor is the
 * view's and is not tested here.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { caret, posOf } from './support.ts';

const microtask = (run: () => void) => queueMicrotask(run);

function footnotes(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'footnote') out.push(node);
    return true;
  });
  return out;
}

describe('insert-footnote at the caret opens the panel on the new footnote (FE-058 criterion 1)', () => {
  it('inserts one footnote with a fresh identifier at the caret in body text', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const before = footnotes(internals(core).state.doc);
    const beforeIds = new Set(before.map((n) => n.attrs['id']));

    caret(core, SPIKE_IDS.intro, 'end');
    expect(core.run('insertFootnote')).toBe(true);

    const after = footnotes(internals(core).state.doc);
    expect(after).toHaveLength(before.length + 1);
    const added = after.find((n) => !beforeIds.has(n.attrs['id']));
    expect(added).toBeDefined();
    expect(typeof added!.attrs['id']).toBe('string');
    expect(added!.attrs['id']).not.toBe('');

    // The footnote sits inside the introduction paragraph, where the caret was.
    const intro = internals(core).state.doc.nodeAt(
      posOf(internals(core).state.doc, SPIKE_IDS.intro),
    )!;
    const inIntro: string[] = [];
    intro.descendants((node) => {
      if (node.type.name === 'footnote') inIntro.push(String(node.attrs['id']));
      return true;
    });
    expect(inIntro).toContain(added!.attrs['id']);
  });

  it('names the new footnote as the panel target, with one paragraph in its content', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    caret(core, SPIKE_IDS.intro, 'end');
    expect(core.panel.get()).toBeNull();

    expect(core.run('insertFootnote')).toBe(true);

    const i = internals(core);
    const added = footnotes(i.state.doc).at(-1)!;
    expect(added.childCount).toBe(1);
    expect(added.firstChild!.type.name).toBe('paragraph');
    expect(core.panel.get()).toEqual({
      kind: 'footnote',
      id: added.attrs['id'],
      label: 'Footnote',
    });
  });
});
