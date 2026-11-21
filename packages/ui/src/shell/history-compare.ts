/**
 * The pure rules of the comparison in the history pane (HIS-013; 08 §6): which versions the pickers
 * offer, how a change is named for the live region ("n of m", its kind and its author), the summary
 * grouped by region, and the field changes. No Svelte import, so the rules are tested in Node.
 */
import type {
  HistoryChange,
  HistoryComparison,
  HistoryPaneItem,
  HistoryPort,
} from '../core-api.ts';
import { type HistoryController, openingOf } from './history-pane.ts';

/**
 * The key of the open version when it is the current document, opened as the newer end of a
 * comparison. It is no list item, and nothing can be restored to it (HIS-021).
 */
export const CURRENT_KEY = 'current';

/** A state the pickers offer: the list item it comes from, and the `seq` and time it stands for. */
export interface CompareChoice {
  readonly key: string;
  readonly seq: number;
  readonly time: string;
  readonly name: string | null;
}

/**
 * The versions a comparison can start from or end at: the items of the list that have a state. The
 * list is the service's answer under the user's gate (HIS-024), so nothing below the gate is
 * offered here (criterion 6). Newest first, as the list is.
 */
export function compareChoices(items: readonly HistoryPaneItem[]): CompareChoice[] {
  const out: CompareChoice[] = [];
  for (const item of items) {
    const opening = openingOf(item);
    if (opening === null) continue;
    out.push({ key: `${item.kind}:${item.id}`, ...opening });
  }
  return out;
}

/**
 * The two ends of a comparison in order: the older `seq` first. `to` null is the current document and
 * is always the newer end.
 */
export function orderedEnds(
  a: CompareChoice,
  b: CompareChoice | null,
): { from: CompareChoice; to: CompareChoice | null } {
  if (b === null) return { from: a, to: null };
  return a.seq <= b.seq ? { from: a, to: b } : { from: b, to: a };
}

/** A change as the navigator lists it: its place in the order, and who and what. */
export interface ChangeRow {
  readonly index: number;
  readonly change: HistoryChange;
  /** Whether the change has a place in the newer version's document (a removed block has none). */
  readonly drawn: boolean;
}

export function changeRows(changes: readonly HistoryChange[]): ChangeRow[] {
  return changes.map((change, index) => ({ index, change, drawn: change.kind !== 'removed' }));
}

/** The users a comparison names, in order of first appearance, for the directory lookup. */
export function usersOf(changes: readonly HistoryChange[]): string[] {
  const seen = new Set<string>();
  for (const change of changes) {
    if (change.user !== undefined) seen.add(change.user);
    for (const span of change.spans ?? []) if (span.user !== undefined) seen.add(span.user);
  }
  return [...seen];
}

/**
 * The person a change is credited to: the user of the change, else the user of its first span. A
 * change names no one when the service could not (a comparison by alignment cannot name who deleted
 * text, HIS-012 Notes).
 */
export function authorOf(change: HistoryChange): string | null {
  if (change.user !== undefined) return change.user;
  for (const span of change.spans ?? []) if (span.user !== undefined) return span.user;
  return null;
}

/**
 * The assistant that acted for the person a change is credited to, when one did (HIS-017): the agent
 * of the change, else the agent of its first span that names one. A person's own writing has none.
 */
export function agentOf(change: HistoryChange): string | null {
  if (change.agent !== undefined) return change.agent;
  for (const span of change.spans ?? []) if (span.agent !== undefined) return span.agent;
  return null;
}

/** The changes an assistant wrote for a person, with their place in the order (HIS-017). */
export function assistantChanges(
  changes: readonly HistoryChange[],
): { index: number; change: HistoryChange; agent: string; user: string | null }[] {
  const out: { index: number; change: HistoryChange; agent: string; user: string | null }[] = [];
  changes.forEach((change, index) => {
    const agent = agentOf(change);
    if (agent !== null) out.push({ index, change, agent, user: authorOf(change) });
  });
  return out;
}

/** One line of the summary: the changes of one region. */
export interface RegionRow {
  /** The region, or null for changes outside regions. */
  readonly region: string | null;
  readonly count: number;
  readonly kinds: Readonly<Record<string, number>>;
}

/**
 * The summary grouped by region, in the order the regions first appear (08 §6, last paragraph). A
 * change to a region itself counts for that region.
 */
export function summaryByRegion(changes: readonly HistoryChange[]): RegionRow[] {
  const out = new Map<string | null, { count: number; kinds: Record<string, number> }>();
  for (const change of changes) {
    const region = change.region ?? (change.type === 'region' ? (change.blockId ?? null) : null);
    let row = out.get(region);
    if (!row) {
      row = { count: 0, kinds: {} };
      out.set(region, row);
    }
    row.count++;
    row.kinds[change.kind] = (row.kinds[change.kind] ?? 0) + 1;
  }
  return [...out].map(([region, row]) => ({ region, count: row.count, kinds: row.kinds }));
}

/** The field changes of a comparison, each with the field and the user who changed it. */
export function fieldChanges(
  changes: readonly HistoryChange[],
): { field: string; user: string | null; index: number }[] {
  const out: { field: string; user: string | null; index: number }[] = [];
  changes.forEach((change, index) => {
    if (change.kind === 'field' && change.fieldId !== undefined)
      out.push({ field: change.fieldId, user: authorOf(change), index });
  });
  return out;
}

/** The index after `index` in `total` changes, wrapping at the end; `-1` starts at the first. */
export function nextIndex(index: number, total: number): number {
  if (total === 0) return -1;
  return index + 1 >= total ? 0 : index + 1;
}

/** The index before `index`, wrapping at the start; `-1` starts at the last. */
export function previousIndex(index: number, total: number): number {
  if (total === 0) return -1;
  return index <= 0 ? total - 1 : index - 1;
}

export type CompareStatus = 'idle' | 'loading' | 'ready' | 'refused';

/** The comparison the pane shows, or the reason there is none. */
export interface CompareState {
  readonly status: CompareStatus;
  readonly reason: 'forbidden' | 'not_found' | 'failed' | null;
  readonly fromSeq: number | null;
  readonly toSeq: number | null;
  readonly rows: readonly ChangeRow[];
  /** The change the navigator is on, or -1 before the first move. */
  readonly index: number;
  readonly showDeleted: boolean;
  /** Names by identifier; null for a person the host does not resolve. */
  readonly names: ReadonlyMap<string, string | null>;
}

export interface CompareController {
  state(): CompareState;
  subscribe(listener: () => void): () => void;
  /** Compares two choices (or one and the current document, `b` null). */
  run(a: CompareChoice, b: CompareChoice | null): Promise<boolean>;
  /**
   * Shows a comparison the caller already holds over the version that is open: the dry run of a
   * restore (HIS-021), whose result is that version. It is drawn, navigated and summarised exactly
   * as a comparison of two versions is. False when no version is open, or the user moved on.
   */
  show(comparison: HistoryComparison): Promise<boolean>;
  next(): boolean;
  previous(): boolean;
  setShowDeleted(on: boolean): void;
  /** Removes the comparison and its marks; the version it was drawn over stays open. */
  clear(): void;
  /** Closes the comparison and the version it was drawn over. */
  close(): void;
}

const IDLE: CompareState = {
  status: 'idle',
  reason: null,
  fromSeq: null,
  toSeq: null,
  rows: [],
  index: -1,
  showDeleted: false,
  names: new Map(),
};

/**
 * Creates the comparison controller over the port and the history controller. A comparison asks the
 * port for the changes, opens the newer version through the history controller (a read-only state
 * that is never connected to the channel, HIS-010) and hands it the changes to draw.
 */
export function createCompareController(
  port: HistoryPort,
  history: Pick<HistoryController, 'openAt' | 'leave' | 'state'>,
): CompareController {
  const listeners = new Set<() => void>();
  let current: CompareState = IDLE;
  let latest = 0;
  const set = (patch: Partial<CompareState>): void => {
    current = { ...current, ...patch };
    for (const listener of [...listeners]) listener();
  };

  const view = () => {
    const v = history.state().viewing;
    return v?.status === 'open' ? v.view : null;
  };

  async function resolve(ids: readonly string[]): Promise<void> {
    const found = new Map<string, string | null>();
    if (port.resolveUsers === undefined) for (const id of ids) found.set(id, null);
    else {
      try {
        const people = await port.resolveUsers([...ids]);
        ids.forEach((id, i) => found.set(id, people[i]?.name ?? null));
      } catch {
        for (const id of ids) found.set(id, null);
      }
    }
    set({ names: new Map([...current.names, ...found]) });
  }

  const go = (index: number): boolean => {
    if (current.status !== 'ready' || index < 0) return false;
    set({ index });
    // A change with no place in this version (a removed block) is still announced; it is not drawn.
    view()?.focusChange?.(index);
    return true;
  };

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async run(a, b) {
      if (port.compare === undefined) return false;
      const mine = ++latest;
      const ends = orderedEnds(a, b);
      history.leave();
      set({ ...IDLE, status: 'loading', names: current.names });
      let result;
      try {
        result = await port.compare(ends.from.seq, ends.to === null ? null : ends.to.seq);
      } catch {
        result = { ok: false as const, reason: 'failed' as const };
      }
      if (mine !== latest) return false;
      if (!result.ok) {
        set({ status: 'refused', reason: result.reason });
        return false;
      }
      const { comparison } = result;
      const rows = changeRows(comparison.changes);
      set({
        status: 'ready',
        reason: null,
        fromSeq: comparison.fromSeq,
        toSeq: comparison.toSeq,
        rows,
        index: -1,
      });
      const missing = usersOf(comparison.changes).filter((id) => !current.names.has(id));
      if (missing.length > 0) await resolve(missing);
      if (mine !== latest) return true;
      // The newer version is the one drawn (08 §6): the current document or the later choice.
      const newer = ends.to ?? {
        key: CURRENT_KEY,
        seq: comparison.toSeq,
        time: new Date().toISOString(),
        name: null,
      };
      const opened = await history.openAt(newer.key, {
        seq: comparison.toSeq,
        time: newer.time,
        name: newer.name,
      });
      if (mine !== latest) return true;
      if (opened) {
        const v = view();
        v?.showComparison?.(comparison.changes);
        v?.showDeletions?.(current.showDeleted);
      }
      return true;
    },
    async show(comparison) {
      const over = view();
      if (over === null) return false;
      const mine = ++latest;
      set({
        status: 'ready',
        reason: null,
        fromSeq: comparison.fromSeq,
        toSeq: comparison.toSeq,
        rows: changeRows(comparison.changes),
        index: -1,
      });
      const missing = usersOf(comparison.changes).filter((id) => !current.names.has(id));
      if (missing.length > 0) await resolve(missing);
      // The user left the version, opened another, or asked for something else meanwhile.
      if (mine !== latest || view() !== over) return false;
      over.showComparison?.(comparison.changes);
      over.showDeletions?.(current.showDeleted);
      return true;
    },
    clear() {
      latest++;
      if (current.status === 'idle') return;
      // The marks go; the version itself stays as the user opened it.
      view()?.showComparison?.([]);
      current = { ...IDLE, names: current.names, showDeleted: current.showDeleted };
      for (const listener of [...listeners]) listener();
    },
    next() {
      return go(nextIndex(current.index, current.rows.length));
    },
    previous() {
      return go(previousIndex(current.index, current.rows.length));
    },
    setShowDeleted(on) {
      set({ showDeleted: on });
      view()?.showDeletions?.(on);
    },
    close() {
      latest++;
      history.leave();
      current = IDLE;
      for (const listener of [...listeners]) listener();
    },
  };
}
