/**
 * The pre-send checklist of the editor's "send for completion" dialog (FRW-028; 12 §6.2, §11).
 * Plain functions, without the DOM: the dialog shows the rows, the link of each failed row and the
 * send control; the strings are external keys (`send.*`), translated by the caller.
 *
 * The four checks and their order are those of the authority's checklist (FRW-027, `sendChecklist`):
 * `required_fields`, `roles`, `rules` and `suggestions`. The input is the failures the authority
 * returned, in its own shape, so this module does not import the authority package (the shell never
 * depends on the services). A check that passes is still listed, marked passed in words with an
 * icon, never by colour alone (FRW-028 criterion 1).
 *
 * Decisions: the link of a failed role check goes to the participants view, where a role is given to a
 * participant; the link of a failed rules check goes to the rules panel with no field named (the
 * authority names the rule problems, not the fields). Both are read from the spec default and are not
 * stated in 12 §6.2 (see the story Notes).
 */

/** The checks, in the order the dialog lists them. */
export const SEND_CHECK_ORDER = ['required_fields', 'roles', 'rules', 'suggestions'] as const;

export type SendCheckId = (typeof SEND_CHECK_ORDER)[number];

/** A failure as the authority reports it (the `SendProblem` of `sendChecklist`). */
export type SendFailure =
  | { readonly code: 'required_field_unassigned'; readonly keys: readonly string[] }
  | { readonly code: 'role_without_participant'; readonly roles: readonly string[] }
  | { readonly code: 'rules_invalid'; readonly problems: readonly unknown[] }
  | { readonly code: 'pending_suggestions'; readonly suggestionIds: readonly (string | null)[] };

/** Where the link of a failed row goes (FRW-028 criterion 2). */
export type CheckTarget =
  | { readonly kind: 'field'; readonly keys: readonly string[] }
  | { readonly kind: 'participants'; readonly roles: readonly string[] }
  | { readonly kind: 'rules' }
  | { readonly kind: 'suggestion'; readonly ids: readonly string[] };

export interface ChecklistRow {
  readonly check: SendCheckId;
  readonly passed: boolean;
  /** `send.check.passed` or `send.check.failed`: the status in words. */
  readonly statusKey: 'send.check.passed' | 'send.check.failed';
  /** `pass` or `fail`: the icon, so that the status is not conveyed by colour alone. */
  readonly icon: 'pass' | 'fail';
  /** The row's label key, `send.check.<check>`. */
  readonly labelKey: string;
  /** How many failures the check has (0 when it passed). */
  readonly count: number;
  /** The names the failures list: field keys, role identifiers or suggestion identifiers. */
  readonly items: readonly string[];
  /** The link to the place that fixes the failure; null when the check passed. */
  readonly target: CheckTarget | null;
}

/** The state of the send control and, when it is off, the reason as a key (FRW-028 criterion 6). */
export interface SendControl {
  readonly enabled: boolean;
  /** Set when the control is off: `send.control.forbidden`, `send.control.not_draft` or `send.control.checks_failed`. */
  readonly reasonKey: string | null;
  /** Whether the control asks for confirmation before it sends (FRW-028 criterion 3). */
  readonly confirm: boolean;
}

/** The checklist rows from the failures the authority reported; the four rows always appear. */
export function checklistRows(failures: readonly SendFailure[]): ChecklistRow[] {
  const byCode = new Map<SendFailure['code'], SendFailure>();
  for (const f of failures) byCode.set(f.code, f);
  return SEND_CHECK_ORDER.map((check) => rowFor(check, byCode));
}

function rowFor(check: SendCheckId, byCode: Map<SendFailure['code'], SendFailure>): ChecklistRow {
  const labelKey = `send.check.${check}`;
  const base = { check, labelKey } as const;
  const failure = byCode.get(CODE_OF[check]);
  if (failure === undefined) {
    return {
      ...base,
      passed: true,
      statusKey: 'send.check.passed',
      icon: 'pass',
      count: 0,
      items: [],
      target: null,
    };
  }
  switch (failure.code) {
    case 'required_field_unassigned':
      return failed(base, failure.keys.length, failure.keys, {
        kind: 'field',
        keys: failure.keys,
      });
    case 'role_without_participant':
      return failed(base, failure.roles.length, failure.roles, {
        kind: 'participants',
        roles: failure.roles,
      });
    case 'rules_invalid':
      return failed(base, failure.problems.length, [], { kind: 'rules' });
    case 'pending_suggestions': {
      const ids = failure.suggestionIds.filter((id): id is string => id !== null);
      // A suggestion with no identifier is still counted, so the row is not reported as passed.
      return failed(base, failure.suggestionIds.length, ids, { kind: 'suggestion', ids });
    }
  }
}

const CODE_OF: Readonly<Record<SendCheckId, SendFailure['code']>> = {
  required_fields: 'required_field_unassigned',
  roles: 'role_without_participant',
  rules: 'rules_invalid',
  suggestions: 'pending_suggestions',
};

function failed(
  base: { check: SendCheckId; labelKey: string },
  count: number,
  items: readonly string[],
  target: CheckTarget,
): ChecklistRow {
  return {
    ...base,
    passed: false,
    statusKey: 'send.check.failed',
    icon: 'fail',
    count,
    items,
    target,
  };
}

/**
 * The send control (FRW-028 criteria 3 and 6). Without `manage` it is off with a reason. A workflow
 * that is not a draft cannot be sent. Otherwise it is on only when every check passed, and it then
 * asks for confirmation.
 */
export function sendControl(
  caller: { readonly manage: boolean },
  state: string,
  rows: readonly ChecklistRow[],
): SendControl {
  if (!caller.manage)
    return { enabled: false, reasonKey: 'send.control.forbidden', confirm: false };
  if (state !== 'draft')
    return { enabled: false, reasonKey: 'send.control.not_draft', confirm: false };
  if (rows.some((r) => !r.passed))
    return { enabled: false, reasonKey: 'send.control.checks_failed', confirm: false };
  return { enabled: true, reasonKey: null, confirm: true };
}

/**
 * The list after the server refused a send that the editor thought valid (FRW-028 criterion 4): the
 * server's verdict replaces the local one, row by row.
 */
export function serverVerdictRows(serverFailures: readonly SendFailure[]): ChecklistRow[] {
  return checklistRows(serverFailures);
}

/**
 * What the live region announces when the result of the checks changes (FRW-028 criterion 5): the
 * number of failed checks, and nothing when the number and the failing checks are the same as before.
 */
export function checklistAnnouncement(
  before: readonly ChecklistRow[] | null,
  after: readonly ChecklistRow[],
): { readonly key: 'send.check.announce'; readonly failed: number } | null {
  const failedAfter = after.filter((r) => !r.passed).map((r) => r.check);
  const failedBefore = (before ?? []).filter((r) => !r.passed).map((r) => r.check);
  if (before !== null && failedAfter.join() === failedBefore.join()) return null;
  return { key: 'send.check.announce', failed: failedAfter.length };
}
