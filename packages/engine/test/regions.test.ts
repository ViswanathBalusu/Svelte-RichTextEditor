/**
 * Regions in the editor (02 §5.2; 07 §7; 03 §4.2): selections that start in a region stay in it
 * (FE-038), the region's edges stop Backspace and Delete, and a body paragraph follows every region
 * (FE-039).
 */
import { Fragment, Slice } from 'prosemirror-model';
import { Selection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { clampToRegion, regionClamp } from '../src/regions.ts';
import { internals, press } from '../src/testing.ts';
import { validate } from '@docedit/model/validate';
import { SPIKE_IDS, editorAccess, ownerAccess, spikeDocument } from './fixtures.ts';
import { caret, microtask, posOf } from './support.ts';

const core = (access = ownerAccess()) =>
  new DocumentCore({ doc: spikeDocument(), access, schedule: microtask });

const key = (c: DocumentCore, name: string) => {
  const i = internals(c);
  return press(i.schema, name, i.state, i.dispatch);
};

function select(c: DocumentCore, anchor: number, head: number): void {
  const i = internals(c);
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, anchor, head)));
}

function regionSpan(c: DocumentCore): { start: number; end: number } {
  const doc = internals(c).state.doc;
  const pos = posOf(doc, SPIKE_IDS.region);
  return { start: pos + 1, end: pos + doc.nodeAt(pos)!.nodeSize - 1 };
}

describe('selections clamped at region boundaries (FE-038)', () => {
  it('a selection that starts in a region and is extended past its end stops at the boundary', () => {
    const c = core();
    const r = regionSpan(c);
    const inside = posOf(internals(c).state.doc, SPIKE_IDS.legal) + 3;
    const outside = posOf(internals(c).state.doc, SPIKE_IDS.last) + 4;
    select(c, inside, outside);
    const sel = internals(c).state.selection;
    expect(sel.anchor).toBe(inside);
    expect(sel.head).toBeLessThanOrEqual(r.end);
    expect(sel.head).toBe(r.end - 1); // the last text position of the region's last paragraph
    // Backwards, past its start.
    select(c, inside, posOf(internals(c).state.doc, SPIKE_IDS.title) + 2);
    expect(internals(c).state.selection.head).toBe(r.start + 1);
  });

  it('the selection hook clamps pointer and touch selections the same way', () => {
    const c = core();
    const doc = internals(c).state.doc;
    const hook = regionClamp().props.createSelectionBetween!;
    const view = { state: internals(c).state } as Parameters<typeof hook>[0];
    const inside = doc.resolve(posOf(doc, SPIKE_IDS.legal) + 2);
    const outside = doc.resolve(posOf(doc, SPIKE_IDS.last) + 2);
    const clamped = hook.call(regionClamp(), view, inside, outside) as Selection | null;
    expect(clamped?.head).toBe(regionSpan(c).end - 1);
    // Starting outside and reaching in: not clamped (07 §7: only selections that start inside).
    expect(hook.call(regionClamp(), view, outside, inside)).toBeNull();
  });

  it('a selection that starts outside a region and extends into it is not clamped', () => {
    const c = core();
    const doc = internals(c).state.doc;
    const outside = posOf(doc, SPIKE_IDS.intro) + 2;
    const inside = posOf(doc, SPIKE_IDS.legal) + 4;
    select(c, outside, inside);
    expect(internals(c).state.selection.head).toBe(inside);
    expect(clampToRegion(doc, outside, inside)).toBeNull();
  });

  it('a collapsed caret moves across a boundary freely', () => {
    const c = core();
    const doc = internals(c).state.doc;
    const r = regionSpan(c);
    // Just after the region: the first position of the paragraph after it.
    const after = Selection.findFrom(doc.resolve(r.end + 1), 1, true)!;
    select(c, after.from, after.from);
    expect(internals(c).state.selection.from).toBe(after.from);
    const before = Selection.findFrom(doc.resolve(r.start - 1), -1, true)!;
    select(c, before.from, before.from);
    expect(internals(c).state.selection.from).toBe(before.from);
  });

  it('Backspace at the start of a region and Delete at its end do nothing', () => {
    const c = core();
    caret(c, SPIKE_IDS.legal, 0);
    const doc = internals(c).state.doc;
    expect(key(c, 'Backspace')).toBe(true);
    expect(internals(c).state.doc).toBe(doc);
    caret(c, SPIKE_IDS.legal, 'end');
    expect(key(c, 'Delete')).toBe(true);
    expect(internals(c).state.doc).toBe(doc);
    // Inside the paragraph the core does not consume the keys: the browser deletes the character.
    caret(c, SPIKE_IDS.legal, 3);
    expect(key(c, 'Backspace')).toBe(false);
    expect(key(c, 'Delete')).toBe(false);
  });

  it('Enter at the end of a region keeps the new paragraph inside it', () => {
    const c = core();
    caret(c, SPIKE_IDS.legal, 'end');
    key(c, 'Enter');
    const doc = internals(c).state.doc;
    const region = doc.nodeAt(posOf(doc, SPIKE_IDS.region))!;
    expect(region.childCount).toBe(2);
    expect(internals(c).state.selection.$from.node(2).attrs['id']).toBe(SPIKE_IDS.region);
  });
});

describe('a body paragraph after every region (FE-039)', () => {
  const newRegion = (c: DocumentCore, text: string) =>
    internals(c).schema.nodeFromJSON({
      type: 'region',
      attrs: { title: text },
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });

  it('creating a region at the end of the body adds a paragraph with a fresh id after it, in the same transaction', () => {
    const c = core();
    const i = internals(c);
    let transactions = 0;
    const stop = i.onTransaction(() => transactions++);
    const end = i.state.doc.content.size - 1;
    i.dispatch(i.state.tr.insert(end, newRegion(c, 'Annex')));
    stop();
    expect(transactions).toBe(1);
    const body = i.state.doc.lastChild!;
    expect(body.child(body.childCount - 2).type.name).toBe('region');
    const last = body.lastChild!;
    expect(last.type.name).toBe('paragraph');
    expect(last.attrs['id']).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(validate(c.getContent()).violations).toEqual([]);
    // The paragraph is in the queue with the region: what is sent has it.
    expect(i.sync.visible.lastChild!.lastChild!.type.name).toBe('paragraph');
  });

  it('wrapping or inserting a region before another region puts a paragraph between them', () => {
    const c = core();
    const i = internals(c);
    i.dispatch(i.state.tr.insert(posOf(i.state.doc, SPIKE_IDS.region), newRegion(c, 'Before')));
    const body = i.state.doc.lastChild!;
    const kinds: string[] = [];
    body.forEach((n) => kinds.push(n.type.name));
    for (let k = 0; k < kinds.length; k++)
      if (kinds[k] === 'region') expect(kinds[k + 1]).toBe('paragraph');
  });

  it('deleting the paragraph after a region leaves a paragraph after it', () => {
    const c = core();
    const i = internals(c);
    // Make the region the last block but one, then delete the last paragraph after it.
    const after = posOf(i.state.doc, SPIKE_IDS.after);
    const last = posOf(i.state.doc, SPIKE_IDS.last);
    const lastEnd = last + i.state.doc.nodeAt(last)!.nodeSize;
    i.dispatch(i.state.tr.delete(after, lastEnd));
    const body = i.state.doc.lastChild!;
    expect(body.lastChild!.type.name).toBe('paragraph');
    expect(body.child(body.childCount - 2).type.name).toBe('region');
  });

  it('content that ends with a region, pasted at the end, is followed by a paragraph', () => {
    const c = core();
    const i = internals(c);
    const end = i.state.doc.content.size - 1;
    const fragment = Fragment.fromArray([
      i.schema.nodes['paragraph']!.create(null, i.schema.text('pasted')),
      newRegion(c, 'Pasted region'),
    ]);
    i.dispatch(i.state.tr.replace(end, end, new Slice(fragment, 0, 0)));
    expect(i.state.doc.lastChild!.lastChild!.type.name).toBe('paragraph');
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('after a region that is the last block, the next text position is the paragraph after it', () => {
    const c = core();
    const i = internals(c);
    const end = i.state.doc.content.size - 1;
    i.dispatch(i.state.tr.insert(end, newRegion(c, 'Last')));
    const doc = i.state.doc;
    const body = doc.lastChild!;
    const regionEnd = doc.content.size - 1 - body.lastChild!.nodeSize;
    const next = Selection.findFrom(doc.resolve(regionEnd), 1, true)!;
    expect(next.$from.parent).toBe(body.lastChild);
  });

  it('a user who cannot change the body root: the change that needs the paragraph is refused, not split', () => {
    // Body read-only, the region editable: deleting the paragraph after the region would need a
    // new body paragraph, which the user may not add.
    const access = editorAccess({
      scopes: {
        ...editorAccess().scopes,
        body: ['view', 'comment'],
        [`region:${SPIKE_IDS.region}`]: ['view', 'comment', 'suggest', 'edit'],
      },
    });
    const c = core(access);
    const i = internals(c);
    // Remove the paragraphs after the region (refused: body), and type in the region (allowed).
    const after = posOf(i.state.doc, SPIKE_IDS.after);
    const doc = i.state.doc;
    i.dispatch(i.state.tr.delete(after, doc.content.size - 1));
    expect(i.state.doc).toBe(doc);
    expect(c.refusal.get()?.scopes).toEqual(['body']);
    caret(c, SPIKE_IDS.legal, 1);
    i.dispatch(i.state.tr.insertText('ok'));
    expect(i.state.doc).not.toBe(doc);
  });
});
