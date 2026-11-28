/**
 * Command entries (13 §4; UX-003). The shape of 13 §4 with the changes ADR 0041 records: `label`
 * is a string key (13 §8: all interface strings are external), `capability` names the row of the
 * parity profile the command delivers (UX-001), `changesContent` lets the registry apply the
 * user's access (UX-004), `feature` hides a command whose backend feature is not announced
 * (05 §1 rule 4), and `aliases` keep the spike's names working in `exec`.
 */
import type { AccessLimit, Capability, CoreApi } from '../core-api.ts';

export interface CommandContext {
  readonly core: CoreApi;
  /** The `args` of `exec(command, args?)` (05 §8.1). */
  readonly args: unknown;
}

export interface CommandEntry {
  /** Stable identifier, `area.name` (for example `format.bold`). */
  readonly id: string;
  /** String key of the label; resolved from the string tables, never shown as written. */
  readonly label: string;
  /** Icon name in the icon set (UX-063); the toolbars and menus draw it beside the label. */
  readonly icon?: string;
  /** Task group, for the full toolbar (UX-007) and for ordering the compact one. */
  readonly group: string;
  /**
   * Shortcuts in the editing core's notation (`Mod-b`). The shell binds them with the alternatives
   * of the shortcut table (`bindShortcuts`, UX-013) and publishes them as `aria-keyshortcuts`; a
   * key the core's own keymap handles first is left to the core. Two entries may not share a key.
   */
  readonly keys?: readonly string[];
  readonly accessKey?: string;
  /** A query that must answer true for the command to be enabled (13 §4); absent: always. */
  readonly enabled?: string;
  /** A query that tells whether the command is active, for toggles (13 §4); absent: no toggle. */
  readonly active?: string;
  /** True when the command changes the document: it then needs `edit` or `suggest` (UX-004). */
  readonly changesContent: boolean;
  /** A backend feature that must be announced for the command to be offered at all. */
  readonly feature?: string;
  /** Further backend features that must all be announced as well (a signature field needs `fields` and `sign`). */
  readonly also?: readonly string[];
  /** The parity-profile row (`spec/parity`) the command delivers (UX-001). */
  readonly capability: string;
  /** Other names `exec` and `state` accept (the spike S1 names). */
  readonly aliases?: readonly string[];
  /**
   * A named command of the core (`CoreApi.commandNames`, run through `runNamed`) that this entry
   * needs. A built-in entry is registered only when the core declares it: the shell offers nothing
   * the core cannot do (ADR 0052).
   */
  readonly needs?: string;
  /** Targets on which the context menu offers the command (UX-008); absent: not in it. */
  readonly contextMenu?: readonly ContextTarget[];
  /**
   * False keeps the command off the toolbars (it is offered elsewhere: the header, the status
   * bar, a pane, or only through `exec` and its keys). Default true.
   */
  readonly toolbar?: boolean;
  /**
   * True: the ribbon's toolbar shows the command although `toolbar` is false, so that the compact and
   * the full toolbars, and their visual baselines, stay as they are (ADR 0490). Default false.
   */
  readonly ribbon?: boolean;
  /**
   * A command that is chosen from a list rather than pressed (ADR 0490): the ribbon draws a menu
   * button for it, and `exec(id, args)` takes the choice. The compact and the full toolbars do not
   * show it (it has `toolbar: false`); the command search and `exec` reach it with its arguments.
   */
  readonly picker?: PickerKind;
  /** Runs the command; false when it did not apply. */
  readonly run: (context: CommandContext) => boolean;
}

/** What a picker chooses: a paragraph style, a font size, a text colour or a highlight. */
export type PickerKind = 'style' | 'fontSize' | 'colour' | 'highlight';

/**
 * What the context menu opened on (UX-008): text, or one of the objects of 13 §3 the selection is
 * in or on (`SelectionSummary.contexts`).
 */
export type ContextTarget = 'text' | 'table' | 'picture' | 'story' | 'field' | 'comment';

/** Why a command is not available. */
export type Unavailable =
  /** No command has this identifier. */
  | 'unknown'
  /** Its backend feature is not announced (05 §8.3: the interface does not show it). */
  | 'unannounced'
  /** The user's access at the selection does not allow it (UX-004). */
  | 'no-access'
  /** It changes content, and the mode in effect is `view` or `fill` (UX-015). */
  | 'mode'
  /** Its `enabled` query answers false. */
  | 'not-applicable'
  /** It was enabled, but running it changed nothing or failed. */
  | 'no-effect';

export interface CommandState {
  /** Shown on surfaces at all (false only for `unknown` and `unannounced`). */
  readonly offered: boolean;
  readonly enabled: boolean;
  /** Null for a command that is not a toggle. */
  readonly active: boolean | null;
  readonly reason: Unavailable | null;
  /** String key of the explanation a surface shows for a disabled command. */
  readonly reasonKey: string | null;
  /** For `no-access`: what limits the user (07 §4). */
  readonly limit: AccessLimit | null;
}

/** A command as a surface sees it: the entry and its current state. */
export interface CommandView extends CommandState {
  readonly id: string;
  readonly entry: CommandEntry;
}

export interface RegistrySnapshot {
  /** Commands in registration order. */
  readonly commands: readonly CommandView[];
  /** Increases with every published change. */
  readonly version: number;
}

/**
 * The result of `exec` (05 §8.1). The shape is proposed in ADR 0041; PRO decides the element's
 * (UX-005, open question).
 */
export interface ExecResult {
  readonly ran: boolean;
  readonly reason: Unavailable | null;
}

/** Answers named queries; notifies when an answer may have changed. */
export interface QuerySource {
  readonly names: readonly string[];
  evaluate(name: string): boolean | undefined;
  /**
   * Why a query answered false, as a reason code; the registry shows `reason.query.<code>` when the
   * string tables have it. Undefined or null: the general "not available here".
   */
  reason?(name: string): string | null | undefined;
  subscribe(listener: () => void): () => void;
}

/** Capabilities that let a user change content (07 §4; suggestion mode turns edits into suggestions). */
export const CONTENT_CAPABILITIES: readonly Capability[] = ['edit', 'suggest'];

export class CommandRegistrationError extends Error {
  readonly entryId: string;

  constructor(entryId: string, message: string) {
    super(`command "${entryId}": ${message}`);
    this.name = 'CommandRegistrationError';
    this.entryId = entryId;
  }
}
