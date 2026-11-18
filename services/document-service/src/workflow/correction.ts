/**
 * Correcting a document in progress and resuming it (12 §6.2 `correct` and `resume`; FRW-032).
 * Both go through `recordTransition`, so each is a lock stored under a new grants revision, a
 * control commit, a stored state and a push to the room (`wf.changed`, FRW-035).
 *
 * - `recordCorrection`: an `in_progress` workflow moves to `correcting`. The lock of that state
 *   leaves the document active with no workflow running (`lockFor`), so the owner may change the
 *   body and the fields; every participant who has not completed is marked `paused`, and the room
 *   refuses what a participant sends as `read_only`. A participant who has completed keeps the mark
 *   `completed`, because the resource has no other place to remember it; the participant's own
 *   status word is `paused` for everyone while the state is `correcting` (`participantStatusWord`).
 * - `recordResume`: a `correcting` workflow returns to `in_progress`. The caller gives the document at
 *   `sentSeq` and at the head as snapshots (`snapshotOf`) and the owners of the fields
 *   (`fieldOwnersOf`); `resumeWorkflow` of the authority says who must complete again, and a reset
 *   participant loses the mark `completed` and its `completedSeq`, so the service never leaves a
 *   completion standing over a body the participant did not complete (criterion 6). The activation
 *   marks are then written again, by order.
 *
 * The events are returned, not raised: the route that calls these functions has the request context
 * that `emit` needs. Decisions: docs/adr/0385-w4-FRW-032-correct-and-resume.md (proposed).
 */
import {
  activeParticipantIds,
  compareWithSent,
  correctWorkflow,
  resumeWorkflow,
  type DocumentSnapshot,
  type FieldOwners,
} from '@docedit/authority';
import type { DocRef } from '../storage/types.ts';
import type { ProgressOutcome, RaisedEvent } from './progress.ts';
import { recordOf } from './record.ts';
import { recordTransition, type TransitionDeps } from './transitions.ts';

export interface CorrectionOutcomeExtra {
  /** The participants that `resume` reset, in the order of the resource. */
  readonly reset: readonly string[];
}

export type ResumeOutcome =
  | (Extract<ProgressOutcome, { ok: true }> & CorrectionOutcomeExtra)
  | Extract<ProgressOutcome, { ok: false }>;

export async function recordCorrection(
  deps: TransitionDeps,
  req: { ref: DocRef; actor: string },
): Promise<ProgressOutcome> {
  const { ref, actor } = req;
  const current = await deps.workflows.read(ref.tenant, ref.doc);
  if (current === null) return { ok: false, problem: { code: 'not_found' } };
  const corrected = correctWorkflow(recordOf(current), { manage: true });
  if (!corrected.ok) return { ok: false, problem: { code: 'invalid_state', state: current.state } };
  const out = await recordTransition(deps, {
    ref,
    actor,
    from: current,
    write: {
      to: corrected.record.state,
      participants: current.participants.map((p) =>
        p.state === 'completed' ? p : { ...p, state: 'paused' },
      ),
    },
  });
  if (!out.ok) return { ok: false, problem: out.problem };
  const raised: RaisedEvent[] = [{ name: 'corrected' }];
  return { ok: true, changed: true, resource: out.resource, control: out.control, raised };
}

export async function recordResume(
  deps: TransitionDeps,
  req: {
    ref: DocRef;
    actor: string;
    /** The document at `sentSeq`, and at the head now. */
    sent: DocumentSnapshot;
    head: DocumentSnapshot;
    owners: FieldOwners;
  },
): Promise<ResumeOutcome> {
  const { ref, actor } = req;
  const current = await deps.workflows.read(ref.tenant, ref.doc);
  if (current === null) return { ok: false, problem: { code: 'not_found' } };
  const resumed = resumeWorkflow(
    recordOf(current),
    { manage: true },
    compareWithSent(req.sent, req.head),
    req.owners,
  );
  if (!resumed.ok) return { ok: false, problem: { code: 'invalid_state', state: current.state } };
  const completed = new Set(
    resumed.record.participants.filter((p) => p.completed).map((p) => p.id),
  );
  const active = new Set(activeParticipantIds(resumed.record.participants));
  const out = await recordTransition(deps, {
    ref,
    actor,
    from: current,
    write: {
      to: resumed.record.state,
      participants: current.participants.map((p) => {
        if (completed.has(p.id)) return p;
        // A participant who must complete again keeps nothing of the earlier completion.
        const { completedSeq, ...rest } = p;
        void completedSeq;
        return { ...rest, state: active.has(p.id) ? 'active' : 'pending' };
      }),
    },
  });
  if (!out.ok) return { ok: false, problem: out.problem };
  // Everyone who is active again was paused: each is told they may act.
  const raised: RaisedEvent[] = current.participants
    .filter((p) => active.has(p.id))
    .map((p) => ({ name: 'participant_activated' as const, participant: p.id }));
  return {
    ok: true,
    changed: true,
    resource: out.resource,
    control: out.control,
    raised,
    reset: resumed.reset,
  };
}
