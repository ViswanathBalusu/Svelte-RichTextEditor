/**
 * The assignee search's controller (UX-032 criterion 1; 05 §8.1 `searchPrincipals`; 13 §5).
 *
 * The user types a name in the task field; each typed query asks the host's `searchPrincipals` for
 * people (`kinds: ['user']`, purpose `participant`: the working choice, since 05 does not say which
 * purpose an assignment uses) and only the results of the newest query are shown, as for mentions
 * (`mention-search.ts`). Choosing a result gives the principal identifier to assign. Without a
 * `searchPrincipals` in the host nothing is offered. This is the logic only: the thread view draws
 * the combobox, binds the keys and sends the assignment.
 */
import type { PrincipalInfo, SearchPrincipals } from '../core-api.ts';
import { START_MENTION_SEARCH, acceptResults, issueQuery } from './mention-search.ts';

export interface AssigneeState {
  /** Whether the list is shown. */
  readonly open: boolean;
  readonly results: readonly PrincipalInfo[];
  /** The result the keyboard is on, or null. */
  readonly active: number | null;
}

const CLOSED: AssigneeState = { open: false, results: [], active: null };

export interface AssigneeSearch {
  /** Whether the host can search at all. */
  readonly offered: boolean;
  state(): AssigneeState;
  /** Asks for `text`; resolves to true when its results were shown (false: empty, stale or failed). */
  update(text: string): Promise<boolean>;
  /** Moves the active result by `delta`, wrapping at both ends. */
  move(delta: number): void;
  /** Closes the list without choosing. */
  close(): void;
  /** The principal of result `index` (or the active one), or null; closes the list. */
  choose(index?: number): PrincipalInfo | null;
}

export function createAssigneeSearch(options: {
  readonly docId: string;
  readonly searchPrincipals?: SearchPrincipals | undefined;
  readonly limit?: number | undefined;
}): AssigneeSearch {
  let search = START_MENTION_SEARCH;
  let state: AssigneeState = CLOSED;
  let current = '';

  return {
    offered: options.searchPrincipals !== undefined,
    state: () => state,

    async update(text) {
      const fragment = text.trim();
      current = fragment;
      if (fragment === '' || options.searchPrincipals === undefined) {
        // A newer (empty) query makes any answer still in flight stale.
        search = issueQuery(search).search;
        state = CLOSED;
        return false;
      }
      const issued = issueQuery(search);
      search = issued.search;
      let results: PrincipalInfo[];
      try {
        results = await options.searchPrincipals({
          text: fragment,
          docId: options.docId,
          purpose: 'participant',
          kinds: ['user'],
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
      } catch {
        results = [];
      }
      const decision = acceptResults(search, issued.id);
      search = decision.search;
      if (!decision.show || current !== fragment) return false;
      // A person is a `user:` principal; anything else the host returned is not offered.
      const people = results.filter((r) => /^user:\S+$/.test(r.principal));
      state = { open: true, results: people, active: people.length > 0 ? 0 : null };
      return true;
    },

    move(delta) {
      if (!state.open || state.results.length === 0 || !Number.isInteger(delta)) return;
      const n = state.results.length;
      const next = ((((state.active ?? 0) + delta) % n) + n) % n;
      state = { ...state, active: next };
    },

    close() {
      state = CLOSED;
    },

    choose(index) {
      const at = index ?? state.active;
      if (at === null || !state.open) return null;
      const picked = state.results[at] ?? null;
      if (picked !== null) state = CLOSED;
      return picked;
    },
  };
}
