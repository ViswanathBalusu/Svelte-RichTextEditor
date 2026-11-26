// The model of the consent step (FRW-044): what the dialog shows for each answer of the service, that
// signing is offered only after an acceptance or when there is nothing to accept, the text in
// paragraphs without loss, and the decline's reason. Node.js only; the step itself is run in the
// browser (e2e/frw-044-consent-step.spec.ts).
import { describe, expect, it } from 'vitest';
import { EN_GB } from '../src/i18n/en-GB.ts';
import {
  declineProblem,
  LOADING,
  paragraphsOf,
  signingOffered,
  stageOf,
} from '../src/shell/consent-step.ts';

const VIEW = { textId: 'esign-consent', version: 3, text: 'I agree.' } as const;

describe('the stage for the service answer (FRW-044 criterion 1)', () => {
  it('requires the acceptance while none is on record, and offers no signing', () => {
    const stage = stageOf({ ok: true, consent: { ...VIEW, acceptedAt: null } });
    expect(stage.kind).toBe('required');
    expect(signingOffered(stage)).toBe(false);
  });

  it('offers signing once the text is accepted, or when there is no text to accept', () => {
    expect(
      signingOffered(
        stageOf({ ok: true, consent: { ...VIEW, acceptedAt: '2026-11-26T10:00:00.000Z' } }),
      ),
    ).toBe(true);
    expect(signingOffered(stageOf({ ok: false, reason: 'none' }))).toBe(true);
  });

  it('offers no signing while the text is loading or cannot be read', () => {
    expect(signingOffered(LOADING)).toBe(false);
    const failed = stageOf({ ok: false, reason: 'failed' });
    expect(failed.kind).toBe('unavailable');
    expect(signingOffered(failed)).toBe(false);
  });
});

describe('the text as paragraphs', () => {
  it('keeps every paragraph and every word, and drops only blank lines', () => {
    const text = 'One.\r\n\r\nTwo, line one\nline two.\n\n\n\nThree.\n';
    expect(paragraphsOf(text)).toEqual(['One.', 'Two, line one\nline two.', 'Three.']);
    expect(paragraphsOf(text).join(' ').replace(/\s+/g, ' ')).toBe(
      text.replace(/\s+/g, ' ').trim(),
    );
  });

  it('gives nothing for an empty text', () => {
    expect(paragraphsOf('  \n\n ')).toEqual([]);
  });
});

describe('the decline (FRW-033)', () => {
  it('needs a reason that is not blank', () => {
    expect(declineProblem('')).toBe('consent.decline.problem');
    expect(declineProblem(' \n\t ')).toBe('consent.decline.problem');
    expect(declineProblem('I disagree')).toBeNull();
  });

  it('has the words it names in the source table', () => {
    for (const key of [
      'consent.title',
      'consent.intro',
      'consent.region',
      'consent.loading',
      'consent.accept',
      'consent.accepting',
      'consent.decline',
      'consent.decline.label',
      'consent.decline.confirm',
      'consent.decline.back',
      'consent.decline.problem',
      'consent.declined',
      'consent.result.failed',
      'consent.result.forbidden',
      'consent.retry',
      'announce.consent.accepted',
      'announce.consent.declined',
    ] as const)
      expect(typeof EN_GB[key], key).toBe('string');
  });
});
