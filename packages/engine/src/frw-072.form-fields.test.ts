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
});
