/**
 * The members of the embedding API that act on the editing core (05 §8.1; PRO-083, PRO-084,
 * PRO-085, FRW-069): `flush`, `getContent`, `exec` and `queryCommand`, and the field members of
 * fill mode (12 §10): `nextField`, `focusField`, `getFieldValues`, `setFieldValue` and
 * `validateFields`. The element's methods forward here,
 * so the logic runs in Node.js tests against the headless core. No DOM and no Svelte.
 *
 * `exec` and `queryCommand` take the identifiers of the shell's command registry (`format.bold`,
 * 13 §4; UX-005) and answer from the same registry the built-in toolbar reads, so a host button and
 * the toolbar agree on enabled and active and pass the same guards. A name the registry does not
 * know falls to the core (`bold`, `insertField`), and a name neither knows runs nothing and says so.
 */
import { FillActionError, type CompleteFillingOutcome, type FillActions } from './fill-actions.ts';
import type {
  CdmEnvelope,
  CdmFragment,
  CommandArgs,
  CommandName,
  CommandState,
  DocumentApi,
  FieldFillOutcome,
  FieldReport,
  FieldsApi,
  InsertResult,
} from '@docedit/engine/headless';

/** The core members this layer forwards to. A `DocumentCore` or `EditorCore` provides them. */
export type CoreHostApi = Pick<
  DocumentApi,
  'flush' | 'exec' | 'queryCommand' | 'confirmedContent' | 'getSelectionContent' | 'insertContent'
> &
  Partial<FieldsApi>;

export type { FieldFillOutcome, FieldReport };

/** The confirmed document (04 §7) as `getContent()` resolves it (PRO-084). */
export type ConfirmedContent = CdmEnvelope & { seq: number };

/** The part of ui's command registry this layer reads: the state of a command and running it. */
export interface HostRegistry {
  get(idOrAlias: string): unknown;
  state(idOrAlias: string): { readonly enabled: boolean; readonly active: boolean | null };
  exec(
    idOrAlias: string,
    args?: unknown,
  ): { readonly ran: boolean; readonly reason?: string | null };
}

/**
 * Why `exec` ran nothing, as a code (never a message, never content). `unknown`: no command has the
 * name (a name of the registry's form, `area.name`, that the registry lacks; the core does not say
 * which of its own names it knows, so a core name it does not know is `not-applicable`). `unannounced`: the backend does not announce the feature the command needs. `no-access`: the
 * user's access does not allow it. `mode`: it changes content and the mode in effect is `view` or
 * `fill`. `not-applicable`: it is not available at the selection. `no-effect`: it was enabled and
 * changed nothing, or failed. `not-loaded`: no document is loaded. The first six are the command
 * registry's own (ui `Unavailable`).
 */
export type ExecReason =
  'unknown' | 'unannounced' | 'no-access' | 'mode' | 'not-applicable' | 'no-effect' | 'not-loaded';

/**
 * What `exec` answers (05 §8.1; owner decision 188 in docs/owner-decisions-2026-11-15.md: `{ ok, reason }`,
 * not a boolean). `reason` is null when `ok` is true.
 */
export type ExecOutcome =
  | { readonly ok: true; readonly reason: null }
  | { readonly ok: false; readonly reason: ExecReason };

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
   * Runs a command through the path the toolbar uses. `ok` is false when nothing ran: the command is
   * unknown, not enabled for this user and mode, or had no effect, and `reason` says which
   * (PRO-085, UX-005; decision 188).
   */
  exec(command: CommandName | (string & {}), args?: CommandArgs): ExecOutcome;
  /** Whether a command is enabled and active for the user's current access (PRO-085, UX-005). */
  queryCommand(command: CommandName | (string & {}), args?: CommandArgs): CommandState;
  /** Moves focus to the next field the user may fill; false when no field took focus (FRW-069). */
  nextField(): boolean;
  /** Moves focus to the field with `key`; false, and no error, for a key no field has (FRW-069). */
  focusField(key: string): boolean;
  /** The values of the form fields by key, as the document holds them now (FRW-069). */
  getFieldValues(): Record<string, unknown>;
  /** Fills the field with `key` as the current user; resolves with the outcome, never throws (FRW-069). */
  setFieldValue(key: string, value: unknown): Promise<FieldFillOutcome>;
  /** The fields that are required and empty or invalid, with keys and reasons; changes nothing (FRW-069). */
  validateFields(): FieldReport[];
  /**
   * Validates the fields and, when none fails, completes this participant's part (FRW-071). With a
   * failure it focuses the first problem and resolves with the failures, calling nothing. Rejects
   * with a `FillActionError` when the participant is not active.
   */
  completeFilling(): Promise<CompleteFillingOutcome>;
  /** Declines the workflow as this participant; rejects without calling the server for no reason (FRW-071). */
  decline(reason: string): Promise<unknown>;
}

const OK: ExecOutcome = { ok: true, reason: null };

const refused = (reason: ExecReason): ExecOutcome => ({ ok: false, reason });

const REASONS: readonly string[] = [
  'unknown',
  'unannounced',
  'no-access',
  'mode',
  'not-applicable',
  'no-effect',
];

/** The registry's result as the host sees it: a code from the list, never free text. */
function outcomeOf(result: {
  readonly ran: boolean;
  readonly reason?: string | null;
}): ExecOutcome {
  if (result.ran) return OK;
  const reason = result.reason ?? 'no-effect';
  return refused(REASONS.includes(reason) ? (reason as ExecReason) : 'no-effect');
}

function coreEnabled(core: CoreHostApi, command: string, args: CommandArgs | undefined): boolean {
  try {
    return core.queryCommand(command as CommandName, args).enabled;
  } catch {
    return false;
  }
}

/** What `exec` answers when no document is loaded: nothing ran. */
export const NOT_LOADED_EXEC: ExecOutcome = { ok: false, reason: 'not-loaded' };

/** Never offered, never enabled: what an unknown identifier reports. */
export const UNKNOWN_COMMAND: CommandState = { enabled: false, active: false };

/**
 * The members that act on the core. With a `registry`, an identifier it knows is answered from it
 * (UX-005); any other name goes to the core, which throws for one it does not know, and that is
 * reported as nothing run (`exec`) or a command that is not enabled (`queryCommand`).
 */
export function hostApi(
  core: CoreHostApi,
  registry?: HostRegistry,
  actions?: Pick<FillActions, 'completeFilling' | 'decline'>,
): HostApi {
  return {
    flush: (opts) => core.flush(opts),
    getContent: async () => core.confirmedContent(),
    getSelectionContent: () => core.getSelectionContent(),
    insertContent: (fragment) => core.insertContent(fragment),
    exec: (command, args) => {
      if (registry?.get(command) !== undefined) return outcomeOf(registry.exec(command, args));
      // An identifier of the registry's form (`area.name`) that the registry does not have is unknown.
      // The core's own names have no dot, and the core does not say which names it knows.
      if (command.includes('.')) return refused('unknown');
      try {
        if (core.exec(command as CommandName, args)) return OK;
      } catch {
        return refused('unknown');
      }
      // The core says only false. Whether the command was enabled tells a refusal from no effect.
      return refused(coreEnabled(core, command, args) ? 'no-effect' : 'not-applicable');
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
    nextField: () => core.nextFillableField?.() ?? false,
    focusField: (key) => core.focusFieldByKey?.(key) ?? false,
    getFieldValues: () => core.fieldValues?.() ?? {},
    setFieldValue: (key, value) => core.fillField?.(key, value) ?? Promise.resolve(NOT_LOADED_FILL),
    validateFields: () => core.validateFields?.() ?? [],
    completeFilling: () =>
      actions?.completeFilling() ?? Promise.reject(new FillActionError('no_workflow', NO_WORKFLOW)),
    decline: (reason) =>
      actions?.decline(reason) ?? Promise.reject(new FillActionError('no_workflow', NO_WORKFLOW)),
  };
}

const NO_WORKFLOW = 'this document has no workflow to complete or decline';

/** What `setFieldValue` answers when no document is loaded: nothing is filled (FRW-069). */
export const NOT_LOADED_FILL: FieldFillOutcome = {
  ok: false,
  code: 'unavailable',
  message: 'no document is loaded',
};

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
 * `getContent` rejects, `exec` answers `not-loaded` and `queryCommand` disabled and inactive.
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
    exec: (command, args) => api()?.exec(command, args) ?? NOT_LOADED_EXEC,
    queryCommand: (command, args) => api()?.queryCommand(command, args) ?? NOT_LOADED_COMMAND,
    nextField: () => api()?.nextField() ?? false,
    focusField: (key) => api()?.focusField(key) ?? false,
    getFieldValues: () => api()?.getFieldValues() ?? {},
    setFieldValue: (key, value) =>
      api()?.setFieldValue(key, value) ?? Promise.resolve(NOT_LOADED_FILL),
    validateFields: () => api()?.validateFields() ?? [],
    completeFilling: () =>
      api()?.completeFilling() ??
      Promise.reject(new FillActionError('no_document', 'no document is loaded')),
    decline: (reason) =>
      api()?.decline(reason) ??
      Promise.reject(new FillActionError('no_document', 'no document is loaded')),
  };
}
