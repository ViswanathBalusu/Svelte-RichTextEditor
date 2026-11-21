// FRW-018 criterion 4, in the package: a value that does not match `validation.pattern` is reported
// invalid with the message the author gave (`validation.message`; owner decision 187 of 2026-11-15;
// ADR 0030 §8). The editor (`checkEntry`, `validateFields`) and the completion check
// (`validateFields` on the stored values) call these functions, so the message has one source.
import { validate } from '@docedit/model/validate';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validationMessageBounds } from '../src/cdm.ts';
import { fieldFrom, readDocument } from '../src/document.ts';
import { type FieldInfo, checkEntry, checkFieldDefinition } from '../src/fields.ts';
import { LIMITS } from '../src/limits.ts';
import { validateFields } from '../src/validate.ts';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const root = resolve(import.meta.dirname, '../../..');
const example = JSON.parse(
  readFileSync(resolve(root, 'packages/model/fixtures/example-03-12.json'), 'utf8'),
) as J;

const MESSAGE = 'Enter two letters and four digits, such as AB1234.';
const withMessage: FieldInfo = {
  key: 'tenant.code',
  kind: 'text',
  validation: { pattern: '[A-Z]{2}[0-9]{4}', message: MESSAGE },
};
const without: FieldInfo = {
  key: 'tenant.code',
  kind: 'text',
  validation: { pattern: '[A-Z]{2}[0-9]{4}' },
};

/** The example document with one text field that carries this validation. */
function documentWith(validation: unknown, value: unknown = null): J {
  const d = structuredClone(example);
  d['requires'] = ['fields'];
  d['doc'].content[1].content[2].content = [
    {
      type: 'form_field',
      attrs: {
        id: 'fField0000000001',
        key: 'tenant.code',
        kind: 'text',
        label: 'Code',
        value,
        validation,
      },
    },
  ];
  return d;
}

describe('the message of a pattern (FRW-018 criterion 4)', () => {
  it('reports an entry that does not match with the message the author gave', () => {
    expect(checkEntry(withMessage, 'ab12')).toEqual([
      { code: 'pattern', message: MESSAGE, authored: true },
    ]);
    // Without a message the package has its own wording, and says it is not the author's.
    const plain = checkEntry(without, 'ab12');
    expect(plain).toEqual([
      { code: 'pattern', message: 'the entry does not have the expected form' },
    ]);
    expect(plain[0]!.authored).toBeUndefined();
  });

  it('reports nothing for an entry that matches, and nothing for an empty entry', () => {
    expect(checkEntry(withMessage, 'AB1234')).toEqual([]);
    expect(checkEntry(withMessage, '')).toEqual([]);
    expect(checkEntry(withMessage, null)).toEqual([]);
  });

  it('is the message of the pattern alone: the other checks keep their own wording', () => {
    const field: FieldInfo = {
      key: 'tenant.code',
      kind: 'text',
      validation: { pattern: '[A-Z]+', message: MESSAGE, minLength: 3, preset: 'email' },
    };
    const problems = checkEntry(field, 'a1');
    expect(problems.map((p) => p.code)).toEqual(['min_length', 'pattern', 'preset']);
    expect(problems.find((p) => p.code === 'pattern')).toEqual({
      code: 'pattern',
      message: MESSAGE,
      authored: true,
    });
    for (const p of problems.filter((x) => x.code !== 'pattern')) {
      expect(p.message).not.toBe(MESSAGE);
      expect(p.authored).toBeUndefined();
    }
    // A type problem comes first and alone; the pattern is not consulted.
    expect(checkEntry(withMessage, 12).map((p) => p.code)).toEqual(['type']);
  });

  it('is what validateFields reports, for the editor and for the completion check', () => {
    const reports = validateFields([{ ...withMessage, id: 'fField0000000001', required: true }], {
      'tenant.code': 'nope',
    });
    expect(reports).toEqual([
      {
        key: 'tenant.code',
        id: 'fField0000000001',
        problems: [{ code: 'pattern', message: MESSAGE, authored: true }],
      },
    ]);
    // Empty and required: the entry is missing, so the pattern has nothing to say.
    expect(
      validateFields([{ ...withMessage, required: true }], { 'tenant.code': '' })[0]!.problems.map(
        (p) => p.code,
      ),
    ).toEqual(['required']);
  });

  it('is read from the field of a document, and the document validates with it', () => {
    const doc = documentWith({ pattern: '[A-Z]{2}[0-9]{4}', message: MESSAGE }, 'ab12');
    expect(validate(doc).violations).toEqual([]);
    const read = readDocument(doc);
    expect(read.fields[0]!.validation).toEqual({ pattern: '[A-Z]{2}[0-9]{4}', message: MESSAGE });
    expect(checkEntry(read.fields[0]!, read.values['tenant.code'])).toEqual([
      { code: 'pattern', message: MESSAGE, authored: true },
    ]);
    // A member of another type is not a message.
    expect(fieldFrom({ key: 'k', kind: 'text', validation: { pattern: 'a', message: 5 } })).toEqual(
      {
        key: 'k',
        kind: 'text',
        validation: { pattern: 'a' },
      },
    );
  });

  it('has the grammar of a label in the CDM: 1 to 255 characters, no control character', () => {
    expect(validationMessageBounds()).toEqual({ minLength: 1, maxLength: LIMITS.messageLength });
    const refused = (message: unknown) =>
      validate(documentWith({ pattern: 'a', message })).violations.filter((v) =>
        v.path.endsWith('/validation/message'),
      );
    expect(refused('x'.repeat(255))).toEqual([]);
    expect(refused('é'.repeat(255))).toEqual([]);
    for (const bad of ['', 'x'.repeat(256), 'bell\u0007', 5, null]) {
      const found = refused(bad);
      expect(found.length, JSON.stringify(bad).slice(0, 20)).toBeGreaterThan(0);
      expect(found[0]!.invariant).toBe('I11');
    }
  });

  it('names a message that nothing would show as a problem of the definition', () => {
    expect(checkFieldDefinition(withMessage)).toEqual([]);
    expect(
      checkFieldDefinition({ key: 'k', kind: 'text', validation: { message: MESSAGE } }),
    ).toEqual([expect.objectContaining({ code: 'not_applicable', path: '/validation/message' })]);
    expect(
      checkFieldDefinition({
        key: 'k',
        kind: 'text',
        validation: { preset: 'email', message: MESSAGE },
      }),
    ).toEqual([expect.objectContaining({ code: 'not_applicable', path: '/validation/message' })]);
    // On a kind a pattern does not apply to, both are named, once each.
    expect(
      checkFieldDefinition({
        key: 'n',
        kind: 'number',
        validation: { pattern: '[0-9]+', message: MESSAGE },
      }).map((p) => [p.code, p.path]),
    ).toEqual([
      ['not_applicable', '/validation/pattern'],
      ['not_applicable', '/validation/message'],
    ]);
  });
});
