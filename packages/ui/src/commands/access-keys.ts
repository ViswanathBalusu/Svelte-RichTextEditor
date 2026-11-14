/**
 * Access keys (13 §2, §4, §12; UX-012). A command may name one letter or digit as its `accessKey`.
 * Keys are scoped to a level: the toolbar group the command sits in (the spec default, recorded in
 * the story's Notes). Two commands on one level may not share a key, and the registry reports that
 * when the second one is registered (`CommandRegistry.register`, through `accessKeyClaim`).
 *
 * The activation gesture is not chosen yet (open question), so nothing here binds a key. The
 * functions say which keys a level shows, and what pressing one would run.
 */
import {
  type CommandEntry,
  type CommandState,
  CommandRegistrationError,
  type ExecResult,
  type RegistrySnapshot,
} from './types.ts';

/** The access key of an entry in its normal form (lower case), or null when it has none. */
export function accessKeyOf(id: string, entry: CommandEntry): string | null {
  if (entry.accessKey === undefined) return null;
  const key: unknown = entry.accessKey;
  if (typeof key !== 'string' || [...key].length !== 1 || !/^[\p{L}\p{N}]$/u.test(key))
    throw new CommandRegistrationError(
      id,
      `its access key "${String(key)}" is not one letter or digit`,
    );
  return key.toLowerCase();
}

/** The level an access key belongs to: the command's toolbar group (the spec default). */
export function accessKeyLevel(entry: CommandEntry): string {
  return entry.group;
}

/**
 * The claim an entry makes on its level, as the registry stores it: `level` and `key` together.
 * Null when the entry has no access key. Throws for a key that is not one letter or digit.
 */
export function accessKeyClaim(id: string, entry: CommandEntry): string | null {
  const key = accessKeyOf(id, entry);
  return key === null ? null : `${accessKeyLevel(entry)}\u0000${key}`;
}

/** The commands a level shows access keys for: offered, on the toolbars, and in the level. */
/** What the access keys read from a registry: its snapshot (structural, so no import cycle). */
export interface AccessKeySource {
  readonly view: { get(): RegistrySnapshot };
}

export function accessKeysAt(
  registry: AccessKeySource,
  level: string,
): ReadonlyMap<string, { readonly id: string; readonly enabled: boolean }> {
  const out = new Map<string, { readonly id: string; readonly enabled: boolean }>();
  for (const view of registry.view.get().commands) {
    if (!view.offered || view.entry.toolbar === false) continue;
    if (accessKeyLevel(view.entry) !== level) continue;
    const key = accessKeyOf(view.id, view.entry);
    if (key !== null && !out.has(key)) out.set(key, { id: view.id, enabled: view.enabled });
  }
  return out;
}

export interface AccessKeyResult extends ExecResult {
  /** The command the key names, or null when no shown command has the key. */
  readonly id: string | null;
  /** String key of the reason the command did not run; null when it ran. */
  readonly reasonKey: string | null;
}

/**
 * Presses an access key on a level. A key no shown command has runs nothing. A command the user's
 * permissions or the mode disallow runs nothing either, and the result carries its reason (UX-012
 * criterion 5); `exec` does the refusal, as for every surface.
 */
export function pressAccessKey(
  registry: AccessKeySource & {
    exec(idOrAlias: string, args?: unknown): ExecResult;
    state(idOrAlias: string): CommandState;
  },
  level: string,
  key: string,
): AccessKeyResult {
  const target = accessKeysAt(registry, level).get(key.toLowerCase());
  if (!target)
    return { ran: false, reason: 'unknown', id: null, reasonKey: 'reason.notApplicable' };
  const result = registry.exec(target.id);
  const reasonKey = result.ran ? null : (registry.state(target.id).reasonKey ?? null);
  return { ...result, id: target.id, reasonKey };
}
