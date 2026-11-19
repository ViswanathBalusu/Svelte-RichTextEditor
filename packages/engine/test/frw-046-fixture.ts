// The fields document with signature and initials fields, for FRW-046 (the core's request and the view's button).
import { fieldsDocument } from './frw-fields-fixture.ts';

export const SIGN_TENANT = 'fSignTenant00001';
export const SIGN_LANDLORD = 'fSignLandlord001';
export const INITIALS_TENANT = 'fInitTenant00001';
export const SIGNED_TENANT = 'fSignedTenant001';
export const SIGN_READONLY = 'fSignReadonly001';
export const TEXT_FIELD = 'fName00000000001';

type J = Record<string, unknown>;

/** The fields document with signature and initials fields of the two roles. */
export function withSignatures(rule = false) {
  const envelope = fieldsDocument() as unknown as {
    doc: { content: Array<{ type: string; content: J[] }> };
  };
  const body = envelope.doc.content.find((n) => n.type === 'body')!;
  const field = (id: string, key: string, kind: string, assignee: string, extra: J = {}): J => ({
    type: 'form_field',
    attrs: { id, key, kind, label: key, assignee, value: null, ...extra },
  });
  body.content.push({
    type: 'paragraph',
    attrs: { id: 'pSignatures00001', style: 'Normal' },
    content: [
      field(SIGN_TENANT, 'tenant.signature', 'signature', 'role_tenant', {
        label: 'Tenant signature',
      }),
      field(SIGN_LANDLORD, 'landlord.signature', 'signature', 'role_landlord'),
      field(INITIALS_TENANT, 'tenant.initials', 'initials', 'role_tenant'),
      field(SIGNED_TENANT, 'tenant.signed', 'signature', 'role_tenant', {
        value: { asset: 'asset-1', mode: 'typed' },
      }),
      field(SIGN_READONLY, 'tenant.fixed', 'signature', 'role_tenant', { readOnly: true }),
    ],
  });
  if (rule)
    envelope.doc.content
      .find((n) => n.type === 'defs')!
      .content.push({
        type: 'rule_def',
        attrs: {
          id: 'rHideSign',
          when: { empty: [{ field: 'tenant.amount' }] },
          then: [{ hide: ['tenant.signature'] }],
        },
      });
  return envelope as unknown as ReturnType<typeof fieldsDocument>;
}
