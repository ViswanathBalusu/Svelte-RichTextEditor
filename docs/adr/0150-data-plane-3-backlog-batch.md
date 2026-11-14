# ADR 0150: data-plane-3 backlog batch (PRO-018 to PRO-035)

**Status:** proposed. **Date:** 2026-11-13. **Lane:** data-plane-3, round 1.

## Context

The lane took the end of the PRO-protocol data-plane slice (PRO-018 to PRO-035), highest number first, and skipped stories with ticked criteria. Work done in `services/document-service/src/data-plane`:

- PRO-025 (join with catch-up by stream): criteria 1, 2 and 4 ticked, with `src/data-plane/resume-catch-up.test.ts` (5 tests). Criteria 3 (stress test) and 5 (client resubmission) stay open; criterion 6 stays open because the visibility-gate case is not tested.
- PRO-030 (reload after a snapshot): criterion 1 stays open because only the reason `import` is tested (`src/data-plane/snapshot-reset.test.ts`). Criteria 2, 4 and 5 are client behaviour.
- PRO-035 (notifications): no criterion ticked. `src/data-plane/notifications.test.ts` (9 tests) covers the server half of criteria 1, 2 and 4. The rest needs the client, the control plane or the DOM names (PRO-086).

## Decisions taken (proposed, spec default unless noted)

1. PRO-030 criterion 3 is tested as the second review (SR-K1) reads it: a commit whose base is older than a snapshot is refused with `stale_base` and action `rebase`. The story text says `reload`. The test follows the review, and the criterion stays unticked until the owner chooses. Owner decision needed.
2. Job events (`export.*`) are routed by matching the requester's `sub` with the channel's `sub` (`DepDataPlaneInstance.notify` with `{ user }`). The tests use the fixture subjects, where the channel's `sub` is the surrogate (`alice`). The control plane passes `job.createdBy`; whether that equals the channel's `sub` in production is not tested. Owner or main session to confirm.
3. Resume requests in tests carry the `view` token of the first open, as the protocol requires. A resume without it is reloaded (`test/data-plane/sync.test.ts`).

## Open questions

- Whether PRO-030 criterion 1 should list all four snapshot reasons in a test, or whether one reason per path is enough.
- The `export.cancelled` event has no test. It is emitted by `control-plane/export-routes.ts`, which is outside this lane.


## Round 2 (lane data-plane-3, 2026-11-13)

Status: proposed. Work in `services/document-service/src/data-plane` and `test/data-plane` only.

- PRO-034 (region states, leases, region list): criteria 1 and 4 ticked with `src/data-plane/region-state-changes.test.ts` (6 tests). Criterion 2 stays open: `break` of a lease has no test of its own. Criterion 3 stays open: no workflow transition path and no `wf.changed` in the data plane (FRW-025, FRW-060 first).
- PRO-026 (catch-up by page or reload): criterion 2 ticked with `src/data-plane/read-commits.test.ts` (4 tests, the visibility gate of PRM-041). Criterion 3 (pinned `content?seq=`) is a control-plane route with no test in this round.
- Open criteria that need client or browser code, or a package outside this directory (PRO-019 criterion 5, PRO-020, PRO-028 criteria 4 and 5, PRO-031 criterion 7, PRO-032 criteria 4 and 5, PRO-024 criterion 6), are left unticked.

Decision needed (owner or main session): none taken in this round. The open question of PRO-030 criterion 3 (`reload` in the story against `stale_base` in the second review) is unchanged and listed in the round 1 section above.
