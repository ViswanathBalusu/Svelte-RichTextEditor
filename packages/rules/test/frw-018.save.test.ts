// Save-time check of patterns in a document (FRW-018 criterion 1): a validation.pattern or a
// `matches` pattern outside the subset is reported with its construct and an absolute JSON Pointer.
import { describe, expect, it } from 'vitest';
import { checkDocumentPatterns } from '../src/definitions.ts';

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function envelope(content: J[]): J {
  return { cdm: '1', requires: ['fields', 'rules'], doc: { type: 'doc', content } };
}

const field = (key: string, validation: J): J => ({
  type: 'form_field',
  attrs: { id: `f_${key}`, key, kind: 'text', validation },
});

describe('save-time pattern check (FRW-018)', () => {
  it('accepts a document whose patterns are all inside the subset', () => {
    const doc = envelope([
      field('code', { pattern: '[A-Z]{2}[0-9]+' }),
      field('name', { preset: 'email' }),
      {
        type: 'rule_def',
        attrs: { id: 'r1', when: { matches: [{ field: 'code' }, '[A-Z]+'] }, then: [] },
      },
    ]);
    expect(checkDocumentPatterns(doc)).toEqual([]);
  });

  it('refuses a validation.pattern with a back-reference and names the construct', () => {
    const doc = envelope([field('code', { pattern: '([A-Z]{2})\\1' })]);
    const problems = checkDocumentPatterns(doc);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      code: 'pattern_unsupported',
      construct: 'back-reference',
    });
    expect(problems[0]!.path).toBe('/doc/content/0/attrs/validation/pattern');
  });

  it('refuses a matches pattern of a rule_def with the rule path and the construct', () => {
    const doc = envelope([
      field('name', { pattern: '[A-Za-z ]+' }),
      {
        type: 'rule_def',
        attrs: { id: 'r1', when: { matches: [{ field: 'name' }, '(?<=a)b'] }, then: [] },
      },
    ]);
    const problems = checkDocumentPatterns(doc);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.code).toBe('pattern_unsupported');
    expect(problems[0]!.construct).toEqual(expect.any(String));
    expect(problems[0]!.path).toMatch(/^\/doc\/content\/1\/attrs\/when\/matches\/1$/);
  });

  it('reports every bad pattern of a document, in document order', () => {
    const doc = envelope([
      field('a', { pattern: '(x)\\1' }),
      field('b', { pattern: '[A-Z]+' }),
      field('c', { pattern: '(y)\\1' }),
    ]);
    expect(checkDocumentPatterns(doc).map((p) => p.path)).toEqual([
      '/doc/content/0/attrs/validation/pattern',
      '/doc/content/2/attrs/validation/pattern',
    ]);
  });

  it('reads a bare doc node as well as an envelope', () => {
    const node = { type: 'doc', content: [field('code', { pattern: '(a)\\1' })] };
    expect(checkDocumentPatterns(node)).toEqual([
      expect.objectContaining({ path: '/content/0/attrs/validation/pattern' }),
    ]);
  });

  it('does not report limits that are not patterns', () => {
    const doc = envelope([field('t', { minLength: 5, maxLength: 4 })]);
    expect(checkDocumentPatterns(doc)).toEqual([]);
  });
});
