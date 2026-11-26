// The evidence record of one participant (12 §7; FRW-040): the items that apply to each kind, the
// server-side hash of a stored signature image, and one event per signing.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type ParticipantFacts,
  type ParticipantKind,
  type SigningFact,
  applicableItems,
  buildParticipantEvidence,
  signatureImageHash,
  signingEvents,
} from '../src/workflow/participant-evidence.ts';

const ON = { captureNetworkIdentity: true };
const OFF = { captureNetworkIdentity: false };
const KINDS: readonly ParticipantKind[] = ['filler', 'signer', 'approver', 'cc'];

const HASH = 'a'.repeat(64);

const SIGNING: SigningFact = {
  seq: 7,
  chainHash: HASH,
  fieldKey: 'tenant.sign',
  atMs: 1_700_000_000_000,
  mode: 'typed',
  imageHash: 'b'.repeat(64),
};

const FULL: ParticipantFacts = {
  session: 'sess_1',
  amr: ['pwd', 'otp'],
  viewedAtMs: 1_699_999_000_000,
  consent: { textId: 'esign-consent', version: 3, hash: HASH, atMs: 1_699_999_500_000 },
  signings: [SIGNING, { ...SIGNING, seq: 9, fieldKey: 'tenant.initials' }],
  completedAtMs: 1_700_000_100_000,
  ipAddress: '203.0.113.7',
  userAgent: 'Agent/1.0',
};

describe('the items that apply to each participant kind (FRW-040 criterion 4)', () => {
  it('gives a filler and a signer every item', () => {
    for (const kind of ['filler', 'signer'] as const) {
      expect(applicableItems(kind)).toEqual([
        'session',
        'ipAddress',
        'userAgent',
        'amr',
        'viewedAt',
        'consent',
        'signedAt',
        'completedAt',
      ]);
    }
  });

  it('gives an approver no consent and no signing, and gives a cc no completion either', () => {
    expect(applicableItems('approver')).not.toContain('consent');
    expect(applicableItems('approver')).not.toContain('signedAt');
    expect(applicableItems('approver')).toContain('completedAt');
    expect(applicableItems('cc')).not.toContain('completedAt');
    expect(applicableItems('cc')).not.toContain('signedAt');
    expect(applicableItems('cc')).toContain('viewedAt');
  });

  it('records no consent, signing or completion for an approver, even when such facts are given', () => {
    const record = buildParticipantEvidence('approver', FULL, ON);
    expect(record).not.toHaveProperty('consent');
    expect(record.signings).toEqual([]);
    expect(record.completedAtMs).toBe(FULL.completedAtMs);
  });

  it('records no completion for a cc, even when a completion fact is given', () => {
    const record = buildParticipantEvidence('cc', FULL, ON);
    expect(record).not.toHaveProperty('completedAtMs');
    expect(record).not.toHaveProperty('consent');
    expect(record.viewedAtMs).toBe(FULL.viewedAtMs);
  });

  it('invents no item: a missing fact leaves its key absent', () => {
    const record = buildParticipantEvidence(
      'signer',
      { ...FULL, viewedAtMs: null, completedAtMs: null, amr: null, consent: null },
      ON,
    );
    expect(record).not.toHaveProperty('viewedAtMs');
    expect(record).not.toHaveProperty('completedAtMs');
    expect(record).not.toHaveProperty('amr');
    expect(record).not.toHaveProperty('consent');
  });

  it('refuses an unknown kind', () => {
    expect(() => applicableItems('owner' as ParticipantKind)).toThrow(RangeError);
  });

  it('never records a key outside the applicable items, for any kind and any facts', () => {
    const signingArb = fc.record({
      seq: fc.nat(),
      chainHash: fc.constant(HASH),
      fieldKey: fc.string({ maxLength: 8 }),
      atMs: fc.nat(),
      mode: fc.constantFrom('typed' as const, 'drawn' as const, 'uploaded' as const),
      imageHash: fc.constant(HASH),
    });
    const factsArb = fc.record({
      session: fc.string({ maxLength: 8 }),
      amr: fc.option(fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }), { nil: null }),
      viewedAtMs: fc.option(fc.nat(), { nil: null }),
      consent: fc.option(
        fc.record({
          textId: fc.string({ maxLength: 8 }),
          version: fc.nat(),
          hash: fc.constant(HASH),
          atMs: fc.nat(),
        }),
        { nil: null },
      ),
      signings: fc.array(signingArb, { maxLength: 3 }),
      completedAtMs: fc.option(fc.nat(), { nil: null }),
      ipAddress: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
      userAgent: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
    });
    fc.assert(
      fc.property(fc.constantFrom(...KINDS), factsArb, fc.boolean(), (kind, facts, on) => {
        const record = buildParticipantEvidence(kind, facts, on ? ON : OFF);
        const allowed = new Set<string>([
          'kind',
          'signings',
          'session',
          'amr',
          'authentication',
          'viewedAtMs',
          'completedAtMs',
          'consent',
          'ipAddress',
          'userAgent',
        ]);
        for (const k of Object.keys(record)) expect(allowed.has(k)).toBe(true);
        if (!applicableItems(kind).includes('signedAt')) expect(record.signings).toEqual([]);
        if (!applicableItems(kind).includes('consent'))
          expect(record).not.toHaveProperty('consent');
        if (!applicableItems(kind).includes('completedAt'))
          expect(record).not.toHaveProperty('completedAtMs');
      }),
    );
  });
});

describe('network identity follows the tenant setting (FRW-040 criterion 6)', () => {
  it('keeps the IP address and the user agent while the setting is on', () => {
    const record = buildParticipantEvidence('signer', FULL, ON);
    expect(record.ipAddress).toBe('203.0.113.7');
    expect(record.userAgent).toBe('Agent/1.0');
  });

  it('leaves both absent while the setting is off, and records the rest', () => {
    const record = buildParticipantEvidence('signer', FULL, OFF);
    expect(record).not.toHaveProperty('ipAddress');
    expect(record).not.toHaveProperty('userAgent');
    expect(record.session).toBe('sess_1');
    expect(record.amr).toEqual(['pwd', 'otp']);
    expect(record.consent).toEqual(FULL.consent);
    expect(record.signings).toHaveLength(2);
  });

  it('keeps network identity out of a cc record while the setting is off', () => {
    const record = buildParticipantEvidence('cc', FULL, OFF);
    expect(record).not.toHaveProperty('ipAddress');
    expect(record).not.toHaveProperty('userAgent');
  });
});

describe('the signature image hash is computed on the server (FRW-040 criterion 3)', () => {
  it('equals SHA-256 over the stored bytes', () => {
    fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 512 }), async (bytes) => {
        const expected = createHash('sha256').update(bytes).digest('hex');
        expect(await signatureImageHash(bytes)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it('changes when one byte of the stored image changes', async () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(await signatureImageHash(a)).not.toBe(await signatureImageHash(b));
  });

  it('refuses an empty image rather than hashing nothing', async () => {
    await expect(signatureImageHash(new Uint8Array(0))).rejects.toThrow(RangeError);
  });
});

describe('each signing is its own event (FRW-040 criterion 5)', () => {
  it('gives two signings two events, each with its own seq and chain hash', () => {
    const events = signingEvents('signer', [
      SIGNING,
      { ...SIGNING, seq: 9, chainHash: 'c'.repeat(64), fieldKey: 'tenant.initials' },
    ]);
    expect(events.map((e) => e.seq)).toEqual([7, 9]);
    expect(events.map((e) => e.chainHash)).toEqual([HASH, 'c'.repeat(64)]);
    expect(events.map((e) => e.fieldKey)).toEqual(['tenant.sign', 'tenant.initials']);
  });

  it('refuses two signings that share a seq', () => {
    expect(() => signingEvents('filler', [SIGNING, { ...SIGNING, fieldKey: 'other' }])).toThrow(
      RangeError,
    );
  });

  it('refuses a seq that is not a non-negative safe integer', () => {
    expect(() => signingEvents('signer', [{ ...SIGNING, seq: -1 }])).toThrow(RangeError);
    expect(() => signingEvents('signer', [{ ...SIGNING, seq: 1.5 }])).toThrow(RangeError);
  });

  it('gives an approver or a cc no signing event, and refuses one given for them', () => {
    expect(signingEvents('approver', [])).toEqual([]);
    expect(() => signingEvents('approver', [SIGNING])).toThrow(RangeError);
    expect(() => signingEvents('cc', [SIGNING])).toThrow(RangeError);
  });
});
