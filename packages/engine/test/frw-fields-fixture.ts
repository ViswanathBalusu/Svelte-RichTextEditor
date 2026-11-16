/**
 * The contract document with a role, form fields and a mirror (FRW-004, FRW-006): one paragraph at
 * the end of the body holding a number field with bounds, a text field with length limits, a
 * required text field with the `email` preset, a field of another role, and a mirror of the amount.
 */
import type { Access } from '@docedit/protocol';
import { contractDocument } from '@docedit/protocol/contract';
import type { CdmEnvelope } from '../src/api.ts';

export const FIELD_IDS = {
  amount: 'fAmount000000001',
  name: 'fName00000000001',
  email: 'fEmail0000000001',
  landlord: 'fLandlord0000001',
  paragraph: 'pFields000000001',
} as const;

type J = Record<string, unknown>;

const field = (id: string, key: string, kind: string, assignee: string, extra: J = {}): J => ({
  type: 'form_field',
  attrs: { id, key, kind, label: key, assignee, value: null, ...extra },
});

export function fieldsDocument(): CdmEnvelope {
  const envelope = contractDocument() as unknown as {
    requires: string[];
    doc: { content: Array<{ type: string; content: J[] }> };
  };
  envelope.requires = [...new Set([...envelope.requires, 'fields'])];
  const defs = envelope.doc.content.find((n) => n.type === 'defs');
  const body = envelope.doc.content.find((n) => n.type === 'body');
  if (!defs || !body) throw new Error('the contract document has no definitions or no body');
  defs.content.push(
    { type: 'role_def', attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' } },
    { type: 'role_def', attrs: { id: 'role_landlord', name: 'Landlord', color: '#FF7F0E' } },
  );
  body.content.push({
    type: 'paragraph',
    attrs: { id: FIELD_IDS.paragraph, style: 'Normal' },
    content: [
      field(FIELD_IDS.amount, 'tenant.amount', 'number', 'role_tenant', {
        label: 'Amount',
        validation: { min: '0', max: '1000000' },
      }),
      { type: 'text', text: ' ' },
      field(FIELD_IDS.name, 'tenant.name', 'text', 'role_tenant', {
        label: 'Name',
        validation: { minLength: 2, maxLength: 5 },
      }),
      { type: 'text', text: ' ' },
      field(FIELD_IDS.email, 'tenant.email', 'text', 'role_tenant', {
        label: 'E-mail',
        required: true,
        validation: { preset: 'email' },
      }),
      { type: 'text', text: ' ' },
      field(FIELD_IDS.landlord, 'landlord.name', 'text', 'role_landlord', { label: 'Landlord' }),
      { type: 'text', text: ' amount again: ' },
      {
        type: 'field',
        attrs: { kind: 'formValue', target: 'field:tenant.amount' },
      },
    ],
  });
  return envelope as unknown as CdmEnvelope;
}

/** A participant who may only fill, holding `roles` (12 §4.1). */
export function participantAccess(roles: readonly string[], active = true): Access {
  return {
    rev: 2,
    asOfSeq: 0,
    docRole: 'filler',
    caps: ['view', 'fill'],
    scopes: { doc: ['view'], body: ['view', 'fill'], defs: ['view'] },
    leases: {},
    fill: { participant: 'participant-1', roles: [...roles], active },
    restrictions: [],
  } as unknown as Access;
}
