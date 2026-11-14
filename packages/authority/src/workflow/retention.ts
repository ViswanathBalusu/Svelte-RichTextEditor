/**
 * The purge decision for workflow evidence (12 §7, §14; FRW-043), as a pure function.
 *
 * - `planPurge` says which evidence rows the purge job may delete at `nowMs`. A legal hold on the
 *   document keeps every row until the hold is lifted. Otherwise a row is removed once its retention
 *   period has passed.
 * - The audit entry records counts and the instant only. It names no row and holds no personal data,
 *   so the entry itself can be kept after the evidence is gone.
 *
 * Open (not decided here, FRW-084 and FRW-043 Notes): the default retention period, and the instant
 * the retention clock starts from (collection, completion or the end of the workflow). The caller
 * passes both. Erasure of one participant's values in commit payloads (FRW-043 criterion 3) and the
 * purge job that deletes rows, together with the chain check of criterion 1, are the workflow
 * service's and are not built.
 */

/** One evidence row, as far as the purge decision needs it. */
export interface EvidenceRow {
  readonly id: string;
  /** The instant the evidence was collected, in milliseconds since the epoch. */
  readonly collectedAtMs: number;
}

export interface PurgeInput {
  readonly rows: readonly EvidenceRow[];
  readonly nowMs: number;
  /** The retention period in milliseconds. Required: no default is decided (FRW-084). */
  readonly retentionMs: number;
  readonly legalHold: boolean;
}

/** What one purge run did, as counts. It names no row. */
export interface PurgeAudit {
  readonly kind: 'evidence.purge';
  readonly atMs: number;
  readonly removedCount: number;
  readonly keptCount: number;
  readonly legalHold: boolean;
}

export interface PurgePlan {
  /** Ids of the rows the job may delete, in input order. */
  readonly remove: readonly string[];
  /** Ids of the rows the job keeps, in input order. */
  readonly keep: readonly string[];
  readonly audit: PurgeAudit;
}

/** Plans one purge run. Pure: it reads the rows and returns the plan; it deletes nothing. */
export function planPurge(input: PurgeInput): PurgePlan {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0)
    throw new RangeError('planPurge: nowMs is not a non-negative safe integer');
  if (!Number.isSafeInteger(input.retentionMs) || input.retentionMs <= 0)
    throw new RangeError('planPurge: retentionMs is not a positive safe integer');
  const remove: string[] = [];
  const keep: string[] = [];
  for (const row of input.rows) {
    const expired = !input.legalHold && input.nowMs - row.collectedAtMs >= input.retentionMs;
    (expired ? remove : keep).push(row.id);
  }
  return {
    remove,
    keep,
    audit: {
      kind: 'evidence.purge',
      atMs: input.nowMs,
      removedCount: remove.length,
      keptCount: keep.length,
      legalHold: input.legalHold,
    },
  };
}
