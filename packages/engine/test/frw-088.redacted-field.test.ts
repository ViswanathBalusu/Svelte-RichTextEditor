/**
 * FRW-088 criterion 3, editor half: a field whose value the reader may not read is shown as
 * redacted, not as an empty field (ADR 0019). The body view draws the form field through the
 * `form_field` spec in schema.ts; these tests read that spec directly, so they run in Node.js.
 */
import { editingSchema } from '../src/schema.ts';
import { describe, expect, it } from 'vitest';

const schema = editingSchema();

function render(value: unknown) {
  const type = schema.nodes['form_field'];
  if (!type) throw new Error('the schema has no form_field');
  const node = type.create({ id: 'fRedacted000001', kind: 'text', key: 'salary', value });
  const toDOM = type.spec.toDOM;
  if (!toDOM) throw new Error('form_field has no toDOM');
  return toDOM(node);
}

describe('FRW-088: a redacted form field is shown as redacted', () => {
  it('shows a redacted value as redacted, with the screen reader announcement', () => {
    const out = render({ redacted: true });
    expect(out).toEqual([
      'span',
      {
        class: 'de-form-field de-redacted',
        'data-redacted': 'true',
        role: 'img',
        'aria-label': 'Redacted value',
      },
      '[redacted]',
    ]);
  });

  it('does not show a redacted value as an empty field', () => {
    const redacted = render({ redacted: true });
    const empty = render('');
    expect(empty).toEqual(['span', { class: 'de-form-field' }, '[field]']);
    expect(redacted).not.toEqual(empty);
  });

  it('shows a readable value without the redaction marker', () => {
    const out = render('Alice');
    expect(out).toEqual(['span', { class: 'de-form-field' }, '[field]']);
    expect(JSON.stringify(out)).not.toContain('redacted');
  });

  it('does not treat an object that only claims redaction as a marker', () => {
    const out = render({ redacted: false });
    expect(out).toEqual(['span', { class: 'de-form-field' }, '[field]']);
  });
});
