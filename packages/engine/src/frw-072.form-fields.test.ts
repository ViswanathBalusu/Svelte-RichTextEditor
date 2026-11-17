/**
 * FRW-072 criterion 1 in the editing core, in Node.js (lane V-FRW-055-072): the insert command of
 * the palette (`insertField` with a form field kind) puts an inline form field at the caret in a
 * body paragraph, with a fresh 16-character identifier and a key unique in the document. The
 * document stays valid (I2, I13). The `date` kind stays the page date (FE-136) and is not a form
 * field here.
 */
import { validate } from '@docedit/model/validate';
import { type EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from './core.ts';
import { SPIKE_IDS, spikeDocument } from './spike-document.ts';
import { internals } from './testing.ts';

const microtask = (run: () => void) => queueMicrotask(run);
const SHAPE = /^[A-Za-z0-9_-]{16}$/;

function core(requires: string[] = ['fields']): DocumentCore {
  const doc = spikeDocument();
  doc.requires = requires;
  return new DocumentCore({ doc, schedule: microtask });
}

/** The caret at the start of the body paragraph `pAfter`. */
function caretAtAfter(c: DocumentCore): void {
  const i = internals(c);
  let pos = -1;
  i.state.doc.descendants((node, p) => {
    if (pos < 0 && node.attrs['id'] === SPIKE_IDS.after) pos = p;
    return pos < 0;
  });
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos + 1)));
}

interface FieldInfo {
  id: unknown;
  key: unknown;
  kind: unknown;
  label: unknown;
  options: unknown;
}

function formFields(state: EditorState): FieldInfo[] {
  const out: FieldInfo[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === 'form_field') {
      out.push({
        id: node.attrs['id'],
        key: node.attrs['key'],
        kind: node.attrs['kind'],
        label: node.attrs['label'],
        options: node.attrs['options'],
      });
    }
    return true;
  });
  return out;
}

const insertKind = (c: DocumentCore, kind: string) =>
  c.run('insertField', { field: { kind: kind as 'text' } });

describe('palette inserts a form field at the caret (FRW-072 criterion 1)', () => {
  it('a text field gets a fresh identifier and the key text_1, and the document stays valid', () => {
    const c = core();
    caretAtAfter(c);
    expect(insertKind(c, 'text')).toBe(true);
    const fields = formFields(internals(c).state);
    expect(fields).toHaveLength(1);
    expect(fields[0]!.kind).toBe('text');
    expect(fields[0]!.key).toBe('text_1');
    expect(fields[0]!.label).toBe('Text 1');
    expect(String(fields[0]!.id)).toMatch(SHAPE);
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('a second insert of any kind gets a new identifier and a key no other field has', () => {
    const c = core();
    caretAtAfter(c);
    expect(insertKind(c, 'text')).toBe(true);
    expect(insertKind(c, 'text')).toBe(true);
    expect(insertKind(c, 'number')).toBe(true);
    expect(insertKind(c, 'checkbox')).toBe(true);
    const fields = formFields(internals(c).state);
    expect(fields.map((f) => f.key)).toEqual(['text_1', 'text_2', 'number_1', 'checkbox_1']);
    expect(new Set(fields.map((f) => f.id)).size).toBe(fields.length);
    for (const f of fields) expect(String(f.id)).toMatch(SHAPE);
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('a choice field gets one option, so the document stays valid', () => {
    const c = core();
    caretAtAfter(c);
    expect(insertKind(c, 'choice')).toBe(true);
    const [field] = formFields(internals(c).state);
    expect(field!.kind).toBe('choice');
    expect(field!.options).toEqual([{ id: 'option_1', label: 'Option 1' }]);
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('a check with no dispatch changes nothing (queryCommand)', () => {
    const c = core();
    caretAtAfter(c);
    const state = c.queryCommand('insertField', { field: { kind: 'text' } });
    expect(state.enabled).toBe(true);
    expect(formFields(internals(c).state)).toEqual([]);
  });

  it('is refused, and inserts nothing, when the document does not require the feature fields', () => {
    const c = core([]);
    caretAtAfter(c);
    expect(insertKind(c, 'text')).toBe(false);
    expect(formFields(internals(c).state)).toEqual([]);
  });

  it('is refused in a header story (I10), and inserts nothing', () => {
    const c = core();
    expect(
      c.run('insertField', { field: { kind: 'text', story: { id: SPIKE_IDS.header, pos: 1 } } }),
    ).toBe(false);
    expect(formFields(internals(c).state)).toEqual([]);
  });

  it('the date kind is still the page date, so without a date source it is refused here', () => {
    const c = core();
    caretAtAfter(c);
    expect(c.run('insertField', { field: { kind: 'date' } })).toBe(false);
    expect(formFields(internals(c).state)).toEqual([]);
  });

  it('a caller that asks for a form field gets the form kind date (lane w4, ADR 0367)', () => {
    const c = core();
    caretAtAfter(c);
    expect(c.run('insertField', { field: { kind: 'date', form: true } })).toBe(true);
    const fields = formFields(internals(c).state);
    expect(fields.map((f) => [f.kind, f.key, f.label])).toEqual([['date', 'date_1', 'Date 1']]);
    expect(String(fields[0]!.id)).toMatch(SHAPE);
    expect(validate(c.getContent()).violations).toEqual([]);
  });

  it('every kind of the palette of phase 1b is inserted with its own identifier and key', () => {
    const c = core();
    caretAtAfter(c);
    for (const kind of ['text', 'number', 'date', 'checkbox', 'choice', 'text'])
      expect(c.run('insertField', { field: { kind: kind as 'text', form: true } })).toBe(true);
    const fields = formFields(internals(c).state);
    expect(fields.map((f) => f.kind).sort()).toEqual(
      ['checkbox', 'choice', 'date', 'number', 'text', 'text'].sort(),
    );
    expect(new Set(fields.map((f) => f.id)).size).toBe(6);
    expect(new Set(fields.map((f) => f.key)).size).toBe(6);
    expect(validate(c.getContent()).violations).toEqual([]);
  });
});

describe('a form field in a table cell (FRW-072 criterion 1)', () => {
  it('is inserted at the caret in the paragraph of a cell', () => {
    const doc = spikeDocument() as unknown as {
      requires: string[];
      doc: { content: Array<{ type: string; content: unknown[] }> };
    };
    doc.requires = [...new Set([...doc.requires, 'fields'])];
    const cell = (text: string) => ({
      type: 'table_cell',
      attrs: {},
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    doc.doc.content
      .find((n) => n.type === 'body')!
      .content.push({
        type: 'table',
        attrs: { grid: [1440, 1440], headerRows: 0 },
        content: [{ type: 'table_row', content: [cell('one'), cell('two')] }],
      });
    const c = new DocumentCore({ doc: doc as never, schedule: microtask });
    const i = internals(c);
    let table = -1;
    i.state.doc.descendants((node, pos) => {
      if (table < 0 && node.type.name === 'table') table = pos;
      return table < 0;
    });
    // Table, row, cell, paragraph: the text starts four positions after the table.
    i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, table + 4)));
    expect(c.query('canInsertField')).toBe(true);
    expect(c.run('insertField', { field: { kind: 'choice', form: true } })).toBe(true);
    const $field = internals(c).state.doc.resolve(table + 4);
    expect($field.nodeAfter?.type.name).toBe('form_field');
    expect($field.node($field.depth - 1).type.name).toBe('table_cell');
    expect(String($field.nodeAfter?.attrs['id'])).toMatch(SHAPE);
    expect(validate(c.getContent()).violations).toEqual([]);
  });
});

describe('the document limit of form fields in the real core (FRW-072 criterion 4; I15)', () => {
  /** The spike document with `count` text fields in one more paragraph of the body. */
  function coreWith(count: number): DocumentCore {
    const doc = spikeDocument() as unknown as {
      requires: string[];
      doc: { content: Array<{ type: string; content: unknown[] }> };
    };
    doc.requires = ['fields'];
    const body = doc.doc.content.find((n) => n.type === 'body')!;
    const fields = Array.from({ length: count }, (_, i) => ({
      type: 'form_field',
      attrs: {
        id: `f${String(i).padStart(15, '0')}`,
        key: `k_${i}`,
        kind: 'text',
        label: `K ${i}`,
        assignee: null,
        value: null,
      },
    }));
    body.content.push({
      type: 'paragraph',
      attrs: { id: 'pManyFields00001', style: 'Normal' },
      content: fields,
    });
    return new DocumentCore({ doc: doc as never, schedule: microtask });
  }

  it('inserts the 2,000th field, then answers false with the reason fieldLimit and inserts nothing', () => {
    const c = coreWith(1999);
    caretAtAfter(c);
    expect(c.query('canInsertField')).toBe(true);
    expect(c.queryReason('canInsertField')).toBeNull();
    expect(insertKind(c, 'number')).toBe(true);
    expect(formFields(internals(c).state)).toHaveLength(2000);
    expect(validate(c.getContent()).violations).toEqual([]);

    expect(c.query('canInsertField')).toBe(false);
    expect(c.queryReason('canInsertField')).toBe('fieldLimit');
    for (const kind of ['text', 'number', 'date', 'checkbox', 'choice']) {
      const field = { kind: kind as 'text', form: true };
      expect(c.queryCommand('insertField', { field }).enabled).toBe(false);
      expect(c.run('insertField', { field })).toBe(false);
    }
    expect(formFields(internals(c).state)).toHaveLength(2000);
  });

  it('gives no limit reason for another refusal', () => {
    // A document that does not require `fields` takes no form field, whatever its count.
    const c = core([]);
    caretAtAfter(c);
    expect(c.query('canInsertField')).toBe(false);
    expect(c.queryReason('canInsertField')).toBeNull();
  });
});
