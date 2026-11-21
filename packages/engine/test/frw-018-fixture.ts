/**
 * The fields document (frw-fields-fixture.ts) with one more field of the tenant: a text field whose
 * `validation` holds a pattern and, when given, the author's message for an entry that does not
 * match it (FRW-018 criterion 4; owner decision 187 of 2026-11-15).
 */
import { fieldsDocument } from './frw-fields-fixture.ts';

export const CODE = 'fCode00000000001';
export const PATTERN = '[A-Z]{2}[0-9]{4}';
export const MESSAGE = 'Enter two letters and four digits, such as AB1234.';
/** What the rules package says of a pattern when the author gave no message. */
export const PLAIN = 'the entry does not have the expected form';

type J = Record<string, unknown>;

export function patternDocument(
  validation: J = { pattern: PATTERN, message: MESSAGE },
): ReturnType<typeof fieldsDocument> {
  const envelope = fieldsDocument() as unknown as {
    doc: { content: Array<{ type: string; content: Array<{ content?: J[] }> }> };
  };
  const body = envelope.doc.content.find((n) => n.type === 'body')!;
  body.content.at(-1)!.content!.push(
    { type: 'text', text: ' code: ' },
    {
      type: 'form_field',
      attrs: {
        id: CODE,
        key: 'tenant.code',
        kind: 'text',
        label: 'Code',
        assignee: 'role_tenant',
        value: null,
        validation,
      },
    },
  );
  return envelope as unknown as ReturnType<typeof fieldsDocument>;
}
