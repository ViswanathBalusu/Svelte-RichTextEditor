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
 * The age at which "daily" becomes "weekly" is not given by the spec (HIS-030 notes; open), so the
 * caller supplies `weeklyAfterMs` and nothing here chooses it.
 */
import { type HistoryResult, refuse } from './types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
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
}

export function thinningPlan(
  checkpoints: readonly CheckpointRecord[],
  policy: ThinningPolicy,
): HistoryResult<ThinningPlan> {
  if (!Number.isSafeInteger(policy.weeklyAfterMs) || policy.weeklyAfterMs < KEEP_ALL_MS)
    return refuse('validation_failed', 'weeklyAfterMs must be a whole number of at least 30 days');
  if (policy.hold === true) {
    const all = checkpoints.map((c) => c.seq).sort((a, b) => a - b);
    return { ok: true, keep: all, remove: [], held: [] };
  }
  const keep: number[] = [];
  const remove: number[] = [];
  const held: number[] = [];
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
  }
  keep.sort((a, b) => a - b);
  remove.sort((a, b) => a - b);
  held.sort((a, b) => a - b);
  return { ok: true, keep, remove, held };
}
