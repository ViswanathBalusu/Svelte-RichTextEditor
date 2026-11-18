# ADR 0395: The authority service, `restoreSteps`, `diff` and `attribution` (proposed)

Status: proposed. Lane w5, story PRO-106. Routes follow ADR 0314 decision 3. The choices below are
the ones 05 §10 leaves open ("as named", no signatures). The maintainers have not accepted them.

## Context

A relay or sidecar backend offers history, restore and comparison only if the authority service
computes them (05 §9; `history` needs `open`, `materialise`, `restoreSteps`, `diff` and
`attribution`). `@docedit/history` already has the functions: `planRestore`, `compare` and
`attributionAt`. The service runs them on a state it holds, with the checks they have, and keeps
nothing.

## Choices

1. Every call names a state in the path (`POST /v1/authority/states/{stateId}/restore-steps`,
   `/diff`, `/attribution`) and carries who is asking: `requester` (the connection of
   `applyCommit`: `sub`, `session`, `role`, `groups`), `permissions` (as `applyCommit`), an optional
   `gate` (`{ min, named }`: the lowest visible seq and the seqs of named versions, 07 §8) and an
   optional `now` (Unix milliseconds). The service computes the requester's access and hidden set
   (07 §4; ADR 0019) from them. Without a `gate` everything is visible (`min` 0).
2. A request the history rules refuse is an answer: `{ refused: { code, reason } }` with the history
   code (`forbidden`, `not_found`, `conflict`, `workflow_active`, `validation_failed`). Over HTTP it is
   `200`, as a rejected commit is (ADR 0394). A malformed request, an unknown state, or a seq the
   state was not opened far enough back to read is an error (`invalid_request`, `unknown_state`,
   `not_found`).
3. `restoreSteps` takes `{ toSeq, region?, dryRun?, retired?, idSalt? }`. It answers
   `{ kind: 'steps', region, steps }` or `{ kind: 'snapshot', reason: 'restore', region?, fallback?,
   content }`, and in both `toSeq`, `headSeq`, `reidentified`, `recreated`, `replaced`,
   `preconditions`, `unchanged` and, for a dry run, `dryRun` (the comparison from the head to the
   result). `content` is the canonical envelope the snapshot commit would hold. `preconditions` is
   what a caller passes to `applyCommit` or to the room when it applies the restore (04 §5). The
   service plans; it does not apply.
4. `diff` takes `{ fromSeq, toSeq, region?, granularity? }` (`word` or `char`) and answers
   `{ comparison }` as `@docedit/history` defines it. The method (steps or alignment) is chosen by
   `compare` as in the document service. The service keeps no comparison cache.
5. `attribution` takes `{ seq?, region?, blocks? }` and answers `{ seq, blocks }`: for each block
   (the leaf blocks of the region, or the listed identifiers, or every leaf block) its `id`, `type`,
   `region`, the positions it covers and the runs (`from`, `len`, `user`, `seq`, and `agent`,
   `restoredBy`, `restoredSeq` when they apply). A block inside a region the requester may not see
   is refused as `not_found`.
6. The attribution map is replayed from a baseline at the checkpoint the state was opened from.
   `checkpointRef` gets two optional fields: `attribution` (the saved map, `AttributionMap.toJSON()`)
   and `createdBy`. Without `attribution`, the checkpoint's content is attributed to `createdBy` at
   the checkpoint's `seq`, and to nobody (user `''`) when `createdBy` is absent. A map that does not
   cover the checkpoint exactly is refused at `open`. A snapshot commit in the log starts a map of
   its own user, as the document service does.
7. The history before the checkpoint a state was opened from cannot be read: a call that needs it
   answers `not_found` and the caller opens the state from an earlier checkpoint.

## Not decided here

- Where the baseline attribution lives for a document opened from a checkpoint (the room's
  checkpoint effect does not carry it yet; HIS-014 criterion 4).
- Whether the history gate belongs to the service (as here, passed by the caller) or is computed
  from stored versions. The service holds no versions.
- The machine-readable interface definition of the authority service. None exists, so the shapes
  above are documented here and in `services/authority-service/src/history-calls.ts` only.
- The comparison's worker-thread rule (HIS-011 criterion 4): the service runs `compare` on the
  caller's request thread. The deployment decides whether a pool serves it.
