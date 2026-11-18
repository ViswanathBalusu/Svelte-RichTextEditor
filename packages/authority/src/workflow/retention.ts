/**
 * The purge decision for workflow evidence (12 §7, §14; FRW-043), as a pure function.
 *
 * - `planPurge` says which evidence rows the purge job may delete at `nowMs`. A legal hold on the
 *   document keeps every row until the hold is lifted. Otherwise a row is removed once its retention
 *   period has passed.
 * - The audit entry records counts and the instant only. It names no row and holds no personal data,
 *   so the entry itself can be kept after the evidence is gone.
 *
 * The default period is decided (owner decision 31 in docs/owner-decisions-2026-11-15.md; FRW-084;
 * docs/adr/0394-w4-FRW-084-evidence-retention.md): evidence is kept as long as the signed document
 * exists and is deleted with it. That is a rule with no period and no clock, so the default
 * `EVIDENCE_RETENTION_DEFAULT` is `null` and `planPurge` removes nothing by age; the document's
 * purge (HIS-039) removes the rows. A caller may still pass a period in milliseconds, counted from
 * the collection time of each row, for a tenant that sets one (not decided, FRW-084 criterion 1).
 * Erasure of one participant (FRW-043 criterion 3) is `eraseParticipant` in the document service.
 */

/**
 * The retention of evidence when no period is set: for the life of the document (decision 31).
 * `null` means no removal by age.
 */
export const EVIDENCE_RETENTION_DEFAULT: number | null = null;

/** One evidence row, as far as the purge decision needs it. */
export interface EvidenceRow {
  readonly id: string;
  /** The instant the evidence was collected, in milliseconds since the epoch. */
  readonly collectedAtMs: number;
}

export interface PurgeInput {
  readonly rows: readonly EvidenceRow[];
  readonly nowMs: number;
  /**
   * The retention period in milliseconds, counted from each row's collection time. `null` is the
   * default of decision 31: the rows stay as long as the document exists, so none is removed by age.
   */
  readonly retentionMs: number | null;
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
  const period = input.retentionMs;
  if (period !== null && (!Number.isSafeInteger(period) || period <= 0))
    throw new RangeError('planPurge: retentionMs is not a positive safe integer or null');
  const remove: string[] = [];
  const keep: string[] = [];
  for (const row of input.rows) {
    const expired =
      !input.legalHold && period !== null && input.nowMs - row.collectedAtMs >= period;
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
