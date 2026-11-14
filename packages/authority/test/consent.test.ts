// The consent acceptance before signing (12 §6.1, §8.1 step 1; FRW-044): the hash is the server's,
// and a sign request needs a recorded acceptance of the same text by the same participant.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkConsentForSign, consentTextHash, recordConsent } from '../src/workflow/consent.ts';

const text = fc.string({ minLength: 1, maxLength: 80 });
const ident = fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/);
const instant = fc.integer({ min: 0, max: 4_102_444_800_000 });

describe('the consent hash is computed on the server (FRW-044 criterion 2)', () => {
  it('equals SHA-256 over the UTF-8 bytes of the server text (property)', async () => {
    await fc.assert(
      fc.asyncProperty(text, async (t) => {
        const expected = createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex');
        expect(await consentTextHash(t)).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('records the text identifier, version, participant, server time and that hash', async () => {
    const rec = await recordConsent(
      { textId: 'consent-eu', version: '3', text: 'I agree to sign electronically.' },
      'p_ada',
      1_762_400_000_000,
    );
    expect(rec).toEqual({
      textId: 'consent-eu',
      version: '3',
      participantId: 'p_ada',
      acceptedAtMs: 1_762_400_000_000,
      textHash: await consentTextHash('I agree to sign electronically.'),
    });
  });

  it('has no parameter for a hash the client could supply', async () => {
    // The signature takes the server's text, the participant and the server time. A hash in the
    // client's request is not read: the record carries the hash of the server's text only.
    const forged = {
      textId: 'consent-eu',
      version: '3',
      text: 'real text',
      textHash: 'f'.repeat(64),
    };
    const rec = await recordConsent(forged, 'p_ada', 5);
    expect(rec.textHash).toBe(await consentTextHash('real text'));
    expect(rec.textHash).not.toBe('f'.repeat(64));
  });

  it('refuses an empty identifier, a bad participant or a server time that is not a safe integer', async () => {
    const ok = { textId: 't', version: '1', text: 'x' };
    await expect(recordConsent({ ...ok, textId: '' }, 'p', 1)).rejects.toThrow(RangeError);
    await expect(recordConsent(ok, '', 1)).rejects.toThrow(RangeError);
    await expect(recordConsent(ok, 'p', -1)).rejects.toThrow(RangeError);
    await expect(recordConsent(ok, 'p', 1.5)).rejects.toThrow(RangeError);
  });
});

describe('a sign request needs a recorded acceptance (FRW-044 criterion 3, decision level)', () => {
  it('refuses when no acceptance is recorded', async () => {
    const v = await checkConsentForSign(undefined, 'p_ada', {
      textId: 't',
      version: '1',
      text: 'x',
    });
    expect(v.ok).toBe(false);
  });

  it('accepts the same participant, text identifier, version and unchanged text (property)', async () => {
    await fc.assert(
      fc.asyncProperty(ident, ident, text, instant, async (p, tid, t, at) => {
        const cur = { textId: tid, version: '1', text: t };
        const rec = await recordConsent(cur, p, at);
        expect(await checkConsentForSign(rec, p, cur)).toEqual({ ok: true });
      }),
      { numRuns: 100 },
    );
  });

  it('refuses an acceptance of another participant, another version or a changed text', async () => {
    const cur = { textId: 't', version: '1', text: 'the text' };
    const rec = await recordConsent(cur, 'p_ada', 1);
    expect((await checkConsentForSign(rec, 'p_bob', cur)).ok).toBe(false);
    expect((await checkConsentForSign(rec, 'p_ada', { ...cur, version: '2' })).ok).toBe(false);
    expect((await checkConsentForSign(rec, 'p_ada', { ...cur, textId: 'other' })).ok).toBe(false);
    expect((await checkConsentForSign(rec, 'p_ada', { ...cur, text: 'the text, edited' })).ok).toBe(
      false,
    );
  });
});
