/**
 * The workflow evidence ledger (12 §7; ADR 0013; FRW-041). Evidence is personal data. It is kept in
 * the workflow table `workflow_evidence` (migration 0060), scoped by tenant, with its own
 * retention (FRW-043), and never in the commit log, a checkpoint, an export, a webhook or a search
 * entry. The one thing that enters the chain is a salted hash of it: `record` returns the payload of
 * a control commit for a signing (origin `sign`) or a completion (origin `rules`), which holds the
 * origin and the hash and nothing else.
 *
 * - `record` builds the evidence of one event under the tenant's capture setting (FRW-042: no IP
 *   address or user agent while it is off), draws a fresh salt, commits to the canonical text of
 *   `{ participant, item, evidence }` (`commitEvidence`) and stores the evidence with its salt and
 *   hash in one row. The collection time is the service clock (`now`), never a caller's value.
 * - `list` gives a document's rows back to a verifier, who recomputes each hash with
 *   `recomputeCommitment` and compares it with the hash the chain holds (`verifyAgainstChain`).
 *   After a purge the rows are gone, and the chain, which holds only the hashes, still verifies.
 *
 * The control commit that carries the hash is written by the signing and completion routes
 * (FRW-047, FRW-048), which are not built; this module gives them the payload. Stores:
 * `MemoryEvidenceLedger` here, `PgEvidenceLedger` in evidence-ledger-pg.ts.
 */
import { canonicalize, uuid7 } from '@docedit/model';
import {
  applicableItems,
  captureEvidence,
  commitEvidence,
  controlCommitEvidence,
  DEFAULT_CAPTURE_SETTINGS,
  newEvidenceSalt,
  type CapturedEvidence,
  type CaptureSettings,
  type EvidenceCommitPayload,
  type EvidenceFacts,
  type EvidenceItem,
  type ParticipantKind,
} from '@docedit/authority';

/** One event's evidence to record. */
export interface EvidenceRecordEvent {
  readonly doc: string;
  /** The participant's identifier in the workflow. */
  readonly participant: string;
  /**
   * The participant's kind. Only the items that apply to it may be recorded (pplicableItems,
   * 12 §6.1, §8.1); another is refused, so that no item is invented for an approver or a cc.
   */
  readonly kind: ParticipantKind;
  /** The evidence item, for example `viewed`, `consented`, `signed` or `completed`. */
  readonly item: string;
  readonly facts: EvidenceFacts;
  /**
   * The origin of the control commit that will carry the hash: sign for a signing, 
ules for a
   * completion. Absent for an event whose hash no commit carries (a view).
   */
  readonly origin?: EvidenceCommitPayload['origin'];
}

export interface RecordedEvidence {
  readonly id: string;
  /** What is stored, after the capture setting. */
  readonly evidence: CapturedEvidence;
  /** The salted hash that is stored with the evidence. */
  readonly hash: string;
  /** What the control commit carries: the origin and the salted hash, nothing else; null without an origin. */
  readonly commit: EvidenceCommitPayload | null;
}

/** A stored row, as a verifier reads it. */
export interface StoredEvidence {
  readonly id: string;
  readonly participant: string;
  readonly item: string;
  readonly collectedAtMs: number;
  readonly evidence: CapturedEvidence;
  readonly salt: Uint8Array;
  /** The salted hash recorded with the evidence. */
  readonly hash: string;
}

export interface EvidenceLedger {
  record(tenant: string, event: EvidenceRecordEvent): Promise<RecordedEvidence>;
  /** The document's rows, oldest first. Empty after a purge. */
  list(tenant: string, doc: string): Promise<readonly StoredEvidence[]>;
}

/** The text a commitment covers: who, what and the evidence, in canonical form. */
export function evidenceCanonical(
  participant: string,
  item: string,
  evidence: CapturedEvidence,
): string {
  return canonicalize({ participant, item, evidence } as unknown as Parameters<
    typeof canonicalize
  >[0]);
}

/** The hash a verifier computes from a stored row. */
export function recomputeCommitment(row: StoredEvidence): Promise<string> {
  return commitEvidence(evidenceCanonical(row.participant, row.item, row.evidence), row.salt);
}

export interface ChainCheck {
  /** Rows whose recomputed hash is in the chain's set. */
  readonly matched: readonly string[];
  /** Rows whose recomputed hash is not in the chain's set (altered, or never committed). */
  readonly unmatched: readonly string[];
}

/**
 * Compares each stored row's recomputed hash with the hashes the chain holds. Rows that were purged
 * are not here, so they are neither matched nor unmatched: the chain's hashes stand alone.
 */
export async function verifyAgainstChain(
  rows: readonly StoredEvidence[],
  chainHashes: ReadonlySet<string>,
): Promise<ChainCheck> {
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const row of rows)
    ((chainHashes.has(await recomputeCommitment(row)) ? matched : unmatched) as string[]).push(
      row.id,
    );
  return { matched, unmatched };
}

/** The size a row's `data` may have (migration 0060: 4096 bytes). */
export const EVIDENCE_DATA_LIMIT = 4096;

/** The member of a stored row's `data` that holds the salt and the hash. */
export interface StoredCommit {
  readonly salt: string;
  readonly hash: string;
}

export const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));

/** The member of the evidence that holds each item (the network items are the facts' own fields). */
const KEY_OF: Readonly<Record<EvidenceItem, string | null>> = {
  session: 'session',
  ipAddress: null,
  userAgent: null,
  amr: 'amr',
  viewedAt: 'viewedAtMs',
  consent: 'consent',
  signedAt: 'signings',
  completedAt: 'completedAtMs',
};

/**
 * Refuses an item that does not apply to the participant's kind, and any member that is no item of
 * the record (FRW-040 criterion 4): the single write path invents nothing and keeps nothing extra.
 */
function checkApplicable(event: EvidenceRecordEvent): void {
  const applies = new Set(applicableItems(event.kind));
  const allowed = new Set(
    [...applies].map((i) => KEY_OF[i]).filter((k): k is string => k !== null),
  );
  // The attempt at the access code (FRW-039) is evidence of a participant who has to act: not a `cc`.
  if (event.kind !== 'cc') allowed.add('accessCode');
  for (const key of Object.keys(event.facts.items))
    if (!allowed.has(key))
      throw new RangeError(
        `evidence item ${key} does not apply to a participant of kind ${event.kind}`,
      );
  if (event.facts.ipAddress !== null && !applies.has('ipAddress'))
    throw new RangeError(`no IP address is recorded for a participant of kind ${event.kind}`);
  if (event.facts.userAgent !== null && !applies.has('userAgent'))
    throw new RangeError(`no user agent is recorded for a participant of kind ${event.kind}`);
}

/** Builds the evidence, the salt and the commitment of one event; the stores write the row. */
export async function prepareEvidence(
  event: EvidenceRecordEvent,
  settings: CaptureSettings,
): Promise<{
  id: string;
  evidence: CapturedEvidence;
  salt: Uint8Array;
  hash: string;
  commit: EvidenceCommitPayload | null;
}> {
  checkApplicable(event);
  const evidence = captureEvidence(event.facts, settings);
  const salt = newEvidenceSalt();
  const canonical = evidenceCanonical(event.participant, event.item, evidence);
  const hash = await commitEvidence(canonical, salt);
  const commit =
    event.origin === undefined ? null : await controlCommitEvidence(event.origin, canonical, salt);
  const data = JSON.stringify({
    ...evidence,
    commit: { salt: toHex(salt), hash },
  });
  if (Buffer.byteLength(data) > EVIDENCE_DATA_LIMIT)
    throw new RangeError(`the evidence of one event is at most ${EVIDENCE_DATA_LIMIT} bytes`);
  return { id: uuid7(), evidence, salt, hash, commit };
}

/** The in-memory ledger: the same rules as the PostgreSQL one (tests and the memory build). */
export class MemoryEvidenceLedger implements EvidenceLedger {
  readonly #rows = new Map<string, StoredEvidence & { tenant: string; doc: string }>();
  readonly #now: () => number;
  readonly #settings: (tenant: string) => CaptureSettings;

  constructor(
    now: () => number = Date.now,
    settings: (tenant: string) => CaptureSettings = () => DEFAULT_CAPTURE_SETTINGS,
  ) {
    this.#now = now;
    this.#settings = settings;
  }

  async record(tenant: string, event: EvidenceRecordEvent): Promise<RecordedEvidence> {
    const made = await prepareEvidence(event, this.#settings(tenant));
    this.#rows.set(`${tenant}/${made.id}`, {
      id: made.id,
      tenant,
      doc: event.doc,
      participant: event.participant,
      item: event.item,
      collectedAtMs: this.#now(),
      evidence: structuredClone(made.evidence),
      salt: made.salt,
      hash: made.hash,
    });
    return { id: made.id, evidence: made.evidence, hash: made.hash, commit: made.commit };
  }

  list(tenant: string, doc: string): Promise<readonly StoredEvidence[]> {
    return Promise.resolve(
      [...this.#rows.values()]
        .filter((r) => r.tenant === tenant && r.doc === doc)
        .sort((a, b) => a.collectedAtMs - b.collectedAtMs || (a.id < b.id ? -1 : 1))
        .map(({ tenant: _t, doc: _d, ...row }) => structuredClone(row)),
    );
  }

  /** Deletes the rows of a document, as a purge does (tests). */
  purge(tenant: string, doc: string): void {
    for (const [k, r] of this.#rows) if (r.tenant === tenant && r.doc === doc) this.#rows.delete(k);
  }
}
