/**
 * The facts a certificate of completion shows (12 §8.2 step 1; FRW-050), as pure functions.
 *
 * `buildCertificateFacts` checks and orders the facts the certificate pages print: the document and
 * workflow identifiers, `sentSeq`, `completedSeq`, the chain-head hash, and each participant's events
 * (viewed, consent, signed, completed, declined) with the server time of each. With the tenant's
 * capture setting off (FRW-042), the IP address and the user agent are absent from every event, not
 * present as null.
 *
 * The module returns plain data. It does not typeset anything: the certificate pages, their LaTeX
 * and the escaping of names and evidence strings are the export's (EXP, through its typed emitters),
 * and the fill of `fields` and the `final` profile are the export's too. Nothing here reads a stored
 * row; the caller passes the evidence it holds.
 *
 * `CERTIFICATE_STATEMENT` is the fixed wording of the certificate's own sentences. It follows the
 * legal stance of FRW-058 (checked by `isWithinLegalStance` in the tests) and describes the
 * authentication of a participant as asserted by the host. Counsel's review (FRW-087) has not taken
 * place, so the wording is not approved for production use.
 */
import { SHA256_HEX_PATTERN } from '@docedit/model';
import type { CaptureSettings } from './capture.ts';
import { AUTHENTICATION_PHRASE, NATIVE_SIGNING_DESCRIPTION } from './language.ts';

/** The event kinds a certificate lists, in the order they are reported when two share a time. */
export const CERTIFICATE_EVENT_KINDS = [
  'viewed',
  'consent',
  'signed',
  'completed',
  'declined',
] as const;

export type CertificateEventKind = (typeof CERTIFICATE_EVENT_KINDS)[number];

/** One event of a participant, with the server time it was recorded at. */
export interface CertificateEventInput {
  readonly kind: CertificateEventKind;
  readonly serverTimeMs: number;
  /** The network identity the request carried; read only while the capture setting is on. */
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface CertificateParticipantInput {
  readonly id: string;
  readonly label: string;
  readonly events: readonly CertificateEventInput[];
}

export interface CertificateInput {
  readonly documentId: string;
  readonly workflowId: string;
  readonly sentSeq: number;
  readonly completedSeq: number;
  /** The chain head at completion: lower-case hexadecimal SHA-256. */
  readonly chainHeadHash: string;
  readonly participants: readonly CertificateParticipantInput[];
  readonly captureSettings: CaptureSettings;
}

export interface CertificateEventFact {
  readonly kind: CertificateEventKind;
  readonly serverTimeMs: number;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface CertificateParticipantFact {
  readonly id: string;
  readonly label: string;
  readonly events: readonly CertificateEventFact[];
}

export interface CertificateFacts {
  readonly documentId: string;
  readonly workflowId: string;
  readonly sentSeq: number;
  readonly completedSeq: number;
  readonly chainHeadHash: string;
  readonly participants: readonly CertificateParticipantFact[];
  /** Whether the network identity fields are present (FRW-042): false when the setting is off. */
  readonly networkIdentityIncluded: boolean;
  readonly statement: readonly string[];
}

const hexRe = new RegExp(SHA256_HEX_PATTERN);

const KIND_ORDER: ReadonlyMap<string, number> = new Map(
  CERTIFICATE_EVENT_KINDS.map((k, i) => [k, i]),
);

/** The fixed sentences of the certificate. The authentication sentence is FRW-058's phrase. */
export const CERTIFICATE_STATEMENT: readonly string[] = [
  NATIVE_SIGNING_DESCRIPTION,
  `Each participant's authentication is ${AUTHENTICATION_PHRASE}; the platform does not verify identity.`,
  'Times are server times recorded when each event was accepted.',
];

function checkSeq(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`buildCertificateFacts: ${name} is not a non-negative safe integer`);
}

/**
 * The certificate's facts. Throws a `RangeError` on a malformed input: a sequence that is not a
 * non-negative safe integer, `completedSeq` before `sentSeq`, a chain head that is not a SHA-256 in
 * lower-case hexadecimal, an unknown event kind, a non-finite time, or a duplicate participant.
 */
export function buildCertificateFacts(input: CertificateInput): CertificateFacts {
  checkSeq('sentSeq', input.sentSeq);
  checkSeq('completedSeq', input.completedSeq);
  if (input.completedSeq < input.sentSeq)
    throw new RangeError('buildCertificateFacts: completedSeq is before sentSeq');
  if (!hexRe.test(input.chainHeadHash))
    throw new RangeError('buildCertificateFacts: the chain head is not a SHA-256 hash');

  const seen = new Set<string>();
  const includeNetwork = input.captureSettings.captureNetworkIdentity;
  const participants: CertificateParticipantFact[] = input.participants.map((p) => {
    if (seen.has(p.id))
      throw new RangeError(`buildCertificateFacts: duplicate participant ${p.id}`);
    seen.add(p.id);
    for (const e of p.events) {
      if (!KIND_ORDER.has(e.kind))
        throw new RangeError(`buildCertificateFacts: unknown event kind ${String(e.kind)}`);
      if (!Number.isFinite(e.serverTimeMs))
        throw new RangeError('buildCertificateFacts: an event time is not finite');
    }
    const events = p.events
      .map((e): CertificateEventFact => {
        // With the setting off, the network fields are not copied at all (absent, not null).
        const network: { ipAddress?: string; userAgent?: string } = {};
        if (includeNetwork) {
          if (e.ipAddress !== undefined) network.ipAddress = e.ipAddress;
          if (e.userAgent !== undefined) network.userAgent = e.userAgent;
        }
        return { kind: e.kind, serverTimeMs: e.serverTimeMs, ...network };
      })
      .sort(
        (a, b) =>
          a.serverTimeMs - b.serverTimeMs ||
          (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0),
      );
    return { id: p.id, label: p.label, events };
  });

  return {
    documentId: input.documentId,
    workflowId: input.workflowId,
    sentSeq: input.sentSeq,
    completedSeq: input.completedSeq,
    chainHeadHash: input.chainHeadHash,
    participants,
    networkIdentityIncluded: includeNetwork,
    statement: CERTIFICATE_STATEMENT,
  };
}
