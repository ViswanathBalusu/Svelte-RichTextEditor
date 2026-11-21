/**
 * Reading the rules' view of a CDM document in its JSON form (12 §3.5, §5.4): the fields, values,
 * roles and rules, without ProseMirror and without the rules language. A module of its own so that
 * the editor's field entries can read a field's attributes without the compiler and the evaluator
 * (FND-008); `document.ts` re-exports it.
 */
import type { JsonEnvelope, JsonNode, JsonValue } from '@docedit/model';
import { type FieldInfo, type FieldKind, type FieldValidation, FIELD_KINDS } from './fields.ts';
import { isObject, pointer } from './json.ts';
import type { RuleInput } from './language.ts';
export interface DocumentRules {
  /** Every `form_field`, in document order. */
  fields: FieldInfo[];
  /** The stored `value` of each field, by key. */
  values: Record<string, JsonValue>;
  /** The identifiers of the `role_def` nodes. */
  roles: string[];
  /** The attributes of the `rule_def` nodes, with their JSON Pointers. */
  rules: RuleInput[];
}

const KINDS = new Set<string>(FIELD_KINDS);

/** The rules' view of one `form_field` node's attributes; null when it has no `key`. */
export function fieldFrom(attrs: Record<string, JsonValue>): FieldInfo | null {
  const key = attrs['key'];
  if (typeof key !== 'string') return null;
  const kind = (
    typeof attrs['kind'] === 'string' && KINDS.has(attrs['kind']) ? attrs['kind'] : 'text'
  ) as FieldKind;
  const f: FieldInfo = { key, kind };
  if (typeof attrs['id'] === 'string' || attrs['id'] === null) f.id = attrs['id'];
  if (attrs['required'] === true) f.required = true;
  if (attrs['readOnly'] === true) f.readOnly = true;
  if (Array.isArray(attrs['options']))
    f.options = attrs['options'].flatMap((o) =>
      isObject(o) && typeof o['id'] === 'string' ? [o['id']] : [],
    );
  if (isObject(attrs['validation'])) {
    const v = attrs['validation'];
    const out: FieldValidation = {};
    if (typeof v['min'] === 'string') out.min = v['min'];
    if (typeof v['max'] === 'string') out.max = v['max'];
    if (typeof v['minLength'] === 'number') out.minLength = v['minLength'];
    if (typeof v['maxLength'] === 'number') out.maxLength = v['maxLength'];
    if (typeof v['pattern'] === 'string') out.pattern = v['pattern'];
    if (typeof v['message'] === 'string') out.message = v['message'];
    if (v['preset'] === 'email' || v['preset'] === 'phone' || v['preset'] === 'postcode')
      out.preset = v['preset'];
    f.validation = out;
  }
  return f;
}

/** Reads the rules' view of a document: an envelope `{ cdm, requires, doc }` or a `doc` node. */
export function readDocument(input: JsonEnvelope | JsonNode | unknown): DocumentRules {
  const out: DocumentRules = { fields: [], values: {}, roles: [], rules: [] };
  let root: unknown = input;
  let base = '';
  if (isObject(input) && 'doc' in input) {
    root = input['doc'];
    base = '/doc';
  }
  const seen = new Set<string>();
  const stack: Array<[unknown, string]> = [[root, base]];
  while (stack.length) {
    const [node, path] = stack.pop()!;
    if (!isObject(node)) continue;
    const attrs = isObject(node['attrs']) ? node['attrs'] : {};
    switch (node['type']) {
      case 'role_def':
        if (typeof attrs['id'] === 'string') out.roles.push(attrs['id']);
        break;
      case 'rule_def':
        out.rules.push({ attrs, path: pointer(path, 'attrs') });
        break;
      case 'form_field': {
        const f = fieldFrom(attrs);
        if (f && !seen.has(f.key)) {
          seen.add(f.key);
          out.fields.push(f);
          out.values[f.key] = attrs['value'] ?? null;
        }
        break;
      }
    }
    const content = node['content'];
    if (Array.isArray(content))
      for (let i = content.length - 1; i >= 0; i--)
        stack.push([content[i], pointer(pointer(path, 'content'), i)]);
  }
  return out;
}
