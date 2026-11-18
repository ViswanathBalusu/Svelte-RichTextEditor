/**
 * The workflow record and the transitions that need no more than the record and the caller: first
 * open, decline and void (12 §6.2; FRW-033 criteria 3 and 6, FRW-031 criterion 4 for the state part).
 * Pure functions: the endpoint, the idempotency key, the control commit, the webhooks and the
 * `wf.changed` push are the workflow service's. The send transition is in `send.ts` and the order of
 * activation and the completion of participants are in `order.ts`.
 *
 * Decisions taken where 12 is silent are recorded in docs/adr/0249-lane-FRW-027-039.md:
 * - a reason is required for `decline` and `void`; a reason that is empty after trimming is no reason;
 * - only a participant who must act (kind other than `cc`) may decline;
 * - `void` is allowed from `sent` and `in_progress` only, and `decline` from `in_progress` only,
 *   because the diagram of 12 §6.2 has no decline from `sent`;
 * - `declined` and `voided` admit no transition at all (FRW-033 criterion 4).
 */

/** The workflow states of 12 §6.2. */
export const WORKFLOW_STATE_NAMES = [
  'draft',
  'sent',
  'in_progress',
  'correcting',
  'completed',
  'finalised',
  'voided',
  'declined',
  'expired',
] as const;

export type WorkflowStateName = (typeof WORKFLOW_STATE_NAMES)[number];

/** The kinds of participant of 12 §6.1. */
export type ParticipantKind = 'filler' | 'signer' | 'approver' | 'cc';

export interface WorkflowParticipant {
  /** The participant identifier (`participants[].id`). */
  readonly id: string;
  /** The role identifiers the participant holds. */
  readonly roles: readonly string[];
  readonly kind: ParticipantKind;
  /** The order; participants with the lowest incomplete order are active first (12 §6.1). */
  readonly order: number;
  /** Whether the participant has completed. */
  readonly completed: boolean;
  /** The host's subject for the participant (`sub` of 12 §6.1), when the host has bound one (FRW-038). */
  readonly sub?: string;
  /** Whether the participant must submit an access code before they may fill (`auth.require`, FRW-039). */
  readonly codeRequired?: boolean;
  /** Whether a correct access code has been submitted for them (FRW-039). */
  readonly verified?: boolean;
}

/** The end of a workflow that was stopped: declined by a participant, or voided by an owner. */
export interface WorkflowEnd {
  readonly state: 'declined' | 'voided';
  /** The participant who declined, or null for a void by a caller with `manage`. */
  readonly by: string | null;
  readonly reason: string;
}

/** The part of the workflow resource this module reads and writes. */
export interface WorkflowRecord {
  readonly state: WorkflowStateName;
  readonly participants: readonly WorkflowParticipant[];
  /** The `seq` of the commit at which the document was sent (`sentSeq`), or null before the send. */
  readonly sentSeq: number | null;
  /** The chain hash at `sentSeq` (`sentHash`), or null before the send. */
  readonly sentHash: string | null;
  readonly end: WorkflowEnd | null;
}

/** Who asks for a transition. `manage` is the right of 07 §4 that owns the workflow. */
export interface Caller {
  readonly manage: boolean;
}

/**
 * Why a transition is refused. `forbidden`: the caller or participant may not do it. `invalid_state`:
 * the state does not allow it (including every transition from `declined` and `voided`).
 * `reason_required`: a decline or void gave no reason. The send adds `checklist_failed` (see send.ts).
 */
export type Refusal = 'forbidden' | 'invalid_state' | 'reason_required';

export type Transition =
  | { readonly ok: true; readonly record: WorkflowRecord }
  | {
      readonly ok: false;
      readonly refusal: Refusal;
    };

const refuse = (refusal: Refusal): Transition => ({ ok: false, refusal });

/** The reason as recorded, or null when it is missing or empty after trimming. */
export function normaliseReason(reason: string): string | null {
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Whether no transition is possible any more (FRW-033 criterion 4 for `declined` and `voided`). */
export function isStopped(state: WorkflowStateName): boolean {
  return state === 'declined' || state === 'voided';
}

/** The first participant opens the document while the workflow is `sent` (FRW-031 criterion 4). */
export function openWorkflow(record: WorkflowRecord): Transition {
  if (record.state !== 'sent') return refuse('invalid_state');
  return { ok: true, record: { ...record, state: 'in_progress' } };
}

/**
 * A participant declines while the workflow is `in_progress`, with a reason (12 §6.2; FRW-033
 * criterion 1 for the state and the reason; the event and the evidence are the service's).
 */
export function declineWorkflow(
  record: WorkflowRecord,
  participantId: string,
  reason: string,
): Transition {
  if (record.state !== 'in_progress') return refuse('invalid_state');
  const text = normaliseReason(reason);
  if (text === null) return refuse('reason_required');
  const who = record.participants.find((p) => p.id === participantId);
  if (who === undefined || who.kind === 'cc') return refuse('forbidden');
  return {
    ok: true,
    record: {
      ...record,
      state: 'declined',
      end: { state: 'declined', by: participantId, reason: text },
    },
  };
}

/**
 * A caller with `manage` voids the workflow while it is `sent` or `in_progress`, with a reason
 * (FRW-033 criteria 2, 3 and 6). A caller without `manage` is refused first, then the state, then
 * the reason.
 */
export function voidWorkflow(record: WorkflowRecord, caller: Caller, reason: string): Transition {
  if (!caller.manage) return refuse('forbidden');
  if (record.state !== 'sent' && record.state !== 'in_progress') return refuse('invalid_state');
  const text = normaliseReason(reason);
  if (text === null) return refuse('reason_required');
  return {
    ok: true,
    record: { ...record, state: 'voided', end: { state: 'voided', by: null, reason: text } },
  };
}
