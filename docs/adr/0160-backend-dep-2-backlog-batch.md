# ADR 0160: backend-dep-2 backlog batch (PRO-097)

**Status:** proposed. **Date:** 2026-11-13. **Lane:** backend-dep-2, round 1.

## Context

The lane was asked to take three to five unclaimed stories from the end of the PRO-protocol slice for `backend-dep` (phase 2 and later, plus the backend-dep side of SYN-021 to SYN-023, SYN-028 and SYN-036). Findings:

- SYN-021, SYN-022, SYN-023, SYN-036 are ticked in `docs/stories/SYN-sync-engine.md`; their code is in `packages/engine`, not `packages/backend-dep`. Nothing to do on the backend-dep side. SYN-028 is an engine story with no backend-dep criterion left.
- PRO-100 (local IndexedDB backend, phase 4) and PRO-101 (backend tiers, phase 4) need a package other than `backend-dep` (a local backend, the authority service and the kit). Not taken.
- PRO-097 (history, comments, leases and imports ports, phase 2) is in `packages/backend-dep` and its routes are in `docs/spec` 05 §6.2. Taken.

## Decisions taken in `packages/backend-dep` (proposed, spec default unless noted)

1. Imports offered only when the host proxies them. The imports port has no feature name (G06), and 05 §6.2 and 07 §12 make the route a service-credential operation (D16). The backend offers `imports` only when `DepBackendOptions.proxyImports` is `true`. Default: absent. The owner should confirm the option name or replace it with a feature name.
2. History, comments and leases ports follow the feature negotiation of 05 §1 rule 4: each is present only when the client asked for its feature and the server announced it. The client does not request them by default (`DEFAULT_FEATURES` is unchanged).
3. Lease heartbeats are explicit calls. The spec's "heartbeats are sent until release" (PRO-097 criterion 3) implies a timer; no timer is built in this batch, so the criterion stays open.
4. Thread and comment events from the channel are not applied by `backend-dep`. That belongs to the review pane's store. PRO-097 criterion 2 stays open.
5. Route-level shape validation uses the names in `packages/protocol/src/definition/resources.ts` (`Version`, `Diff`, `Thread`, `Comment`, `Lease`, `ImportJob`, `HistoryGroup`, `Attribution`, `Activity`, `ReadMarker`, `RestoreResult`). No new shape was invented.

## Open questions left to the owner or the main session

- The name of the Word-import proxy option, and whether a feature name should be added for imports (G06).
- Whether the lease heartbeat timer belongs in `backend-dep` or in the component's review pane.
- Whether thread events from the channel should be applied by the port (as the story text reads) or by the review pane (as decision 4 assumes).

## Round 2 (2026-11-13): no story taken

The round 2 slice was checked again against the same rules. No story was claimed and no code or test changed.

- SYN-021, SYN-022, SYN-023 and SYN-036 have ticked criteria, and their code is in `packages/engine`. Skipped.
- SYN-028 has a ticked criterion (1). Its open criteria 2 to 6 are engine and protocol work, and the page path (criterion 4) is the only part in `packages/backend-dep` (`backend.ts`, `page`). The rule for this round skips a story with ticked criteria, so it is not taken here. The owner or the main session may lift that rule for this story.
- PRO-097 is named as handled in an earlier round. Its open criteria 2 to 4 are the same questions as in round 1 (decisions 3 and 4 above). Not taken.
- PRO-100 (local IndexedDB backend) and PRO-101 (backend tiers) are phase 4 and need `backend-local`, the authority service and the kit. Neither exists in `packages/backend-dep`. Not taken.

Open for the main session: whether the skip rule for ticked stories should allow the open criteria of SYN-028 (criteria 2 to 6) and PRO-097 (criteria 2 to 4) to be taken by this lane.
