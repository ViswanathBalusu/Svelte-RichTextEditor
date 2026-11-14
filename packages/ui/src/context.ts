/**
 * What the shell's components share (02 §4): the core, the command registry, the translator and
 * the people directory. Plain objects; the reactive reads go through `live()`.
 */
import { getContext, setContext } from 'svelte';
import type { CommandRegistry } from './commands/registry.ts';
import type { CoreApi, SearchPrincipals } from './core-api.ts';
import type { StringKey } from './i18n/en-GB.ts';
import type { Translator } from './i18n/strings.ts';
import type { MessageParams } from './i18n/types.ts';
import type { PeopleDirectory } from './people/directory.ts';
import type { Writable } from 'svelte/store';
import type { LinkedTarget } from './shell/linked-comment.ts';

export interface ShellContext {
  readonly core: CoreApi;
  readonly registry: CommandRegistry;
  readonly people: PeopleDirectory;
  /** The translator in use; reading `current` inside a component tracks locale changes. */
  readonly strings: { readonly current: Translator };
  /** Puts a message in the shell's polite live region (FE-107). */
  readonly announce: (key: StringKey, params?: MessageParams) => void;
  /** Puts a text already built from the string tables in the live region. */
  readonly announceText: (text: string) => void;
  /** The pane host: opens and closes panes, and moves focus into them and back (UX-019). */
  readonly panes: {
    toggle(id: string, options?: { focus?: string }): boolean;
    close(): void;
    isOpen(id: string): boolean;
  };
  /** The host's directory search (05 §8.1 `searchPrincipals`), when the host gives one. */
  readonly searchPrincipals?: SearchPrincipals | undefined;
  /** The document identifier, for `searchPrincipals` (`PrincipalQuery.docId`). */
  readonly docId?: string | undefined;
  /** A prefix for element identifiers, unique per shell, for ARIA references inside the root. */
  readonly idPrefix: string;
  /** A followed comment link, taken by the comments pane (UX-034); null when none is waiting. */
  readonly linkedThread: Writable<LinkedTarget | null>;
}

const KEY = Symbol('docedit-shell');

export function provideShell(context: ShellContext): void {
  setContext(KEY, context);
}

/** The shell's context; undefined outside a shell (a pane used on its own). */
export function useShell(): ShellContext | undefined {
  return getContext<ShellContext | undefined>(KEY);
}
