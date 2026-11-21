/**
 * Reading the authored properties of form fields (FRW-073; 12 §3.2). The reading half of
 * `field-edit.ts`: the shell reads the fields' list as soon as it has the fields service, so this
 * stays in the first load, while the editing and its grammar and invariant checks load with the
 * fields pane (`./parts.ts`; FND-008).
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import type { JsonValue } from '@docedit/model/definition';
import type { Node } from 'prosemirror-model';
import { findFormField } from './field-entries.ts';

/** The attributes of a form field an author may set. */
export const FIELD_PROPERTY_NAMES = [
  'key',
  'kind',
  'label',
  'assignee',
  'required',
  'readOnly',
  'default',
  'placeholder',
  'options',
  'format',
  'validation',
  'width',
] as const;

export type FieldPropertyName = (typeof FIELD_PROPERTY_NAMES)[number];
export type FieldProperties = Record<FieldPropertyName, JsonValue>;

/** The authored properties of the form field `id`; null when the document has no such field. */
export function fieldProperties(doc: Node, id: string): FieldProperties | null {
  const hit = findFormField(doc, id);
  if (!hit) return null;
  const out = {} as FieldProperties;
  for (const name of FIELD_PROPERTY_NAMES) out[name] = (hit.node.attrs[name] ?? null) as JsonValue;
  return out;
}

/** The form fields of the document in order: identifier, key and label. */
export function listFormFields(doc: Node): Array<{ id: string; key: string; label: string }> {
  const out: Array<{ id: string; key: string; label: string }> = [];
  doc.descendants((node) => {
    if (node.type.name !== 'form_field') return true;
    const id = node.attrs['id'];
    const key = String(node.attrs['key'] ?? '');
    const label = node.attrs['label'];
    if (typeof id === 'string')
      out.push({ id, key, label: typeof label === 'string' && label !== '' ? label : key });
    return false;
  });
  return out;
}
