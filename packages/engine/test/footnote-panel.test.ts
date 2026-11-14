/**
 * Footnotes in the headless core (FE-058 criteria 2 and 5; 03 §4.4, §13; CDM-001): the footnote
 * sub-editor accepts exactly one paragraph and refuses a second one, and deleting the footnote
 * reference deletes the footnote with its content. The panel itself (the view) is not tested here.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { validate } from '@docedit/model/validate';
import { describe, expect, it } from 'vitest';
import { noBlockersInNote, oneParagraphLimit } from '../src/footnote.ts';
import { DocumentCore, insertFootnote } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';
import { posOf } from './support.ts';

const microtask = (run: () => void) => queueMicrotask(run);

/** Every footnote node of a document, in order. */
function footnotes(doc: PMNode): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'footnote') out.push(node);
    return true;
  });
  return out;
}

/** Position of the footnote with identifier `id`, or -1. */
function footnotePos(doc: PMNode, id: unknown): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === 'footnote' && node.attrs['id'] === id) found = pos;
    return found < 0;
  });
  return found;
}

describe('a footnote holds exactly one paragraph (FE-058 criterion 2)', () => {
  it('accepts an edit inside the one paragraph and refuses a second paragraph', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const note = footnotes(internals(core).state.doc)[0]!;
    expect(note.childCount).toBe(1);

    // The sub-editor's document is the footnote itself, limited to one paragraph.
    const panel = EditorState.create({ doc: note, plugins: [oneParagraphLimit()] });

    const typed = panel.applyTransaction(panel.tr.insertText('Noted: ', 1)).state;
    expect(typed.doc.childCount).toBe(1);
    expect(typed.doc.textContent).toBe('Noted: Footnote text');

    // Splitting the paragraph would leave two paragraphs in the footnote: refused, state unchanged.
    const split = typed.applyTransaction(typed.tr.split(4));
    expect(split.state).toBe(typed);
    expect(split.transactions).toHaveLength(0);
    expect(split.state.doc.childCount).toBe(1);
  });
});

describe('deleting the footnote reference deletes the footnote and its content (FE-058 criterion 5)', () => {
  it('removes the inserted footnote with its paragraph and leaves the document valid', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const before = validate(core.getContent()).violations.length;

    // Insert a footnote at the caret in the introduction paragraph (FE-058 criterion 1).
    let i = internals(core);
    const caret = posOf(i.state.doc, SPIKE_IDS.intro) + 1;
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, caret)));
    const inserted = insertFootnote(i.state.schema)(i.state, (tr) => i.dispatch(tr));
    expect(inserted).toBe(true);

    i = internals(core);
    const all = footnotes(i.state.doc);
    expect(all).toHaveLength(2);
    const created = all.find((n) => n.attrs['id'] !== SPIKE_IDS.footnote)!;
    expect(typeof created.attrs['id']).toBe('string');
    expect(created.attrs['id']).not.toBe('');
    expect(validate(core.getContent()).violations.length).toBe(before);

    // Select the reference itself and delete it: the footnote goes with its content.
    const at = footnotePos(i.state.doc, created.attrs['id']);
    expect(at).toBeGreaterThanOrEqual(0);
    i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, at)));
    i.dispatch(internals(core).state.tr.deleteSelection());

    i = internals(core);
    expect(footnotes(i.state.doc).map((n) => n.attrs['id'])).toEqual([SPIKE_IDS.footnote]);
    expect(validate(core.getContent()).violations.length).toBe(before);
  });

  it('refuses to insert a footnote inside a footnote (I10, the first half of criterion 4)', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const i = internals(core);
    const note = footnotes(i.state.doc)[0]!;
    const notePos = footnotePos(i.state.doc, note.attrs['id']);
    // Inside the footnote's paragraph: one position past the footnote's open token and the paragraph's.
    const inside = notePos + 2;
    const state = i.state.apply(i.state.tr.setSelection(TextSelection.create(i.state.doc, inside)));
    expect(insertFootnote(state.schema)(state)).toBe(false);
  });
});

/** Dispatches through the core and reports whether the document changed (the guard decides). */
function dispatchChanged(core: DocumentCore, make: (i: ReturnType<typeof internals>) => void) {
  const before = internals(core).state.doc;
  make(internals(core));
  return internals(core).state.doc !== before;
}

describe('a footnote takes no table and no page or column break (FE-058 criterion 4)', () => {
  it('refuses a page break, a column break and a table in the footnote, and keeps a line break', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const i = internals(core);
    const inNote = posOf(i.state.doc, SPIKE_IDS.footnoteParagraph) + 2;
    const { schema } = i.state;

    for (const kind of ['page', 'column']) {
      const brk = schema.nodes['break']!.create({ kind });
      expect(dispatchChanged(core, (x) => x.dispatch(x.state.tr.insert(inNote, brk)))).toBe(false);
      expect(core.refusal.get()?.reason).toBe('invariant');
    }

    const table = schema.nodes['table']!.createAndFill({ grid: [1440] })!;
    expect(dispatchChanged(core, (x) => x.dispatch(x.state.tr.insert(inNote, table)))).toBe(false);
    expect(core.refusal.get()?.reason).toBe('invariant');

    // A line break is allowed in a footnote.
    const line = schema.nodes['break']!.create({ kind: 'line' });
    expect(dispatchChanged(core, (x) => x.dispatch(x.state.tr.insert(inNote, line)))).toBe(true);
    // The document is still valid.
    expect(validate(core.getContent()).violations).toEqual([]);
  });

  it('the footnote panel refuses a page break or a table before the document sees it', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const { schema } = internals(core).state;
    const note = footnotes(internals(core).state.doc)[0]!;
    const panel = EditorState.create({
      doc: note,
      plugins: [oneParagraphLimit(), noBlockersInNote()],
    });
    const page = schema.nodes['break']!.create({ kind: 'page' });
    expect(panel.apply(panel.tr.insert(2, page))).toBe(panel);
    const table = schema.nodes['table']!.createAndFill({ grid: [1440] })!;
    expect(panel.apply(panel.tr.insert(2, table))).toBe(panel);
    // A line break and typing stay allowed.
    const line = schema.nodes['break']!.create({ kind: 'line' });
    const withBreak = panel.apply(panel.tr.insert(2, line));
    expect(withBreak).not.toBe(panel);
    expect(withBreak.doc.textContent).toBe('F\nootnote text');
    expect(panel.apply(panel.tr.insertText('x', 2)).doc.textContent).toBe('Fxootnote text');
  });

  it('insert-footnote is unavailable in a caption (I10, the caption half of criterion 4)', () => {
    const core = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    const { schema } = internals(core).state;
    const caption = schema.nodes['caption']!;
    // The caption's content model takes no footnote, and the command refuses it too.
    expect(caption.contentMatch.matchType(schema.nodes['footnote']!)).toBeNull();
    const doc = schema.nodes['doc']!.create(null, [
      schema.nodes['figure']!.create(null, [caption.create(null, [schema.text('Cap')])]),
    ]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
    expect(state.selection.$from.parent.type.name).toBe('caption');
    expect(insertFootnote(schema)(state)).toBe(false);
  });
});
