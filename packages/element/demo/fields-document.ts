/**
 * The form document of the demo pages (FRW): two roles, and fields of a tenant and a landlord, and
 * the same with one rule (FND-008). Shared by the embedding page (`embed-page.ts`) and the
 * library page (`lib-page.ts`).
 */
import { spikeDocument } from '@docedit/engine/spike-document';
import type { CdmEnvelope } from '@docedit/model';
/** The identifiers of the form document (FRW): two roles, and fields of a tenant and a landlord. */
export const FIELD_IDS = {
  tenant: 'role_tenant',
  landlord: 'role_landlord',
  paragraph: 'pFields000000001',
  amount: 'fAmount000000001',
  name: 'fName00000000001',
  email: 'fEmail0000000001',
  landlordName: 'fLandlord0000001',
} as const;

/**
 * The spike document with the feature `fields`, two roles and a paragraph of form fields: three of
 * the tenant (one required, one with a range) and one of the landlord.
 */
export function fieldsDocument(): CdmEnvelope {
  type J = Record<string, unknown>;
  const envelope = spikeDocument() as unknown as {
    requires: string[];
    doc: { content: Array<{ type: string; content: J[] }> };
  };
  envelope.requires = [...new Set([...envelope.requires, 'fields'])];
  const defs = envelope.doc.content.find((n) => n.type === 'defs');
  const body = envelope.doc.content.find((n) => n.type === 'body');
  if (!defs || !body) throw new Error('the spike document has no definitions or no body');
  // Roles follow the page setups and come before every other definition (03 §4.1).
  const after = defs.content.findLastIndex((n) => n['type'] === 'page_setup') + 1;
  defs.content.splice(
    after,
    0,
    { type: 'role_def', attrs: { id: FIELD_IDS.tenant, name: 'Tenant', color: '#1F77B4' } },
    { type: 'role_def', attrs: { id: FIELD_IDS.landlord, name: 'Landlord', color: '#FF7F0E' } },
  );
  const field = (id: string, key: string, kind: string, assignee: string, extra: J): J => ({
    type: 'form_field',
    attrs: { id, key, kind, assignee, value: null, ...extra },
  });
  body.content.push({
    type: 'paragraph',
    attrs: { id: FIELD_IDS.paragraph, style: 'Normal' },
    content: [
      { type: 'text', text: 'Fields: ' },
      field(FIELD_IDS.amount, 'tenant.amount', 'number', FIELD_IDS.tenant, {
        label: 'Amount',
        validation: { min: '0', max: '1000' },
      }),
      { type: 'text', text: ' ' },
      field(FIELD_IDS.name, 'tenant.name', 'text', FIELD_IDS.tenant, {
        label: 'Name',
        required: true,
      }),
      { type: 'text', text: ' ' },
      field(FIELD_IDS.email, 'tenant.email', 'text', FIELD_IDS.tenant, {
        label: 'E-mail',
        required: true,
        validation: { preset: 'email' },
      }),
      { type: 'text', text: ' ' },
      field(FIELD_IDS.landlordName, 'landlord.name', 'text', FIELD_IDS.landlord, {
        label: 'Landlord',
        required: true,
      }),
    ],
  });
  return envelope as unknown as CdmEnvelope;
}

/**
 * The form document with one rule (FND-008): the landlord's name is shown only when the tenant's
 * name is `Ada`. A document with a rule needs the rules language before it is drawn, which loads as
 * a part of its own (engine `parts.ts`); the form document has none.
 */
export function rulesDocument(): CdmEnvelope {
  const envelope = fieldsDocument() as unknown as {
    doc: { content: Array<{ type: string; content: Array<Record<string, unknown>> }> };
  };
  const defs = envelope.doc.content.find((n) => n.type === 'defs');
  if (!defs) throw new Error('the form document has no definitions');
  defs.content.push({
    type: 'rule_def',
    attrs: {
      id: 'r_landlord',
      when: { '==': [{ field: 'tenant.name' }, 'Ada'] },
      then: [{ show: ['landlord.name'] }],
      else: [{ hide: ['landlord.name'] }],
    },
  });
  return envelope as unknown as CdmEnvelope;
}
