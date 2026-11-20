/**
 * The state of the catch-up (HIS-028; 08 §10; 13 §3, §5): what others changed since the user's read
 * marker, with the summary per region, and what waits for the user ("for you": the mentions of them
 * and the tasks assigned to them, which come first). The controller reads the host's catch-up port
 * and has no DOM; the pane draws its state, and the header reads its badge.
 *
 * Rules:
 * - the badge is the number of changes, the comments of others and the tasks; no activity is no badge;
 * - leaving or dismissing moves the marker to the head, but only when the user has viewed the head
 *   (`viewedHead`, default yes), and only forward, as the service does; a refusal keeps the activity;
 * - a later `refresh` asks again, so it shows only what is newer than the moved marker;
 * - the number of changes is announced once for each load that finds activity (a polite live region).
 */
import type { CatchUpActivity, CatchUpForYou, CatchUpPort, HistoryChange } from '../core-api.ts';
import type { RegionRow } from './history-compare.ts';

/** The comparison helpers load with the first activity, not with the first interactive editor (FND-008). */
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type Compare = typeof import('./history-compare.ts');

export type CatchUpStatus = 'loading' | 'ready' | 'empty' | 'error' | 'forbidden';

export interface CatchUpState {
  readonly status: CatchUpStatus;
  readonly activity: CatchUpActivity | null;
  /** The summary per region of the changes, in the order the regions first appear. */
  readonly regions: readonly RegionRow[];
  /** The mentions and the tasks, mentions first (the order the service gives is kept inside each). */
  readonly forYou: readonly CatchUpForYou[];
  /** The number the header shows; 0 shows nothing. */
  readonly badge: number;
  /** People's names by identifier; null for a person the host does not know (an erased person). */
  readonly names: ReadonlyMap<string, string | null>;
  /** The number of changes to announce, with a counter that changes for each announcement. */
  readonly announcement: { readonly changes: number; readonly n: number } | null;
  /** Set when the marker could not be moved: the activity stays and the user may try again. */
  readonly markFailed: boolean;
}

export interface CatchUpController {
  state(): CatchUpState;
  subscribe(listener: () => void): () => void;
  /** Asks the port for the activity. A newer call makes an older answer stale. */
  refresh(): Promise<void>;
  /**
   * Leaves or dismisses the catch-up: moves the marker to the head when the user has viewed it.
   * Returns whether the marker was moved.
   */
  finish(): Promise<boolean>;
  dispose(): void;
}

const NOTHING: CatchUpState = {
  status: 'loading',
  activity: null,
  regions: [],
  forYou: [],
  badge: 0,
  names: new Map(),
  announcement: null,
  markFailed: false,
};

/** The number the header shows for an activity (08 §10). */
export function badgeOf(activity: CatchUpActivity): number {
  const tasks = activity.forYou.filter((f) => f.kind === 'task').length;
  return activity.changes.length + activity.comments + tasks;
}

/** Whether the activity has anything to show. */
export function hasActivity(activity: CatchUpActivity): boolean {
  return badgeOf(activity) > 0 || activity.forYou.length > 0;
}

/** Mentions first, then tasks; each keeps the order it came in. */
export function forYouOrder(items: readonly CatchUpForYou[]): CatchUpForYou[] {
  return [...items.filter((i) => i.kind === 'mention'), ...items.filter((i) => i.kind === 'task')];
}

function peopleOf(compare: Compare, activity: CatchUpActivity): string[] {
  const seen = new Set<string>(compare.usersOf(activity.changes as readonly HistoryChange[]));
  for (const item of activity.forYou) if (item.author !== null) seen.add(item.author);
  return [...seen];
}

export function createCatchUpController(port: CatchUpPort): CatchUpController {
  let state: CatchUpState = NOTHING;
  let asked = 0;
  let announced = 0;
  let finished = false;
  const listeners = new Set<() => void>();
  const set = (next: CatchUpState): void => {
    state = next;
    for (const l of [...listeners]) l();
  };

  const names = async (
    compare: Compare,
    activity: CatchUpActivity,
  ): Promise<ReadonlyMap<string, string | null>> => {
    const ids = peopleOf(compare, activity);
    const out = new Map<string, string | null>();
    if (ids.length === 0) return out;
    if (!port.resolveUsers) {
      for (const id of ids) out.set(id, id);
      return out;
    }
    try {
      const found = await port.resolveUsers(ids);
      ids.forEach((id, i) => out.set(id, found[i]?.name ?? null));
    } catch {
      for (const id of ids) out.set(id, null);
    }
    return out;
  };

  async function refresh(): Promise<void> {
    const mine = ++asked;
    // A refresh while something is shown keeps the old state until the new one arrives.
    if (state.activity === null) set({ ...NOTHING });
    let result;
    try {
      result = await port.load();
    } catch {
      result = { ok: false as const, reason: 'failed' as const };
    }
    if (mine !== asked || finished) return;
    if (!result.ok) {
      set({ ...NOTHING, status: result.reason === 'forbidden' ? 'forbidden' : 'error' });
      return;
    }
    const activity = result.activity;
    const compare = await import('./history-compare.ts');
    const resolved = await names(compare, activity);
    if (mine !== asked || finished) return;
    if (!hasActivity(activity)) {
      set({ ...NOTHING, status: 'empty', activity });
      return;
    }
    announced += 1;
    set({
      status: 'ready',
      activity,
      regions: compare.summaryByRegion(activity.changes),
      forYou: forYouOrder(activity.forYou),
      badge: badgeOf(activity),
      names: resolved,
      announcement: { changes: activity.changes.length, n: announced },
      markFailed: false,
    });
  }

  const offChange = port.onChange?.(() => void refresh());

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh,
    async finish() {
      const activity = state.activity;
      if (activity === null || activity.head <= activity.marker) return false;
      if (port.viewedHead && !port.viewedHead()) return false;
      let ok: boolean;
      try {
        ok = (await port.markSeen(activity.head)).ok;
      } catch {
        ok = false;
      }
      if (!ok) {
        set({ ...state, markFailed: true });
        return false;
      }
      // The marker is at the head: nothing is waiting any more, and a later visit asks again.
      asked += 1;
      set({
        ...NOTHING,
        status: 'empty',
        activity: { ...activity, marker: activity.head, changes: [], comments: 0, forYou: [] },
      });
      return true;
    },
    dispose() {
      finished = true;
      offChange?.();
      listeners.clear();
    },
  };
}
