/**
 * The fields document at the limits of 12 §5.1 (FRW-023 criterion 6): 2,000 fields and 500 rules.
 *
 * - The fields are `s.f0000` to `s.f1999`, text fields assigned to the tenant, ten to a paragraph.
 * - Rule `k` (0 to 499) hides `s.f(1000 + k)` while `s.f(k)` is `hide`; so each of the 500 rules has
 *   its own target and its own input, and a keystroke in one input concerns one rule.
 * - The rules are the targets of 12 §5.1: nothing here is a measurement, see the tests that use it.
 */
import { fieldsDocument } from './frw-fields-fixture.ts';

export const SCALE_FIELDS = 2000;
export const SCALE_RULES = 500;

type J = Record<string, unknown>;
type Envelope = { doc: { content: Array<{ type: string; content: J[] }> } };

const pad = (n: number, width: number): string => String(n).padStart(width, '0');
export const scaleKey = (i: number): string => `s.f${pad(i, 4)}`;
export const scaleId = (i: number): string => `fScale${pad(i, 9)}`;

export function scaleDocument(): ReturnType<typeof fieldsDocument> {
  const envelope = fieldsDocument() as unknown as Envelope;
  const defs = envelope.doc.content.find((n) => n.type === 'defs')!;
  const body = envelope.doc.content.find((n) => n.type === 'body')!;
  for (let k = 0; k < SCALE_RULES; k++)
    defs.content.push({
      type: 'rule_def',
      attrs: {
        id: `rScale${pad(k, 4)}`,
        when: { '==': [{ field: scaleKey(k) }, 'hide'] },
        then: [{ hide: [scaleKey(1000 + k)] }],
      },
    });
  for (let p = 0; p < SCALE_FIELDS / 10; p++) {
    const content: J[] = [];
    for (let j = 0; j < 10; j++) {
      const i = p * 10 + j;
      content.push({
        type: 'form_field',
        attrs: {
          id: scaleId(i),
          key: scaleKey(i),
          kind: 'text',
          label: `Field ${i}`,
          assignee: 'role_tenant',
          value: null,
        },
      });
      content.push({ type: 'text', text: ' ' });
    }
    body.content.push({
      type: 'paragraph',
      attrs: { id: `pScale${pad(p, 9)}`, style: 'Normal' },
      content,
    });
  }
  return envelope as unknown as ReturnType<typeof fieldsDocument>;
}
