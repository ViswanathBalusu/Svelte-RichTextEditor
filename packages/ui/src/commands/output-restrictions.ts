/**
 * Output restrictions in the editor (UX-040; 13 §5, §12; 05 §3.1 `restrict`, §5.5; 07 §12).
 *
 * `no-export`, `no-copy` and `no-print` in the access object refuse three kinds of output action.
 * This module is the one rule that says which action a restriction refuses and why. It creates no
 * side effect: it does not copy, print or export anything, and it does not prevent a DOM event.
 *
 * - `outputDecision` answers for one action (export, print, copy, cut or drag) with the reason
 *   code, so that a control can show the reason next to the disabled command (criterion 1 and 3).
 * - `commandOutputAction` says which registry commands are output actions. Every other command, and
 *   every feature of the document that is not output (comments, navigation, viewing), is allowed
 *   whatever the restrictions are (criterion 6).
 * - The list is read at each call. A caller that holds the current restrictions gets the new answer
 *   as soon as the list changes; no decision is cached here (criterion 4, the caller's to wire).
 *
 * Not built here, and left open in UX-040: the copy, cut and drag prevention on the editing surface
 * (criterion 2), the call sites of `print()` and the export command, the direct refusal by the
 * service (criterion 1, the control plane's), and the help text (criterion 5). Restrictions deter
 * casual copying and are not a security boundary; this module says nothing that suggests otherwise.
 */

/** The restriction names of 05 §3.1, as they appear in `AccessObject.restrictions`. */
export const NO_EXPORT = 'no-export';
export const NO_COPY = 'no-copy';
export const NO_PRINT = 'no-print';

export type RestrictionReason = typeof NO_EXPORT | typeof NO_COPY | typeof NO_PRINT;

/** The output actions a restriction can refuse. */
export type OutputAction = 'export' | 'print' | 'copy' | 'cut' | 'drag';

export type OutputDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: RestrictionReason };

const REASON_OF: Readonly<Record<OutputAction, RestrictionReason>> = {
  export: NO_EXPORT,
  print: NO_PRINT,
  copy: NO_COPY,
  cut: NO_COPY,
  drag: NO_COPY,
};

/** The registry command ids that export or print. Other ids are not output actions. */
const OUTPUT_COMMANDS: Readonly<Record<string, OutputAction>> = {
  'document.export': 'export',
  'document.print': 'print',
};

/**
 * Whether an output action is allowed under the given restrictions. The reason is the restriction
 * that refuses it, so that the caller can tell the user why (UX-040 criterion 1 and 3).
 */
export function outputDecision(
  action: OutputAction,
  restrictions: readonly string[],
): OutputDecision {
  const reason = REASON_OF[action];
  if (restrictions.includes(reason)) return { allowed: false, reason };
  return { allowed: true };
}

/** The output action a registry command performs, or null when it is not an output action. */
export function commandOutputAction(commandId: string): OutputAction | null {
  return Object.prototype.hasOwnProperty.call(OUTPUT_COMMANDS, commandId)
    ? (OUTPUT_COMMANDS[commandId] ?? null)
    : null;
}

/**
 * The decision for a registry command under the restrictions. A command that is not an output
 * action is always allowed (UX-040 criterion 6).
 */
export function commandDecision(
  commandId: string,
  restrictions: readonly string[],
): OutputDecision {
  const action = commandOutputAction(commandId);
  if (action === null) return { allowed: true };
  return outputDecision(action, restrictions);
}
