/**
 * Finding the form fields of a document and the roles that name them (FRW-004, FRW-023; 12 §3.1).
 *
 * These reads are small and the first interactive editor needs them (the selected field, the fill
 * list, the rules part). The entries a person types into the fields, with the checks of
 * `@docedit/rules` behind them, are the `forms` part (`forms-part.ts`; FND-008).
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import type { Node as PMNode } from 'prosemirror-model';

/** A role as a field shows it: its name, colour and place among the document's roles. */
export interface FieldRole {
  readonly name: string;
  readonly color: string;
  readonly order: number;
}

/** The roles of the document by identifier, in the order of its definitions (12 §3.1). */
export function rolesOf(doc: PMNode): Map<string, FieldRole> {
  const roles = new Map<string, FieldRole>();
  doc.firstChild?.forEach((child) => {
    if (child.type.name !== 'role_def') return;
    const { id, name, color } = child.attrs as { id?: unknown; name?: unknown; color?: unknown };
    if (typeof id !== 'string') return;
    roles.set(id, {
      name: typeof name === 'string' ? name : id,
      color: typeof color === 'string' ? color : '',
      order: roles.size,
    });
  });
  return roles;
}

/** A form field of a document with its position. */
export interface FieldAt {
  readonly node: PMNode;
  readonly pos: number;
}

/** The form fields of a document: every one in document order, and the first of each identifier. */
export interface FormFields {
  readonly list: readonly FieldAt[];
  readonly byId: ReadonlyMap<string, FieldAt>;
}

const fieldIndexes = new WeakMap<PMNode, FormFields>();

/**
 * The form fields of `doc`. The document is walked once, whoever asks and however often: the
 * control of each field, the state of the entries, the rules and the fill list all read this one
 * list, so a change of the document costs one walk and not one for each reader (FRW-023 criterion 6).
 */
export function formFieldsOf(doc: PMNode): FormFields {
  let index = fieldIndexes.get(doc);
  if (index === undefined) {
    const list: FieldAt[] = [];
    const byId = new Map<string, FieldAt>();
    doc.descendants((node, pos) => {
      if (node.type.name !== 'form_field') return true;
      const at = { node, pos };
      list.push(at);
      const fieldId = node.attrs['id'];
      if (typeof fieldId === 'string' && !byId.has(fieldId)) byId.set(fieldId, at);
      return false;
    });
    fieldIndexes.set(doc, (index = { list, byId }));
  }
  return index;
}

/**
 * The form field with `id` in `doc`, with its position (the first, in document order). The fields
 * of a document are found in one walk, however many are asked for, so that drawing 2,000 fields
 * does not walk the document 2,000 times (FRW-023 criterion 6).
 */
export function findFormField(doc: PMNode, id: string): FieldAt | null {
  return formFieldsOf(doc).byId.get(id) ?? null;
}
