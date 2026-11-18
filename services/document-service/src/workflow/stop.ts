/**
 * Stopping a workflow (12 §6.2 `decline` and `void`; FRW-033). Both go through `recordTransition`,
 * so each is a lock stored under a new grants revision, a control commit, a stored state and a push
 * to the room. The lock of `declined` and `voided` keeps the document locked and lets nobody fill
 * (`lockFor`), and neither state has a way out (`lifecycle.ts`).
 *
 * - `recordDecline`: a participant who is not a `cc` declines while the workflow is `in_progress`.
 * - `recordVoid`: the owner voids a workflow that is `sent` or `in_progress`.
 *
 * Both need a reason, trimmed; a blank one is refused before anything is written. The reason is kept
 * in the audit entry of the transition with who stopped it, and nowhere else: the webhook that
 * follows names the workflow, the document and, for a decline, the participant, never the reason
 * (FRW-036 criterion 2). Every participant who has not completed is marked `closed`.
 *
 * The events are returned, not raised: the route that calls these functions has the request context
 * that `emit` needs. Decisions: docs/adr/0386-w4-FRW-033-decline-and-void.md (proposed).
 */
import { declineWorkflow, voidWorkflow, type WorkflowRefusal } from '@docedit/authority';
import type { DocRef } from '../storage/types.ts';
import type { ProgressOutcome } from './progress.ts';
import { recordOf } from './record.ts';
import { recordTransition, type TransitionDeps } from './transitions.ts';

export type StopOutcome =
  | Extract<ProgressOutcome, { ok: true }>
  | {
      readonly ok: false;
      readonly problem:
        | { readonly code: 'not_found' }
        | { readonly code: 'forbidden' }
        | { readonly code: 'reason_required' }
        | { readonly code: 'invalid_state'; readonly state: string }
        | { readonly code: 'conflict'; readonly state: string; readonly rev: number };
    };

const refusal = (state: string, why: WorkflowRefusal): StopOutcome => ({
  ok: false,
  problem: why === 'invalid_state' ? { code: 'invalid_state', state } : { code: why },
});

export async function recordDecline(
  deps: TransitionDeps,
  req: { ref: DocRef; actor: string; participant: string; reason: string },
): Promise<StopOutcome> {
  const { ref, actor, participant } = req;
  const current = await deps.workflows.read(ref.tenant, ref.doc);
  if (current === null) return { ok: false, problem: { code: 'not_found' } };
  const out = declineWorkflow(recordOf(current), participant, req.reason);
  if (!out.ok) return refusal(current.state, out.refusal);
  const moved = await recordTransition(deps, {
    ref,
    actor,
    from: current,
    write: {
      to: 'declined',
      participants: current.participants.map((p) =>
        p.state === 'completed' ? p : { ...p, state: 'closed' },
      ),
    },
    note: { by: participant, reason: out.record.end?.reason ?? null },
  });
  if (!moved.ok) return { ok: false, problem: moved.problem };
  return {
    ok: true,
    changed: true,
    resource: moved.resource,
    control: moved.control,
    raised: [{ name: 'participant_declined', participant }],
  };
}

export async function recordVoid(
  deps: TransitionDeps,
  req: { ref: DocRef; actor: string; reason: string },
): Promise<StopOutcome> {
  const { ref, actor } = req;
  const current = await deps.workflows.read(ref.tenant, ref.doc);
  if (current === null) return { ok: false, problem: { code: 'not_found' } };
  const out = voidWorkflow(recordOf(current), { manage: true }, req.reason);
  if (!out.ok) return refusal(current.state, out.refusal);
  const moved = await recordTransition(deps, {
    ref,
    actor,
    from: current,
    write: {
      to: 'voided',
      participants: current.participants.map((p) =>
        p.state === 'completed' ? p : { ...p, state: 'closed' },
      ),
    },
    note: { by: null, reason: out.record.end?.reason ?? null },
  });
  if (!moved.ok) return { ok: false, problem: moved.problem };
  return {
    ok: true,
    changed: true,
    resource: moved.resource,
    control: moved.control,
    raised: [{ name: 'voided' }],
  };
}
