/**
 * Correcting a document in progress and resuming it (12 §6.2 `correct` and `resume`; FRW-032
 * criteria 1, 4, 5, 6 and 7, the state and reset parts). Pure functions over the workflow record and
 * over two snapshots of the document: the one at `sentSeq` and the one at the head.
 *
 * Not built here: the endpoints, the idempotency key, the control commit and the `corrected` event
 * (FRW-030, FRW-036), the recovered-edits pane and the `read_only` refusal of a paused participant's
 * commit (criterion 2, the room's and the editor's), and the serialisation of the body. The caller
 * serialises the body to the text compared here.
 *
 * Decisions taken where 12 is silent are recorded in docs/adr/0249-lane-FRW-027-039.md (decision 15):
 * - `correct` needs `manage` and is allowed from `in_progress` only; `resume` needs `manage` and is
 *   allowed from `correcting` only;
 * - a paused participant is one whose fill is not active while `correcting` (`fillActive` is false in
 *   that state), so pausing needs no separate flag; the room refuses what a paused participant
 *   sends as `read_only` (`isPaused` in room/room.ts);
 * - on `resume`, a changed body resets every completed participant. A changed field resets the
 *   completed participant who owns it. A changed field with no owner in the map is treated as a body
 *   change, the conservative reading that never leaves a signature over an unsigned value;
 * - a reset only clears `completed`. What happens to an earlier signature value and its evidence is
 *   not stated by 12 (Open questions), so this module does not touch them.
 */
import type { Caller, Transition, WorkflowParticipant, WorkflowRecord } from './lifecycle.ts';

/** The document as the comparison sees it: the serialised body and the field values by key. */
export interface DocumentSnapshot {
  readonly body: string;
  /** Field values by field key. A missing key and a null value are the same (no value). */
  readonly fields: Readonly<Record<string, string | null>>;
}

/** What differs between the document at `sentSeq` and the document at the head. */
export interface DocumentChange {
  readonly bodyChanged: boolean;
  /** The field keys whose value differs, in sorted order. */
  readonly changedFields: readonly string[];
}

/** Compares the document at `sentSeq` with the document at the head (FRW-032 criterion 4). */
export function compareWithSent(sent: DocumentSnapshot, head: DocumentSnapshot): DocumentChange {
  const keys = new Set<string>([...Object.keys(sent.fields), ...Object.keys(head.fields)]);
  const changedFields = [...keys]
    .filter((k) => (sent.fields[k] ?? null) !== (head.fields[k] ?? null))
    .sort();
  return { bodyChanged: sent.body !== head.body, changedFields };
}

/**
 * The field key to the participant identifier, or identifiers, who own it: the participants who hold
 * the field's assignee role. A field with no owner in the map is treated as part of the body.
 */
export type FieldOwners = Readonly<Record<string, string | readonly string[]>>;

/** `correct`: `manage` is needed and the workflow must be `in_progress` (FRW-032 criterion 1). */
export function correctWorkflow(record: WorkflowRecord, caller: Caller): Transition {
  if (!caller.manage) return { ok: false, refusal: 'forbidden' };
  if (record.state !== 'in_progress') return { ok: false, refusal: 'invalid_state' };
  return { ok: true, record: { ...record, state: 'correcting' } };
}

export type ResumeResult =
  | {
      readonly ok: true;
      readonly record: WorkflowRecord;
      /** The participant identifiers that were reset, in the order of the participants. */
      readonly reset: readonly string[];
    }
  | { readonly ok: false; readonly refusal: 'forbidden' | 'invalid_state' };

/**
 * `resume`: `manage` is needed and the workflow must be `correcting`. The completed participants who
 * must be reset are computed from the change (FRW-032 criteria 4, 5 and 6). The workflow returns to
 * `in_progress` in every case (criterion 5).
 */
export function resumeWorkflow(
  record: WorkflowRecord,
  caller: Caller,
  change: DocumentChange,
  owners: FieldOwners,
): ResumeResult {
  if (!caller.manage) return { ok: false, refusal: 'forbidden' };
  if (record.state !== 'correcting') return { ok: false, refusal: 'invalid_state' };
  const resetIds = resetSet(record.participants, change, owners);
  const participants: WorkflowParticipant[] = record.participants.map((p) =>
    resetIds.has(p.id) ? { ...p, completed: false } : p,
  );
  const reset = record.participants.filter((p) => resetIds.has(p.id)).map((p) => p.id);
  return {
    ok: true,
    record: { ...record, participants, state: 'in_progress' },
    reset,
  };
}

/** The identifiers of the completed participants that the change obliges to complete again. */
function resetSet(
  participants: readonly WorkflowParticipant[],
  change: DocumentChange,
  owners: FieldOwners,
): Set<string> {
  const completed = participants.filter((p) => p.completed);
  const ownersOf = (key: string): readonly string[] => {
    const owner = owners[key];
    return owner === undefined ? [] : typeof owner === 'string' ? [owner] : owner;
  };
  const unowned = change.changedFields.some((k) => ownersOf(k).length === 0);
  if (change.bodyChanged || unowned) return new Set(completed.map((p) => p.id));
  const owningIds = new Set(change.changedFields.flatMap(ownersOf));
  return new Set(completed.filter((p) => owningIds.has(p.id)).map((p) => p.id));
}
