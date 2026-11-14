# ADR 0146: Authority lane 2, backlog batch (PRM-permissions, phase 2)

Status: proposed (2026-11-13). Written by the developer of lane `authority-2` in round 1. The owner decides whether the recommendations below become the rules. Until then, the spec's text stands.

## Context

Lane `authority-2` works the phase 2 end of `docs/stories/PRM-permissions.md` (PRM-037 to PRM-065) from the highest number down, in `packages/authority`. This batch records the stories it moved, and the one spike that ends in a written recommendation.

## Stories moved in this round

- PRM-058 (matrix tests for comments, versions, restore, leases, states and output restrictions): rows 4 and 5, 8, 9, 11 and 12 ticked on existing tests in `packages/authority/test`. Row 2 (view with the gate), row 10 for workflow actions, and the profile tags stay open, reasons in the story's Notes.
- PRM-060 (threat cases: suggestions, identity, revocation, visibility and load): criteria 2, 3, 4 and 8 ticked on existing tests. Criteria 1, 5 (presence), 6 and 7 (activity) stay open, reasons in the Notes.
- PRM-062 (spike: P4 for block-level suggestions): see the recommendation below.

## Recommendation for PRM-062 (P4 for block-level suggestions)

**Reconciliation.** 03 §5 says version 1 suggests block-level changes to paragraphs, whole table rows and whole tables. 07 §17 names paragraphs and whole table rows only. The model, the view and the oracle of PRM-017 already handle whole tables (`packages/authority/test/suggestions.test.ts`, "handles block suggestions on paragraphs, whole table rows and whole tables"). Recommendation: keep 03 §5 as it stands, and add whole tables to the list in 07 §17. This is the spec default for the model; the owner decides whether 07 changes.

**Supported in version 1** (node marks `ins`, `del` and `fmt`, with P4 applied to the baseline and the marks):
- paragraphs, including a suggested change of style, alignment or list level (`fmt` with its recorded `before`);
- whole table rows;
- whole tables.

**Unsupported in version 1** (a suggestion naming one of them is refused, `invalid_op`, as the test "refuses block suggestions the model does not allow: on a cell or a region" shows for a cell and a region):
- table cells and columns (03 §13 leaves their block-level suggestions undefined);
- figures, equations, `toc` and extension blocks;
- regions, whose deletion is judged by the outcome check of their scope (07 §16 row 8), not by a node mark.

**P4 rules for block-level changes.** The baseline is the content with every suggestion rejected, as in 07 §5.2. For a suggested block change, the outcome check requires that every node mark added names the submitting user and uses a suggestion identifier that belongs to them, and that no other block changes. A suggester may not add a non-suggestion node mark (such as `bold`) to a block; the property test in `suggestions.test.ts` includes that step, and every commit it accepts passes the oracle, so an accepted bold change would fail it.

**Property tests.** `suggestions.test.ts` runs 1,500 generated cases against the oracle of PRM-017, over paragraphs, a table row, a table and a cell, with crafted steps (attribute plus `fmt`, removal of a `del`, and a bold node mark) and with marks that name another user. Every commit the outcome check accepts passes the oracle; the test requires accepted paragraphs, rows and tables.

## Open for the owner

- Whether whole tables belong in version 1 suggestions (recommended: yes, as 03 §5 says).
- Amendment of PRM-013 and PRM-014 to state the `perm-suggest` profile's scope (criterion 4 of PRM-062). Not done here: it changes the stories of another lane and the spec.
- Owner decisions PRM-061, PRM-063, PRM-064 and PRM-065 are not touched by this batch. Their proposals are in ADR 0033 and their stories wait for the owner.

## Consequences

If the owner accepts the recommendation, PRM-013 and PRM-014 need the scope sentence, and 07 §17 loses the item it answers. No code change follows: the authority already behaves this way.

## Round 2 (2026-11-13)

Stories ticked on existing and new tests in `packages/authority/test`: PRM-044 (criteria 1, 2, 3 and 5), PRM-047 (criteria 1, 2, 3, 5, 6, 7 and 8), PRM-049 (criteria 1 to 4), PRM-043 (criteria 1, 2, 3 and 5), PRM-050 (criterion 1). New test files: `leases-restore.test.ts` and `approved-region.property.test.ts`. Reasons for the open criteria are in each story's Notes.

**Decision taken without the owner (proposed, to confirm).** PRM-047 criterion 8 is ticked on the rule the room already computes: the approval hash is the canonical text of the region without field values (`regionApproval`, `regionCanonicalText`), which is the answer SR-M25 proposes. The spec default for 07 §11 is still open. If the owner decides otherwise, criterion 8 and the approval test change together.

**Recommendation (proposed).** The room's commit result should carry the styles a restore replaced (`planRestoreDefinitions` already computes them), so that PRM-050 criterion 2 can be met at the wire. This is for the owner and the BE lane to agree; no code changed for it.

## Round 3 (2026-11-13)

Stories ticked on existing and new tests in `packages/authority/test`: PRM-040 (criteria 1 and 3), PRM-045 (criteria 1 and 2), PRM-046 (criteria 2, 3, 4 and 6), PRM-053 (criteria 4 and 5). New source file: `src/permissions/events.ts` (event bodies and the throttle). New test files: `test/permissions.events.test.ts` and `test/region-state-rights.test.ts`. Reasons for the open criteria are in each story's Notes.

**Decision taken without the owner (proposed, to confirm).** The throttle of `dep.commit.rejected` takes its `limit` and `windowMs` as inputs with no default. 05 and 07 state no figures, and this batch invents none. The owner sets them. The throttle counts every dropped rejection, so the audit trail of PRM-051 can record each one whatever the webhook does.

**Question for the owner (not decided here).** PRM-045 criterion 4 expects a lease holder's commit to be refused with `permission_denied` after the break. The holder keeps her own grant of `edit`, so the break alone does not refuse her. Whether a holder's rights should depend on the lease is open (07 §10 is silent). The story's criterion stays open until the owner answers.

**Reading taken (proposed, to confirm).** PRM-040 counts every thread the room holds towards the limit of 5,000, whether resolved or not; 07 §6 does not say.

## Round 4 (2026-11-13, lane authority-2)

**Stories worked (from the end of PRM-037 to PRM-065):** PRM-065, PRM-064, PRM-063, PRM-061 (owner decisions) and PRM-052 (audit of the other permission events). No criterion was ticked in this round. Reasons are in each story's Notes.

**PRM-052 (builder only).** New file `packages/authority/src/permissions/control-audit.ts` (`controlAudit`), tested in `packages/authority/test/permissions.control-audit.test.ts`. It builds the entry for a region state change, a lease break, a session revocation, a restore or a workflow transition, with identifiers only. The control commit, the store and the query are the host's, so no criterion is met inside the package. Decision taken without the owner (proposed, to confirm): the entry names a `subject` for a state change, lease break, revocation and transition, and at least one scope for all but a revocation, which the spec does not require to name a scope. The builder enforces that; the spec does not say it.

**PRM-061 (`everyone` on a restricted region). Proposal for the owner; no code changed.** The spec gives no default (07 §17 leaves it open). What the code does now: `grantMatches` in `src/permissions/access.ts` treats an `everyone` grant as matching every connection, and `validateRegionGrant` in `src/permissions/model.ts` accepts `everyone` as a principal. So on a `restricted` region an `everyone` grant gives every connection the grant's role there, which is the inheritance that `restricted` is meant to stop (07 §4). Options: (a) forbid `everyone` on a `restricted` region, so `validateRegionGrant` refuses it and the pane offers no such choice; (b) allow it, and the pane's explanation of `restricted` says so (PRM-061 criterion 3). Recommendation: (a), fail closed, to be confirmed by the owner. Until the owner decides, the current behaviour stands.

**PRM-063 and PRM-064 (spec defaults, owner decides).** The spec's defaults are in ADR 0033 items 4 and 5, and this round checked the code against them. `structure` is document-level only: `ROLE_CAPABILITIES` gives `structure` to `editor` and `owner` at document level, and `validateRegionGrant` refuses any region grant that names `structure` or `manage`. No per-region quota exists: the only `quota_exceeded` in `src/room/room.ts` is the thread limit. The risk in ADR 0033 item 5 (a region-only editor can grow the document to the 16 MiB limit of I7) stands as recorded.

**PRM-065 (splits and merges).** ADR 0033 item 3 is the proposal and is unchanged in this round. It is not yet confirmed by the owner, so PRM-034's split and merge criteria stay as they are.

**Needs from the main session (not in this lane's directory).** The PRM-053 leftovers recorded in its Notes are still open: (1) an `events` port in `DataPlaneDeps` (`services/document-service/src/seams.ts`) so that `#observe` in `services/document-service/src/data-plane/room-host.ts` can raise `dep.commit.rejected` through `createThrottle`; (2) the owner or main session decides whether the room or the control plane raises `dep.grants.changed` and `dep.region.state_changed`, and with which `seq` (the control plane stores `rev` and no `seq`, `services/document-service/src/control-plane/handlers.ts`); (3) BE-055 delivers the events. None of these is done here.

## Round 5 (2026-11-13, lane authority-2)

**Stories ticked:** PRM-043 (criterion 4: `access.leases` and the cap under a lease) and PRM-047 (criterion 4: a numbering definition and a page setup used by an approved region are refused, with the style case already there). New source: `leases` added to `Access` in `src/permissions/access.ts` (`computeAccess` and `sameAccess`). New tests: `test/leases.access.test.ts`, `test/approved-region.definitions.test.ts`. A row-3 test across roles, `test/matrix.commit-row.test.ts`, was added for PRM-057 criterion 2; that story is claimed by lane PRM-057-067, so its criterion stays unticked and its Notes are unchanged by this lane.

**Decision taken without the owner (proposed, to confirm).** `access.leases` lists every lease in force at the computation time, to every connection that has an access map, holder and expiry included. 07 §10 says the access object "shows the holder and expiry", and the lock indicator of PRM-048 needs them, so this follows the spec's wording. The owner may want the holder hidden from connections without `view` on the region; that would change `leases` in `computeAccess` only.

**Not decided here.** PRM-042, PRM-048 and PRM-051 have no criterion that can be met inside `packages/authority`: they concern REST surfaces, the UI and the host's audit store. They are left as they are.
