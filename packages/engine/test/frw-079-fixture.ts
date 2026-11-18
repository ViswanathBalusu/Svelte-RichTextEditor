/**
 * The contract document with a role and one form field of every kind a person fills by hand
 * (FRW-079): a required text field with a length limit, a number with a format, a date with a
 * pattern, a checkbox and a choice. The same shape is built by the embed page of the element
 * (`kindsDocument` there), which the end-to-end suite of FRW-079 opens.
 */
import { contractDocument } from '@docedit/protocol/contract';

export const KIND_IDS = {
  paragraph: 'pKinds0000000001',
  text: 'fKText0000000001',
  number: 'fKNumber00000001',
  date: 'fKDate0000000001',
  checkbox: 'fKCheck000000001',
  choice: 'fKChoice00000001',
} as const;

/** The option identifiers of the choice field; the stored value is the identifier, not the label. */
export const CHOICE_OPTIONS = [
  { id: 'opt_single', label: 'Single' },
  { id: 'opt_married', label: 'Married' },
] as const;

type J = Record<string, unknown>;

export function kindsDocument(): ReturnType<typeof contractDocument> {
  const envelope = contractDocument() as unknown as {
    requires: string[];
    doc: { content: Array<{ type: string; content: J[] }> };
  };
  envelope.requires = [...new Set([...envelope.requires, 'fields'])];
  const defs = envelope.doc.content.find((n) => n.type === 'defs');
  const body = envelope.doc.content.find((n) => n.type === 'body');
  if (!defs || !body) throw new Error('the contract document has no definitions or no body');
  defs.content.push({
    type: 'role_def',
    attrs: { id: 'role_tenant', name: 'Tenant', color: '#1F77B4' },
  });
  const field = (id: string, key: string, kind: string, extra: J): J => ({
    type: 'form_field',
    attrs: { id, key, kind, assignee: 'role_tenant', value: null, ...extra },
  });
  body.content.push({
    type: 'paragraph',
    attrs: { id: KIND_IDS.paragraph, style: 'Normal' },
    content: [
      field(KIND_IDS.text, 'tenant.name', 'text', {
        label: 'Full name',
        required: true,
        validation: { maxLength: 8 },
      }),
      { type: 'text', text: ' ' },
      field(KIND_IDS.number, 'tenant.rent', 'number', {
        label: 'Rent',
        format: { decimals: 2, prefix: '€', suffix: ' a month' },
        validation: { min: '0' },
      }),
      { type: 'text', text: ' ' },
      field(KIND_IDS.date, 'tenant.start', 'date', {
        label: 'Start date',
        format: { datePattern: 'dd.MM.yyyy' },
      }),
      { type: 'text', text: ' ' },
      field(KIND_IDS.checkbox, 'tenant.pets', 'checkbox', { label: 'Has pets' }),
      { type: 'text', text: ' ' },
      field(KIND_IDS.choice, 'tenant.status', 'choice', {
        label: 'Status',
        options: CHOICE_OPTIONS.map((o) => ({ ...o })),
      }),
    ],
  });
  return envelope as unknown as ReturnType<typeof contractDocument>;
}
