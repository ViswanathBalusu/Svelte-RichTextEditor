/**
 * The mention picker's controller (UX-031 criteria 1, 2, 3 and 6; 05 §8.1 `searchPrincipals` and
 * `resolveUsers`; 13 §5).
 *
 * The picker reads the comment text and the caret, finds a mention trigger (`@` at the start of the
 * text or after whitespace, followed by a non-empty name fragment with no whitespace), asks the host's
 * `searchPrincipals`, and keeps the results of the newest query only (criterion 2, `mention-search.ts`).
 * Choosing a result yields the comment body as parts: text, then a mention node that holds the
 * principal identifier and no name (criterion 3). The name for display comes from `resolveUsers`
 * for `user:` principals and from the search results for groups (groups have no `resolveUsers`).
 *
 * This is the logic only. The comment box (`components/CommentBox.svelte`) drives it: it draws the
 * list, binds the keys and announces the results. Without a `searchPrincipals` in the host, nothing
 * is searched and the picker stays closed (criterion 6). Nothing here sends a comment; the post and
 * `dep.comment.mentioned` are the service's.
 */
import type { PrincipalInfo, ResolveUsers, SearchPrincipals, UserInfo } from '../core-api.ts';
import {
  START_MENTION_SEARCH,
  acceptResults,
  issueQuery,
  mentionNode,
  mentionsOffered,
  type MentionNode,
  type MentionSearch,
} from './mention-search.ts';

/** A piece of the comment body: typed text, or a mention node (principal identifier only). */
export type BodyPart = { readonly type: 'text'; readonly text: string } | MentionNode;

/** The `@` trigger found before the caret: where it starts and the name fragment typed after it. */
export interface MentionTrigger {
  readonly start: number;
  readonly fragment: string;
}

const WHITESPACE = /\s/;

/**
 * The mention trigger at the caret, or null. The `@` must start the text or follow whitespace, and
 * the fragment after it must be non-empty and hold no whitespace.
 */
export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !WHITESPACE.test(before.charAt(at - 1))) return null;
  const fragment = before.slice(at + 1);
  if (fragment.length === 0 || WHITESPACE.test(fragment)) return null;
  return { start: at, fragment };
}

export interface PickerOptions {
  readonly docId: string;
  readonly searchPrincipals?: SearchPrincipals | undefined;
  readonly resolveUsers?: ResolveUsers | undefined;
  /** How many results to ask for; the host may give fewer. */
  readonly limit?: number | undefined;
}

export interface PickerState {
  /** Whether the list is shown: a trigger is active and its results have arrived. */
  readonly open: boolean;
  readonly results: readonly PrincipalInfo[];
  /** The result the keyboard is on, or null. */
  readonly active: number | null;
}

export const CLOSED: PickerState = { open: false, results: [], active: null };

export interface MentionPicker {
  /** Whether the host offers mentions at all (criterion 6). */
  readonly offered: boolean;
  /** The state now. */
  state(): PickerState;
  /**
   * Called when the text or the caret changes. With a trigger, issues a query and resolves to true
   * when its results were shown (false when the answer was stale, failed or was not asked for).
   */
  update(text: string, caret: number): Promise<boolean>;
  /** Moves the active result by `delta`, wrapping at both ends. */
  move(delta: number): void;
  /** Closes the list without choosing. */
  close(): void;
  /**
   * Inserts the principal of result `index` (or the active result) in place of the trigger. Returns
   * null when there is nothing to choose.
   */
  choose(
    text: string,
    caret: number,
    index?: number,
  ): { readonly parts: BodyPart[]; readonly caret: number } | null;
  /** The display name of a principal: from the results shown, else from `resolveUsers` for a user. */
  displayName(principal: string): Promise<string | null>;
}

/** The `sub` of a `user:<sub>` principal, or null for any other identifier. */
function userSub(principal: string): string | null {
  return principal.startsWith('user:') && principal.length > 'user:'.length
    ? principal.slice(5)
    : null;
}

/** Body parts for `text` with the trigger replaced by a mention node; empty text parts are dropped. */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  caret: number,
  node: MentionNode,
): { readonly parts: BodyPart[]; readonly caret: number } {
  const parts: BodyPart[] = [];
  const before = text.slice(0, trigger.start);
  const after = text.slice(caret);
  if (before.length > 0) parts.push({ type: 'text', text: before });
  parts.push(node);
  if (after.length > 0) parts.push({ type: 'text', text: after });
  return { parts, caret: trigger.start };
}

/** Builds a picker. The host's functions are optional; without `searchPrincipals` nothing is searched. */
export function createMentionPicker(options: PickerOptions): MentionPicker {
  const offered = mentionsOffered(options.searchPrincipals !== undefined);
  let search: MentionSearch = START_MENTION_SEARCH;
  let state: PickerState = CLOSED;
  let lastTrigger: MentionTrigger | null = null;
  const shownNames = new Map<string, string>();

  return {
    offered,
    state: () => state,

    async update(text, caret) {
      const trigger = offered ? mentionTrigger(text, caret) : null;
      lastTrigger = trigger;
      if (trigger === null || options.searchPrincipals === undefined) {
        state = CLOSED;
        return false;
      }
      const issued = issueQuery(search);
      search = issued.search;
      const query = {
        text: trigger.fragment,
        docId: options.docId,
        purpose: 'mention' as const,
        kinds: ['user', 'group'] as const,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      };
      let results: PrincipalInfo[];
      try {
        results = await options.searchPrincipals(query);
      } catch {
        results = [];
      }
      const decision = acceptResults(search, issued.id);
      search = decision.search;
      if (!decision.show) return false;
      // A newer update may have changed the trigger while this query was in flight; the list
      // belongs to the trigger it was asked for, so it is shown only while that trigger is current.
      if (lastTrigger !== trigger) return false;
      for (const r of results) shownNames.set(r.principal, r.name);
      state = { open: true, results, active: results.length > 0 ? 0 : null };
      return true;
    },

    move(delta) {
      if (!state.open || state.results.length === 0 || !Number.isInteger(delta)) return;
      const n = state.results.length;
      const current = state.active ?? 0;
      const next = (((current + delta) % n) + n) % n;
      state = { ...state, active: next };
    },

    close() {
      state = CLOSED;
    },

    choose(text, caret, index) {
      const at = index ?? state.active;
      if (at === null || !state.open) return null;
      const picked = state.results[at];
      if (picked === undefined) return null;
      const node = mentionNode(picked.principal);
      if (node === null) return null;
      const trigger = mentionTrigger(text, caret);
      if (trigger === null) return null;
      state = CLOSED;
      return insertMention(text, trigger, caret, node);
    },

    async displayName(principal) {
      const known = shownNames.get(principal);
      if (known !== undefined) return known;
      const sub = userSub(principal);
      if (sub === null || options.resolveUsers === undefined) return null;
      const found: ReadonlyArray<UserInfo | null> = await options.resolveUsers([sub]);
      return found[0]?.name ?? null;
    },
  };
}
