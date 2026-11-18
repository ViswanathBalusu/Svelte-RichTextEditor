/**
 * The members of the embedding API that act on the editing core (05 §8.1; PRO-083, PRO-084,
 * PRO-085): `flush`, `getContent`, `exec` and `queryCommand`. The element's methods forward here,
 * so the logic runs in Node.js tests against the headless core. No DOM and no Svelte.
 *
 * `exec` and `queryCommand` take the identifiers of the shell's command registry (`format.bold`,
 * 13 §4; UX-005) and answer from the same registry the built-in toolbar reads, so a host button and
 * the toolbar agree on enabled and active and pass the same guards. A name the registry does not
 * know falls to the core (`bold`, `insertField`), and a name neither knows runs nothing and says so.
 */
import type {
  CdmEnvelope,
  CdmFragment,
  CommandArgs,
  CommandName,
  CommandState,
  DocumentApi,
  InsertResult,
} from '@docedit/engine/headless';

/** The core members this layer forwards to. A `DocumentCore` or `EditorCore` provides them. */
export type CoreHostApi = Pick<
  DocumentApi,
  'flush' | 'exec' | 'queryCommand' | 'confirmedContent' | 'getSelectionContent' | 'insertContent'
>;

/** The confirmed document (04 §7) as `getContent()` resolves it (PRO-084). */
export type ConfirmedContent = CdmEnvelope & { seq: number };

/** The part of ui's command registry this layer reads: the state of a command and running it. */
export interface HostRegistry {
  get(idOrAlias: string): unknown;
  state(idOrAlias: string): { readonly enabled: boolean; readonly active: boolean | null };
  exec(idOrAlias: string, args?: unknown): { readonly ran: boolean };
}

export interface HostApi {
  /** Resolves when nothing is in flight or queued; rejects at `timeoutMs` (PRO-083, FE-012). */
  flush(opts?: { timeoutMs?: number }): Promise<void>;
  /** The confirmed document with its `seq` (PRO-084). */
  getContent(): Promise<ConfirmedContent>;
  /** The selection as a CDM fragment (PRO-084, FE-027); null when no document is loaded. */
  getSelectionContent(): CdmFragment | null;
  /** Inserts a fragment at the selection through the guards as typing (PRO-084, FE-027). */
  insertContent(fragment: CdmFragment): InsertResult;
  /**
   * Runs a command through the path the toolbar uses; false when nothing ran: the command is
   * unknown, not enabled for this user and mode, or had no effect (PRO-085, UX-005).
   */
  exec(command: CommandName | (string & {}), args?: CommandArgs): boolean;
  /** Whether a command is enabled and active for the user's current access (PRO-085, UX-005). */
  queryCommand(command: CommandName | (string & {}), args?: CommandArgs): CommandState;
}

/** Never offered, never enabled: what an unknown identifier reports. */
export const UNKNOWN_COMMAND: CommandState = { enabled: false, active: false };

/**
 * The members that act on the core. With a `registry`, an identifier it knows is answered from it
 * (UX-005); any other name goes to the core, which throws for one it does not know, and that is
 * reported as nothing run (`exec`) or a command that is not enabled (`queryCommand`).
 */
export function hostApi(core: CoreHostApi, registry?: HostRegistry): HostApi {
  return {
    flush: (opts) => core.flush(opts),
    getContent: async () => core.confirmedContent(),
    getSelectionContent: () => core.getSelectionContent(),
    insertContent: (fragment) => core.insertContent(fragment),
    exec: (command, args) => {
      if (registry?.get(command) !== undefined) return registry.exec(command, args).ran;
      try {
        return core.exec(command as CommandName, args);
      } catch {
        return false;
      }
    },
    queryCommand: (command, args) => {
      if (registry?.get(command) !== undefined) {
        const state = registry.state(command);
        return { enabled: state.enabled, active: state.active === true };
      }
      try {
        return core.queryCommand(command as CommandName, args);
      } catch {
        return UNKNOWN_COMMAND;
      }
    },
  };
}

/** What `insertContent` answers when no document is loaded: nothing is inserted (PRO-084). */
export const NOT_LOADED_INSERT: InsertResult = {
  ok: false,
  reason: 'refused',
  message: 'no document is loaded',
};

/** What the element answers when no document is loaded (PRO-085: nothing applies). */
export const NOT_LOADED_COMMAND: CommandState = { enabled: false, active: false };

/** The part of a session the element's methods read: its mounted editor, if any. */
export interface MountedSession {
  readonly editor: { readonly api?: HostApi } | null;
}

/**
 * The element's methods (05 §8.1) over the session it holds now. `DocEditorElement.flush`,
 * `getContent`, `exec` and `queryCommand` are one line each over this, so the whole path from the
 * element to the core (session, mounted editor, its `api`) runs in Node.js tests. With no session,
 * no mounted editor or an editor without `api`: `flush` resolves (nothing can be unconfirmed),
 * `getContent` rejects, `exec` answers false and `queryCommand` disabled and inactive.
 */
export function elementMethods(current: () => MountedSession | null): HostApi {
  const api = () => current()?.editor?.api ?? null;
  return {
    flush: (opts) => api()?.flush(opts) ?? Promise.resolve(),
    getContent: () => {
      const a = api();
      return a ? a.getContent() : Promise.reject(new Error('no document is loaded'));
    },
    getSelectionContent: () => api()?.getSelectionContent() ?? null,
    insertContent: (fragment) => api()?.insertContent(fragment) ?? NOT_LOADED_INSERT,
    exec: (command, args) => api()?.exec(command, args) ?? false,
    queryCommand: (command, args) => api()?.queryCommand(command, args) ?? NOT_LOADED_COMMAND,
  };
}
