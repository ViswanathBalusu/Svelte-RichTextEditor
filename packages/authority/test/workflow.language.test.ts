// The legal stance of the signing language (FRW-058; the check of criteria 1, 2 and 5 over text).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATION_PHRASE,
  NATIVE_SIGNING_DESCRIPTION,
  OVERCLAIM_PHRASES,
  findOverclaims,
  isWithinLegalStance,
} from '../src/index.ts';

describe('the phrase list refuses over-claims about a signature (FRW-058 criterion 1)', () => {
  it('finds every listed phrase, whatever its case and spacing', () => {
    for (const phrase of OVERCLAIM_PHRASES) {
      const shouted = phrase.toUpperCase().replace(/ /g, '   ');
      expect(findOverclaims(`Our product gives a ${shouted} here.`)).toContain(phrase);
      expect(isWithinLegalStance(phrase)).toBe(false);
    }
  });

  it('reports a phrase once even when the text repeats it (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...OVERCLAIM_PHRASES),
        fc.integer({ min: 2, max: 5 }),
        (phrase, n) => {
          const found = findOverclaims(Array(n).fill(phrase).join(' '));
          return found.filter((p) => p === phrase).length === 1;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('passes ordinary text that does not over-claim', () => {
    expect(isWithinLegalStance('Sign the agreement and download your copy.')).toBe(true);
  });
});

describe('the native description claims only a simple electronic signature (FRW-058 criterion 2)', () => {
  it('names an audit trail and a tamper-evident seal, and no signature level', () => {
    expect(NATIVE_SIGNING_DESCRIPTION).toContain(
      'A simple electronic signature with an audit trail',
    );
    expect(NATIVE_SIGNING_DESCRIPTION).toContain('a tamper-evident seal');
    expect(isWithinLegalStance(NATIVE_SIGNING_DESCRIPTION)).toBe(true);
  });
});

describe('authentication is described as asserted by the host (FRW-058 criterion 5)', () => {
  it('uses the phrase and never calls the identity verified', () => {
    expect(AUTHENTICATION_PHRASE).toBe('as asserted by the host');
    expect(findOverclaims(`The signer is ${AUTHENTICATION_PHRASE}.`)).toEqual([]);
    expect(findOverclaims('The signer has a verified identity.')).toEqual(['verified identity']);
  });
});
