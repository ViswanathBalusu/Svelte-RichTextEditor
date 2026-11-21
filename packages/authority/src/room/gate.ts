/**
 * The history visibility gate (07 §8; 08 §9; HIS-023, HIS-024, PRM-041; ADR 0034).
 *
 * The gate is a number per user and moment, `minVisibleSeq(user)`, the lowest sequence number
 * whose content the user may read. Two rules are built on it:
 *
 * - a single state (content at a `seq`) is visible at or above the gate, at the head, and, in
 *   phase 2, at a named version (`stateVisible`);
 * - a run of commits after a `seq` (resume, `after`, `fromSeq`) may be sent only when that `seq` is
 *   at or above the gate, because the commits reveal every state between it and the head
 *   (`rangeVisible`).
 *
 * The function reads no clock and no storage: the caller passes the setting, the user's standing
 * and the commit times it holds.
 */
import { computeAccess, type RegionInfo } from '../permissions/access.ts';
import type { Connection, PermissionState } from '../permissions/model.ts';

/** Who sees full history (08 §9). `editors` is the default. */
export type HistoryVisibility = 'editors' | 'all' | 'since_access';

export const HISTORY_VISIBILITIES: readonly HistoryVisibility[] = [
  'editors',
  'all',
  'since_access',
];

export const DEFAULT_HISTORY_VISIBILITY: HistoryVisibility = 'editors';

export interface GateInput {
  setting: HistoryVisibility;
  /** Whether the user holds `edit` somewhere in the document through their role or a grant. */
  editsSomewhere: boolean;
  /** The token's `access_since` claim, Unix milliseconds, when the host supplies one. */
  accessSince?: number | undefined;
  /** The current head. */
  head: number;
  /** The server time of the commit at a sequence number, or undefined when the caller lacks it. */
  timeOf: (seq: number) => number | undefined;
  /** The highest sequence number below which `timeOf` knows nothing (0 for a whole log). */
  floor?: number;
}

/**
 * The search of `since_access`: the last commit stored at or before `since`. Commit times come
 * from the room's clock and are taken as non-decreasing, so it is a binary search. It is written
 * once, as a generator that asks for the time of one commit at a time, so that a caller with the
 * times in memory (`minVisibleSeq`) and a caller that reads them from storage
 * (`minVisibleSeqAsync`) run the same rule.
 */
function* sinceAccessSearch(
  floor: number,
  head: number,
  since: number,
): Generator<number, number, number | undefined> {
  let lo = floor + 1;
  let hi = head;
  let found = floor;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = yield mid;
    if (t !== undefined && t <= since) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The part of the rule that needs no commit times, or null when `since_access` needs them. */
function decided(g: Omit<GateInput, 'timeOf'>): number | null {
  switch (g.setting) {
    case 'all':
      return 0;
    case 'editors':
      return g.editsSomewhere ? 0 : g.head;
    case 'since_access':
      return g.accessSince === undefined || !Number.isFinite(g.accessSince) ? g.head : null;
  }
}

/**
 * 07 §8's `minVisibleSeq(user)`.
 *
 * - `all`: 0, everyone with `view` sees full history.
 * - `editors`: 0 for a user with `edit` somewhere, otherwise the head: everyone else sees the
 *   current version only (and, in phase 2, named versions, which `stateVisible` admits).
 * - `since_access`: the last commit stored at or before the token's `access_since`, so the state
 *   current at that moment is visible. Without the claim the gate fails closed at the head.
 */
export function minVisibleSeq(g: GateInput): number {
  const d = decided(g);
  if (d !== null) return d;
  const search = sinceAccessSearch(g.floor ?? 0, g.head, g.accessSince!);
  let step = search.next();
  while (!step.done) step = search.next(g.timeOf(step.value));
  return step.value;
}

/** `minVisibleSeq` for a caller that reads commit times from storage: the same rule, awaited. */
export async function minVisibleSeqAsync(
  g: Omit<GateInput, 'timeOf'> & { timeOf: (seq: number) => Promise<number | undefined> },
): Promise<number> {
  const d = decided(g);
  if (d !== null) return d;
  const search = sinceAccessSearch(g.floor ?? 0, g.head, g.accessSince!);
  let step = search.next();
  while (!step.done) step = search.next(await g.timeOf(step.value));
  return step.value;
}

/**
 * Whether the rule asks who edits somewhere under a setting (08 §9: only `editors` does). A caller
 * that would have to read the document's regions to answer that reads them only when this is true
 * and the role alone does not hold `edit`. The answer is taken from the rule itself, so a caller
 * holds no copy of it (PRM-041 criterion 1).
 */
export function gateAsksWhoEdits(setting: HistoryVisibility): boolean {
  const g = { setting, accessSince: undefined, head: 1 };
  return decided({ ...g, editsSomewhere: true }) !== decided({ ...g, editsSomewhere: false });
}

/**
 * Whether the rule may read commit times under a setting (only `since_access` does, and only with
 * the claim), so that a caller reads the log's times from storage only then. Taken from the rule.
 */
export function gateReadsTimes(setting: HistoryVisibility): boolean {
  return decided({ setting, editsSomewhere: false, accessSince: 0, head: 1 }) === null;
}

/** Whether the content at `seq` is visible: at or above the gate, the head, or a named version. */
export function stateVisible(
  min: number,
  seq: number,
  head: number,
  named?: (seq: number) => boolean,
): boolean {
  return seq >= min || seq === head || (named?.(seq) ?? false);
}

/** Whether the commits after `from` may be sent: the client must be entitled to the state at `from`. */
export function rangeVisible(min: number, from: number): boolean {
  return from >= min;
}

/**
 * Whether a connection holds `edit` somewhere in the document through its role or a matching grant
 * (08 §9, "people with `edit` somewhere in the document"). The temporary limits of 07 §4 (document
 * state, approved regions, leases) do not count: a lock does not take history away from editors.
 */
export function editsSomewhere(
  conn: Connection,
  regions: readonly RegionInfo[],
  perms: PermissionState,
  now: number,
): boolean {
  const a = computeAccess(
    conn,
    regions,
    { ...perms, documentState: 'active', regionStates: new Map(), leases: [] },
    now,
  );
  if (a.body.has('edit') || a.structureScopes.has('edit')) return true;
  for (const c of a.regions.values()) if (c.has('edit')) return true;
  return false;
}
