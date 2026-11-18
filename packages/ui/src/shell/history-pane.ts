/**
 * The state of the history pane (HIS-009; 08 §1, §4). The pane reads the host's history port, keeps
 * the filters the user chose, resolves author names through the host's `resolveUsers` (UX-025), and
 * says which state it is in: loading, ready, empty or error. It is plain TypeScript with no Svelte
 * import, so the rules are tested in Node and the component only renders the state.
 *
 * Filtering is done by the service (the port receives the filters); this module only keeps them,
 * asks again when one changes, and drops a reply that arrives after a newer request (a stale reply
 * never replaces a newer list). Erased people (HIS-038) are those the host does not resolve; they
 * show the unknown-person label, and their contributions stay in the list.
 */
import type {
  HistoryChoices,
  HistoryPaneItem,
  HistoryPaneQuery,
  HistoryPort,
  HistoryVersionView,
} from '../core-api.ts';

export type HistoryStatus = 'loading' | 'ready' | 'empty' | 'error';

/** The filters of HIS-009 criterion 2: named versions, one region, one field or one person. */
export interface HistoryFilter {
  readonly namedOnly: boolean;
  readonly region: string | null;
  readonly field: string | null;
  readonly user: string | null;
}

/**
 * The old version the user has opened from the list (HIS-010), if any. `key` names the list item it
 * came from, so the pane can mark it and return focus to it.
 */
export type ViewingState =
  | { readonly status: 'opening'; readonly key: string; readonly seq: number }
  | {
      readonly status: 'open';
      readonly key: string;
      readonly seq: number;
      readonly time: string;
      readonly name: string | null;
      readonly view: HistoryVersionView;
    }
  | {
      readonly status: 'refused';
      readonly key: string;
      readonly seq: number;
      readonly reason: 'forbidden' | 'not_found' | 'failed';
    };

export interface HistoryPaneState {
  readonly status: HistoryStatus;
  /** The version being read, or null. */
  readonly viewing: ViewingState | null;
  readonly filter: HistoryFilter;
  readonly items: readonly HistoryPaneItem[];
  readonly nextCursor: string | null;
  /** True for a reader who sees named versions only (HIS-024); the pane then says why. */
  readonly namedOnly: boolean;
  /**
   * Names by identifier. A null value is a person the host does not resolve (an erased person,
   * HIS-038); the pane shows the unknown-person label for it.
   */
  readonly names: ReadonlyMap<string, string | null>;
  readonly choices: HistoryChoices;
}

export interface HistoryController {
  state(): HistoryPaneState;
  subscribe(listener: () => void): () => void;
  /** Changes some filters and asks the port again; the list narrows to what the service returns. */
  setFilter(patch: Partial<HistoryFilter>): Promise<void>;
  /** Asks for the next page, if the service gave a cursor. */
  loadMore(): Promise<void>;
  /** Asks for the first page again. */
  reload(): Promise<void>;
  /** Opens the state an item stands for, read-only (HIS-010). False when the item cannot be opened. */
  open(item: HistoryPaneItem): Promise<boolean>;
  /** Leaves the version: the state is released and the list shows again. */
  leave(): void;
  /** Releases anything the pane holds (an open version); the pane calls it when it closes. */
  dispose(): void;
}

/** The key of a list item. */
export function itemKey(item: HistoryPaneItem): string {
  return `${item.kind}:${item.id}`;
}

/** The `seq`, time and name that opening an item uses; null when the item has no state to open. */
export function openingOf(
  item: HistoryPaneItem,
): { seq: number; time: string; name: string | null } | null {
  if (item.kind === 'version') return { seq: item.seq, time: item.time, name: item.name };
  return item.toSeq === undefined ? null : { seq: item.toSeq, time: item.to, name: null };
}

export const NO_FILTER: HistoryFilter = { namedOnly: false, region: null, field: null, user: null };

const NO_CHOICES: HistoryChoices = { regions: [], fields: [], people: [] };

/** The filters that are set, by their names, in the order the pane shows them. */
export function activeFilters(
  filter: HistoryFilter,
): readonly ('named' | 'region' | 'field' | 'user')[] {
  const active: ('named' | 'region' | 'field' | 'user')[] = [];
  if (filter.namedOnly) active.push('named');
  if (filter.region !== null) active.push('region');
  if (filter.field !== null) active.push('field');
  if (filter.user !== null) active.push('user');
  return active;
}

/** The label of an author: the resolved name, or the unknown-person label when none is known. */
export function authorLabel(
  id: string,
  names: ReadonlyMap<string, string | null>,
): { readonly known: boolean; readonly name: string | null } {
  const name = names.get(id) ?? null;
  return { known: name !== null, name };
}

function queryOf(filter: HistoryFilter, cursor: string | null): HistoryPaneQuery {
  return {
    namedOnly: filter.namedOnly,
    region: filter.region,
    field: filter.field,
    user: filter.user,
    cursor,
  };
}

function authorIdsOf(items: readonly HistoryPaneItem[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind === 'group') for (const id of item.authors) ids.add(id);
    else ids.add(item.creator);
  }
  return [...ids];
}

/**
 * Creates the controller over a port. The port is read when the pane opens and when a filter or
 * the page changes; the caller decides when to call `reload` first.
 */
export function createHistoryController(port: HistoryPort): HistoryController {
  const listeners = new Set<() => void>();
  let current: HistoryPaneState = {
    status: 'loading',
    viewing: null,
    filter: NO_FILTER,
    items: [],
    nextCursor: null,
    namedOnly: false,
    names: new Map(),
    choices: NO_CHOICES,
  };
  // Each request takes a number; a reply that is not the latest is dropped.
  let latest = 0;

  const set = (patch: Partial<HistoryPaneState>): void => {
    current = { ...current, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function resolve(ids: readonly string[]): Promise<Map<string, string | null>> {
    const found = new Map<string, string | null>();
    const missing = ids.filter((id) => !current.names.has(id));
    if (missing.length === 0) return found;
    if (port.resolveUsers === undefined) {
      for (const id of missing) found.set(id, null);
      return found;
    }
    try {
      const people = await port.resolveUsers(missing);
      missing.forEach((id, index) => {
        found.set(id, people[index]?.name ?? null);
      });
    } catch {
      // A directory that fails leaves the names unknown; the list itself still shows.
      for (const id of missing) found.set(id, null);
    }
    return found;
  }

  const withNames = async (ids: readonly string[]): Promise<void> => {
    const found = await resolve(ids);
    if (found.size === 0) return;
    set({ names: new Map([...current.names, ...found]) });
  };

  const reload = async (): Promise<void> => {
    const mine = ++latest;
    set({ status: 'loading', items: [], nextCursor: null });
    try {
      const page = await port.list(queryOf(current.filter, null));
      if (mine !== latest) return;
      set({
        status: page.items.length === 0 ? 'empty' : 'ready',
        items: page.items,
        nextCursor: page.nextCursor,
        namedOnly: page.namedOnly,
      });
      await withNames(authorIdsOf(page.items));
    } catch {
      if (mine !== latest) return;
      set({ status: 'error', items: [], nextCursor: null });
    }
  };

  const loadMore = async (): Promise<void> => {
    const cursor = current.nextCursor;
    if (cursor === null) return;
    const mine = ++latest;
    try {
      const page = await port.list(queryOf(current.filter, cursor));
      if (mine !== latest) return;
      set({
        status: 'ready',
        items: [...current.items, ...page.items],
        nextCursor: page.nextCursor,
        namedOnly: page.namedOnly,
      });
      await withNames(authorIdsOf(page.items));
    } catch {
      if (mine !== latest) return;
      set({ status: 'error' });
    }
  };

  const setFilter = async (patch: Partial<HistoryFilter>): Promise<void> => {
    set({ filter: { ...current.filter, ...patch } });
    await reload();
  };

  // Each opening takes a number too: leaving, or opening another, makes an earlier reply late.
  let opening = 0;

  const release = (): void => {
    const was = current.viewing;
    if (was?.status === 'open') was.view.close();
  };

  const open = async (item: HistoryPaneItem): Promise<boolean> => {
    const what = openingOf(item);
    if (what === null || port.openVersion === undefined) return false;
    release();
    const mine = ++opening;
    const key = itemKey(item);
    set({ viewing: { status: 'opening', key, seq: what.seq } });
    let result;
    try {
      result = await port.openVersion(what.seq, { time: what.time, name: what.name });
    } catch {
      result = { ok: false as const, reason: 'failed' as const };
    }
    if (mine !== opening) {
      // The user left, or opened another version, while this one was loading.
      if (result.ok) result.view.close();
      return false;
    }
    if (!result.ok) {
      set({ viewing: { status: 'refused', key, seq: what.seq, reason: result.reason } });
      return false;
    }
    set({
      viewing: {
        status: 'open',
        key,
        seq: what.seq,
        time: result.view.time,
        name: result.view.name,
        view: result.view,
      },
    });
    return true;
  };

  const leave = (): void => {
    opening++;
    release();
    if (current.viewing !== null) set({ viewing: null });
  };

  // The choices are read once; a port that fails offers none and the list still works.
  port
    .choices()
    .then((choices) => set({ choices }))
    .catch(() => undefined);

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setFilter,
    loadMore,
    reload,
    open,
    leave,
    dispose() {
      opening++;
      release();
      listeners.clear();
    },
  };
}
