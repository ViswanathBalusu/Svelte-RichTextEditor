/**
 * The activation of participants in order and the completion of a workflow (12 §6.1, §6.2;
 * FRW-031 criteria 1, 3, 5 and 6). Pure functions over the workflow record.
 *
 * - The participants who must act are those of kind `filler`, `signer` and `approver`. A `cc`
 *   participant is never active for filling and does not count as "the last participant" (the reading
 *   FRW-031 gives; recorded in docs/adr/0249-lane-FRW-027-039.md).
 * - The active participants are every must-act participant who has not completed and whose order is
 *   the lowest among those. Two participants with the same order are active together.
 * - A participant may fill only while the workflow is `sent` or `in_progress` and the participant is
 *   active: `fillActive` is the derived `access.fill.active` of FRW-031 criterion 1.
 *
 * Not built here: the `participant_activated` event and the `wf.changed` push (FRW-035, FRW-036), the
 * first-viewed time and the `participant_viewed` event (FRW-031 criterion 4), the approver's rule of
 * completing without fields (the field checks are FRW-047), and the sequence numbers of completion.
 */
import type { WorkflowParticipant, WorkflowRecord } from './lifecycle.ts';

/** Whether the participant must act: every kind except `cc` (see the module note). */
export function mustAct(participant: WorkflowParticipant): boolean {
  return participant.kind !== 'cc';
}

/** The identifiers of the participants who are active now, in the order of the list. */
export function activeParticipantIds(participants: readonly WorkflowParticipant[]): string[] {
  const pending = participants.filter((p) => mustAct(p) && !p.completed);
  if (pending.length === 0) return [];
  const lowest = Math.min(...pending.map((p) => p.order));
  return pending.filter((p) => p.order === lowest).map((p) => p.id);
}

/** Whether the participant may fill now: the workflow is `sent` or `in_progress` and they are active. */
export function fillActive(record: WorkflowRecord, participantId: string): boolean {
  if (record.state !== 'sent' && record.state !== 'in_progress') return false;
  return activeParticipantIds(record.participants).includes(participantId);
}

/** Whether a must-act participant has still to complete. */
export function hasPendingParticipants(participants: readonly WorkflowParticipant[]): boolean {
  return participants.some((p) => mustAct(p) && !p.completed);
}

export interface CompletionResult {
  /** The participant identifiers that became active because this completion moved the order on. */
  readonly activated: readonly string[];
  /** Whether this completion was the last one that had to happen, so the workflow is `completed`. */
  readonly completedWorkflow: boolean;
}

export type CompletionTransition =
  | { readonly ok: true; readonly record: WorkflowRecord; readonly completion: CompletionResult }
  | { readonly ok: false; readonly refusal: 'forbidden' | 'invalid_state' };

/**
 * A participant completes while the workflow is `in_progress`. The participant must be active and
 * must not have completed already. When no must-act participant is left, the workflow moves to
 * `completed` (FRW-031 criterion 6); otherwise the participants of the next order become active
 * (FRW-031 criterion 2, the state part).
 */
export function completeParticipant(
  record: WorkflowRecord,
  participantId: string,
): CompletionTransition {
  if (record.state !== 'in_progress') return { ok: false, refusal: 'invalid_state' };
  const before = activeParticipantIds(record.participants);
  if (!before.includes(participantId)) return { ok: false, refusal: 'forbidden' };
  const participants = record.participants.map((p) =>
    p.id === participantId ? { ...p, completed: true } : p,
  );
  const next = activeParticipantIds(participants);
  const completedWorkflow = !hasPendingParticipants(participants);
  const activated = next.filter((id) => !before.includes(id));
  return {
    ok: true,
    record: {
      ...record,
      participants,
      state: completedWorkflow ? 'completed' : record.state,
    },
    completion: { activated, completedWorkflow },
  };
}
