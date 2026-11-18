/**
 * Thinning old checkpoints with age (08 §11; HIS-030): the plan only. The scheduler in the document
 * service applies it and runs the replay that verifies a checkpoint's hash first (BE-020).
 *
 * The rule of 08 §11: checkpoints younger than 30 days are all kept; older ones are thinned to one
 * per UTC day and then, past the age the policy gives, to one per UTC week (epoch-aligned weeks).
 * In each period the checkpoint with the highest `seq` is kept. Three kinds are never removed: a
 * checkpoint a stored version points at (`pinned`), one that borders a snapshot commit
 * (`bordersSnapshot`), and any checkpoint in a period whose kept checkpoint is not yet verified
 * against a replay (`verified`), because the kept one would replace older ones.
 *
 * The age at which "daily" becomes "weekly" is 90 days (owner decision 55, 2026-11-15;
 * `WEEKLY_AFTER_MS`). The caller still passes it as `weeklyAfterMs`, so that a test may give
 * another. `checkpointRecords` builds the records from what a store holds: which checkpoints a
 * stored version points at, which border a snapshot commit, and which a replay has verified.
 */
import { type HistoryResult, refuse } from './types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
/** Owner decision 55: daily checkpoints thin to weekly after 90 days. */
export const WEEKLY_AFTER_MS = 90 * DAY_MS;
/** 08 §11: checkpoints younger than this are all kept. */
export const KEEP_ALL_MS = 30 * DAY_MS;

export interface CheckpointRecord {
  seq: number;
  /** Server time when the checkpoint was written, Unix milliseconds. */
  time: number;
  /** Whether its hash was verified against a replay (BE-020). */
  verified: boolean;
  /** A stored version (`named`, `export`, `sent`, ...) points at it. */
  pinned: boolean;
  /** It borders a snapshot commit. */
  bordersSnapshot: boolean;
}

export interface ThinningPolicy {
  /** The time of the run, Unix milliseconds. */
  now: number;
  /** The age after which periods are weeks rather than days; at least `KEEP_ALL_MS`. */
  weeklyAfterMs: number;
  /**
   * A legal hold is in force on the document (HIS-031): nothing is removed while it lasts. When it
   * is released, the plan is the policy's again, with nothing thinned retroactively (HIS-031 criterion 3).
   */
  hold?: boolean;
}

export interface ThinningPlan {
  /** Checkpoints that stay, in `seq` order. */
  keep: number[];
  /** Checkpoints that may be removed, in `seq` order. */
  remove: number[];
  /** Checkpoints held back because their period's kept checkpoint is not verified yet. */
  held: number[];
  /**
   * The kept checkpoints that replace older ones: the highest seq of each period that has
   * something to remove. Those are the ones to verify against a replay before the run (BE-020).
   */
  keepers: number[];
}

export function thinningPlan(
  checkpoints: readonly CheckpointRecord[],
  policy: ThinningPolicy,
): HistoryResult<ThinningPlan> {
  if (!Number.isSafeInteger(policy.weeklyAfterMs) || policy.weeklyAfterMs < KEEP_ALL_MS)
    return refuse('validation_failed', 'weeklyAfterMs must be a whole number of at least 30 days');
  if (policy.hold === true) {
    const all = checkpoints.map((c) => c.seq).sort((a, b) => a - b);
    return { ok: true, keep: all, remove: [], held: [], keepers: [] };
  }
  const keep: number[] = [];
  const remove: number[] = [];
  const held: number[] = [];
  const keepers: number[] = [];
  const periods = new Map<string, CheckpointRecord[]>();
  for (const c of checkpoints) {
    const age = policy.now - c.time;
    if (age < KEEP_ALL_MS || c.pinned || c.bordersSnapshot) {
      keep.push(c.seq);
      continue;
    }
    const key =
      age < policy.weeklyAfterMs
        ? `day:${Math.floor(c.time / DAY_MS)}`
        : `week:${Math.floor(c.time / WEEK_MS)}`;
    const list = periods.get(key);
    if (list) list.push(c);
    else periods.set(key, [c]);
  }
  for (const list of periods.values()) {
    // The highest seq is the period's kept checkpoint; the others may go if it is verified.
    const kept = list.reduce((a, b) => (b.seq > a.seq ? b : a));
    if (!kept.verified) {
      for (const c of list) held.push(c.seq);
      continue;
    }
    keep.push(kept.seq);
    for (const c of list) if (c !== kept) remove.push(c.seq);
    if (list.length > 1) keepers.push(kept.seq);
  }
  keep.sort((a, b) => a - b);
  remove.sort((a, b) => a - b);
  held.sort((a, b) => a - b);
  keepers.sort((a, b) => a - b);
  return { ok: true, keep, remove, held, keepers };
}

export interface StoredCheckpoint {
  seq: number;
  /** Server time when the checkpoint was written, Unix milliseconds. */
  time: number;
}

/**
 * The records `thinningPlan` takes, from what a store holds about one document.
 *
 * - `pinned`: the checkpoint at sequence number 0 (the content a document starts from, which no
 *   rebuild can do without), and, for each stored version, the nearest checkpoint at or before its
 *   `seq`: the one a rebuild of that version starts from, so that its replay does not grow.
 * - `bordersSnapshot`: the checkpoint at a snapshot commit's own `seq` and the one just before it,
 *   which the room writes around every snapshot commit (08 section 3; ADR 0034).
 * - `verified`: whether its hash matched a replay of the log (BE-020); the caller gives the set.
 */
export function checkpointRecords(
  checkpoints: readonly StoredCheckpoint[],
  versionSeqs: readonly number[],
  snapshotSeqs: readonly number[],
  verified: ReadonlySet<number>,
): CheckpointRecord[] {
  const ordered = [...checkpoints].sort((a, b) => a.seq - b.seq);
  const pinned = new Set<number>([0]);
  for (const v of versionSeqs) {
    let nearest: number | null = null;
    for (const c of ordered) if (c.seq <= v) nearest = c.seq;
    if (nearest !== null) pinned.add(nearest);
  }
  const borders = new Set<number>();
  for (const q of snapshotSeqs) {
    borders.add(q);
    borders.add(q - 1);
  }
  return ordered.map((c) => ({
    seq: c.seq,
    time: c.time,
    verified: verified.has(c.seq),
    pinned: pinned.has(c.seq),
    bordersSnapshot: borders.has(c.seq),
  }));
}
