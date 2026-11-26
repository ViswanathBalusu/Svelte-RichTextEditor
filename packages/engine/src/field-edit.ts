/**
 * Changing the properties of a form field (FRW-073; 12 §3.2, §11; 07 §4).
 *
 * - The properties are the attributes of `form_field` an author sets: `key`, `kind`, `label`,
 *   `assignee`, `required`, `readOnly`, `default`, `placeholder`, `options`, `format`, `validation`
 *   and `width`. `value` is filled, not authored, and `sensitive` is reserved: neither is taken.
 * - A change is one transaction with one `attr` step per attribute that differs, so it leaves
 *   through the commit log like any change and one undo takes it back.
 * - Before a step is made each value is checked against the attribute's grammar of the CDM
 *   definition (I11), the key against the other fields and the assignee against the roles (I13),
 *   and the whole result against the document's invariants. A change that fails is reported and
 *   nothing changes.
 * - When the kind changes, or the option that is the field's value is removed, the value is
 *   cleared in the same transaction, so that the field never holds a value of another kind
 *   (proposed; the spec does not say, FRW-073 Notes).
 * - The caller passes the region guard's answer as `writable`; where it is false the command
 *   returns `read-only`.
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import { CDM1 } from '@docedit/model/definition';
import { checkGrammar, validateDoc } from '@docedit/model/validate';
import type { EditorState, Transaction } from 'prosemirror-state';
import { findFormField } from './field-lookup.ts';
import {
  FIELD_PROPERTY_NAMES,
  type FieldProperties,
  type FieldPropertyName,
} from './field-read.ts';

export { FIELD_PROPERTY_NAMES, fieldProperties, listFormFields } from './field-read.ts';
export type { FieldProperties, FieldPropertyName } from './field-read.ts';

export type FieldPatch = Partial<FieldProperties>;

export interface FieldEditProblem {
  /** The attribute; empty for a problem of the document as a whole. */
  readonly field: string;
  readonly code: 'grammar' | 'duplicate-key' | 'not-a-role' | 'not-a-property' | 'invariant';
  readonly message: string;
}

export type FieldEditOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'read-only' | 'not-found' | 'no-change' }
  | {
      readonly ok: false;
      readonly reason: 'invalid';
      readonly problems: readonly FieldEditProblem[];
    };

export interface FieldEditOptions {
  /** Whether the region guard lets the user change the field at a position (07 §4). */
  readonly writable: (pos: number) => boolean;
  /** The features the document requires, for the check of the result. */
  readonly requires: readonly string[];
}

const FORM_FIELD = CDM1.nodes.find((n) => n.name === 'form_field');
const isProperty = (name: string): name is FieldPropertyName =>
  (FIELD_PROPERTY_NAMES as readonly string[]).includes(name);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function optionIds(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return (options as Array<{ id?: unknown }>).map((o) => String(o?.id));
}

/** Changes properties of the form field `id`. With `dispatch` absent, only checks. */
export function editField(
  state: EditorState,
  id: string,
  patch: FieldPatch,
  options: FieldEditOptions,
  dispatch?: (tr: Transaction) => void,
): FieldEditOutcome {
  const hit = findFormField(state.doc, id);
  if (!hit) return { ok: false, reason: 'not-found' };
  if (!options.writable(hit.pos)) return { ok: false, reason: 'read-only' };

  const problems: FieldEditProblem[] = [];
  const attrs = FORM_FIELD?.attrs ?? {};
  for (const [name, value] of Object.entries(patch)) {
    const grammar = isProperty(name) ? attrs[name]?.grammar : undefined;
    if (!grammar) {
      problems.push({ field: name, code: 'not-a-property', message: 'not a property of a field' });
      continue;
    }
    for (const message of checkGrammar(grammar, value, `/${name}`))
      problems.push({ field: name, code: 'grammar', message });
  }
  if (typeof patch.key === 'string') {
    const key = patch.key;
    let taken = false;
    state.doc.descendants((node) => {
      if (node.type.name === 'form_field' && node !== hit.node && node.attrs['key'] === key)
        taken = true;
      return !taken;
    });
    if (taken)
      problems.push({
        field: 'key',
        code: 'duplicate-key',
        message: 'another field has this key',
      });
  }
  if (typeof patch.assignee === 'string') {
    const role = patch.assignee;
    let found = false;
    state.doc.firstChild?.forEach((child) => {
      if (child.type.name === 'role_def' && child.attrs['id'] === role) found = true;
    });
    if (!found) problems.push({ field: 'assignee', code: 'not-a-role', message: 'not a role' });
  }
  if (problems.length > 0) return { ok: false, reason: 'invalid', problems };

  const changed = Object.entries(patch).filter(
    ([name, value]) => !same(hit.node.attrs[name] ?? null, value),
  );
  if (changed.length === 0) return { ok: false, reason: 'no-change' };

  const tr = state.tr;
  for (const [name, value] of changed) tr.setNodeAttribute(hit.pos, name, value);
  // A value of the old kind, or of an option that is gone, does not stay (proposed).
  const value: unknown = hit.node.attrs['value'] ?? null;
  if (value !== null) {
    const kindChanged = changed.some(([name]) => name === 'kind');
    const optionGone =
      changed.some(([name]) => name === 'options') &&
      hit.node.attrs['kind'] === 'choice' &&
      typeof value === 'string' &&
      !optionIds(patch.options).includes(value);
    if (kindChanged || optionGone) tr.setNodeAttribute(hit.pos, 'value', null);
  }

  // The result as a whole: a change that breaks an invariant the document kept is refused here,
  // before the authority would refuse the commit.
  const before = validateDoc(state.doc, options.requires);
  const after = validateDoc(tr.doc, options.requires);
  if (before.valid && !after.valid)
    return {
      ok: false,
      reason: 'invalid',
      problems: after.violations.map((v) => ({
        field: '',
        code: 'invariant' as const,
        message: String((v as { message?: unknown }).message ?? ''),
      })),
    };

  if (dispatch) dispatch(tr);
  return { ok: true };
}
