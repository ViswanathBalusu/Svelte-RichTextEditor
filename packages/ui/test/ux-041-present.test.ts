/**
 * UX-041 criteria 4, 5 and 6, in words: the quiet status item (none without a port; text, never an
 * error) and the sentence a screen reader hears for a finding (kind, text, message, suggestions).
 * The shell's own behaviour in a browser is in e2e/ux-041-042-proofing.spec.ts. Node.js.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ProofingFindingView, ProofingStatus } from '../src/core-api.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { findingSentence, proofingBarItem, type Translate } from '../src/proofing/present.ts';

/** The English table, with `{name}` filled in and the plural `other` form for a count. */
const t: Translate = (key, params = {}) => {
  const message = EN_GB[key];
  const text = typeof message === 'string' ? message : (message as { other: string }).other;
  return text.replace(/\{(\w+)\}/g, (_m, name: string) => String(params[name] ?? ''));
};

const status = (over: Partial<ProofingStatus>): ProofingStatus => ({
  available: true,
  state: 'idle',
  count: 0,
  dictionary: false,
  current: null,
  atCaret: null,
  ...over,
});

describe('the proofing item of the status bar (UX-041 criteria 4 and 5)', () => {
  it('is absent without a proofing port', () => {
    expect(proofingBarItem(undefined, t)).toBeNull();
    expect(proofingBarItem(null, t)).toBeNull();
    expect(
      proofingBarItem(status({ available: false, count: 3, state: 'checking' }), t),
    ).toBeNull();
  });

  it('says checking, not available or the count, as plain text', () => {
    expect(proofingBarItem(status({ state: 'checking' }), t)?.text).toBe(
      'Checking spelling and grammar',
    );
    expect(proofingBarItem(status({ state: 'unavailable' }), t)?.text).toBe(
      'Spelling and grammar check is not available',
    );
    expect(proofingBarItem(status({ count: 0 }), t)?.text).toBe('No spelling or grammar issues');
    expect(proofingBarItem(status({ count: 4 }), t)?.text).toBe('4 spelling or grammar issues');
  });

  it('is never an empty string for any state of a port that is there', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('idle', 'checking', 'unavailable'),
        fc.nat(50),
        (state, count) => {
          const item = proofingBarItem(status({ state, count }), t);
          expect(item).not.toBeNull();
          expect(item!.text.trim().length).toBeGreaterThan(0);
        },
      ),
    );
  });
});

describe('the sentence for a finding (UX-041 criterion 6)', () => {
  const finding = (over: Partial<ProofingFindingView>): ProofingFindingView => ({
    id: 'b:0:3:spelling',
    kind: 'spelling',
    message: 'Unknown word',
    text: 'teh',
    suggestions: ['the', 'tea'],
    scope: 'body',
    lang: 'en-GB',
    ...over,
  });

  it('names the kind, the text, the message and the suggestions', () => {
    expect(findingSentence(finding({}), t)).toBe(
      'Spelling: teh. Unknown word Suggestions: the, tea.',
    );
  });

  it('says there are no suggestions, and names a grammar issue and an unknown kind', () => {
    expect(findingSentence(finding({ kind: 'grammar', suggestions: [] }), t)).toBe(
      'Grammar: teh. Unknown word No suggestions.',
    );
    expect(findingSentence(finding({ kind: 'style' }), t)).toMatch(/^Issue: teh\./);
  });

  it('always carries the text and the kind word, whatever the port says', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.trim() === s && !/[{}]/.test(s)),
        fc.string({ maxLength: 20 }).filter((s) => !/[{}]/.test(s)),
        fc.array(
          fc.string({ minLength: 1, maxLength: 8 }).filter((s) => !/[{}]/.test(s)),
          {
            maxLength: 4,
          },
        ),
        (text, message, suggestions) => {
          const sentence = findingSentence(finding({ text, message, suggestions }), t);
          expect(sentence).toContain(text.replace(/\s+/g, ' '));
          expect(sentence).toContain('Spelling');
        },
      ),
    );
  });
});
