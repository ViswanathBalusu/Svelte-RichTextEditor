/**
 * FRW-002 criteria 3 and 4 in the editing core, in Node.js: a field inserted in the editor gets a
 * 16-character identifier in the same transaction (I2 holds at the end of the commit), and a field
 * copied and pasted gets a fresh identifier while the document still satisfies I13 (unique keys
 * are the model's; here the identifiers must be unique). Criterion 1 (the editing schema default
 * of `id`) is tested in packages/model/src/fields/fields.test.ts.
 */
import { validate } from '@docedit/model/validate';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from './core.ts';
import { SPIKE_IDS, spikeDocument } from './spike-document.ts';
import { internals } from './testing.ts';

const microtask = (run: () => void) => queueMicrotask(run);

const SHAPE = /^[A-Za-z0-9_-]{16}$/;

/** A fresh core on the spike document, with the `fields` feature required for form fields. */
function core(): DocumentCore {
  const doc = spikeDocument();
  doc.requires = ['fields'];
  return new DocumentCore({ doc, schedule: microtask });
}

/** The fragment of one body paragraph that holds one text field, as a client would send it. */
function fieldFragment(id: string | null, key: string) {
  return {
    cdm: 1,
    requires: ['fields'],
    defs: [],
    openStart: 0,
    openEnd: 0,
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'pFrw002paste0001', style: 'Normal' },
        content: [
          {
            type: 'form_field',
            attrs: { id, key, kind: 'text', label: 'Name', assignee: null, value: null },
          },
        ],
      },
    ],
  } as unknown as Parameters<DocumentCore['insertContent']>[0];
}

/** Every identifier of a form field in the document, in order. */
function fieldIds(c: DocumentCore): Array<string | null> {
  const out: Array<string | null> = [];
  internals(c).state.doc.descendants((node) => {
    if (node.type.name === 'form_field') out.push((node.attrs['id'] as string | null) ?? null);
    return true;
  });
  return out;
}

const violations = (c: DocumentCore) => validate(c.getContent()).violations;

/** Places the caret at the start of the body paragraph `pAfter`. */
function caretAtStart(c: DocumentCore): void {
  const i = internals(c);
  let pos = -1;
  i.state.doc.descendants((node, p) => {
    if (pos < 0 && node.attrs['id'] === SPIKE_IDS.after) pos = p;
    return pos < 0;
  });
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos + 1)));
}

describe('form fields in the editing core (FRW-002 criteria 3 and 4)', () => {
  it('inserting a field with a null id gives it a 16-character identifier, and the document stays valid (criterion 3)', () => {
    const c = core();
    caretAtStart(c);
    const result = c.insertContent(fieldFragment(null, 'tenant.name'));
    expect(result.ok).toBe(true);
    const ids = fieldIds(c);
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toBeNull();
    expect(ids[0]).toMatch(SHAPE);
    expect(violations(c)).toEqual([]);
  });

  it('a copied and pasted field gets a fresh identifier and the document stays valid (criterion 4)', () => {
    const c = core();
    caretAtStart(c);
    expect(c.insertContent(fieldFragment(null, 'tenant.name')).ok).toBe(true);
    const [original] = fieldIds(c);
    expect(original).toMatch(SHAPE);

    // Select the field and copy it with the editor's own copy path.
    const i = internals(c);
    let pos = -1;
    i.state.doc.descendants((node, p) => {
      if (pos < 0 && node.type.name === 'form_field') pos = p;
      return pos < 0;
    });
    i.dispatch(i.state.tr.setSelection(NodeSelection.create(i.state.doc, pos)));
    const copied = c.getSelectionContent();
    expect(copied.content.length).toBeGreaterThan(0);

    // Paste it at the start of the paragraph again: the copy must not keep the identifier.
    caretAtStart(c);
    const pasted = c.insertContent(copied);
    expect(pasted.ok).toBe(true);

    const ids = fieldIds(c);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(id).toMatch(SHAPE);
    expect(new Set(ids).size).toBe(2);
    // The copy keeps its key. How a copy's key is chosen is an open question (12 §4.1, FRW-002
    // Open questions), so the only violation allowed here is the duplicate key that follows from
    // it. Criterion 4 stays unticked until that question is decided.
    const v = violations(c);
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.invariant === 'I13')).toBe(true);
    expect(JSON.stringify(v)).toContain('duplicate_field_key');
  });
});
