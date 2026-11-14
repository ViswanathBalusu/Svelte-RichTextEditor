/**
 * A footnote inserted at the caret gets the next number the web view shows (FE-135 criterion 4,
 * FE-058 criterion 1). The numbers are the node decorations of `footnoteNumbers()` (view/
 * footnote-view.ts); the test runs `insertFootnote` on the core's document with that plugin and reads
 * the decorations back. Mounting the panel is the view's and is not tested here.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { insertFootnote } from '../src/footnote.ts';
import { DocumentCore } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { footnoteNumbers, footnoteNumbersKey } from '../src/view/footnote-view.ts';
import { caret } from './support.ts';

const microtask = (run: () => void) => queueMicrotask(run);

/** The footnotes of the document in document order: their position and identifier. */
function footnotesOf(doc: PMNode): Array<{ pos: number; id: string }> {
  const out: Array<{ pos: number; id: string }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'footnote') out.push({ pos, id: String(node.attrs['id']) });
    return true;
  });
  return out;
}

/** The number each footnote decoration shows, by position, as the plugin's `data-n` attribute. */
function shownNumbers(state: EditorState): Map<number, string> {
  const shown = new Map<number, string>();
  const set = footnoteNumbersKey.getState(state);
  for (const d of set?.find() ?? []) {
    const attrs = (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
    shown.set(d.from, attrs['data-n'] ?? '');
  }
  return shown;
}

describe('a footnote inserted at the caret gets the next number (FE-135 criterion 4)', () => {
  it('numbers every footnote in document order, and the new one with its own place in that order', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    caret(core, SPIKE_IDS.intro, 'end');
    const start = internals(core).state;
    let state = EditorState.create({
      doc: start.doc,
      selection: start.selection,
      plugins: [footnoteNumbers()],
    });

    const beforeIds = new Set(footnotesOf(state.doc).map((f) => f.id));
    const beforeCount = beforeIds.size;

    const inserted = insertFootnote(state.schema)(state, (tr) => {
      state = state.apply(tr);
    });
    expect(inserted).toBe(true);

    const after = footnotesOf(state.doc);
    expect(after).toHaveLength(beforeCount + 1);
    const added = after.find((f) => !beforeIds.has(f.id));
    expect(added).toBeDefined();

    // Every footnote shows its ordinal in the body, from 1, with no gap and no repeat.
    const shown = shownNumbers(state);
    expect([...shown.values()]).toEqual(after.map((_, i) => String(i + 1)));
    const ordinal = after.findIndex((f) => f.id === added!.id) + 1;
    expect(shown.get(added!.pos)).toBe(String(ordinal));
  });

  it('keeps the numbers of footnotes before the caret, and renumbers only what follows it', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    caret(core, SPIKE_IDS.intro, 'end');
    const start = internals(core).state;
    let state = EditorState.create({
      doc: start.doc,
      selection: start.selection,
      plugins: [footnoteNumbers()],
    });
    const before = footnotesOf(state.doc);
    insertFootnote(state.schema)(state, (tr) => {
      state = state.apply(tr);
    });
    const after = footnotesOf(state.doc);
    const shown = shownNumbers(state);
    // Each footnote that existed before keeps its place in order, so its number is its new ordinal.
    for (const old of before) {
      const i = after.findIndex((f) => f.id === old.id);
      expect(shown.get(after[i]!.pos)).toBe(String(i + 1));
    }
  });
});
