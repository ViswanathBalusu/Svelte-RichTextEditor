/**
 * The command registry (13 §4; UX-003, UX-004): one instance feeds the toolbars, the header's
 * actions, the context menu, the keyboard shortcuts, `exec()` and `queryCommand()` of the element,
 * and later command search, access keys and extensions.
 *
 * - Entries are validated when they are registered: a duplicate identifier or alias, an unknown
 *   query name, a label that is not a string key or a key already bound fails with an error that
 *   names the entry, and nothing is overwritten.
 * - States are evaluated here and only here: each named query once per evaluation, through the
 *   query sources (the core's document API first). Surfaces read `view` and never evaluate.
 * - A change of any input marks the states dirty; one evaluation runs per frame at most, and only
 *   when something changed is a snapshot published and `onStateChange` told which commands
 *   changed (`de-command-state`, 05 §8.1).
 * - `exec` and `state` evaluate at the moment of the call, so they never act on a stale state.
 */
import type { AccessLimit, AccessSummary, CoreApi, EditorMode } from '../core-api.ts';
import { boundKeys, shellKeys } from '../shortcuts/table.ts';
import { reasonKeyFor } from './access.ts';
import { accessKeyClaim } from './access-keys.ts';
import { canonicalKey, isApplePlatform } from './keys.ts';
import { type Scheduler, frameScheduler } from './schedule.ts';
import {
  CONTENT_CAPABILITIES,
  type CommandEntry,
  CommandRegistrationError,
  type CommandState,
  type CommandView,
  type ExecResult,
  type QuerySource,
  type RegistrySnapshot,
} from './types.ts';

const ID = /^[a-z][A-Za-z0-9-]*(\.[a-z][A-Za-z0-9-]*)+$/;

export interface RegistryOptions {
  core: CoreApi;
  /** Query sources besides the core's (the shell adds its own for pane state). */
  sources?: readonly QuerySource[];
  /** Whether a string key exists; when given, every label must be a known key. */
  hasString?: (key: string) => boolean;
  scheduler?: Scheduler;
  /** A command's `run` threw; the registry reports `no-effect` and carries on. */
  onError?: (id: string, error: unknown) => void;
  /** Whether `Mod` means Meta, for comparing keys; the platform's by default. */
  apple?: boolean;
  /** Keys the shell keeps for itself (landmarks, the context menu); the shortcut table's by default. */
  reservedKeys?: readonly string[];
}

const UNKNOWN: CommandState = {
  offered: false,
  enabled: false,
  active: null,
  reason: 'unknown',
  reasonKey: 'reason.notApplicable',
  limit: null,
};

/** Modes in which nothing that changes content may run (UX-015; 12 §11 for fill). */
const READ_ONLY_MODES: Readonly<Partial<Record<EditorMode, string>>> = {
  view: 'reason.mode.view',
  fill: 'reason.mode.fill',
};

function sameState(a: CommandState, b: CommandState): boolean {
  return (
    a.offered === b.offered &&
    a.enabled === b.enabled &&
    a.active === b.active &&
    a.reason === b.reason &&
    a.reasonKey === b.reasonKey &&
    a.limit === b.limit
  );
}

interface Answer {
  readonly value: boolean | undefined;
  readonly source: QuerySource | null;
}

export class CommandRegistry {
  readonly #core: CoreApi;
  readonly #sources: QuerySource[] = [];
  readonly #sourceUnsubscribers = new Map<QuerySource, () => void>();
  readonly #inputUnsubscribers: Array<() => void> = [];
  readonly #entries = new Map<string, CommandEntry>();
  readonly #aliases = new Map<string, string>();
  /** Canonical key to the identifier of the entry that binds it. */
  readonly #keys = new Map<string, string>();
  /** Access key claims (UX-012): level and key, to the identifier of the entry holding it. */
  readonly #accessKeys = new Map<string, string>();
  readonly #reserved: ReadonlySet<string>;
  readonly #apple: boolean;
  readonly #hasString: ((key: string) => boolean) | undefined;
  readonly #scheduler: Scheduler;
  readonly #onError: ((id: string, error: unknown) => void) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #changeListeners = new Set<(ids: readonly string[]) => void>();
  readonly #changed = new Set<string>();
  #states = new Map<string, CommandState>();
  #snapshot: RegistrySnapshot = { commands: [], version: 0 };
  #dirty = true;
  #structureChanged = false;
  #structure = 0;
  #destroyed = false;

  readonly view: { get(): RegistrySnapshot; subscribe(listener: () => void): () => void };

  constructor(options: RegistryOptions) {
    this.#core = options.core;
    this.#hasString = options.hasString;
    this.#scheduler = options.scheduler ?? frameScheduler();
    this.#onError = options.onError;
    this.#apple = options.apple ?? isApplePlatform();
    this.#reserved = new Set(
      (options.reservedKeys ?? shellKeys())
        .map((k) => canonicalKey(k, this.#apple))
        .filter((k): k is string => k !== null),
    );
    for (const source of options.sources ?? []) this.addSource(source);
    const core = this.#core;
    // `permissions` and `regions` are inputs too: a query such as `hasNextEditableRegion` depends
    // on the rights in other regions, which can change while the caret's access stays the same
    // (`perm.changed`, PRM-027 criterion 4).
    for (const input of [
      core.access,
      core.permissions,
      core.regions,
      core.features,
      core.selection,
      core.panel,
      core.revision,
      core.mode,
    ])
      if (input) this.#inputUnsubscribers.push(input.subscribe(this.#invalidate));
    this.view = {
      get: () => {
        if (this.#dirty) this.#evaluateAll();
        return this.#snapshot;
      },
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
  }

  /** Whether `Mod` means Meta here (the shortcut binder resolves keys the same way). */
  get apple(): boolean {
    return this.#apple;
  }

  /** Increases whenever a command is registered or removed. */
  get structure(): number {
    return this.#structure;
  }

  /** Adds a source of named queries; entries registered later may name its queries. */
  addSource(source: QuerySource): () => void {
    if (this.#sources.includes(source)) return () => this.removeSource(source);
    this.#sources.push(source);
    this.#sourceUnsubscribers.set(source, source.subscribe(this.#invalidate));
    this.#invalidate();
    return () => this.removeSource(source);
  }

  removeSource(source: QuerySource): void {
    const i = this.#sources.indexOf(source);
    if (i < 0) return;
    this.#sources.splice(i, 1);
    this.#sourceUnsubscribers.get(source)?.();
    this.#sourceUnsubscribers.delete(source);
    this.#invalidate();
  }

  /** Every query name some source answers. */
  queryNames(): string[] {
    return [...new Set(this.#sources.flatMap((s) => s.names))];
  }

  /**
   * Whether the core and the sources back an entry: every query it names is known, and the named
   * command it needs is one the core declares. Built-in entries are registered only then.
   */
  backs(entry: CommandEntry): boolean {
    const known = new Set(this.queryNames());
    for (const name of [entry.enabled, entry.active])
      if (name !== undefined && !known.has(name)) return false;
    if (entry.needs !== undefined) {
      const names = this.#core.commandNames;
      if (!names?.includes(entry.needs) || typeof this.#core.runNamed !== 'function') return false;
    }
    return true;
  }

  /**
   * Registers an entry; returns the function that removes it. Throws CommandRegistrationError,
   * naming the entry, for an invalid identifier, a duplicate identifier or alias, an unknown query,
   * a label that is not a string key, or a key another command or the shell already binds.
   */
  register(entry: CommandEntry): () => void {
    const id = typeof entry.id === 'string' ? entry.id : String(entry.id);
    if (!ID.test(id))
      throw new CommandRegistrationError(id, 'the identifier must have the form "area.name"');
    if (this.#entries.has(id) || this.#aliases.has(id))
      throw new CommandRegistrationError(
        id,
        'a command with this identifier is already registered',
      );
    for (const alias of entry.aliases ?? [])
      if (this.#entries.has(alias) || this.#aliases.has(alias))
        throw new CommandRegistrationError(id, `the alias "${alias}" is already registered`);
    const known = new Set(this.queryNames());
    for (const [field, name] of [
      ['enabled', entry.enabled],
      ['active', entry.active],
    ] as const)
      if (name !== undefined && !known.has(name))
        throw new CommandRegistrationError(id, `its ${field} query "${name}" is not a known query`);
    if (typeof entry.label !== 'string' || (this.#hasString && !this.#hasString(entry.label)))
      throw new CommandRegistrationError(
        id,
        `its label "${String(entry.label)}" is not a string key`,
      );
    if (typeof entry.capability !== 'string' || !entry.capability)
      throw new CommandRegistrationError(id, 'it names no capability of the parity profile');
    if (typeof entry.run !== 'function')
      throw new CommandRegistrationError(id, 'it has no run function');
    const keys = this.#canonicalKeys(id, entry);
    const access = accessKeyClaim(id, entry);
    const accessHolder = access === null ? undefined : this.#accessKeys.get(access);
    if (accessHolder !== undefined)
      throw new CommandRegistrationError(
        id,
        `its access key "${entry.accessKey ?? ''}" is already used on its level by "${accessHolder}"; neither binding was changed`,
      );
    this.#entries.set(id, entry);
    for (const alias of entry.aliases ?? []) this.#aliases.set(alias, id);
    for (const key of keys) this.#keys.set(key, id);
    if (access !== null) this.#accessKeys.set(access, id);
    this.#structureChanged = true;
    this.#structure++;
    this.#changed.add(id);
    this.#invalidate();
    return () => this.unregister(id);
  }

  /** The canonical keys an entry binds; throws when one is taken (UX-013 criterion 5). */
  #canonicalKeys(id: string, entry: CommandEntry): string[] {
    const out: string[] = [];
    for (const key of boundKeys(id, entry.keys)) {
      const canonical = canonicalKey(key, this.#apple);
      if (canonical === null)
        throw new CommandRegistrationError(id, `its key "${key}" is not a shortcut`);
      const holder = this.#keys.get(canonical);
      if (holder)
        throw new CommandRegistrationError(
          id,
          `its key "${key}" is already bound to "${holder}"; neither binding was changed`,
        );
      if (this.#reserved.has(canonical))
        throw new CommandRegistrationError(id, `its key "${key}" is kept by the shell`);
      if (!out.includes(canonical)) out.push(canonical);
    }
    return out;
  }

  /** Removes a command; surfaces drop its control at the next publication. */
  unregister(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#entries.delete(id);
    for (const alias of entry.aliases ?? []) this.#aliases.delete(alias);
    for (const [key, holder] of [...this.#keys]) if (holder === id) this.#keys.delete(key);
    for (const [key, holder] of [...this.#accessKeys])
      if (holder === id) this.#accessKeys.delete(key);
    this.#states.delete(id);
    this.#structureChanged = true;
    this.#structure++;
    this.#changed.add(id);
    this.#invalidate();
    return true;
  }

  /** The entry for an identifier or alias. */
  get(idOrAlias: string): CommandEntry | undefined {
    return this.#entries.get(this.#aliases.get(idOrAlias) ?? idOrAlias);
  }

  list(): CommandEntry[] {
    return [...this.#entries.values()];
  }

  /** The command a canonical key is bound to (see `canonicalKey`), if any. */
  commandForKey(canonical: string): string | undefined {
    return this.#keys.get(canonical);
  }

  /** The state of a command, evaluated now (`queryCommand`, 05 §8.1). */
  state(idOrAlias: string): CommandState {
    const entry = this.get(idOrAlias);
    if (!entry) return UNKNOWN;
    return this.#evaluate(entry, this.#queryCache(), this.#core.access?.get(), this.#features());
  }

  /**
   * Runs a command through the same path as every surface (05 §8.1 `exec`). Nothing runs when the
   * command is unknown, not offered or not enabled; the result says why.
   */
  exec(idOrAlias: string, args?: unknown): ExecResult {
    const entry = this.get(idOrAlias);
    if (!entry) return { ran: false, reason: 'unknown' };
    const state = this.state(entry.id);
    if (!state.enabled) return { ran: false, reason: state.reason };
    let done: boolean;
    try {
      done = entry.run({ core: this.#core, args });
    } catch (error) {
      this.#onError?.(entry.id, error);
      done = false;
    }
    this.#invalidate();
    return done ? { ran: true, reason: null } : { ran: false, reason: 'no-effect' };
  }

  /** Listens for the identifiers of commands whose state changed (`de-command-state`). */
  onStateChange(listener: (ids: readonly string[]) => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Re-evaluates at the next opportunity (an input the registry does not observe changed). */
  refresh(): void {
    this.#invalidate();
  }

  destroy(): void {
    this.#destroyed = true;
    for (const off of this.#inputUnsubscribers) off();
    for (const off of this.#sourceUnsubscribers.values()) off();
    this.#inputUnsubscribers.length = 0;
    this.#sourceUnsubscribers.clear();
    this.#listeners.clear();
    this.#changeListeners.clear();
  }

  #invalidate = (): void => {
    if (this.#destroyed) return;
    this.#dirty = true;
    this.#scheduler.request(this.#flush);
  };

  #flush = (): void => {
    if (this.#destroyed) return;
    if (this.#dirty) this.#evaluateAll();
    if (this.#changed.size === 0) return;
    const ids = [...this.#changed];
    this.#changed.clear();
    this.#scheduler.published();
    for (const listener of [...this.#listeners]) listener();
    for (const listener of [...this.#changeListeners]) listener(ids);
  };

  #features(): ReadonlySet<string> {
    return new Set(this.#core.features?.get() ?? []);
  }

  /** Each query is evaluated at most once per evaluation pass, whatever number of entries name it. */
  #queryCache(): (name: string) => Answer {
    const cache = new Map<string, Answer>();
    return (name) => {
      const cached = cache.get(name);
      if (cached) return cached;
      let answer: Answer = { value: undefined, source: null };
      for (const source of this.#sources) {
        if (!source.names.includes(name)) continue;
        const value = source.evaluate(name);
        if (value !== undefined) {
          answer = { value, source };
          break;
        }
      }
      cache.set(name, answer);
      return answer;
    };
  }

  /** The string key that explains a query's false answer: the source's reason, when there is one. */
  #queryReasonKey(name: string, answer: Answer): string {
    const code = answer.source?.reason?.(name);
    if (typeof code === 'string' && /^[A-Za-z][\w-]*$/.test(code)) {
      const key = `reason.query.${code}`;
      if (!this.#hasString || this.#hasString(key)) return key;
    }
    return 'reason.notApplicable';
  }

  #evaluate(
    entry: CommandEntry,
    query: (name: string) => Answer,
    access: AccessSummary | undefined,
    features: ReadonlySet<string>,
  ): CommandState {
    if (
      (entry.feature !== undefined && !features.has(entry.feature)) ||
      (entry.also?.some((f) => !features.has(f)) ?? false)
    )
      return {
        offered: false,
        enabled: false,
        active: null,
        reason: 'unannounced',
        reasonKey: 'reason.unannounced',
        limit: null,
      };
    const active = entry.active === undefined ? null : query(entry.active).value === true;
    if (
      entry.changesContent &&
      access &&
      !access.caps.some((c) => CONTENT_CAPABILITIES.includes(c))
    ) {
      const limit: AccessLimit | null = access.limit ?? null;
      return {
        offered: true,
        enabled: false,
        active,
        reason: 'no-access',
        reasonKey: reasonKeyFor(access),
        limit,
      };
    }
    const mode = this.#core.mode?.get();
    const modeKey = mode === undefined ? undefined : READ_ONLY_MODES[mode];
    if (entry.changesContent && modeKey)
      return {
        offered: true,
        enabled: false,
        active,
        reason: 'mode',
        reasonKey: modeKey,
        limit: null,
      };
    // An unanswered query does not disable a command: running it reports `no-effect` instead.
    if (entry.enabled !== undefined) {
      const answer = query(entry.enabled);
      if (answer.value === false)
        return {
          offered: true,
          enabled: false,
          active,
          reason: 'not-applicable',
          reasonKey: this.#queryReasonKey(entry.enabled, answer),
          limit: null,
        };
    }
    return { offered: true, enabled: true, active, reason: null, reasonKey: null, limit: null };
  }

  #evaluateAll(): void {
    this.#dirty = false;
    const query = this.#queryCache();
    const access = this.#core.access?.get();
    const features = this.#features();
    const next = new Map<string, CommandState>();
    const commands: CommandView[] = [];
    for (const entry of this.#entries.values()) {
      const state = this.#evaluate(entry, query, access, features);
      const previous = this.#states.get(entry.id);
      if (!previous || !sameState(previous, state)) this.#changed.add(entry.id);
      next.set(entry.id, state);
      commands.push({ id: entry.id, entry, ...state });
    }
    this.#states = next;
    if (this.#changed.size === 0 && !this.#structureChanged) return;
    this.#structureChanged = false;
    this.#snapshot = { commands, version: this.#snapshot.version + 1 };
  }
}
