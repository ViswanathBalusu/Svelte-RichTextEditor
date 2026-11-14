/**
 * Inserts a form field of a phase 1b kind at the caret (FRW-072 criterion 1; 12 §3.2, §11).
 *
 * - The kinds are `text`, `number`, `checkbox` and `choice`. `date` is not one of them: the `date`
 *   field of the insert command is the page date (FE-136), so a form date needs a decision the
 *   spec does not make (lane V-FRW-055-072, ADR 0342).
 * - The field goes in a body paragraph or a table cell. Form fields are not allowed in headers,
 *   footers or footnotes (I10), so a caret in a sub-editor is refused.
 * - The document must require the feature `fields` (the caller says so with `formFields`).
 * - The key is `<kind>_<n>` for the least `n` that no form field of the document uses (I13). The
 *   key grammar is the CDM's `FIELD_KEY_PATTERN`, and `<kind>` is a plain word, so the key matches it.
 * - The identifier is left null: the identifier plugin gives the node a fresh 16-character one in
 *   the same transaction (FRW-002 criterion 3).
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import type { EditorState, Transaction } from 'prosemirror-state';
import type { FieldResult, InsertFieldOptions } from './fields-types.ts';

/** The form field kinds this command inserts in phase 1b. */
export const FORM_FIELD_INSERT_KINDS = ['text', 'number', 'checkbox', 'choice'] as const;
export type FormFieldInsertKind = (typeof FORM_FIELD_INSERT_KINDS)[number];

/** Whether `kind` is a form field kind this command inserts. */
export function isFormFieldInsertKind(kind: unknown): kind is FormFieldInsertKind {
  return typeof kind === 'string' && (FORM_FIELD_INSERT_KINDS as readonly string[]).includes(kind);
}

/** The least `<kind>_<n>` key that no form field of the document uses, with its number. */
export function nextFormFieldKey(
  state: EditorState,
  kind: FormFieldInsertKind,
): { readonly key: string; readonly n: number } {
  const used = new Set<string>();
  state.doc.descendants((node) => {
    if (node.type.name === 'form_field') {
      const key = node.attrs['key'];
      if (typeof key === 'string') used.add(key);
    }
    return true;
  });
  for (let n = 1; ; n++) {
    const key = `${kind}_${n}`;
    if (!used.has(key)) return { key, n };
  }
}

const fail = (reason: 'bad-kind' | 'no-feature' | 'not-here' | 'not-in-body' | 'read-only') =>
  ({ ok: false, reason }) as const;

/**
 * Inserts a form field of `kind` at the caret, replacing a selection. Nothing changes on a refusal.
 * Without `dispatch` the call only checks, as the other field commands do.
 */
export function insertFormField(
  state: EditorState,
  kind: string,
  options: InsertFieldOptions,
  dispatch?: (tr: Transaction) => void,
): FieldResult {
  if (!isFormFieldInsertKind(kind)) return fail('bad-kind');
  if (options.formFields !== true) return fail('no-feature');
  const type = state.schema.nodes['form_field'];
  const { $from } = state.selection;
  if (!type || !$from.parent.inlineContent) return fail('not-here');
  if (!$from.parent.canReplaceWith($from.index(), $from.index(), type)) return fail('not-here');

  const chain: string[] = [];
  for (let d = $from.depth; d >= 0; d--) chain.push($from.node(d).type.name);
  if (chain.includes('story') || !chain.includes('body')) return fail('not-in-body');
  if (!options.writable($from.pos)) return fail('read-only');

  if (dispatch) {
    const { key, n } = nextFormFieldKey(state, kind);
    const label = `${kind.charAt(0).toUpperCase()}${kind.slice(1)} ${n}`;
    const node = type.create({
      id: null,
      key,
      kind,
      label,
      assignee: null,
      value: null,
      options: kind === 'choice' ? [{ id: 'option_1', label: 'Option 1' }] : null,
    });
    dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
  }
  return { ok: true, cached: null };
}
