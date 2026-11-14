// A participant of kind approver has no fields to check: completing is approving (12 §6.1; FRW-047
// criterion 7). The check passes for an approver role whatever the other roles' fields hold.
import { describe, expect, it } from 'vitest';
import { completionCheck } from '../src/workflow/completion.ts';
import { FIELDS, fieldsJson, schema } from './permission-fixtures.ts';

type J = Record<string, unknown>;

/** The fixture document with every field of the tenant made required and left empty. */
function requiredTenantDoc() {
  const json = structuredClone(fieldsJson()) as unknown as { content: Array<{ content: J[] }> };
  const walk = (n: J): void => {
    const attrs = n['attrs'] as J | undefined;
    if (n['type'] === 'form_field' && attrs && attrs['id'] === FIELDS.number) {
      attrs['required'] = true;
      attrs['value'] = null;
    }
    for (const c of (n['content'] as J[] | undefined) ?? []) walk(c);
  };
  for (const top of json.content) walk(top as unknown as J);
  const doc = schema.nodeFromJSON(json);
  doc.check();
  return doc;
}

describe('an approver completes without fields to check (FRW-047 criterion 7)', () => {
  it('passes for an approver role that owns no field, even when a tenant field is required and empty', () => {
    expect(completionCheck(requiredTenantDoc(), ['role_approver'])).toEqual({ ok: true });
  });

  it('still refuses the tenant field for the tenant, so the approver check does not weaken it', () => {
    const v = completionCheck(requiredTenantDoc(), ['role_tenant']);
    expect(v.ok).toBe(false);
  });
});
