/**
 * How a workflow moves once it is sent (12 §6.1, §6.2; FRW-031): the first view of the document by
 * a participant, and the completion of a participant. Both go through `recordTransition`, so each
 * is a control commit, a stored state and a push to the room (`wf.changed`, FRW-035).
 *
 * - `recordFirstView`: the first time a participant opens the document the time is stored once and
 *   `participant_viewed` is raised. While the workflow is `sent` the first view of anyone moves it
 *   to `in_progress`. A later call for the same participant changes nothing.
 * - `recordCompletion`: an active participant completes (`completeParticipant` of the authority).
 *   The participants of the next order become active together and `participant_activated` is raised
 *   for each; the last participant who must act moves the workflow to `completed`
 *   (`workflow_completed` is raised). A `cc` participant is never active, so never completes. An
 *   approver completes as any other: it has no fields to check. The checks of the participant's
 *   own fields and the `rules` commit belong to the `/complete` route (FRW-047), which calls this
 *   after they pass.
 *
 * The events are returned, not raised: the route that calls these functions has the request
 * context that `emit` needs. Decisions: docs/adr/0384-w4-FRW-031-progression.md (proposed).
 */
import {
  activeParticipantIds,
  completeParticipant,
  openWorkflow,
  routeParticipants,
  type WorkflowEventName,
} from '@docedit/authority';
import type { DocRef } from '../storage/types.ts';
import { recordOf } from './record.ts';
import {
  recordTransition,
  type ControlRecord,
  type TransitionDeps,
  type TransitionOutcome,
} from './transitions.ts';
import type { WorkflowResourceView } from './workflow-resource.ts';

/** One event for the caller to raise, with the participant it names (when it names one). */
export interface RaisedEvent {
  readonly name: WorkflowEventName;
  readonly participant?: string;
}

export type ProgressOutcome =
  | {
      readonly ok: true;
      /** False when nothing was stored (a repeated first view). */
      readonly changed: boolean;
      readonly resource: WorkflowResourceView;
      readonly control: ControlRecord | null;
      readonly raised: readonly RaisedEvent[];
    }
  | {
      readonly ok: false;
      readonly problem:
        | { readonly code: 'not_found' }
        | { readonly code: 'forbidden' }
        | { readonly code: 'invalid_state'; readonly state: string }
        | { readonly code: 'conflict'; readonly state: string; readonly rev: number };
    };

const fail = (outcome: Extract<TransitionOutcome, { ok: false }>): ProgressOutcome => ({
  ok: false,
  problem: outcome.problem,
});

export async function recordFirstView(
  deps: TransitionDeps,
  req: { ref: DocRef; actor: string; participant: string },
): Promise<ProgressOutcome> {
  const { ref, actor, participant } = req;
  // Two participants may open the document together: the first to write moves the row, and the other
  // reads it again and writes on top (a first view is never lost to a race).
  for (let attempt = 0; ; attempt++) {
    const current = await deps.workflows.read(ref.tenant, ref.doc);
    if (current === null) return { ok: false, problem: { code: 'not_found' } };
    const who = current.participants.find((p) => p.id === participant);
    if (who === undefined) return { ok: false, problem: { code: 'forbidden' } };
    // A document that is not running shows no first view: a draft is not sent, and an ended one has
    // nobody to ask. A repeated view stores nothing.
    const running = current.state === 'sent' || current.state === 'in_progress';
    if (!running) return { ok: false, problem: { code: 'invalid_state', state: current.state } };
    if (who.firstViewedAt !== undefined)
      return { ok: true, changed: false, resource: current, control: null, raised: [] };

    let to = current.state;
    if (current.state === 'sent') {
      const opened = openWorkflow(recordOf(current));
      if (!opened.ok)
        return { ok: false, problem: { code: 'invalid_state', state: current.state } };
      to = opened.record.state;
    }
    const at = new Date(deps.now()).toISOString();
    const out = await recordTransition(deps, {
      ref,
      actor,
      from: current,
      write: {
        to,
        participants: current.participants.map((p) =>
          p.id === participant ? { ...p, firstViewedAt: at } : p,
        ),
      },
    });
    if (!out.ok && out.problem.code === 'conflict' && attempt < 5) continue;
    if (!out.ok) return fail(out);
    return {
      ok: true,
      changed: true,
      resource: out.resource,
      control: out.control,
      raised: [{ name: 'participant_viewed', participant }],
    };
  }
}

/** What a completion needs: who completes, and what the routes see. */
export interface CompletionRequest {
  ref: DocRef;
  actor: string;
  participant: string;
  /** The `seq` of the commit that completes the participant (FRW-047); default: none stored. */
  completedSeq?: number;
  /**
   * The document as it stands after the completion's `rules` commit, whole. With it the routes of
   * the workflow are evaluated and applied in this transition (FRW-037): who is added or skipped
   * is settled before the participant completes, so the next order is the one routing leaves.
   */
  routingDocument?: unknown;
}

export async function recordCompletion(
  deps: TransitionDeps,
  req: CompletionRequest,
): Promise<ProgressOutcome> {
  // Another participant's first view, or another completion, may write the row between the read and
  // the write. The completion reads it again and goes on, as `recordFirstView` does, so that it is
  // never refused for a race it did not cause.
  for (let attempt = 0; ; attempt++) {
    const out = await completeOnce(deps, req);
    if (!out.ok && out.problem.code === 'conflict' && attempt < 5) continue;
    return out;
  }
}

async function completeOnce(
  deps: TransitionDeps,
  req: CompletionRequest,
): Promise<ProgressOutcome> {
  const { ref, actor, participant } = req;
  const stored = await deps.workflows.read(ref.tenant, ref.doc);
  if (stored === null) return { ok: false, problem: { code: 'not_found' } };
  let current = stored;
  let routingChanged = false;
  if (req.routingDocument !== undefined && stored.members.routing !== undefined) {
    const routed = routeParticipants(stored.participants, {
      routing: stored.members.routing,
      document: req.routingDocument,
      instant: new Date(deps.now()).toISOString(),
      timeZone: stored.timeZone,
      except: [participant],
    });
    // A routing that cannot be evaluated leaves the participants as they are: the completion
    // itself does not depend on it, and the owner sees the workflow unchanged.
    if (routed.ok && routed.changed) {
      routingChanged = true;
      current = { ...stored, participants: routed.participants as typeof stored.participants };
    }
  }
  const activeBefore = new Set(activeParticipantIds(recordOf(stored).participants));
  // Whether the participant may complete is decided on the workflow as it was read: a route that
  // adds someone ahead of them does not take back a part they have already done.
  const done = completeParticipant(recordOf(stored), participant);
  if (!done.ok) {
    // A participant who has completed already, or who is not active (an earlier order first, a
    // `cc`), is refused; another state of the workflow is `invalid_state`.
    return {
      ok: false,
      problem:
        done.refusal === 'forbidden'
          ? { code: 'forbidden' }
          : { code: 'invalid_state', state: stored.state },
    };
  }
  // The next order is the one that routing leaves: nobody active and nobody left to act ends it.
  const marked = current.participants.map((p) =>
    p.id === participant ? { ...p, state: 'completed' } : p,
  );
  const nowActive = new Set(
    activeParticipantIds(recordOf({ ...current, participants: marked }).participants),
  );
  const completedWorkflow = nowActive.size === 0;
  const out = await recordTransition(deps, {
    ref,
    actor,
    from: stored,
    write: {
      to: completedWorkflow ? 'completed' : stored.state,
      participants: current.participants.map((p) => {
        if (p.id === participant)
          return {
            ...p,
            state: 'completed',
            ...(req.completedSeq !== undefined ? { completedSeq: req.completedSeq } : {}),
          };
        if (p.state === 'completed') return p;
        if (p.skippedBy !== undefined) return { ...p, state: 'skipped' };
        return { ...p, state: nowActive.has(p.id) ? 'active' : 'pending' };
      }),
    },
    // A routing change is recorded in the chain, though the lock is the same (FRW-037 criterion 4).
    ...(routingChanged ? { anchor: true } : {}),
  });
  if (!out.ok) return fail(out);
  // Everyone who is active now and was not before the completion: the next order, and whoever
  // routing added or left at the front (the same set as `done.completion.activated` without routing).
  const activated = [...nowActive].filter((id) => !activeBefore.has(id));
  const raised: RaisedEvent[] = [
    { name: 'participant_completed', participant },
    ...activated.map((id) => ({
      name: 'participant_activated' as const,
      participant: id,
    })),
    ...(completedWorkflow ? [{ name: 'completed' as const }] : []),
  ];
  return { ok: true, changed: true, resource: out.resource, control: out.control, raised };
}
