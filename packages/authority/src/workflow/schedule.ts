/**
 * The deadline, the reminder schedule and the manual `remind` action of a workflow (12 §6.1, §6.2;
 * FRW-034 criteria 1 to 6, the state and timing parts). Pure functions over the workflow record and
 * over instants in milliseconds since the Unix epoch.
 *
 * Not built here: the scheduler that calls these functions, the control commit of the expiry, the
 * `expired` and `reminder_due` webhooks (FRW-030, FRW-036), the store that keeps the count of raised
 * reminders, and the server clock. The caller supplies `nowMs`.
 *
 * Decisions taken where 12 is silent are recorded in docs/adr/0249-lane-FRW-027-039.md:
 * - the deadline is read as UTC. A value with a `Z` suffix, or with no suffix, is read as UTC. Any
 *   other offset is refused, because a silent local-time reading is the usual fault of this kind;
 * - reminders are raised only in `sent` and `in_progress` (the states of the deadline in 12 §6.2);
 *   `correcting` is not decided by 12, so no reminder is raised there;
 * - the anchor of `firstAfterDays` is passed by the caller (the send or the participant's activation).
 *   12 does not say which, so this module takes no default.
 */
import type { Caller, Refusal, WorkflowRecord, WorkflowStateName } from './lifecycle.ts';
import { activeParticipantIds, mustAct } from './order.ts';

export const DAY_MS = 86_400_000;

/** The reminder timers of 12 §6.1 (`reminders`): the first after this many days, then every N days. */
export interface ReminderPolicy {
  /** Whole days from the anchor to the first reminder; zero or more. */
  readonly firstAfterDays: number;
  /** Whole days between later reminders; one or more. */
  readonly everyDays: number;
}

/** Whether a policy is usable: whole, non-negative `firstAfterDays` and whole, positive `everyDays`. */
export function isReminderPolicy(policy: ReminderPolicy): boolean {
  return (
    Number.isSafeInteger(policy.firstAfterDays) &&
    policy.firstAfterDays >= 0 &&
    Number.isSafeInteger(policy.everyDays) &&
    policy.everyDays >= 1
  );
}

/** The states in which the deadline applies and reminders are raised (12 §6.2). */
const RUNNING_STATES: ReadonlySet<WorkflowStateName> = new Set<WorkflowStateName>([
  'sent',
  'in_progress',
]);

/** Whether the workflow is running, so that its deadline and reminders apply. */
export function isRunning(state: WorkflowStateName): boolean {
  return RUNNING_STATES.has(state);
}

const DEADLINE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z)?$/;

/**
 * The instant of a deadline written as an ISO 8601 date and time, read as UTC, in milliseconds since
 * the epoch; null when the text is not such a value. A calendar value that does not exist (30 February,
 * hour 24, a leap second) is refused. The result does not depend on the time zone of the process.
 */
export function parseDeadline(text: string): number | null {
  const match = DEADLINE_PATTERN.exec(text);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s, frac] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  const millisecond = frac === undefined ? 0 : Number(frac.padEnd(3, '0'));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

/** Whether the deadline has passed at `nowMs`: the instant is reached when `nowMs` is not before it. */
export function deadlinePassed(deadlineMs: number, nowMs: number): boolean {
  return nowMs >= deadlineMs;
}

/**
 * How many reminders are due at `nowMs` for an anchor, under a policy: the first when `firstAfterDays`
 * have elapsed, then one more every `everyDays` (FRW-034 criterion 2). Zero before the first.
 */
export function remindersDue(anchorMs: number, nowMs: number, policy: ReminderPolicy): number {
  if (!isReminderPolicy(policy)) throw new RangeError('the reminder policy is not usable');
  const first = policy.firstAfterDays * DAY_MS;
  const every = policy.everyDays * DAY_MS;
  const elapsed = nowMs - anchorMs;
  if (elapsed < first) return 0;
  return Math.floor((elapsed - first) / every) + 1;
}

/**
 * The numbers (1-based) of the reminders that are due now and not yet raised. `raised` is the count
 * the store holds for this participant. Once a reminder number is returned, the caller stores it, so
 * a second call at the same instant, or on a second instance that reads the same count, returns none
 * (FRW-034 criterion 5). The store's atomic increment is the service's.
 */
export function newReminders(
  anchorMs: number,
  nowMs: number,
  policy: ReminderPolicy,
  raised: number,
): number[] {
  if (!Number.isSafeInteger(raised) || raised < 0) {
    throw new RangeError('the raised count must be a non-negative integer');
  }
  const due = remindersDue(anchorMs, nowMs, policy);
  const out: number[] = [];
  for (let k = raised + 1; k <= due; k += 1) out.push(k);
  return out;
}

/**
 * Whether a reminder may still be raised for a participant (FRW-034 criterion 4): the workflow is
 * running, the participant must act, has not completed, and is active now.
 */
export function reminderEligible(record: WorkflowRecord, participantId: string): boolean {
  if (!isRunning(record.state)) return false;
  const who = record.participants.find((p) => p.id === participantId);
  if (who === undefined || !mustAct(who) || who.completed) return false;
  return activeParticipantIds(record.participants).includes(participantId);
}

export type RemindResult =
  | { readonly ok: true; readonly participantIds: readonly string[] }
  | { readonly ok: false; readonly refusal: Refusal };

/**
 * The action `remind` (12 §6.2, FRW-034 criterion 3): a caller with `manage` asks for `reminder_due`
 * for the active participants who have not completed. The raising is the service's.
 */
export function remindTargets(record: WorkflowRecord, caller: Caller): RemindResult {
  if (!caller.manage) return { ok: false, refusal: 'forbidden' };
  if (!isRunning(record.state)) return { ok: false, refusal: 'invalid_state' };
  const ids = activeParticipantIds(record.participants).filter((id) =>
    reminderEligible(record, id),
  );
  return { ok: true, participantIds: ids };
}

export type ExpiryResult =
  | { readonly ok: true; readonly record: WorkflowRecord }
  | { readonly ok: false; readonly refusal: 'not_due' | 'invalid_state' };

/**
 * The expiry at the deadline (12 §6.2, FRW-034 criterion 1, the state part): a running workflow whose
 * deadline has passed becomes `expired`. The record keeps `end` null, because `end` names only a
 * decline or a void. After expiry `fillActive` is false, since it requires `sent` or `in_progress`.
 */
export function expireIfDue(
  record: WorkflowRecord,
  deadlineMs: number,
  nowMs: number,
): ExpiryResult {
  if (!isRunning(record.state)) return { ok: false, refusal: 'invalid_state' };
  if (!deadlinePassed(deadlineMs, nowMs)) return { ok: false, refusal: 'not_due' };
  return { ok: true, record: { ...record, state: 'expired' } };
}
