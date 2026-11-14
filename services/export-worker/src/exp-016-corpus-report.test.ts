/**
 * EXP-016 (lane V-EXP-001-016): the validation gate and the failure report, Node.js only, without a
 * container. The corpus run itself is in exp-016-v-exp-001-016.corpus.e2e.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { flavoursFor, requiresValidation, validationReport } from './exp-016-corpus-report.ts';
import type { Validation } from './verapdf.ts';

describe('EXP-016 flavours of the declared standards', () => {
  it('maps each pdfStandard value to the veraPDF flavours it declares', () => {
    expect(flavoursFor('ua-2+a-4f')).toEqual(['ua2', '4f']);
    expect(flavoursFor('ua-2')).toEqual(['ua2']);
    expect(flavoursFor('a-4f')).toEqual(['4f']);
    expect(flavoursFor('none')).toEqual([]);
  });
});

describe('EXP-016 draft tagging is not required to validate', () => {
  it('skips the draft preview and validates the other tagging values', () => {
    expect(requiresValidation('draft')).toBe(false);
    expect(requiresValidation('on')).toBe(true);
    expect(requiresValidation('off')).toBe(true);
  });
});

describe('EXP-016 the failure report names the rule and the document (criterion 3)', () => {
  const failing: Validation = {
    flavour: 'ua2',
    profile: 'PDF/UA-2 validation profile',
    compliant: false,
    passedChecks: 10,
    failedChecks: 2,
    failures: [
      {
        specification: 'ISO 14289-2',
        clause: '7.1',
        testNumber: 3,
        description: 'Tagged PDF structure is missing',
        failedChecks: 2,
      },
    ],
  };

  it('writes one line per failed rule with the document, the flavour, the clause and the test', () => {
    const text = validationReport('pages-1', failing);
    expect(text).toContain('pages-1 ua2');
    expect(text).toContain('ISO 14289-2 clause 7.1 test 3');
    expect(text).toContain('Tagged PDF structure is missing');
    expect(text.split('\n')).toHaveLength(1);
  });

  it('gives no text for a compliant PDF and a message for a validator that gave no result', () => {
    expect(validationReport('pages-1', { ...failing, compliant: true, failures: [] })).toBe('');
    const broken: Validation = { ...failing, failures: [], error: 'no validation result' };
    expect(validationReport('form-fields', broken)).toContain('form-fields ua2');
  });

  it('still names the document when a failure has no rule summary', () => {
    const text = validationReport('pages-20', { ...failing, failures: [] });
    expect(text).toContain('pages-20 ua2');
    expect(text).toContain('no rule named');
  });
});
