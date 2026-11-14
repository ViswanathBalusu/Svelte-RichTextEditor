/**
 * Thinning old payloads for a tenant that keeps only the history after a chosen period (08 §11;
 * HIS-032): the plan, and the effect of a plan on a bundle. The document service's scheduler
 * applies the plan to its rows; this module decides what goes and what stays.
 *
 * The rules:
 *
 * - a payload older than `periodMs` may be removed. Its metadata, payload hash and the chain stay,
 *   so the chain still verifies from the stored hashes (chain.ts);
 * - a stored version of kind `named`, `export`, `sent` or `completed` is never thinned: the payloads
 *   needed to rebuild it are kept, that is the commits after its nearest checkpoint at or before it,
 *   up to it (08 §4, §11);
 * - a snapshot commit's payload is kept: a replay stops at a snapshot, so its content is needed;
 * - nothing is removed while a legal hold is in force (HIS-031, `hold.ts`).
 *
 * A thinned range answers through `payloadOf` (`tombstone.ts`) with a fixed reason. The code it
 * answers with is not named in the spec (HIS-032 notes; open). The age of the period and the
 * response code are the caller's and the owner's, not chosen here.
 */
import type { BundleCommit, LogBundle } from './chain.ts';
import { type HistoryResult, refuse, type VersionKind } from './types.ts';

/** The kinds of stored version whose rebuild data is kept (08 §11; HIS-032 criterion 2). */
export const PINNED_VERSION_KINDS: ReadonlySet<VersionKind> = new Set<VersionKind>([
  'named',
  'export',
  'sent',
  'completed',
]);

/** One commit as the plan reads it. */
export interface PayloadRecord {
  seq: number;
  /** Server time of the commit, Unix milliseconds. */
  time: number;
  /** The commit kind (`steps`, `control` or `snapshot`). */
  kind: string;
}

/** A stored version the plan must keep rebuildable. */
export interface PinnedVersion {
  seq: number;
  kind: VersionKind;
}

export interface PayloadThinningPolicy {
  /** The time of the run, Unix milliseconds. */
  now: number;
  /** The period of history that keeps its payloads, in milliseconds (the tenant's choice). */
  periodMs: number;
  /** A legal hold is in force: nothing is removed while it lasts (HIS-031). */
  hold?: boolean;
}

export interface PayloadThinningPlan {
  /** Payloads that may be removed, in `seq` order. */
  remove: number[];
  /** Payloads that stay, in `seq` order. */
  keep: number[];
  /** Payloads kept only because a stored version needs them to be rebuilt, in `seq` order. */
  keptForVersions: number[];
}

/**
 * The payload plan for a document at the policy's time. `checkpointSeqs` are the sequence numbers
 * of the checkpoints (their content is kept by the scheduler, HIS-030); `versions` are the stored
 * versions the plan must keep rebuildable.
 */
export function payloadThinningPlan(
  commits: readonly PayloadRecord[],
  checkpointSeqs: readonly number[],
  versions: readonly PinnedVersion[],
  policy: PayloadThinningPolicy,
): HistoryResult<PayloadThinningPlan> {
  if (!Number.isSafeInteger(policy.now)) return refuse('validation_failed', 'now is a whole time');
  if (!Number.isSafeInteger(policy.periodMs) || policy.periodMs < 0)
    return refuse('validation_failed', 'periodMs is a whole number of milliseconds, not negative');
  const all = [...commits].sort((a, b) => a.seq - b.seq);
  if (policy.hold === true)
    return { ok: true, keep: all.map((c) => c.seq), remove: [], keptForVersions: [] };

  const cps = [...checkpointSeqs].sort((a, b) => a - b);
  // The payloads a pinned version needs: those after its nearest checkpoint at or before it.
  const needed = new Set<number>();
  for (const v of versions) {
    if (!PINNED_VERSION_KINDS.has(v.kind)) continue;
    let from = 0;
    for (const s of cps) if (s <= v.seq) from = s;
    for (const c of all) if (c.seq > from && c.seq <= v.seq) needed.add(c.seq);
  }

  const cut = policy.now - policy.periodMs;
  const keep: number[] = [];
  const remove: number[] = [];
  const keptForVersions: number[] = [];
  for (const c of all) {
    if (c.kind === 'snapshot' || c.time >= cut) {
      keep.push(c.seq);
      continue;
    }
    if (needed.has(c.seq)) {
      keep.push(c.seq);
      keptForVersions.push(c.seq);
      continue;
    }
    remove.push(c.seq);
  }
  return { ok: true, keep, remove, keptForVersions };
}

/** The records a plan reads, from a bundle's metadata (the server's time, Unix milliseconds). */
export function payloadRecordsOf(bundle: LogBundle): PayloadRecord[] {
  return bundle.commits.map((c) => ({
    seq: c.meta.seq,
    time: Date.parse(c.meta.time),
    kind: c.meta.kind,
  }));
}

/**
 * The bundle with the payloads of the plan's `remove` list dropped, as a thinned or tombstoned
 * commit is held (chain.ts). The input is not changed; the metadata and hashes stay.
 */
export function thinBundle(
  bundle: LogBundle,
  plan: PayloadThinningPlan,
): HistoryResult<{ bundle: LogBundle; removed: number }> {
  const drop = new Set(plan.remove);
  let removed = 0;
  const commits = bundle.commits.map((c): BundleCommit => {
    if (!drop.has(c.meta.seq) || c.payload === undefined || c.payload === null) return c;
    removed++;
    return { meta: c.meta, payloadHash: c.payloadHash, prevHash: c.prevHash, hash: c.hash };
  });
  return { ok: true, bundle: { ...bundle, commits }, removed };
}
