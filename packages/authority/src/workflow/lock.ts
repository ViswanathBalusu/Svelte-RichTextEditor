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
 * - `correcting`, `completed`, `finalised` and `expired` are not decided here. 12 does not say whether
 *   `correcting` lets the owner edit the body (FRW-032 criterion 3 implies it) and whether the terminal
 *   states are locked (FRW-029 Open questions). `lockFor` returns null for them, so no caller can
 *   take a default by accident.
 */
import type { WorkflowStateName } from './lifecycle.ts';

/** The two permission fields a workflow state sets (permissions/model.ts `PermissionState`). */
export interface WorkflowLock {
  readonly documentState: 'active' | 'locked';
  readonly workflowActive: boolean;
}

/** The lock of a workflow state, or null where this module does not decide it (see the note). */
export function lockFor(state: WorkflowStateName): WorkflowLock | null {
  switch (state) {
    case 'draft':
      return { documentState: 'active', workflowActive: false };
    case 'sent':
    case 'in_progress':
      return { documentState: 'locked', workflowActive: true };
    case 'declined':
    case 'voided':
      return { documentState: 'locked', workflowActive: false };
    case 'correcting':
    case 'completed':
    case 'finalised':
    case 'expired':
      return null;
  }
}
