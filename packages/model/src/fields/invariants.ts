/**
 * The field invariants of 12 §3.6 (FRW-005), run by `model.validate()` through the registration
 * point of CDM-013, as every package's invariants are (CDM-022):
 *
 * - I13: field keys are unique; every `assignee` resolves to a `role_def`, matched by `id` alone;
 *   a `role_def` still referenced cannot be deleted (the reference is then dangling).
 * - I14, first half: every field key a `formValue` field targets exists. The rules' half (keys in
 *   rules, no cycle of `set` effects and formulas) is the rules package's (FRW-019).
 * - I15: at most 2,000 fields and 500 rules; a value is at most 4 KiB and has the type of its kind.
 *
 * With them: choice options have unique identifiers (I11), the asset of a signature or initials
 * value is attached (I4), and no stored value is the redaction marker of projections (I1).
 */
import { FIELD_LIMITS } from '../definition/fields.ts';
import type { JsonValue } from '../definition/grammar.ts';
import { REDACTED_FIELD_ATTRIBUTES, isRedactionMarker } from '../definition/projection.ts';
import { show } from '../validate/grammar-check.ts';
import type { InvariantCheck } from '../validate/types.ts';
import { fieldValueProblem } from './values.ts';

export const FIELD_CODES = {
  duplicate_field_key: { invariant: 'I13', doc: 'Two form fields share a key.' },
  unresolved_role: {
    invariant: 'I13',
    doc: 'A field `assignee` that names no `role_def`, for example after the role was deleted.',
  },
  unresolved_field_key: {
    invariant: 'I14',
    doc: 'A `formValue` field whose target names no form field key, for example after the field was deleted.',
  },
  too_many_fields: { invariant: 'I15', doc: 'More than 2,000 form fields.' },
  too_many_rules: { invariant: 'I15', doc: 'More than 500 rules.' },
  value_too_large: { invariant: 'I15', doc: 'A field value of more than 4 KiB.' },
  value_type: { invariant: 'I15', doc: 'A field value that does not have the type of its kind.' },
  duplicate_option_id: {
    invariant: 'I11',
    doc: 'Two options of one choice field share an identifier.',
  },
} as const;

export const FIELD_INVARIANTS: InvariantCheck = {
  name: 'fields',
  codes: FIELD_CODES,
  // The attributes of fields, roles, rules and `field` mirrors, and the attached assets of a
  // signature. A commit that changes none of them is validated without this check (CDM-013).
  reads: {
    nodes: ['form_field', 'role_def', 'rule_def', 'field'],
    context: ['attachedAssets'],
  },
  check(view, report) {
    const fields = view.ofType('form_field');
    const roles = new Set(
      view
        .ofType('role_def')
        .flatMap((r) => (typeof r.attrs['id'] === 'string' ? [r.attrs['id']] : [])),
    );
    if (fields.length > FIELD_LIMITS.fields)
      report({
        code: 'too_many_fields',
        path: '/doc',
        nodeId: null,
        message: `${fields.length} fields, more than ${FIELD_LIMITS.fields}`,
      });
    const rules = view.ofType('rule_def').length;
    if (rules > FIELD_LIMITS.rules)
      report({
        code: 'too_many_rules',
        path: '/doc',
        nodeId: null,
        message: `${rules} rules, more than ${FIELD_LIMITS.rules}`,
      });

    const keys = new Map<string, string>();
    for (const f of fields) {
      const ap = `${f.path}/attrs`;
      const key = f.attrs['key'];
      if (typeof key === 'string') {
        const first = keys.get(key);
        if (first !== undefined)
          report({
            code: 'duplicate_field_key',
            path: `${ap}/key`,
            message: `field key "${key}" is also used at ${first}`,
          });
        else keys.set(key, `${ap}/key`);
      }
      const assignee = f.attrs['assignee'];
      if (typeof assignee === 'string' && !roles.has(assignee))
        report({
          code: 'unresolved_role',
          path: `${ap}/assignee`,
          message: `role "${assignee}" does not exist`,
        });
      const options = Array.isArray(f.attrs['options'])
        ? (f.attrs['options'] as Array<Record<string, JsonValue>>)
        : [];
      const optionIds = new Set<unknown>();
      options.forEach((o, i) => {
        const oid = typeof o === 'object' && o !== null ? o['id'] : undefined;
        if (oid === undefined) return;
        if (optionIds.has(oid))
          report({
            code: 'duplicate_option_id',
            path: `${ap}/options/${i}/id`,
            message: `option identifier ${JSON.stringify(oid)} is used twice in this field`,
          });
        optionIds.add(oid);
      });
      for (const name of REDACTED_FIELD_ATTRIBUTES) {
        const value = f.attrs[name];
        if (isRedactionMarker(value)) {
          report({
            code: 'redaction_marker',
            path: `${ap}/${name}`,
            message:
              'the redaction marker exists only in projections and is never stored (ADR 0019)',
          });
          continue;
        }
        const problem = fieldValueProblem(show(f.attrs['kind']), value, { options });
        if (problem)
          report({
            code: problem.kind === 'size' ? 'value_too_large' : 'value_type',
            path: `${ap}/${name}`,
            message: `${show(f.attrs['kind'])} field: ${problem.message}`,
          });
        const assets = view.context.attachedAssets;
        if (
          !problem &&
          assets &&
          (f.attrs['kind'] === 'signature' || f.attrs['kind'] === 'initials') &&
          typeof value === 'object' &&
          value !== null &&
          !Array.isArray(value) &&
          typeof value['asset'] === 'string' &&
          !assets.has(value['asset'])
        )
          report({
            code: 'asset_not_attached',
            path: `${ap}/${name}/asset`,
            message: `asset "${value['asset']}" is not attached to this document`,
          });
      }
    }

    for (const m of view.ofType('field')) {
      const target = m.attrs['target'];
      if (m.attrs['kind'] !== 'formValue' || typeof target !== 'string') continue;
      if (!target.startsWith('field:')) continue; // the form is I11, checked by validate()
      const key = target.slice('field:'.length);
      if (!keys.has(key))
        report({
          code: 'unresolved_field_key',
          path: `${m.path}/attrs/target`,
          message: `field target "${target}" names no form field`,
        });
    }
  },
};
