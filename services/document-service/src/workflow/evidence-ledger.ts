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
  captureEvidence,
  commitEvidence,
  controlCommitEvidence,
  DEFAULT_CAPTURE_SETTINGS,
  newEvidenceSalt,
  type CapturedEvidence,
  type CaptureSettings,
  type EvidenceCommitPayload,
  type EvidenceFacts,
} from '@docedit/authority';

/** One event's evidence to record. */
export interface EvidenceRecordEvent {
  readonly doc: string;
  /** The participant's surrogate (never a host identifier). */
  readonly participant: string;
  /** The evidence item, for example `viewed`, `consented`, `signed` or `completed`. */
  readonly item: string;
  readonly facts: EvidenceFacts;
  /** The origin of the control commit that will carry the hash: a signing or a completion. */
  readonly origin: EvidenceCommitPayload['origin'];
}

export interface RecordedEvidence {
  readonly id: string;
  /** What is stored, after the capture setting. */
  readonly evidence: CapturedEvidence;
  /** What the control commit carries: the origin and the salted hash, nothing else. */
  readonly commit: EvidenceCommitPayload;
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

/** Builds the evidence, the salt and the commitment of one event; the stores write the row. */
export async function prepareEvidence(
  event: EvidenceRecordEvent,
  settings: CaptureSettings,
): Promise<{
  id: string;
  evidence: CapturedEvidence;
  salt: Uint8Array;
  commit: EvidenceCommitPayload;
}> {
  const evidence = captureEvidence(event.facts, settings);
  const salt = newEvidenceSalt();
  const commit = await controlCommitEvidence(
    event.origin,
    evidenceCanonical(event.participant, event.item, evidence),
    salt,
  );
  const data = JSON.stringify({
    ...evidence,
    commit: { salt: toHex(salt), hash: commit.evidenceHash },
  });
  if (Buffer.byteLength(data) > EVIDENCE_DATA_LIMIT)
    throw new RangeError(`the evidence of one event is at most ${EVIDENCE_DATA_LIMIT} bytes`);
  return { id: uuid7(), evidence, salt, commit };
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
      hash: made.commit.evidenceHash,
    });
    return { id: made.id, evidence: made.evidence, commit: made.commit };
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
