/**
 * The evidence record of one participant, as pure functions (12 §7; FRW-040).
 *
 * - `applicableItems` says which evidence items a participant kind has. A `filler` or `signer`
 *   accepts the consent, adopts a signature and signs; an `approver` approves or declines without
 *   fields (12 §6.1) and so has no consent acceptance, no adoption and no signing; a `cc` receives
 *   the result and so has no completion. Spec default for the approver's consent: none is recorded,
 *   because 12 §8.1 places the consent before the signing ceremony only (ADR 0250, item 1).
 * - `buildParticipantEvidence` assembles the record from the facts the endpoints hold. It keeps only
 *   the items that apply to the kind and invents none: an item without a fact is absent, never
 *   defaulted. Network identity goes through `captureEvidence`, so the tenant setting (FRW-042)
 *   decides it.
 * - `signatureImageHash` hashes the stored image bytes on the server. It takes the bytes and no
 *   hash, so no client-declared hash can reach the record (FRW-040 criterion 3).
 * - `signingEvents` gives one event per signing, each with its own `seq` and chain hash (FRW-040
 *   criterion 5).
 *
 * This module builds the record; it does not store it. The evidence tables, the connection that
 * supplies the network identity, the server clock and the signing commit are the workflow service's
 * (FRW-041). Nothing here reads a request.
 */
import { sha256HexBytes } from '@docedit/model';
import {
  type AssertedAuthentication,
  presentAssertedAuthentication,
} from './asserted-authentication.ts';
import { type CaptureSettings, captureEvidence } from './capture.ts';

export type ParticipantKind = 'filler' | 'signer' | 'approver' | 'cc';

/** The evidence items a record may hold. */
export type EvidenceItem =
  | 'session'
  | 'ipAddress'
  | 'userAgent'
  | 'amr'
  | 'viewedAt'
  | 'consent'
  | 'signedAt'
  | 'completedAt';

const ALL_ITEMS: readonly EvidenceItem[] = [
  'session',
  'ipAddress',
  'userAgent',
  'amr',
  'viewedAt',
  'consent',
  'signedAt',
  'completedAt',
];

const APPLICABLE: Readonly<Record<ParticipantKind, ReadonlySet<EvidenceItem>>> = {
  filler: new Set(ALL_ITEMS),
  signer: new Set(ALL_ITEMS),
  approver: new Set(['session', 'ipAddress', 'userAgent', 'amr', 'viewedAt', 'completedAt']),
  cc: new Set(['session', 'ipAddress', 'userAgent', 'amr', 'viewedAt']),
};

/** The items that apply to a participant of `kind`, in the order of 12 §7. */
export function applicableItems(kind: ParticipantKind): readonly EvidenceItem[] {
  const set = APPLICABLE[kind];
  if (set === undefined)
    throw new RangeError(`applicableItems: unknown participant kind ${String(kind)}`);
  return ALL_ITEMS.filter((i) => set.has(i));
}

/** The consent acceptance, as the consent endpoint recorded it (FRW-044). */
export interface ConsentFact {
  readonly textId: string;
  readonly version: number;
  /** The hash the server computed over the held text. */
  readonly hash: string;
  readonly atMs: number;
}

/** One signing, as the sign commit recorded it (FRW-046). */
export interface SigningFact {
  /** The sequence number of the signing commit. */
  readonly seq: number;
  /** The chain hash at that commit. */
  readonly chainHash: string;
  readonly fieldKey: string;
  readonly atMs: number;
  /** How the signature was adopted (FRW-045). */
  readonly mode: 'typed' | 'drawn' | 'uploaded';
  /** The hash of the stored image, from `signatureImageHash`. */
  readonly imageHash: string;
}

/** The facts a participant's events produced. Absent facts are `null` or empty, never defaulted. */
export interface ParticipantFacts {
  readonly session: string;
  readonly amr: readonly string[] | null;
  /** `auth_time` of the token, in seconds, as given. Optional: absent when the host gave none. */
  readonly authTimeSeconds?: number | null;
  readonly viewedAtMs: number | null;
  readonly consent: ConsentFact | null;
  readonly signings: readonly SigningFact[];
  readonly completedAtMs: number | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/** The evidence record of one participant: only the applicable items that have a fact. */
export interface ParticipantEvidence {
  readonly kind: ParticipantKind;
  readonly session?: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly amr?: readonly string[];
  /** The host's claims as asserted and unchecked (SEC-043); present when `amr` or `auth_time` is. */
  readonly authentication?: AssertedAuthentication;
  readonly viewedAtMs?: number;
  readonly consent?: ConsentFact;
  readonly signings: readonly SigningFact[];
  readonly completedAtMs?: number;
}

/** Assembles the evidence record of a participant of `kind` under the tenant's capture setting. */
export function buildParticipantEvidence(
  kind: ParticipantKind,
  facts: ParticipantFacts,
  settings: CaptureSettings,
): ParticipantEvidence {
  const applies = new Set<EvidenceItem>(applicableItems(kind));
  const items: Record<string, unknown> = {};
  if (applies.has('session')) items['session'] = facts.session;
  if (applies.has('amr') && facts.amr !== null) items['amr'] = [...facts.amr];
  if (applies.has('viewedAt') && facts.viewedAtMs !== null) items['viewedAtMs'] = facts.viewedAtMs;
  if (applies.has('completedAt') && facts.completedAtMs !== null)
    items['completedAtMs'] = facts.completedAtMs;
  const network = captureEvidence(
    {
      items,
      ipAddress: applies.has('ipAddress') ? facts.ipAddress : null,
      userAgent: applies.has('userAgent') ? facts.userAgent : null,
    },
    settings,
  );
  const record: {
    -readonly [K in keyof ParticipantEvidence]: ParticipantEvidence[K];
  } = { kind, signings: applies.has('signedAt') ? [...facts.signings] : [] };
  const it = network.items;
  if (it['session'] !== undefined) record.session = it['session'] as string;
  if (it['amr'] !== undefined) record.amr = it['amr'] as readonly string[];
  if (it['viewedAtMs'] !== undefined) record.viewedAtMs = it['viewedAtMs'] as number;
  if (it['completedAtMs'] !== undefined) record.completedAtMs = it['completedAtMs'] as number;
  if (network.ipAddress !== undefined) record.ipAddress = network.ipAddress;
  if (network.userAgent !== undefined) record.userAgent = network.userAgent;
  if (applies.has('amr')) {
    // The raw claims stay in the record as given. A value that cannot be worded as an assertion
    // (an odd `amr` string, a time out of range) gets no wording rather than failing the record.
    try {
      const authentication = presentAssertedAuthentication({
        amr: facts.amr,
        authTimeSeconds: facts.authTimeSeconds ?? null,
      });
      if (authentication !== undefined) record.authentication = authentication;
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
    }
  }
  if (applies.has('consent') && facts.consent !== null) record.consent = facts.consent;
  return record;
}

/**
 * The SHA-256 of the stored signature image, in lower-case hexadecimal. The argument is the stored
 * bytes only: the caller reads them from the asset store, and no client-declared hash enters.
 */
export async function signatureImageHash(storedImage: Uint8Array): Promise<string> {
  if (storedImage.length === 0) throw new RangeError('signatureImageHash: the image is empty');
  return sha256HexBytes(storedImage);
}

/** One signing event: its own `seq` and chain hash (FRW-040 criterion 5). */
export type SigningEvent = SigningFact;

/**
 * The signing events of a participant. Each signing is its own event, in the order given; a kind
 * that cannot sign has none, and a signing given for it is refused rather than recorded.
 */
export function signingEvents(
  kind: ParticipantKind,
  signings: readonly SigningFact[],
): SigningEvent[] {
  if (!APPLICABLE[kind].has('signedAt')) {
    if (signings.length > 0)
      throw new RangeError(`signingEvents: a ${kind} cannot sign, so no signing event applies`);
    return [];
  }
  const seqs = new Set<number>();
  for (const s of signings) {
    if (!Number.isSafeInteger(s.seq) || s.seq < 0)
      throw new RangeError('signingEvents: a seq is not a non-negative safe integer');
    if (seqs.has(s.seq)) throw new RangeError('signingEvents: two signings share a seq');
    seqs.add(s.seq);
  }
  return signings.map((s) => ({ ...s }));
}
