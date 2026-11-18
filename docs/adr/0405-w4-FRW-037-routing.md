# ADR 0405: Routing rules in the workflow service (FRW-037)

**Status:** proposed, 2026-11-18. Written by lane w4. The owner has not settled these points. Owner decision 185 of 2026-11-15 (`docs/owner-decisions-2026-11-15.md`) settles one of them: every rule problem is refused at save (ADR 0340).

## Context

12 §5.1 and §6.1 give the routing effects `addParticipant` and `skipParticipant` and an example route. 12 does not say when routes are evaluated, who the added participant is, or what a skipped participant is. `packages/rules/src/routing.ts` (lane rules-3, ADR 0159) already compiles routes and says which apply. This record covers the workflow side.

## Decisions taken

1. **Save.** `PUT /documents/{id}/workflow` compiles the routes against the document as it stands (`checkRoutingOfDocument`): field keys and roles must exist and each condition must be boolean. A problem is refused as `validation_failed` with the JSON Pointer of each, and nothing is stored (criterion 3).
2. **Evaluation points.** The routes are evaluated twice: when the workflow is sent (over the document as sent), and when a participant completes (over the document after the completion's `rules` commit). Nothing else evaluates them. A value that a participant writes becomes visible to routing at that participant's completion, not at the fill commit. The reason: the workflow service learns of a workflow change only through its own transitions, and a completion is the point at which a participant's values are final.
3. **One transition.** What routing changes is stored in the same transition as the send or the completion. The transition is written as a control commit even when the lock does not change (`anchor`), so the routing change is part of the hash chain (12 §6.2, last paragraph). `wf.changed` goes to each channel whose own status changed, and `participant_activated` is raised for each participant who becomes active, whether by the order or by routing.
4. **Added participant.** `addParticipant { role, order }` adds one participant: kind `approver`, the role, the order, the identifier `route<route index>_<role>`, the member `addedBy` (the route index), and no `sub`. The identifier is the same at every evaluation, so a repeat adds nobody. Activation follows the ordering rules of `order.ts`: an added participant at an order below the active one becomes the active one.
5. **Skipped participant.** `skipParticipant { role }` skips every participant who holds the role and has not completed, except the one who is completing. A skipped participant has the member `skippedBy`, the state word `skipped`, does not act, does not hold the workflow back and has the status `closed` on their channel. A workflow whose last participants are all skipped completes at the next completion; at the send, if routing leaves nobody active, the workflow stays `sent` until the owner voids it.
6. **Monotonic.** An effect that has applied is never undone: a participant is not removed, and a skip is not lifted, when the condition is false at a later evaluation.
7. **Send checklist.** A role that a route may add (`rolesAddedByRouting`) needs no holder at the send. Without this a role named by `addParticipant` could not be used, because 12 §6.1 requires a `role_def` and the checklist requires a holder for each.
8. **Failure.** A route whose condition does not evaluate does not apply (rules-3, ADR 0159). A routing that no longer compiles at the send refuses the send with `validation_failed`. At a completion it leaves the participants as they are: the completion does not depend on it.

## Open

- **Who the added participant is.** The added participant has no `sub`, so a token cannot bind to it (`bindParticipant`, FRW-038), and no operation names the person after the send (a `PUT` is refused unless the workflow is a `draft`). 12 does not say how the host binds a person to a routed role. Proposal: an operation `PUT /documents/{id}/workflow/participants/{pid}` for the owner or the host, allowed for a participant who has no `sub`; the `participant_activated` webhook already tells the host which participant to bind. Not built here.
- **Kind of the added participant.** `approver` is a choice. A role that owns fields would need `filler`. Proposal: `filler` when a field is assigned to the role, `approver` otherwise.
- **Formula fields.** Routing reads stored values, and a `formula` field has no type and no value in the expression evaluator (`rules/src/language.ts`, `rules/src/evaluate.ts`: a formula is read as computed, and routing computes none). A route over a formula field never applies. Proposal: evaluate the document's rules first and give routing the computed values and types.
- **Roles with no holder at the end.** Because of point 7, a role that holds fields may end with no participant when no route adds one. The completion check is per participant, so nobody checks those fields. Proposal: a check at the end of the workflow.

## Consequences

Criteria 1 to 4 of FRW-037 are met for the point of view of the document service with these decisions, and tested in `packages/authority/test/frw-037.routing-apply.test.ts` and `services/document-service/test/control-plane/frw-037.routing.test.ts`. The open points above stay open for the owner.
