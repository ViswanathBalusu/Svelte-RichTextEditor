/**
 * Fields on the control plane (12 §3, §9, §10; FRW-060, FRW-061; ADR 0019; decision D145; ADR 0054).
 *
 * Fields and their values are read from the document tree: there is no second source of truth
 * (12 §3.3). Every read is of the caller's projection (ADR 0019): a field inside a region hidden
 * from the caller is not listed, and a value hidden from the caller is the redaction marker of the
 * projection, `{ "redacted": true }`; every other value is returned as stored (decimal strings stay
 * strings).
 *
 * Prefill (`PATCH /documents/{id}/field-values`, 12 §9) is a server-authored commit with origin
 * `prefill`: one attribute step per field, on the content at the head, attributed to the DEP-Actor
 * or to `system`. The request is atomic: every key must name a field of a kind that may be
 * prefilled and every value must fit the kind (`field_invalid`, naming the key), or nothing is
 * applied. The room applies the commit through the outbox (06 §3), or a transient authority when no
 * room is open (06 §2.2).
 */
import { fieldValueProblem, type JsonNode } from '@docedit/model';
import { SERVER_SET_FIELD_KINDS, type JsonValue } from '@docedit/model/definition';
import { cdmSchema } from '@docedit/model/prosemirror';
import { ApiError } from './problems.ts';

/** A field of the derived list (12 §3.2; FRW-060; the `FieldInfo` shape of the protocol). */
export interface FieldInfo {
  id: string;
  key: string;
  kind: string;
  label: string;
  assignee: string | null;
  required: boolean;
  readOnly: boolean;
}

export interface FieldNode {
  info: FieldInfo;
  /** The value as the projection shows it. */
  value: unknown;
  /** The choice options, for checking a prefilled value. */
  options: ReadonlyArray<{ id?: unknown }> | null;
  /** The node's position in the document it was read from (for prefill, the full document). */
  pos: number;
}

/** The form fields of a document, in document order. */
export function fieldsOf(doc: JsonNode): FieldNode[] {
  const node = cdmSchema().nodeFromJSON(doc);
  const out: FieldNode[] = [];
  node.descendants((n, pos) => {
    if (n.type.name !== 'form_field') return true;
    const a = n.attrs as Record<string, unknown>;
    out.push({
      info: {
        id: String(a['id']),
        key: String(a['key']),
        kind: String(a['kind']),
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

/**
 * The fields of a projected document. A projection may hold `hidden_region` placeholders, which the
 * CDM schema does not know, so the walk is over the JSON tree.
 */
export function projectedFields(doc: JsonNode): Array<Omit<FieldNode, 'pos'>> {
  const out: Array<Omit<FieldNode, 'pos'>> = [];
  const visit = (n: unknown) => {
    const x = n as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
    if (!x || typeof x !== 'object') return;
    if (x.type === 'form_field') {
      const a = x.attrs ?? {};
      out.push({
        info: {
          id: String(a['id']),
          key: String(a['key']),
          kind: typeof a['kind'] === 'string' ? a['kind'] : 'text',
          label: typeof a['label'] === 'string' ? a['label'] : '',
          assignee: typeof a['assignee'] === 'string' ? a['assignee'] : null,
          required: a['required'] === true,
          readOnly: a['readOnly'] === true,
        },
        value: a['value'] ?? null,
        options: Array.isArray(a['options']) ? (a['options'] as Array<{ id?: unknown }>) : null,
      });
      return;
    }
    if (Array.isArray(x.content)) x.content.forEach(visit);
  };
  visit(doc);
  return out;
}

/** The values by key of a projection, for `GET /field-values` (12 §10). */
export function valuesByKey(
  fields: ReadonlyArray<Omit<FieldNode, 'pos'>>,
  keys?: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f.info.key] = f.value;
  if (!keys || keys.length === 0) return out;
  const missing = keys.filter((k) => !(k in out));
  if (missing.length)
    throw new ApiError('not_found', `no field with the key ${missing[0]}`, {
      violations: missing.map((k) => ({ path: `key=${k}`, rule: 'a key of the document' })),
    });
  return Object.fromEntries(keys.map((k) => [k, out[k]]));
}

/**
 * The steps of a prefill (12 §9): one `AttrStep` of `value` per key on the full content at the
 * head, after every key and value is checked. Throws `field_invalid` naming the first bad key.
 */
export function prefillSteps(
  full: JsonNode,
  values: Readonly<Record<string, unknown>>,
): Array<{ stepType: 'attr'; pos: number; attr: 'value'; value: unknown }> {
  const fields = new Map(fieldsOf(full).map((f) => [f.info.key, f]));
  const violations: Array<{ path: string; rule: string }> = [];
  const steps: Array<{ stepType: 'attr'; pos: number; attr: 'value'; value: unknown }> = [];
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
    const problem = fieldValueProblem(f.info.kind, value as JsonValue, {
      options: f.options,
    });
    if (problem) {
      violations.push({ path: at, rule: problem.message });
      continue;
    }
    steps.push({ stepType: 'attr', pos: f.pos, attr: 'value', value: value ?? null });
  }
  if (violations.length)
    throw new ApiError(
      'field_invalid',
      `the field ${violations[0]!.path.slice(8)} cannot take the value`,
      {
        violations,
      },
    );
  return steps;
}
