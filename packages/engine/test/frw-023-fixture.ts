/**
 * The fields document with rules (FRW-023): the spouse's name is shown and required for a tenant
 * named Ada and hidden otherwise (12 §5.1 in miniature); the amount must reach 10, or a message
 * says so; an amount of 99 locks the e-mail; and a calculated total is twice the amount.
 */
import { fieldsDocument, FIELD_IDS } from './frw-fields-fixture.ts';

export const RULE_FIELD_IDS = {
  ...FIELD_IDS,
  spouse: 'fSpouse00000001',
  total: 'fTotal000000001',
} as const;

type J = Record<string, unknown>;
type Envelope = {
  doc: { content: Array<{ type: string; content: J[] }> };
};

const field = (id: string, key: string, kind: string, extra: J = {}): J => ({
  type: 'form_field',
  attrs: { id, key, kind, label: key, assignee: 'role_tenant', value: null, ...extra },
});

export function ruleDocument(): ReturnType<typeof fieldsDocument> {
  const envelope = fieldsDocument() as unknown as Envelope;
  const defs = envelope.doc.content.find((n) => n.type === 'defs')!;
  const body = envelope.doc.content.find((n) => n.type === 'body')!;
  defs.content.push(
    {
      type: 'rule_def',
      attrs: {
        id: 'r_spouse',
        when: { '==': [{ field: 'tenant.name' }, 'Ada'] },
        then: [{ show: ['tenant.spouse'] }, { require: ['tenant.spouse'] }],
        else: [{ hide: ['tenant.spouse'] }],
      },
    },
    {
      type: 'rule_def',
      attrs: {
        id: 'r_amount',
        when: { '>=': [{ field: 'tenant.amount' }, '10'] },
        then: [],
        else: [{ validate: { fields: ['tenant.amount'], message: 'Enter at least 10.' } }],
      },
    },
    {
      type: 'rule_def',
      attrs: {
        id: 'r_lock',
        when: { '==': [{ field: 'tenant.amount' }, '99'] },
        then: [{ disable: ['tenant.email'] }],
      },
    },
    {
      type: 'rule_def',
      attrs: {
        id: 'r_total',
        when: true,
        then: [
          { set: { field: 'tenant.total', value: { '*': [{ field: 'tenant.amount' }, '2'] } } },
        ],
      },
    },
  );
  body.content.push({
    type: 'paragraph',
    attrs: { id: 'pRules000000001', style: 'Normal' },
    content: [
      field(RULE_FIELD_IDS.spouse, 'tenant.spouse', 'text', { label: 'Spouse' }),
      { type: 'text', text: ' ' },
      field(RULE_FIELD_IDS.total, 'tenant.total', 'formula', { label: 'Total' }),
    ],
  });
  return envelope as unknown as ReturnType<typeof fieldsDocument>;
}
