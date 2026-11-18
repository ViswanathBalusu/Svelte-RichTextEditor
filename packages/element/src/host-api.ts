/**
 * The members of the embedding API that act on the editing core (05 §8.1; PRO-083, PRO-084,
 * PRO-085, FRW-069): `flush`, `getContent`, `exec` and `queryCommand`, and the field members of
 * fill mode (12 §10): `nextField`, `focusField`, `getFieldValues`, `setFieldValue` and
 * `validateFields`. The element's methods forward here,
 * so the logic runs in Node.js tests against the headless core. No DOM and no Svelte.
 *
 * `exec` is the core's `run`, which is the path the built-in toolbar and the shell's shortcuts take
 * (`packages/element/src/editor.ts`, `shell.run`), so a host button and the toolbar behave alike.
 */
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

export interface HostApi {
  /** Resolves when nothing is in flight or queued; rejects at `timeoutMs` (PRO-083, FE-012). */
  flush(opts?: { timeoutMs?: number }): Promise<void>;
  /** The confirmed document with its `seq` (PRO-084). */
  getContent(): Promise<ConfirmedContent>;
  /** The selection as a CDM fragment (PRO-084, FE-027); null when no document is loaded. */
  getSelectionContent(): CdmFragment | null;
  /** Inserts a fragment at the selection through the guards as typing (PRO-084, FE-027). */
  insertContent(fragment: CdmFragment): InsertResult;
  /** Runs a command through the path the toolbar uses; false when it does not apply (PRO-085). */
  exec(command: CommandName, args?: CommandArgs): boolean;
  /** Whether a command is enabled and active for the user's current access (PRO-085). */
  queryCommand(command: CommandName, args?: CommandArgs): CommandState;
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
}

export function hostApi(core: CoreHostApi): HostApi {
  return {
    flush: (opts) => core.flush(opts),
    getContent: async () => core.confirmedContent(),
    getSelectionContent: () => core.getSelectionContent(),
    insertContent: (fragment) => core.insertContent(fragment),
    exec: (command, args) => core.exec(command, args),
    queryCommand: (command, args) => core.queryCommand(command, args),
    nextField: () => core.nextFillableField?.() ?? false,
    focusField: (key) => core.focusFieldByKey?.(key) ?? false,
    getFieldValues: () => core.fieldValues?.() ?? {},
    setFieldValue: (key, value) => core.fillField?.(key, value) ?? Promise.resolve(NOT_LOADED_FILL),
    validateFields: () => core.validateFields?.() ?? [],
  };
}

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
    nextField: () => api()?.nextField() ?? false,
    focusField: (key) => api()?.focusField(key) ?? false,
    getFieldValues: () => api()?.getFieldValues() ?? {},
    setFieldValue: (key, value) =>
      api()?.setFieldValue(key, value) ?? Promise.resolve(NOT_LOADED_FILL),
    validateFields: () => api()?.validateFields() ?? [],
  };
}
