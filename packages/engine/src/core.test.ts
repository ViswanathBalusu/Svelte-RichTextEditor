/**
 * The editing core in Node.js without a browser (FE-121): identifiers (FE-031; CDM-012), the
 * body-scoped commands (FE-032), and the schema rules the core relies on. Key presses run through
 * the same bindings the web view installs (`press`).
 */
import { validate } from '@docedit/model/validate';
import { joinBackward } from 'prosemirror-commands';
import {
  EditorState as PlainState,
  NodeSelection,
  Selection,
  TextSelection,
  type EditorState,
} from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { BodySelection, bodyRange, stopAtBodyEdge } from './body.ts';
import { DocumentCore } from './core.ts';
import { editingSchema } from './schema.ts';
import { SPIKE_IDS, spikeDocument } from './spike-document.ts';
import { internals, press } from './testing.ts';

const microtask = (run: () => void) => queueMicrotask(run);

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), schedule: microtask });
}

function posOf(state: EditorState, id: string): number {
  let found = -1;
  state.doc.descendants((node, pos) => {
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

function ids(state: EditorState): Array<string | null> {
  const out: Array<string | null> = [];
  state.doc.descendants((node) => {
    if (node.type.spec.attrs?.['id'] && node.type.name !== 'hidden_region')
      out.push((node.attrs['id'] as string | null) ?? null);
    return true;
  });
  return out;
}

const valid = (c: DocumentCore) => validate(c.getContent()).violations;
const state = (c: DocumentCore) => internals(c).state;

describe('editing schema (03 §3, §9; 02 §5.2)', () => {
  it('reads the spike document, which validates, with the footnote of CDM-001 option B', () => {
    const c = core();
    expect(valid(c)).toEqual([]);
    expect(editingSchema().nodes['footnote']!.spec.content).toBe('paragraph+');
  });

  it('defaults every id to null and keeps definitions and stories unselectable', () => {
    const s = editingSchema();
    for (const name of Object.keys(s.nodes)) {
      const attr = s.nodes[name]!.spec.attrs?.['id'];
      if (attr && name !== 'hidden_region') expect(attr.default, name).toBeNull();
    }
    for (const name of ['defs', 'story', 'settings', 'style_def', 'page_setup'])
      expect(s.nodes[name]!.spec.selectable).toBe(false);
    for (const name of ['defs', 'story']) {
      expect(s.nodes[name]!.spec.isolating).toBe(true);
      expect(s.nodes[name]!.spec.allowGapCursor).toBe(false);
    }
    const c = core();
    let defsPos = -1;
    state(c).doc.forEach((node, offset) => {
      if (node.type.name === 'defs') defsPos = offset;
    });
    expect(NodeSelection.isSelectable(state(c).doc.nodeAt(defsPos)!)).toBe(false);
  });

  it('starts with the caret in the body, not in the header story', () => {
    const c = core();
    const b = bodyRange(state(c).doc);
    expect(state(c).selection.from).toBeGreaterThanOrEqual(b.start);
    expect(state(c).selection.$from.parent.attrs['id']).toBe(SPIKE_IDS.title);
    // ProseMirror's default, Selection.atStart, would put it in the hidden header story.
    expect(Selection.atStart(state(c).doc).$from.parent.attrs['id']).toBe(
      SPIKE_IDS.headerParagraph,
    );
  });
});

describe('identifier plugin (03 §9; ADR 0018; FE-031; CDM-012)', () => {
  it('a split in the middle keeps the id in the first half; the second gets a fresh one', () => {
    const c = core();
    caret(c, SPIKE_IDS.after, 6);
    expect(key(c, 'Enter')).toBe(true);
    const list = ids(state(c));
    expect(list).not.toContain(null);
    expect(new Set(list).size).toBe(list.length);
    const first = state(c).doc.nodeAt(posOf(state(c), SPIKE_IDS.after))!;
    expect(first.textContent).toBe('Remote');
    const second = state(c).doc.resolve(
      posOf(state(c), SPIKE_IDS.after) + first.nodeSize,
    ).nodeAfter!;
    expect(second.textContent).toBe(' target paragraph.');
    expect(second.attrs['id']).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(valid(c)).toEqual([]);
  });

  it('Enter at the start gives the fresh id to the new empty paragraph', () => {
    const c = core();
    caret(c, SPIKE_IDS.after, 0);
    key(c, 'Enter');
    const kept = state(c).doc.nodeAt(posOf(state(c), SPIKE_IDS.after))!;
    expect(kept.textContent).toBe('Remote target paragraph.');
    const before = state(c).doc.resolve(posOf(state(c), SPIKE_IDS.after)).nodeBefore!;
    expect(before.content.size).toBe(0);
    expect(typeof before.attrs['id']).toBe('string');
    expect(before.attrs['id']).not.toBe(SPIKE_IDS.after);
    expect(valid(c)).toEqual([]);
  });

  it('Enter at the end gives the fresh id to the new paragraph', () => {
    const c = core();
    caret(c, SPIKE_IDS.after, 'Remote target paragraph.'.length);
    key(c, 'Enter');
    const kept = state(c).doc.nodeAt(posOf(state(c), SPIKE_IDS.after))!;
    expect(kept.textContent).toBe('Remote target paragraph.');
    expect(ids(state(c))).not.toContain(null);
    expect(valid(c)).toEqual([]);
  });

  it('a pasted copy gets a fresh id and the original keeps its own', () => {
    const c = core();
    const i = internals(c);
    const pos = posOf(i.state, SPIKE_IDS.after);
    const copy = i.state.doc.nodeAt(pos)!;
    i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, copy));
    const list = ids(i.state);
    expect(list.filter((x) => x === SPIKE_IDS.after)).toHaveLength(1);
    expect(posOf(i.state, SPIKE_IDS.after)).toBe(pos);
    expect(new Set(list).size).toBe(list.length);
  });

  it('a pasted copy placed before the original still leaves the original its id', () => {
    const c = core();
    const i = internals(c);
    const copy = i.state.doc.nodeAt(posOf(i.state, SPIKE_IDS.last))!;
    i.dispatch(i.state.tr.insert(posOf(i.state, SPIKE_IDS.after), copy));
    const original = i.state.doc.nodeAt(posOf(i.state, SPIKE_IDS.last))!;
    expect(original.textContent).toBe('Last paragraph.');
    const list = ids(i.state);
    expect(new Set(list).size).toBe(list.length);
  });

  it('every node of a copied region gets a fresh id, the region included', () => {
    const c = core();
    const i = internals(c);
    const region = i.state.doc.nodeAt(posOf(i.state, SPIKE_IDS.region))!;
    const before = new Set(ids(i.state));
    i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, region));
    const after = ids(i.state);
    expect(after).not.toContain(null);
    expect(new Set(after).size).toBe(after.length);
    const fresh = after.filter((x) => !before.has(x));
    // The copied region, its paragraph, and the paragraph kept after it (FE-039).
    expect(fresh.length).toBe(3);
    expect(valid(c)).toEqual([]);
  });

  it('fills a null id in the same state update: no state the queue sees has a null id', () => {
    const c = core();
    const i = internals(c);
    const seen: Array<Array<string | null>> = [];
    const stop = i.onTransaction((_tr, s) => seen.push(ids(s)));
    const para = i.schema.nodes['paragraph']!.create(null, i.schema.text('New'));
    i.dispatch(i.state.tr.insert(posOf(i.state, SPIKE_IDS.last), para));
    stop();
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain(null);
    // The queued steps include the fill: the document they produce has no null id.
    expect(ids({ doc: i.sync.visible } as EditorState)).not.toContain(null);
  });

  it('never changes an existing id: typing, marks and styles leave every id as it was', () => {
    const c = core();
    const i = internals(c);
    const before = ids(i.state);
    caret(c, SPIKE_IDS.after, 3);
    i.dispatch(i.state.tr.insertText('xyz'));
    c.run('paragraphStyle', { style: 'Heading1' });
    key(c, 'Mod-a');
    c.run('italic');
    expect(ids(i.state)).toEqual(before);
  });

  it('undo after Enter undoes the split and the typing around it (one group)', () => {
    const c = core();
    const i = internals(c);
    const original = i.state.doc;
    caret(c, SPIKE_IDS.after, 'Remote target paragraph.'.length);
    i.dispatch(i.state.tr.insertText(' typed'));
    key(c, 'Enter');
    i.dispatch(i.state.tr.insertText('New paragraph'));
    expect(c.queryCommand('undo').enabled).toBe(true);
    expect(c.run('undo')).toBe(true);
    expect(c.refusal.get()).toBeNull();
    expect(i.state.doc.eq(original)).toBe(true);
    expect(ids(i.state)).not.toContain(null);
    expect(c.run('redo')).toBe(true);
    const after = i.state.doc.nodeAt(posOf(i.state, SPIKE_IDS.after))!;
    expect(after.textContent).toBe('Remote target paragraph. typed');
    expect(valid(c)).toEqual([]);
  });

  it('undo and redo run through the command registry; the key table does not bind Mod-z (FE-049 criterion 7)', () => {
    const c = core();
    const i = internals(c);
    const original = i.state.doc;
    caret(c, SPIKE_IDS.after, 'Remote target paragraph.'.length);
    i.dispatch(i.state.tr.insertText(' typed'));
    const typed = i.state.doc;
    expect(typed.eq(original)).toBe(false);
    // The key table has no undo binding, so a press of Mod-z changes nothing (core.ts binds it).
    expect(key(c, 'Mod-z')).toBe(false);
    expect(i.state.doc.eq(typed)).toBe(true);
    expect(c.run('undo')).toBe(true);
    expect(i.state.doc.eq(original)).toBe(true);
    expect(c.run('redo')).toBe(true);
    expect(i.state.doc.eq(typed)).toBe(true);
    expect(valid(c)).toEqual([]);
  });

  it('a footnote inserted with its paragraph gets ids for both (I2)', () => {
    const c = core();
    caret(c, SPIKE_IDS.last, 4);
    expect(c.run('insertFootnote')).toBe(true);
    expect(ids(state(c))).not.toContain(null);
    expect(valid(c)).toEqual([]);
  });
});

describe('body-scoped commands (02 §5.2; FE-032)', () => {
  it('select all covers the body and nothing else; deleting it keeps one paragraph', () => {
    const c = core();
    const outside = (state(c).doc.toJSON() as { content: unknown[] }).content.slice(0, -1);
    expect(key(c, 'Mod-a')).toBe(true);
    expect(state(c).selection).toBeInstanceOf(BodySelection);
    const b = bodyRange(state(c).doc);
    expect([state(c).selection.from, state(c).selection.to]).toEqual([b.start, b.end]);
    key(c, 'Delete');
    expect((state(c).doc.toJSON() as { content: unknown[] }).content.slice(0, -1)).toEqual(outside);
    const body = state(c).doc.lastChild!;
    expect(body.childCount).toBe(1);
    expect(body.firstChild!.type.name).toBe('paragraph');
    expect(ids(state(c))).not.toContain(null);
    expect(valid(c)).toEqual([]);
  });

  it('select all from inside a region selects the whole body (02 §5.2, the spec default)', () => {
    const c = core();
    caret(c, SPIKE_IDS.legal, 2);
    c.run('selectAll');
    const b = bodyRange(state(c).doc);
    expect([state(c).selection.from, state(c).selection.to]).toEqual([b.start, b.end]);
  });

  it('typing over select all replaces the body only', () => {
    const c = core();
    const outside = (state(c).doc.toJSON() as { content: unknown[] }).content.slice(0, -1);
    c.run('selectAll');
    internals(c).dispatch(state(c).tr.insertText('X'));
    expect(state(c).doc.lastChild!.textContent).toBe('X');
    expect((state(c).doc.toJSON() as { content: unknown[] }).content.slice(0, -1)).toEqual(outside);
  });

  it('the start and end commands go to the first and last body positions', () => {
    const c = core();
    caret(c, SPIKE_IDS.after, 3);
    key(c, 'Mod-Home');
    const b = bodyRange(state(c).doc);
    expect(state(c).selection.$from.parent.attrs['id']).toBe(SPIKE_IDS.title);
    expect(state(c).selection.from).toBe(b.start + 1);
    key(c, 'Mod-End');
    expect(state(c).selection.$from.parent.attrs['id']).toBe(SPIKE_IDS.last);
    expect(state(c).selection.to).toBe(b.end - 1);
    key(c, 'Shift-Mod-Home');
    expect(state(c).selection.from).toBe(b.start + 1);
    expect(state(c).selection.to).toBe(b.end - 1);
  });

  it("without the body commands, ProseMirror's Backspace moves an empty first paragraph's caret into the header story", () => {
    const c = core();
    const pos = posOf(state(c), SPIKE_IDS.title);
    const emptied = state(c).tr.delete(pos + 1, pos + 1 + 'Scope'.length);
    const plain = PlainState.create({ doc: emptied.doc });
    const atStart = plain.apply(plain.tr.setSelection(TextSelection.create(emptied.doc, pos + 1)));
    let after: EditorState | null = null;
    expect(joinBackward(atStart, (tr) => (after = atStart.apply(tr)))).toBe(true);
    expect((after as EditorState | null)!.selection.$from.parent.attrs['id']).toBe(
      SPIKE_IDS.headerParagraph,
    );
    // The core's binding consumes the same key press, and nothing changes.
    const guarded = core();
    caret(guarded, SPIKE_IDS.title, 0);
    const doc = state(guarded).doc;
    expect(key(guarded, 'Backspace')).toBe(true);
    expect(state(guarded).doc).toBe(doc);
  });

  it('Backspace at the first body position and Delete at the last are consumed; elsewhere not', () => {
    const c = core();
    caret(c, SPIKE_IDS.title, 0);
    expect(stopAtBodyEdge('start')(state(c))).toBe(true);
    caret(c, SPIKE_IDS.title, 1);
    expect(stopAtBodyEdge('start')(state(c))).toBe(false);
    caret(c, SPIKE_IDS.last, 'Last paragraph.'.length);
    expect(stopAtBodyEdge('end')(state(c))).toBe(true);
    const doc = state(c).doc;
    expect(key(c, 'Delete')).toBe(true);
    expect(state(c).doc).toBe(doc);
  });

  it('a selection placed in the header story is clamped into the body', () => {
    const c = core();
    const inStory = posOf(state(c), SPIKE_IDS.headerParagraph) + 2;
    internals(c).dispatch(state(c).tr.setSelection(TextSelection.create(state(c).doc, inStory)));
    const b = bodyRange(state(c).doc);
    expect(state(c).selection.from).toBeGreaterThanOrEqual(b.start);
  });
});
