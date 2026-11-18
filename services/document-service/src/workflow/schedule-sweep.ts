/**
 * The deadline and the reminders of running workflows (12 §6.1 `deadline`, `reminders`, §6.2;
 * FRW-034). The rules are the pure functions of `@docedit/authority` (`schedule.ts`); this module
 * applies them to the stored workflows, on the server clock.
 *
 * - `sweepTenant` looks at every `sent` or `in_progress` workflow of one tenant. A workflow whose
 *   `deadline` has passed becomes `expired` through `recordTransition` (the lock, a control commit,
 *   the stored state, the push to the room) and `expired` is raised; every participant who has not
 *   completed is marked `closed`. A workflow still running gets its reminders: for each active
 *   participant who has not completed, `reminder_due` is raised when `firstAfterDays` have passed
 *   since they became active and then every `everyDays`.
 * - Each reminder is raised once. The number of the last one raised is kept in `ReminderStore` and
 *   moved by a compare and set before the event is raised, so a second instance, or a run after a
 *   restart, finds it moved and raises nothing. When several are due at once (the service was
 *   stopped for a while) one event is raised and the count moves to the latest due.
 * - `recordRemind` is the action `remind`: a caller with `manage` asks for `reminder_due` for the
 *   active participants who have not completed. It does not change the count of the schedule.
 *
 * The events go to the `EventSink` with the workflow, document and participant identifiers, the
 * `seq` and the chain head, and nothing else (FRW-036); the host sends the messages. Decisions:
 * docs/adr/0389-w4-FRW-034-expire-and-remind.md (proposed).
 */
import {
  expireIfDue,
  isReminderPolicy,
  newReminders,
  parseDeadline,
  reminderEligible,
  remindTargets,
  workflowEvent,
  type WorkflowEventName,
} from '@docedit/authority';
import type { DepEvent, EventSink } from '../control-plane/events.ts';
import { RevisionConflictError, type DocRef } from '../storage/types.ts';
import type { ReminderStore } from './reminder-store.ts';
import { recordOf } from './record.ts';
import type { RaisedEvent } from './progress.ts';
import { recordTransition, type ControlRecord, type TransitionDeps } from './transitions.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

/** The actor of a change the schedule makes (08 §13: `system`). */
export const SCHEDULE_ACTOR = 'system';

export interface SweepDeps extends TransitionDeps {
  readonly reminders: ReminderStore;
  readonly events: EventSink;
}

export interface SweepResult {
  /** The documents whose workflow this run expired. */
  readonly expired: readonly string[];
  /** The reminders this run raised. */
  readonly reminded: readonly { readonly doc: string; readonly participant: string }[];
  /** Workflows this run could not handle, with the reason; the others were handled. */
  readonly failed: readonly { readonly doc: string; readonly error: string }[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The `seq` and the chain head an event of this workflow carries, as `raiseAll` of the routes. */
async function eventPosition(
  deps: TransitionDeps,
  ref: DocRef,
  resource: WorkflowResourceView,
  control: ControlRecord | null,
): Promise<{ seq: number; chainHead: string }> {
  if (control !== null) return control;
  const head = await deps.logs.head(ref);
  const logged = (await deps.logs.state?.(ref))?.chainHead;
  const sent = resource.sentHash?.replace(/^sha256:/, '');
  const chainHead = [logged, sent].find((h) => h !== undefined && h !== null && SHA256_HEX.test(h));
  if (chainHead === undefined || chainHead === null)
    throw new RangeError('the workflow has no chain head to name in an event');
  return { seq: head.seq, chainHead };
}

async function raise(
  deps: SweepDeps,
  ref: DocRef,
  resource: WorkflowResourceView,
  control: ControlRecord | null,
  raised: readonly RaisedEvent[],
): Promise<void> {
  const at = await eventPosition(deps, ref, resource, control);
  for (const e of raised) {
    const event = workflowEvent(e.name, {
      workflow: resource.id,
      document: ref.doc,
      ...at,
      ...(e.participant !== undefined ? { participant: e.participant } : {}),
    });
    const out: DepEvent = {
      type: `${event.type}.v1`,
      tenant: ref.tenant,
      subject: ref.doc,
      data: { ...event.data },
      time: deps.now(),
    };
    deps.events.emit(out);
  }
}

/**
 * Expires one running workflow whose deadline has passed; null when it is not due, or when another
 * instance moved it first.
 */
async function expireOne(
  deps: SweepDeps,
  ref: DocRef,
  view: WorkflowResourceView,
  now: number,
): Promise<boolean | null> {
  const text = view.members.deadline;
  if (text === undefined) return null;
  const deadline = parseDeadline(text);
  if (deadline === null) return null;
  const due = expireIfDue(recordOf(view), deadline, now);
  if (!due.ok) return null;
  let moved;
  try {
    moved = await recordTransition(deps, {
      ref,
      actor: SCHEDULE_ACTOR,
      from: view,
      write: {
        to: 'expired',
        participants: view.participants.map((p) =>
          p.state === 'completed' ? p : { ...p, state: 'closed' },
        ),
      },
      note: { by: null, cause: 'deadline' },
    });
  } catch (e) {
    // The grants moved under this run: another instance is making the same transition.
    if (e instanceof RevisionConflictError) return null;
    throw e;
  }
  if (!moved.ok) return null;
  await raise(deps, ref, moved.resource, moved.control, [{ name: 'expired' }]);
  return true;
}

/** Raises the reminders of one running workflow that are due, once each. */
async function remindOne(
  deps: SweepDeps,
  ref: DocRef,
  view: WorkflowResourceView,
  now: number,
): Promise<string[]> {
  const policy = view.members.reminders;
  if (
    policy === undefined ||
    policy.firstAfterDays === undefined ||
    policy.everyDays === undefined ||
    !isReminderPolicy({ firstAfterDays: policy.firstAfterDays, everyDays: policy.everyDays })
  )
    return [];
  const timing = { firstAfterDays: policy.firstAfterDays, everyDays: policy.everyDays };
  const record = recordOf(view);
  const out: string[] = [];
  for (const p of view.participants) {
    if (p.activatedAt === undefined || !reminderEligible(record, p.id)) continue;
    const anchor = Date.parse(p.activatedAt);
    if (!Number.isSafeInteger(anchor)) continue;
    const raised = await deps.reminders.raised(ref.tenant, ref.doc, p.id, anchor);
    const fresh = newReminders(anchor, now, timing, raised);
    const latest = fresh[fresh.length - 1];
    if (latest === undefined) continue;
    // The count moves first: of two instances only the one that moves it raises the event.
    if (!(await deps.reminders.claim(ref.tenant, ref.doc, p.id, anchor, raised, latest))) continue;
    await raise(deps, ref, view, null, [{ name: 'reminder_due', participant: p.id }]);
    out.push(p.id);
  }
  return out;
}

/** One run of the schedule for a tenant: expiry first, reminders for what still runs. */
export async function sweepTenant(deps: SweepDeps, tenant: string): Promise<SweepResult> {
  const now = deps.now();
  const expired: string[] = [];
  const reminded: { doc: string; participant: string }[] = [];
  const failed: { doc: string; error: string }[] = [];
  for (const view of await deps.workflows.listRunning(tenant)) {
    const ref = { tenant, doc: view.doc };
    try {
      if ((await expireOne(deps, ref, view, now)) === true) {
        expired.push(view.doc);
        continue;
      }
      // A workflow that another instance expired meanwhile is not reminded: read it again.
      const current = await deps.workflows.read(tenant, view.doc);
      if (current === null || (current.state !== 'sent' && current.state !== 'in_progress'))
        continue;
      for (const participant of await remindOne(deps, ref, current, now))
        reminded.push({ doc: view.doc, participant });
    } catch (e) {
      failed.push({ doc: view.doc, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { expired, reminded, failed };
}

export type RemindOutcome =
  | {
      readonly ok: true;
      readonly resource: WorkflowResourceView;
      readonly raised: readonly RaisedEvent[];
    }
  | {
      readonly ok: false;
      readonly problem:
        | { readonly code: 'not_found' }
        | { readonly code: 'forbidden' }
        | { readonly code: 'invalid_state'; readonly state: string };
    };

/**
 * The action `remind`: the events for the active participants who have not completed. The caller
 * raises them (the route has the request context); nothing is stored.
 */
export async function recordRemind(
  deps: Pick<TransitionDeps, 'workflows'>,
  req: { ref: DocRef; manage: boolean },
): Promise<RemindOutcome> {
  const current = await deps.workflows.read(req.ref.tenant, req.ref.doc);
  if (current === null) return { ok: false, problem: { code: 'not_found' } };
  const targets = remindTargets(recordOf(current), { manage: req.manage });
  if (!targets.ok)
    return {
      ok: false,
      problem:
        targets.refusal === 'forbidden'
          ? { code: 'forbidden' }
          : { code: 'invalid_state', state: current.state },
    };
  return {
    ok: true,
    resource: current,
    raised: targets.participantIds.map((participant) => ({
      name: 'reminder_due' satisfies WorkflowEventName,
      participant,
    })),
  };
}
