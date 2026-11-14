/**
 * The binding of a host-minted token to a workflow participant (12 §6.1, §7; FRW-038 criteria 1, 2 and
 * 6, the rule part). Pure: the token is verified by the document service (`tokens.ts`), and the
 * connection it yields is built there. This module says which participant a token's claims name, and
 * whether that participant may fill now.
 *
 * - The `wfp` claim names a participant identifier of this workflow. A `wfp` that names a participant
 *   of another document's workflow names nothing here and binds to no one (FRW-038 criterion 2).
 * - The token's `sub` must equal the participant's recorded `sub`. A participant with no recorded
 *   `sub` cannot be bound: the host has not said who the person is (FRW-038 criterion 2, the reading
 *   recorded in docs/adr/0249-lane-FRW-027-039.md).
 * - Fill needs a bound participant who is active in a workflow that is `sent` or `in_progress`
 *   (`fillActive`, order.ts). A declined, voided or expired workflow yields no fill, whatever the
 *   token's expiry (FRW-038 criterion 6).
 *
 * Not built here: the `amr` and `auth_time` claims (recorded as given and never validated, FRW-038
 * criterion 3), the refresh that recomputes access and sends `perm.changed` (criterion 5), and the
 * connection that the token service builds from this result.
 */
import type { WorkflowParticipant, WorkflowRecord } from './lifecycle.ts';
import { fillActive } from './order.ts';

/** The claims of a host-minted token that bind it to a participant. */
export interface ParticipantClaims {
  readonly sub: string;
  /** The `wfp` claim, when the token has one. */
  readonly wfp?: string;
}

export type Binding =
  | { readonly ok: true; readonly participant: WorkflowParticipant }
  | {
      readonly ok: false;
      readonly reason: 'no_claim' | 'not_in_workflow' | 'sub_mismatch' | 'sub_not_recorded';
    };

/** The participant the claims bind to in this workflow, or the reason they bind to no one. */
export function bindParticipant(claims: ParticipantClaims, workflow: WorkflowRecord): Binding {
  if (claims.wfp === undefined || claims.wfp.length === 0) return { ok: false, reason: 'no_claim' };
  const participant = workflow.participants.find((p) => p.id === claims.wfp);
  if (participant === undefined) return { ok: false, reason: 'not_in_workflow' };
  if (participant.sub === undefined) return { ok: false, reason: 'sub_not_recorded' };
  if (participant.sub !== claims.sub) return { ok: false, reason: 'sub_mismatch' };
  return { ok: true, participant };
}

/** Whether a token may fill now: it binds to a participant who is active in a running workflow. */
export function tokenMayFill(claims: ParticipantClaims, workflow: WorkflowRecord): boolean {
  const bound = bindParticipant(claims, workflow);
  return bound.ok && fillActive(workflow, bound.participant.id);
}
