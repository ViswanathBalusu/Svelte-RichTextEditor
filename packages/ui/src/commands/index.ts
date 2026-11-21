/**
 * The command system (13 §4; UX-003, UX-004, UX-013). The element creates one registry with
 * `createCommandRegistry(core)`, passes it to the shell (`registry` prop), and answers `exec()` and
 * `queryCommand()` from the same instance; `bindCommandStateEvent` raises `de-command-state` from
 * it. The shell binds the registry's keys itself (`bindShortcuts`), on the shadow root it is
 * mounted in.
 */
import type { CoreApi } from '../core-api.ts';
import { dispatchDocEvent } from '../de-event.ts';
import { SOURCE_TABLE } from '../i18n/source.ts';
import { coreCommands } from './builtin.ts';
import { coreQuerySource, fieldInsertSource, markRegionSource } from './queries.ts';
import { CommandRegistry, type RegistryOptions } from './registry.ts';

export { CommandRegistry, type RegistryOptions } from './registry.ts';
export {
  coreQuerySource,
  fieldInsertBlock,
  fieldInsertSource,
  markRegionSource,
  regionMarkBlock,
  ShellQueries,
  CORE_QUERY_NAMES,
  CORE_QUERY_NAMES_1B,
} from './queries.ts';
export {
  builtinCommands,
  coreCommands,
  shellCommands,
  shellCommands1b,
  CONTEXT_GROUPS,
  FIELD_KINDS,
  GROUP_ORDER,
  HEADER_GROUP,
  SHELL_QUERY_NAMES,
  type ShellCommandHost,
  type ShellCommandHost1b,
} from './builtin.ts';
export { frameScheduler, immediateScheduler, type Scheduler } from './schedule.ts';
export { accessChangeAnnouncement, canChangeContent, reasonKeyFor } from './access.ts';
export {
  accessKeyClaim,
  accessKeyLevel,
  accessKeyOf,
  accessKeysAt,
  pressAccessKey,
  type AccessKeyResult,
} from './access-keys.ts';
export { MINI_TOOLBAR_GROUPS, miniToolbarItems } from './mini-toolbar.ts';
export {
  activateFirstHit,
  normaliseQuery,
  runSearchHit,
  searchCommands,
  synonymsFromStrings,
  type CommandSearchHit,
  type CommandSearchOptions,
  type CommandSearchResults,
  type SearchTranslator,
  type SynonymSource,
} from './search.ts';
export { bindShortcuts, type ShortcutOptions } from './shortcuts.ts';
export { ariaShortcut, ariaShortcuts, canonicalKey, eventKey, isApplePlatform } from './keys.ts';
export * from './types.ts';

/**
 * A registry with the core's query source and the built-in core commands the core backs: those of
 * phase 1a always, those of phase 1b once the core declares the queries and named commands they
 * need (ADR 0052). The field palette's source comes first, so that its rules (no field in a
 * header, footer or footnote; `edit` needed) hold whatever the core answers (FRW-072).
 */
export function createCommandRegistry(
  core: CoreApi,
  options: Omit<RegistryOptions, 'core'> = {},
): CommandRegistry {
  const registry = new CommandRegistry({
    hasString: (key) => Object.hasOwn(SOURCE_TABLE, key),
    ...options,
    core,
    sources: [
      fieldInsertSource(core),
      markRegionSource(core),
      coreQuerySource(core),
      ...(options.sources ?? []),
    ],
  });
  for (const entry of coreCommands()) if (registry.backs(entry)) registry.register(entry);
  return registry;
}

/**
 * Dispatches `de-command-state` on `target` whenever command states change (05 §8.1): a composed,
 * bubbling CustomEvent whose `detail.commands` lists the identifiers that changed, never content.
 * Returns the function that stops it.
 */
export function bindCommandStateEvent(registry: CommandRegistry, target: EventTarget): () => void {
  return registry.onStateChange((ids) => {
    dispatchDocEvent(target, 'de-command-state', { commands: [...ids] });
  });
}
