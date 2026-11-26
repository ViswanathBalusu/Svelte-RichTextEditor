// How the host's `amr` and `auth_time` are shown (SEC-043 criterion 2): as assertions recorded as
// given, in the certificate's facts and in the participant's evidence record.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { presentAssertedAuthentication } from '../src/workflow/asserted-authentication.ts';
import { buildCertificateFacts } from '../src/workflow/certificate.ts';
import { AUTHENTICATION_PHRASE, findOverclaims } from '../src/workflow/language.ts';
import { buildParticipantEvidence } from '../src/workflow/participant-evidence.ts';

const ON = { captureNetworkIdentity: true };
const HEAD = 'a'.repeat(64);

describe('presentAssertedAuthentication', () => {
  it('shows nothing when the host gave nothing', () => {
    expect(presentAssertedAuthentication({})).toBeUndefined();
    expect(presentAssertedAuthentication({ amr: null, authTimeSeconds: null })).toBeUndefined();
  });

  it('shows the values as given, marked as asserted by the host and not checked', () => {
    const a = presentAssertedAuthentication({
      amr: ['pwd', 'otp'],
      authTimeSeconds: 1_700_000_000,
    });
    expect(a).toMatchObject({
      source: 'host',
      checked: false,
      amr: ['pwd', 'otp'],
      authTimeSeconds: 1_700_000_000,
    });
    expect(a!.text).toContain(AUTHENTICATION_PHRASE);
    expect(a!.text).toContain('amr: pwd, otp');
    expect(a!.text).toContain('auth_time: 2023-11-14 22:13:20 UTC');
    expect(a!.text).toContain('recorded as given');
    expect(a!.text).toContain('did not check');
  });

  it('never words the claims as verified, and the text passes the over-claim list for any amr', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9_-]{1,12}$/), { maxLength: 8 }),
        fc.option(fc.integer({ min: 0, max: 4_000_000_000 }), { nil: undefined }),
        (amr, t) => {
          const a = presentAssertedAuthentication({
            amr,
            ...(t === undefined ? {} : { authTimeSeconds: t }),
          })!;
          expect(findOverclaims(a.text)).toEqual([]);
          expect(a.text.toLowerCase()).not.toMatch(/verified|valid identity/);
          expect(a.checked).toBe(false);
        },
      ),
    );
  });

  it('refuses a value that cannot be shown as given', () => {
    expect(() => presentAssertedAuthentication({ amr: ['a\nb'] })).toThrow(RangeError);
    expect(() => presentAssertedAuthentication({ amr: ['x'.repeat(65)] })).toThrow(RangeError);
    expect(() => presentAssertedAuthentication({ amr: Array<string>(17).fill('a') })).toThrow(
      RangeError,
    );
    expect(() => presentAssertedAuthentication({ authTimeSeconds: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => presentAssertedAuthentication({ authTimeSeconds: 1e20 })).toThrow(RangeError);
  });
});

describe('the certificate and the evidence record use it', () => {
  it('puts the assertion on the participant of the certificate, and none when the host gave none', () => {
    const facts = buildCertificateFacts({
      documentId: 'd',
      workflowId: 'w',
      sentSeq: 1,
      completedSeq: 2,
      chainHeadHash: HEAD,
      captureSettings: ON,
      participants: [
        { id: 'p1', label: 'A', events: [], authentication: { amr: ['pwd'] } },
        { id: 'p2', label: 'B', events: [] },
      ],
    });
    expect(facts.participants[0]!.authentication?.checked).toBe(false);
    expect(facts.participants[0]!.authentication?.text).toContain(AUTHENTICATION_PHRASE);
    expect(facts.participants[1]).not.toHaveProperty('authentication');
  });

  it('puts the assertion in the evidence record next to the raw claims', () => {
    const base = {
      session: 's',
      amr: ['pwd'],
      viewedAtMs: null,
      consent: null,
      signings: [],
      completedAtMs: null,
      ipAddress: null,
      userAgent: null,
    } as const;
    const r = buildParticipantEvidence('signer', { ...base, authTimeSeconds: 1_700_000_000 }, ON);
    expect(r.amr).toEqual(['pwd']);
    expect(r.authentication).toMatchObject({ source: 'host', checked: false, amr: ['pwd'] });
    const none = buildParticipantEvidence('signer', { ...base, amr: null }, ON);
    expect(none).not.toHaveProperty('authentication');
  });

  it('keeps the raw amr and gives no wording for a value that cannot be worded', () => {
    const r = buildParticipantEvidence(
      'signer',
      {
        session: 's',
        amr: ['has a space'],
        viewedAtMs: null,
        consent: null,
        signings: [],
        completedAtMs: null,
        ipAddress: null,
        userAgent: null,
      },
      ON,
    );
    expect(r.amr).toEqual(['has a space']);
    expect(r).not.toHaveProperty('authentication');
  });
});
