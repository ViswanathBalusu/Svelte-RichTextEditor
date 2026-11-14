/**
 * The workflow object of `ch.opened` and the payload of `wf.changed` (12 §10 real-time plane; FRW-035
 * criteria 1, 2 and 5, the payload parts). Pure: it builds the complete object for one connection from
 * the workflow record. Sending it is the room's and the service's.
 *
 * - The object carries the workflow state, the lock that the state implies (`lockFor`), the `seq` of
 *   the send, and the status of the one participant the connection belongs to (or none). It never
 *   carries another participant's entry, `sub` or roles (FRW-035 criterion 5, and the privacy question
 *   of FRW-035 Notes, decided here as "no"; recorded in docs/adr/0249-lane-FRW-027-039.md, decision 16).
 * - The participant's status is one word: `copy` for a `cc` participant, `completed`, `active` for a
 *   must-act participant who may act now, `paused` while `correcting`, `closed` after a stop or expiry,
 *   and `waiting` otherwise.
 *
 * Not built here: the `access` recomputation and the `rev` increase that a lock or an activation
 * implies (FRW-035 criterion 3, the room's), and the editor's guided bar (criterion 6).
 */
import { lockFor, type WorkflowLock } from './lock.ts';
import type { WorkflowParticipant, WorkflowRecord, WorkflowStateName } from './lifecycle.ts';
import { activeParticipantIds } from './order.ts';

export type ParticipantStatusWord =
  'copy' | 'completed' | 'active' | 'paused' | 'closed' | 'waiting';

/** The status of the connection's own participant. */
export interface OwnParticipantStatus {
  readonly id: string;
  readonly kind: WorkflowParticipant['kind'];
  readonly status: ParticipantStatusWord;
}

/** The workflow object of `ch.opened` and `wf.changed`: a complete object, not a delta. */
export interface WorkflowView {
  readonly state: WorkflowStateName;
  readonly sentSeq: number | null;
  readonly lock: WorkflowLock | null;
  readonly participant: OwnParticipantStatus | null;
}

const CLOSED_STATES: ReadonlySet<WorkflowStateName> = new Set<WorkflowStateName>([
  'declined',
  'voided',
  'expired',
  'completed',
  'finalised',
]);

/** The status word of one participant in a record. */
export function participantStatusWord(
  record: WorkflowRecord,
  participant: WorkflowParticipant,
): ParticipantStatusWord {
  if (participant.kind === 'cc') return 'copy';
  if (participant.completed) return 'completed';
  if (CLOSED_STATES.has(record.state)) return 'closed';
  if (record.state === 'correcting') return 'paused';
  const running = record.state === 'sent' || record.state === 'in_progress';
  if (running && activeParticipantIds(record.participants).includes(participant.id))
    return 'active';
  return 'waiting';
}

/**
 * The view for one connection. `participantId` is the participant the connection belongs to, or null
 * for a connection that is not a participant. An identifier that names no participant gives null.
 */
export function workflowView(record: WorkflowRecord, participantId: string | null): WorkflowView {
  const own =
    participantId === null ? undefined : record.participants.find((p) => p.id === participantId);
  return {
    state: record.state,
    sentSeq: record.sentSeq,
    lock: lockFor(record.state),
    participant:
      own === undefined
        ? null
        : { id: own.id, kind: own.kind, status: participantStatusWord(record, own) },
  };
}
