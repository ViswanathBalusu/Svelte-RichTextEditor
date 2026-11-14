// The certificate's facts (FRW-050 criteria 1, 6 and 7 at the level of data; FRW-042 for the network
// identity). The pages and their typesetting are the export's and are not tested here.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_EVENT_KINDS,
  CERTIFICATE_STATEMENT,
  type CertificateEventInput,
  type CertificateInput,
  buildCertificateFacts,
} from '../src/workflow/certificate.ts';
import {
  AUTHENTICATION_PHRASE,
  findOverclaims,
  isWithinLegalStance,
} from '../src/workflow/language.ts';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const chainHead = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => hex(b));

const eventArb: fc.Arbitrary<CertificateEventInput> = fc.record(
  {
    kind: fc.constantFrom(...CERTIFICATE_EVENT_KINDS),
    serverTimeMs: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    ipAddress: fc.string({ minLength: 1, maxLength: 20 }),
    userAgent: fc.string({ minLength: 1, maxLength: 40 }),
  },
  { requiredKeys: ['kind', 'serverTimeMs'] },
);

const inputArb = (captureNetworkIdentity: boolean): fc.Arbitrary<CertificateInput> =>
  fc
    .record({
      sent: fc.nat({ max: 1_000_000 }),
      extra: fc.nat({ max: 1_000_000 }),
      head: chainHead,
      participants: fc.array(
        fc.record({
          label: fc.string({ minLength: 1, maxLength: 30 }),
          events: fc.array(eventArb, { maxLength: 6 }),
        }),
        { maxLength: 4 },
      ),
    })
    .map(({ sent, extra, head, participants }) => ({
      documentId: 'doc-1',
      workflowId: 'wf-1',
      sentSeq: sent,
      completedSeq: sent + extra,
      chainHeadHash: head,
      participants: participants.map((p, i) => ({ id: `p${i}`, label: p.label, events: p.events })),
      captureSettings: { captureNetworkIdentity },
    }));

describe('the certificate lists the identifiers, the sequence numbers and the events (FRW-050 criterion 1)', () => {
  it('carries the identifiers, sentSeq, completedSeq and the chain head unchanged (property)', () => {
    fc.assert(
      fc.property(inputArb(true), (input) => {
        const facts = buildCertificateFacts(input);
        expect(facts.documentId).toBe(input.documentId);
        expect(facts.workflowId).toBe(input.workflowId);
        expect(facts.sentSeq).toBe(input.sentSeq);
        expect(facts.completedSeq).toBe(input.completedSeq);
        expect(facts.chainHeadHash).toBe(input.chainHeadHash);
      }),
    );
  });

  it('keeps every event of every participant, ordered by server time (property)', () => {
    fc.assert(
      fc.property(inputArb(true), (input) => {
        const facts = buildCertificateFacts(input);
        expect(facts.participants.length).toBe(input.participants.length);
        facts.participants.forEach((p, i) => {
          const source = input.participants[i]!;
          expect(p.events.length).toBe(source.events.length);
          for (let k = 1; k < p.events.length; k++) {
            const prev = p.events[k - 1]!;
            const cur = p.events[k]!;
            expect(prev.serverTimeMs <= cur.serverTimeMs).toBe(true);
          }
          const kinds = [...p.events.map((e) => e.kind)].sort();
          const srcKinds = [...source.events.map((e) => e.kind)].sort();
          expect(kinds).toEqual(srcKinds);
        });
      }),
    );
  });

  it('refuses a completion before the send, a malformed chain head and an unknown event', () => {
    const base: CertificateInput = {
      documentId: 'doc-1',
      workflowId: 'wf-1',
      sentSeq: 5,
      completedSeq: 9,
      chainHeadHash: 'a'.repeat(64),
      participants: [],
      captureSettings: { captureNetworkIdentity: true },
    };
    expect(() => buildCertificateFacts({ ...base, completedSeq: 4 })).toThrow(RangeError);
    expect(() => buildCertificateFacts({ ...base, sentSeq: -1 })).toThrow(RangeError);
    expect(() => buildCertificateFacts({ ...base, chainHeadHash: 'A'.repeat(64) })).toThrow(
      RangeError,
    );
    expect(() =>
      buildCertificateFacts({
        ...base,
        participants: [
          {
            id: 'p0',
            label: 'Tenant',
            events: [{ kind: 'forwarded' as unknown as 'viewed', serverTimeMs: 1 }],
          },
        ],
      }),
    ).toThrow(RangeError);
    expect(() =>
      buildCertificateFacts({
        ...base,
        participants: [
          { id: 'p0', label: 'A', events: [] },
          { id: 'p0', label: 'B', events: [] },
        ],
      }),
    ).toThrow(RangeError);
  });
});

describe('with capture switched off, no network identity is shown (FRW-050 criterion 6; FRW-042)', () => {
  it('omits the IP address and the user agent from every event, not as null (property)', () => {
    fc.assert(
      fc.property(inputArb(false), (input) => {
        const facts = buildCertificateFacts(input);
        expect(facts.networkIdentityIncluded).toBe(false);
        for (const p of facts.participants)
          for (const e of p.events) {
            expect(Object.prototype.hasOwnProperty.call(e, 'ipAddress')).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(e, 'userAgent')).toBe(false);
          }
      }),
    );
  });

  it('shows the network identity the events carried while the setting is on', () => {
    const facts = buildCertificateFacts({
      documentId: 'doc-1',
      workflowId: 'wf-1',
      sentSeq: 1,
      completedSeq: 2,
      chainHeadHash: 'b'.repeat(64),
      participants: [
        {
          id: 'p0',
          label: 'Tenant',
          events: [{ kind: 'signed', serverTimeMs: 10, ipAddress: '192.0.2.7', userAgent: 'UA/1' }],
        },
      ],
      captureSettings: { captureNetworkIdentity: true },
    });
    expect(facts.networkIdentityIncluded).toBe(true);
    expect(facts.participants[0]!.events[0]).toEqual({
      kind: 'signed',
      serverTimeMs: 10,
      ipAddress: '192.0.2.7',
      userAgent: 'UA/1',
    });
  });
});

describe('the certificate wording follows the legal stance (FRW-050 criterion 7; FRW-058)', () => {
  it('describes authentication as asserted by the host and makes no over-claim', () => {
    const text = CERTIFICATE_STATEMENT.join(' ');
    expect(text).toContain(AUTHENTICATION_PHRASE);
    expect(isWithinLegalStance(text)).toBe(true);
    expect(findOverclaims(text)).toEqual([]);
  });
});
