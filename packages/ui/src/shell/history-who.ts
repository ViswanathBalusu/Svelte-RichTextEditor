/**
 * "Who wrote this" in the history pane (HIS-015; 08 §1, §7). The user asks about the open version, for
 * the whole body, a region or the passage selected in the version; the host answers from the
 * attribution map at that version, limited by the gate, and the pane lists the authors with the times
 * of their runs, in words (no colour carries the answer). A person the host does not resolve, such as
 * an erased person (HIS-038), shows the unknown-person label. No Svelte import: the rules are tested
 * in Node.
 */
import type { HistoryAuthorLine, HistoryPort } from '../core-api.ts';
import type { HistoryController } from './history-pane.ts';

/** What the user asked about. */
export type WhoScope =
  | { readonly kind: 'document' }
  | { readonly kind: 'selection' }
  | { readonly kind: 'region'; readonly id: string };

/** 
othing: a passage was asked for and nothing is selected in the version. */
export type WhoStatus = 'idle' | 'loading' | 'ready' | 'refused' | 'nothing';

export interface WhoState {
  readonly status: WhoStatus;
  readonly reason: 'forbidden' | 'not_found' | 'failed' | null;
  /** The version the answer is about. */
  readonly seq: number | null;
  readonly authors: readonly HistoryAuthorLine[];
  /** Names by identifier; null for a person the host does not resolve. */
  readonly names: ReadonlyMap<string, string | null>;
}

export interface WhoController {
  state(): WhoState;
  subscribe(listener: () => void): () => void;
  /** Asks about the open version. False when no version is open or the host cannot answer. */
  ask(scope: WhoScope): Promise<boolean>;
  /** Clears the answer (the version was left, or another opened). */
  clear(): void;
}

const IDLE: WhoState = {
  status: 'idle',
  reason: null,
  seq: null,
  authors: [],
  names: new Map(),
};

/** The people an answer names, including those who restored text, for the directory lookup. */
export function whoUsers(authors: readonly HistoryAuthorLine[]): string[] {
  const seen = new Set<string>();
  for (const a of authors) {
    seen.add(a.user);
    if (a.restoredBy !== undefined) seen.add(a.restoredBy);
  }
  return [...seen];
}

/** Authors in the order of their first run: earliest first, ties by name of the user identifier. */
export function orderAuthors(authors: readonly HistoryAuthorLine[]): HistoryAuthorLine[] {
  return [...authors].sort(
    (a, b) => a.firstTime.localeCompare(b.firstTime) || a.user.localeCompare(b.user),
  );
}

export function createWhoController(
  port: HistoryPort,
  history: Pick<HistoryController, 'state'>,
): WhoController {
  const listeners = new Set<() => void>();
  let current: WhoState = IDLE;
  let latest = 0;
  const set = (patch: Partial<WhoState>): void => {
    current = { ...current, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function resolve(ids: readonly string[]): Promise<void> {
    const missing = ids.filter((id) => !current.names.has(id));
    if (missing.length === 0) return;
    const found = new Map<string, string | null>();
    if (port.resolveUsers === undefined) for (const id of missing) found.set(id, null);
    else {
      try {
        const people = await port.resolveUsers([...missing]);
        missing.forEach((id, i) => found.set(id, people[i]?.name ?? null));
      } catch {
        for (const id of missing) found.set(id, null);
      }
    }
    set({ names: new Map([...current.names, ...found]) });
  }

  return {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async ask(scope) {
      const viewing = history.state().viewing;
      if (port.whoWrote === undefined || viewing?.status !== 'open') return false;
      const mine = ++latest;
      const blocks = scope.kind === 'selection' ? (viewing.view.selectedBlocks?.() ?? []) : null;
      if (blocks !== null && blocks.length === 0) {
        set({ status: 'nothing', reason: null, seq: viewing.seq, authors: [] });
        return false;
      }
      set({ status: 'loading', reason: null, seq: viewing.seq, authors: [] });
      let result;
      try {
        result = await port.whoWrote({
          seq: viewing.seq,
          region: scope.kind === 'region' ? scope.id : null,
          blocks,
        });
      } catch {
        result = { ok: false as const, reason: 'failed' as const };
      }
      if (mine !== latest) return false;
      if (!result.ok) {
        set({ status: 'refused', reason: result.reason });
        return false;
      }
      set({
        status: 'ready',
        reason: null,
        seq: result.seq,
        authors: orderAuthors(result.authors),
      });
      await resolve(whoUsers(result.authors));
      return true;
    },
    clear() {
      latest++;
      current = { ...IDLE, names: current.names };
      for (const listener of [...listeners]) listener();
    },
  };
}
