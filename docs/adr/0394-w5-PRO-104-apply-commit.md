# ADR 0394: The authority service, `applyCommit` (proposed)

Status: proposed. Lane w5, story PRO-104. The route is the one of ADR 0314 decision 3
(`POST /v1/authority/states/{stateId}/commits`). The choices below are the ones 05 §10 leaves open.
The maintainers have not accepted them.

## Context

05 §10 names `applyCommit(stateId, commit, permissions, preconditions)` and says it rebases, applies,
checks the invariants, runs the permission outcome check and the rules. It gives no shapes. The
authority package already does all of this in `Room`. The service must give a backend the same
decisions, so it runs `Room` and does not reimplement any rule.

## Choices

1. The call builds a `Room` from the held state for the duration of the call: the checkpoint's
   document, the commits after it, the permission state given in the request. It opens one channel
   for the commit's author, submits the commit, reads the room's answer and drops the room. The
   service keeps no room between calls. The cost is that of replaying the log held for the state
   (see the measurement in PRO-104 Notes).
2. `permissions` is the permission state now, as JSON: `revision`, `grants`, `regionStates` (an
   object by region), `leases`, `documentState`, `workflowActive`, `approvals`. The caller owns it;
   the service keeps none of it. The author's connection (`sub`, `session`, `role`, `groups`,
   optional `agent` and participant fields) is part of `commit`, because a stateless call cannot
   look the user up.
3. `preconditions` are what the caller relied on: `revision`, `head`, `documentState`,
   `workflowActive`, `regionStates`. They are compared with the state and the permissions of the
   call. A mismatch is a rejection with code `conflict` and action `drop`, as the room answers a
   failed precondition of a server-authored commit (04 §5, closing paragraph). The room checks
   preconditions only for commits the control plane authors; the service checks them for any commit
   it is given, because the caller states them.
4. A commit that is not acceptable is an answer, not an error: `{ accepted: false, rejected }`, with
   the fields of `sync.reject` (`id`, `code`, `action`, `head`, `reason`, `scopes`, `rule`). Over
   HTTP it is `200` with `{ rejected }` (ADR 0314). A malformed request, an unknown state or a
   storage failure is an error (`problem+json`).
5. An accepted commit answers with `stateId`, `seq`, `steps` (as applied, after rebasing), `scopes`,
   `rebased` and `commits`: every commit the room wants stored, as `open` takes them (`meta`,
   `payloadHash`, `prevHash`, `hash`, `payload`). The commit's time is the one the caller gives
   (`commit.time`, Unix milliseconds); without it the service uses its own clock. The new `stateId`
   is the hash of the last of these commits, and the service holds that state at once. A caller
   that stores `commits` can `open` the same state again after a restart.
6. When the grants revision in `permissions` is ahead of the revision the log last recorded, the
   room writes a control commit after the commit (04 §5). It is in `commits` and in the new
   `stateId`. A rejected commit writes nothing, so the control commit is written with the next
   accepted commit. A caller whose own log writes it earlier must say so (open question below).
7. The state a call names stays valid: `applyCommit` does not change it. A second call on the old
   `stateId` is a branch the caller chose to take; the service does not forbid it.

## Open questions (not decided here)

- Server-authored origins (`prefill`, `restore`, signatures) go through `Room.author`, not `submit`.
  The service does not take them yet. The `fields` feature needs them for prefill by key.
- The revision at a checkpoint is not part of `checkpointRef`. When the log after a checkpoint is
  empty and the checkpoint is not at 0, the service assumes the log last recorded the revision it
  is given, so it writes no control commit first. A `revision` in `checkpointRef` would remove the
  guess.
- Whether the service should refuse a call on a state that is no longer the head of the caller's
  log. The caller sends `preconditions.head` for that today.
- Read restrictions (ADR 0019) need projection calls that 05 §10 does not define.
