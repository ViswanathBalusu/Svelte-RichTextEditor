/**
 * The document lock that a workflow state implies (12 §3.3, §4.3, §6.2; FRW-029 criteria 2, 3 and 5).
 * Pure: the service that holds the workflow sets `documentState` and `workflowActive` of the
 * permission state from this mapping. The permission rules that act on those two fields (the state
 * limit of 07 §4, the fill allowance and the commenting rule) are in `permissions/access.ts`,
 * `permissions/comments.ts` and `room/room.ts`; this module only says which fields a state implies.
 *
 * Decisions taken where 12 is silent are recorded in docs/adr/0249-lane-FRW-027-039.md:
 * - `sent` and `in_progress` lock the document and keep fill for the active participants
 *   (`workflowActive`), so an owner's edit is refused while they fill and sign (FRW-029 criterion 1);
 * - `declined` and `voided` lock the document and end the workflow (`workflowActive` false), so the
 *   document stays locked (FRW-029 criterion 5) and nobody may fill it any more;
 * - `draft` leaves the document active: no workflow runs yet;
 * - `completed` keeps the lock and ends fill, as `declined` and `voided` do (12 §6.2: terminal states
 *   keep the lock; FRW-031 criterion 6; docs/adr/0384-w4-FRW-031-progression.md, proposed);
 * - `correcting` leaves the document active with no workflow running, as a draft does: the owner
 *   corrects the body and the fields as an editor of a draft would (FRW-032 criterion 3), and no
 *   participant fills, because a participant of a `correcting` workflow is paused
 *   (docs/adr/0385-w4-FRW-032-correct-and-resume.md, proposed);
 * - `expired` locks the document and ends fill, as the other states that end a workflow do: the
 *   deadline stops the process, and an owner's edit would change what the participants were sent
 *   (FRW-034 criterion 1; docs/adr/0389-w4-FRW-034-expire-and-remind.md, proposed);
 * - `finalised` keeps the lock and ends fill, as `completed` does: it is a terminal state (12 §6.2) and
 *   its sealed PDF is the record of the document as signed (FRW-054; docs/adr/0401-w4-FRW-054-finalise-and-final-route.md,
 *   proposed). 12 does not say so in words (FRW-029 Open questions).
 */
import type { WorkflowStateName } from './lifecycle.ts';

/** The two permission fields a workflow state sets (permissions/model.ts `PermissionState`). */
export interface WorkflowLock {
  readonly documentState: 'active' | 'locked';
  readonly workflowActive: boolean;
}

/** The lock of a workflow state, or null where this module does not decide it (no state at present; see the note). */
export function lockFor(state: WorkflowStateName): WorkflowLock | null {
  switch (state) {
    case 'draft':
      return { documentState: 'active', workflowActive: false };
    case 'sent':
    case 'in_progress':
      return { documentState: 'locked', workflowActive: true };
    case 'declined':
    case 'voided':
    case 'expired':
    case 'completed':
    case 'finalised':
      return { documentState: 'locked', workflowActive: false };
    case 'correcting':
      return { documentState: 'active', workflowActive: false };
  }
}
