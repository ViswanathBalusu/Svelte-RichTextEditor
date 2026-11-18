/**
 * Fields in the mock backend (12 §3, §9, §10; FRW-067 criterion 2). Fields and their values are read
 * from the document tree: there is no second source of truth (12 §3.3). The mock serves the full
 * document to every reader, so there is no projection and no redaction marker (ADR 0019).
 *
 * A prefill is one `AttrStep` of `value` per key, checked as a whole before anything is applied
 * (12 §9): an unknown key, a field whose value only the server sets and a value that does not fit
 * the kind are `field_invalid`, naming the key.
 */
import { fieldValueProblem } from '@docedit/model';
import { SERVER_SET_FIELD_KINDS, type JsonValue } from '@docedit/model/definition';
import { PortError, type FieldInfo } from '@docedit/protocol';
import type { Node } from 'prosemirror-model';

export interface FieldNode {
  info: FieldInfo;
  value: unknown;
  options: ReadonlyArray<{ id?: unknown }> | null;
  /** The node's position in the document. */
  pos: number;
}

/** The form fields of a document, in document order. */
export function fieldsOf(doc: Node): FieldNode[] {
  const out: FieldNode[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name !== 'form_field') return true;
    const a = n.attrs as Record<string, unknown>;
    out.push({
      info: {
        id: String(a['id']),
        key: String(a['key']),
        kind: String(a['kind']) as FieldInfo['kind'],
        label: typeof a['label'] === 'string' ? a['label'] : '',
        assignee: typeof a['assignee'] === 'string' ? a['assignee'] : null,
        required: a['required'] === true,
        readOnly: a['readOnly'] === true,
      },
      value: a['value'] ?? null,
      options: Array.isArray(a['options']) ? (a['options'] as Array<{ id?: unknown }>) : null,
      pos,
    });
    return false;
  });
  return out;
}

/** The values by key; with `keys`, only those, and a key that names no field is `not_found`. */
export function valuesByKey(
  fields: readonly FieldNode[],
  keys: readonly string[] = [],
): Record<string, unknown> {
  const all: Record<string, unknown> = {};
  for (const f of fields) all[f.info.key] = f.value;
  if (keys.length === 0) return all;
  const missing = keys.find((k) => !(k in all));
  if (missing !== undefined) throw new PortError('not_found', `no field with the key ${missing}`);
  return Object.fromEntries(keys.map((k) => [k, all[k]]));
}

export interface PrefillStep {
  stepType: 'attr';
  pos: number;
  attr: 'value';
  value: unknown;
}

/** The steps of a prefill, or `field_invalid` naming every key that is refused. */
export function prefillSteps(doc: Node, values: Readonly<Record<string, unknown>>): PrefillStep[] {
  const fields = new Map(fieldsOf(doc).map((f) => [f.info.key, f]));
  const violations: Array<{ path: string; rule: string }> = [];
  const steps: PrefillStep[] = [];
  for (const [key, value] of Object.entries(values)) {
    const f = fields.get(key);
    const at = `/values/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (!f) {
      violations.push({ path: at, rule: 'a key of a field of the document (12 §3.2)' });
      continue;
    }
    if ((SERVER_SET_FIELD_KINDS as readonly string[]).includes(f.info.kind)) {
      violations.push({
        path: at,
        rule: `a ${f.info.kind} field is set only by the server and cannot be prefilled (12 §9)`,
      });
      continue;
    }
    const problem = fieldValueProblem(f.info.kind, value as JsonValue, { options: f.options });
    if (problem) {
      violations.push({ path: at, rule: problem.message });
      continue;
    }
    steps.push({ stepType: 'attr', pos: f.pos, attr: 'value', value: value ?? null });
  }
  if (violations.length)
    throw new PortError(
      'field_invalid',
      `the field ${violations[0]!.path.slice(8)} cannot take the value`,
      { details: { violations } },
    );
  return steps;
}
