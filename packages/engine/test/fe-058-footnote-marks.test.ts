/**
 * FE-058 criterion 3: the footnote numbers the web view shows come from the shared numbering
 * algorithm (`computeLabels`, CDM-042), with `settings.footnoteFormat` and `settings.footnoteRestart`,
 * not from a plain count. The numbers are the node decorations of `footnoteNumbers()`; the test builds
 * the document, gives the plugin an editor state and reads the decorations back. It also checks that
 * the numbers are computed again when a section break or the settings change, and not when text is
 * typed outside a footnote. The painted page is not run here (see the story's Notes).
 */
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { footnoteNumbers, footnoteNumbersKey } from '../src/view/footnote-view.ts';

type J = { type: string; attrs?: Record<string, unknown>; content?: J[]; text?: string };

const microtask = (run: () => void) => queueMicrotask(run);

const note = (id: string, paragraph: string): J => ({
  type: 'footnote',
  attrs: { id },
  content: [
    { type: 'paragraph', attrs: { id: paragraph }, content: [{ type: 'text', text: 'Note' }] },
  ],
});

const para = (id: string, content: J[]): J => ({
  type: 'paragraph',
  attrs: { id, style: 'Normal' },
  content,
});

/** The spike document with three footnotes in the body and a section break after the second. */
function document(settings: Record<string, unknown>): CdmEnvelope {
  const env = spikeDocument();
  const doc = env.doc as unknown as J;
  const defs = doc.content!.find((n) => n.type === 'defs')!;
  const sets = defs.content!.find((n) => n.type === 'settings')!;
  sets.attrs = { ...sets.attrs, ...settings };
  const body = doc.content!.find((n) => n.type === 'body')!;
  body.content = [
    para('pA0000000000001', [
      { type: 'text', text: 'One' },
      note('fnA0000000000001', 'pnA000000000001'),
    ]),
    para('pB0000000000001', [
      { type: 'text', text: 'Two' },
      note('fnB0000000000001', 'pnB000000000001'),
    ]),
    {
      type: 'section_break',
      attrs: { id: 'sbA0000000000001', pageSetup: 'ps1', start: 'nextPage' },
    },
    para('pC0000000000001', [
      { type: 'text', text: 'Three' },
      note('fnC0000000000001', 'pnC000000000001'),
    ]),
  ];
  return env;
}

/** The mark each footnote shows, in document order. */
function shown(state: EditorState): string[] {
  const set = footnoteNumbersKey.getState(state);
  return (set?.find() ?? [])
    .sort((a, b) => a.from - b.from)
    .map(
      (d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs['data-n']!,
    );
}

function stateOf(env: CdmEnvelope): EditorState {
  const core = new DocumentCore({ doc: env, schedule: microtask });
  const start = internals(core).state;
  return EditorState.create({ doc: start.doc, plugins: [footnoteNumbers()] });
}

describe('footnote numbers in the web view (FE-058 criterion 3)', () => {
  it('counts through the body in the decimal format by default', () => {
    expect(shown(stateOf(document({})))).toEqual(['1', '2', '3']);
  });

  it('takes the format of footnoteFormat', () => {
    expect(shown(stateOf(document({ footnoteFormat: 'lowerRoman' })))).toEqual(['i', 'ii', 'iii']);
    expect(shown(stateOf(document({ footnoteFormat: 'symbol' })))).toEqual(['*', '†', '‡']);
  });

  it('restarts the count at a section break under footnoteRestart perPageSection, and not under continuous', () => {
    expect(shown(stateOf(document({ footnoteRestart: 'perPageSection' })))).toEqual([
      '1',
      '2',
      '1',
    ]);
    expect(shown(stateOf(document({ footnoteRestart: 'continuous' })))).toEqual(['1', '2', '3']);
  });

  it('gives the same marks as the shared algorithm for the same document', async () => {
    const { computeLabels } = await import('@docedit/model');
    const env = document({ footnoteFormat: 'upperLetter', footnoteRestart: 'perPageSection' });
    const state = stateOf(env);
    const labels = computeLabels(state.doc as PMNode).footnotes;
    expect(shown(state)).toEqual([...labels.values()]);
    expect(shown(state)).toEqual(['A', 'B', 'A']);
  });

  it('numbers again when a section break is added, and when the restart rule changes', () => {
    let state = stateOf(document({ footnoteRestart: 'perPageSection' }));
    expect(shown(state)).toEqual(['1', '2', '1']);
    // Take the section break away: the third footnote continues the count.
    let at = -1;
    let size = 0;
    state.doc.descendants((n, pos) => {
      if (n.type.name === 'section_break') {
        at = pos;
        size = n.nodeSize;
      }
      return true;
    });
    state = state.apply(state.tr.delete(at, at + size));
    expect(shown(state)).toEqual(['1', '2', '3']);
    // Change the rule on the settings node.
    let settingsAt = -1;
    state.doc.descendants((n, pos) => {
      if (n.type.name === 'settings') settingsAt = pos;
      return true;
    });
    state = state.apply(state.tr.setNodeAttribute(settingsAt, 'footnoteFormat', 'lowerLetter'));
    expect(shown(state)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the numbers when text is typed outside a footnote, and the aria-label names the mark', () => {
    let state = stateOf(document({ footnoteFormat: 'symbol' }));
    let pos = -1;
    state.doc.descendants((n, p) => {
      if (pos < 0 && n.type.name === 'paragraph' && n.attrs['id'] === 'pA0000000000001')
        pos = p + 1;
      return true;
    });
    state = state.apply(state.tr.insertText('x', pos));
    expect(shown(state)).toEqual(['*', '†', '‡']);
    const first = footnoteNumbersKey.getState(state)!.find()[0]!;
    expect(
      (first as unknown as { type: { attrs: Record<string, string> } }).type.attrs['aria-label'],
    ).toBe('Footnote *');
  });
});
