# 0102 Authority backlog batch (round 1)

**Status:** proposed, 2026-11-13. Written by the `packages/authority` developer. Decisions below are the specification's defaults or readings of existing stories; none is an owner decision.

## Context

Round 1 of the backlog run covered the authority side of SYN, PRM, FRW-007 to FRW-010, HIS-005 and HIS-023. Most of the open criteria need the document service, the editor, the protocol kit or the workflow (FRW phase 2), so they stay unticked.

## Changes made

1. **SYN-009 criterion 3 ticked.** A snapshot commit after a step commit's base gives `stale_base` with action `rebase` and nothing is rebased. The note that snapshot commits did not exist is out of date (SYN-005).
2. **PRM-009 criterion 6 ticked.** Every server-authored origin takes the same `process` and `outcomeCheck` path as a client commit, and preconditions the control plane relied on are re-checked. Import, migration and repair have no origin-specific refusal test. Their code path is the same, so the tick is a reading of the code path, not a separate test for each origin.
3. **FRW-008 criterion 5 left open.** The field index now exists (PRM-016), but a fill on an old base is still rebased, so the `attr` step is mapped. The criterion says it needs no position mapping.

## Reasoning recorded for later review

- PRM-016 criterion 3 (the P4 comparison looks only at changed blocks) stays open. `diffScopes` counts visits (`visited`) and the test in `outcome.test.ts` shows a few visits for a one-block edit. The P4 comparison still serialises the whole changed scope, as the story's Notes say.
- SYN-007 criterion 2 (workflow refusal with `read_only`) stays open until FRW ships a workflow. Locked and archived documents are refused.
- SYN-012 criterion 3 stays open. The spike returns `field_invalid` for wrongly typed values, while the criterion expects `invalid_op` except for a fill-only user. This is the I15 versus P7 question for FRW.

## Open questions (not decided here)

- Which code wins when a wrongly typed value comes from a user with more than `fill` (SYN-012 criterion 3 against P7).
- Whether a rebased fill should carry its field scope without a position mapping (FRW-008 criterion 5).

# Round 2 (2026-11-13)

Round 2 covered the same packet. Changes made in this round:

1. **SYN-006 criterion 4 ticked.** A checkpoint is taken from the durable state, never the tentative one. `test/checkpoints.test.ts` requests a snapshot while two commits wait for storage and checks that the checkpoint holds the two stored insertions only. Writing checkpoints is BE-020.
2. **SYN-016 criterion 5 ticked.** A conflict on the commit identifier alone is a `duplicate` outcome (`WriteResult`), and the room acknowledges it and keeps serving (`test/room-commits.test.ts`, "storage outcomes (SYN-016)"). The earlier note that the contract lacked this outcome was out of date. The PostgreSQL write is BE-017 and its run is SYN-047.
3. **FRW-009 criterion 5 left open.** The room applies a retry with the same deterministic identifier once. The outbox and the stop between outbox and log are BE's. The FRW-009 note now says so.

## Left open in round 2, with reasons

- SYN-001 criterion 5 (worker thread with plain data): the four pure functions take ProseMirror nodes and steps. Only the content replay (HIS-005, `test/room-content.test.ts`) runs in a worker on plain data.
- SYN-013 criterion 3 (primary key on (document, `seq`)): storage is PostgreSQL (BE-017, SYN-047).
- SYN-037 criteria 5 and 6: the acknowledgement latency needs the reference deployment (SYN-015). The backoff and resubmission are the client's (SYN-020).
- SYN-046 criteria 1 and 3: the gateway does not exist yet, and `ch.open.engine` is answered by the document service (PRO, BE-001).
- PRM-041 criteria 1, 3 and 7: the route enumeration and the read-marker rule are the document service's. The authority has no read markers.
- PRM-020 criterion 4 and FRW-010 criterion 5: the client refreshes its permissions and shows the conflict (FE).
- SYN-047, SYN-049 (CI runs and the conformance kit), SYN-050 (cost on the reference machine, FND-007): need CI, PostgreSQL or the reference machine. Not measured here.

## Open questions (not decided here)

- Whether a retry is applied once when the process stops between the outbox and the log, and which party keeps the outbox (FRW-009 criterion 5; BE).

# Round 4 (2026-11-13)

Round 4 covered the same packet. This file has no round 3 section. The stories ticked here were chosen from the unticked criteria whose tests already existed or could be written inside `packages/authority`.

1. **PRM-002 criterion 4 ticked.** An editor's commits of several shapes (text, field values carrying grant-shaped data, bold added and removed, a region title) leave the room's permission state unchanged. `test/permissions.grants.test.ts` (new). Criterion 3 stays open: the content holds `sensitive` (FRW-088), field `assignee` and `readOnly`, so "the only permission-related attribute is `policy`" is not met as written. Whether those count is a reading the story leaves open.
2. **SYN-031 criteria 3 and 4 ticked.** A room started from a checkpoint with an empty tail stores the same commit, with the same `seq`, steps, scopes and commit record, and the same document hash, as a room with the whole history. A retry with the same identifier writes nothing, from the stored tail or after one application. `test/transient.test.ts` (new). Criteria 1 and 2 stay open: loading from storage and the exit are BE-020's, and no memory measurement exists.
3. **PRM-013 criteria 1 to 6 ticked, PRM-014 criteria 1 to 8 ticked, PRM-015 criteria 1 to 3 ticked.** The tests were already in `test/suggestions.test.ts` and passed; the stories had not been updated. Criterion 5 of PRM-013 uses `fc.sample` with a fixed seed, not `fc.assert`; the story says "property test", and the Evidence line says so. PRM-015 criterion 4 is the component's (PRM-031).
4. **Checked and left open, with reasons:**
   - PRM-034 criterion 4: the authority's part is tested (`outcome.structure.test.ts`), but the story's Notes say the identifiers, policy and grants of split and merge results follow PRM-065, which is ADR 0033 item 3 and waits for the owner. Not ticked.
   - PRM-034 criterion 5: the forced commit is refused with its scopes, but "disabled with the reason" is the editor's.
   - PRM-056 criterion 5: `test/matrix.test.ts` generates the cases for each row, role and principal. The Notes say running them against the reference service is the conformance kit's (PRO), and the criterion names "the harness", so it stays open.
   - SYN-003 criterion 6: `welcome` is PRO's; the room enforces the `Limits` it is given.
   - SYN-004 criteria 1 and 2: the workflow transitions and the participant's completion have no source until FRW.
   - SYN-030 criterion 3: the room's re-check is tested; writing the request to the outbox is BE's.
   - PRM-066 criterion 2: the commit part is tested; the grant request is the control plane's.

## Open questions (not decided here)

- Whether `sensitive`, field `assignee` and `readOnly` in content count as "permission-related attributes" for PRM-002 criterion 3. The spec default reading (only `policy` is permission data in the region node) is not met by them, so the criterion stays open until the owner or 07 decides.
- Whether PRM-013 criterion 5 needs `fc.assert` (a shrinking run) rather than a seeded sample. The sample is kept as written.

# Round 5 (2026-11-13)

Round 5 covered the same packet. Two stories were checked against `packages/authority` and ticked where the existing tests meet the criterion. The rest of the packet was checked and left open with reasons.

1. **SYN-032 criteria 1 to 5 ticked.** Range mapping through each commit, collapse that survives undo, block targets by identifier, `mapRanges` with no document, and commenting that leaves the head unchanged. `test/threads.test.ts`, "mapping comment ranges through every commit (SYN-032)" and "commenting never changes the document (PRM-038)". Criterion 6 stays open: the authority puts the anchors in the checkpoint effect, but the durable write is BE-020's.
2. **SYN-033 criteria 1 to 5 ticked.** Mapping from `baseSeq` to the head, the scope check at the head and now, the block must exist at the head, and the document and log unchanged. `test/threads.test.ts`, "mapping a requested range from its base to the head (SYN-033; PRM-037)".
3. **Checked and left open, with reasons:**
   - SYN-031 criterion 2 (no subscribers, timers or held memory after a transient run): the room has no timers and no subscriber list in `src`, but the exit of the transient runner is the host's (BE-020 and SYN-031's runner). No memory measurement exists. Not ticked.
   - FRW-010 criterion 5 (the control shows the current value and a live region announces the rejection): the editor's (FE).
   - PRM-020 criterion 4 (the client refreshes its `access` after `permission_denied`): client behaviour.
   - SYN-003 criterion 6: `welcome` is PRO's.

## Open questions (not decided here)

- SYN-033 criterion 2: the code for a `baseSeq` older than the rebase window. The tests use `stale_base`, the code a stale commit gets (SYN-020). This is the assumed code, not a decision. Owner or 05 §6.2 to confirm.
- SYN-032 criterion 6 and the checkpoint: whether the anchors must be written in the same transaction as the checkpoint row. The authority emits them in the checkpoint effect; the transaction is BE-020's.

# Round 6 (2026-11-13)

Round 6 covered the same packet. The packet's candidates were checked against `packages/authority`. One change to the room was needed and is made in this package.

1. **PRM-036 criteria 2 and 4 ticked, criterion 1 and 3 open.** Criterion 2 (a restricted region gives an editor with no grant `view` and `comment`, and the owner all four capabilities) and criterion 4 (returning to `inherit` restores the document roles) are tested in `test/region-policy.test.ts`.
2. **Room change: connected channels now get `perm.changed` when a stored commit changes the region list or a region's policy** (`packages/authority/src/room/room.ts`, `commitBatch` and `sendAccessChanges`). Before this round the room recomputed access only for the submitting channel, so a region restricted by a commit did not reach connected editors. The spec default (07 §9, PRM-006 region-list trigger) is used: the same `perm.changed` message as the expiry and the refresh paths, sent only where the access of that connection changed. No other behaviour changes. The authority suite passes (415 tests) and the package type-checks.
3. **Checked and left open, with reasons:**
   - PRM-036 criterion 1: the authority side is tested, but the commit the editor sends through the core's `setRegionPolicy` is not exercised by an authority test. Not ticked.
   - PRM-036 criterion 3: the forced commit is refused in the authority test; the disabled control is the UI's. Not ticked.
   - PRM-006 criterion 2: workflow transitions have no source yet, and a refreshed token that changes roles closes the channel (ADR 0035), so "one test per trigger" is not complete. Not ticked.
   - PRM-003 criteria 1, 2 and 5: the transaction and the grants route are storage's (PRM-002, BE). Not ticked.
   - PRM-056 criterion 5: as round 5. The cases exist; the reference-service run stays with the conformance kit.
   - SYN-027, SYN-028: streaming and reconnect criteria are the service's or the client's.
   - FRW-010 criterion 5, HIS-005 (all six criteria already ticked): no authority work left.

## Open questions (not decided here)

- Read-restricted readers (ADR 0019) are served through the projection gateway (`src/projection/gateway.ts`), which sends no `perm.changed` today, so a policy change does not reach them through the new path. Whether they need one is not decided here; SYN-051 and SYN-053 own the projection path and it is not changed in this round.

# Round 7 (2026-11-13)

Round 7 covered the same packet. Most open criteria in the packet need the document service, PostgreSQL, the reference deployment, the editor or the workflow, so one story changed.

1. **SYN-001 criterion 5 ticked.** The four pure functions run in a worker thread on structured-cloned JSON, and the worker's result equals the in-process result. `test/worker-boundary.test.ts`, with `test/harness/authority-run.ts` (the shared function) and `test/harness/authority-worker.ts` (the worker entry). The round 2 note that only the content replay runs on plain data in a worker is out of date. Criterion 4 (one implementation shared by the room, the transient authority, the local backend and the authority service) stays open: three of the four consumers do not exist yet.

## Checked and left open in round 7, with reasons

- FRW-010 criterion 5 (the control shows the current value and a live region announces the conflict): the editor's (FE). Criteria 1 to 4 are already ticked and tested in `test/permissions.room.test.ts`.
- HIS-005 and HIS-023: every criterion of HIS-005 is already ticked. HIS-023 was handled in round 1 and is not changed here.
- PRM-017 criterion 6 (rules P4, P7, P9 extend the oracle through a registered hook): P4 and P7 are modelled inside `test/harness/oracle.ts` and not through a hook. The criterion applies "when their stories ship", so it stays open.
- PRM-006 criterion 1 (one test per trigger, including the workflow) and criterion 2 (a region created by a commit the client has just received): the workflow has no source until FRW ships, and the client's `asOfSeq` rule is the engine's.
- PRM-003, PRM-019 criterion 2 (`precondition_failed` on a stale `If-Match`), PRM-005 criterion 1 (locked-document rejection, leaves the code open), PRM-034 criterion 4 (disabled controls are the editor's): the storage, the control plane or the editor own the rest.
- PRM-057 criteria 2 to 5 (the row verdicts, asset rows 6 and 7, row 12 raw logs) and criterion 8 (the `perm-doc` and `perm-region` profiles): the cases live in `tests/security` against the service, and no log or asset route is served by the authority.
- SYN-004 criteria 1 and 2 (workflow and completion sources; the client's `seq` is the engine's), SYN-037 criterion 5 (latency needs the reference deployment) and criterion 6 (the client's backoff, SYN-020), SYN-013 criterion 3 (primary key, BE-017), SYN-003 criterion 6 (`welcome` is PRO's).

## Open questions (not decided here)

- Whether the production worker boundary for the authority is the JSON form of the SYN-002 fixtures, as SYN-039 suggests, or another encoding. The harness uses that JSON form; the transient authority (SYN-031) should confirm it when it is built.

## Round 1 addendum: PRM-051 (authority, 2026-11-13)

**Changes made**

4. **PRM-051: the audit entry of a refused commit.** `src/permissions/audit.ts` builds one audit entry for each commit refused with `permission_denied` or `invalid_op` (`rejectionAudit`). The entry holds the actor, the optional agent, the document, the scopes the check named, the head, the commit identifier and the server time. Tests: `test/audit.test.ts`.

   *Corrected after the round 1 review (2026-11-13).* Round 1 also had the room list the entries in a new `Effects.audit`, with a new `RoomInit.document`, and said the host stored them. No host read `Effects.audit`. The document service's room host already recorded the same refusals by its own path, so wiring both would have audited every refusal twice. The room's list also missed refusals the room does not make: the projection gateway's, and the `invalid_op` for a commit identifier that belongs to another user. `Effects.audit` and `RoomInit.document` are removed. The room host (`services/document-service/src/data-plane/room-host.ts`, `#auditRejection`) is now the one place entries are made: it calls `rejectionAudit` for every `sync.reject` it sends to a channel or to the requester of a server-authored commit, and queues the entry for the audit store. Tests: `services/document-service/src/data-plane/audit.test.ts`.

**Reasoning recorded for later review**

- Entry content. PRM-051 names the actor, document, scopes and server time but not the rest. The reason string is left out because it can echo client input. This is a reading of the story, not a decision of the owner.
- Other refusal codes (`busy`, `read_only`, `too_large`, `conflict`, `rate_limited`, `unavailable`) are not audited, because PRM-051 names only the two codes.
- PRM-051 criterion 3 (grant changes) stays open. `permissionsChanged` gets grants from the control plane without an actor. The entry belongs to the host that stores the change, as `src/permissions/leases.ts` already says for lease breaks.
- PRM-052 (region state, lease break, revocation, restore, transition audit) is not started in this round. A restore's audit entry belongs in the path where a write succeeds (`writeCompleted`), which this round did not change.
- Criterion 4 stays open. The document service keeps an entry for every refusal of a burst, also through an audit store outage (`audit.test.ts` in the data plane), but no delivery of `dep.commit.rejected` exists yet (PRM-053, BE-055), so nothing shows the entries surviving a throttled webhook. The round 1 test that compared two in-memory lists is removed.

**Needed from other packages (not made here)**

- Done in the round 1 fix: the document service stores the entry of each refusal (see change 4). It is queued and written off the path of the rejection, not in one transaction with it, because a refusal writes nothing else. Exposing the entries for query by document, actor and time over the API is still to do (PRM-051 criterion 5; UX-076, UX-081).
- The throttled `dep.commit.rejected` webhook (PRM-053 criterion 3, BE-055), which PRM-051 criterion 4 needs.
- The host must write the audit entry for each grant change (PRM-051 criterion 3).
