# ADR 0147: Authority lane 3 backlog batch (SYN-039, SYN-041, SYN-042, SYN-043, SYN-046, SYN-047)

**Status:** proposed, 2026-11-13. Records the choices that lane authority-3 made while it built the authority side of three sync stories. Nothing here amends 04, 05, 06 or the protocol yet. The project owner has not reviewed it.

## Context

The sync epic (`docs/stories/SYN-sync-engine.md`) has stories whose criteria are partly authority-side and partly the client's, the backend's or the protocol's. Lane authority-3 took SYN-039 (keep heavy work off the room's loop), SYN-041 (coalesce broadcasts) and SYN-043 (divergence check) from the end of the slice. Each story records what is met and what is not.

## Decisions

### 1. Canonical form for the divergence check (SYN-043)

04 §13 says "the SHA-256 of the canonical form of the durable document". The spec does not name the canonical form of a whole document node in the room. The default taken: the CDM canonical node (`canonicalNode`, 03 §2) serialised by RFC 8785 (`canonicalize`) and hashed with SHA-256 (`sha256Hex`), the same as the engine fixtures and the room's tests hash a document. Owner's decision: the spec default stands; the owner may replace it.

### 2. The divergence check is computed by the host (SYN-043)

The room is synchronous and reads no clock. SHA-256 is WebCrypto's and asynchronous (FND-005). The room therefore cannot compute the hash inside its loop. `src/room/check.ts` gives the async function that builds the message from the durable document; the host calls it. The room's own decision to send `sync.check` (criterion 1, "when it chooses to send") is not built: the spec does not say when the room chooses, and no default cadence is given. Proposed default for a later decision: send after a checkpoint is written (08 §3). No number is invented here.

### 3. The `sync.check` message is not yet in the protocol (SYN-043)

`sync.check` is added to the authority's `ToClient` union in `src/room/types.ts` only. The protocol package (PRO) has no such message. A decision on its wire form and its reporting path belongs to PRO. Needed from others: PRO to define `sync.check` on the wire.

### 4. Coalescing needs a message decision (SYN-041)

SYN-041 criteria 1 to 3 ask for one `sync.commit` message per 30 to 50 ms, with several commits in it. Today each commit is one `sync.commit`. Whether a batch is a new message type or a list inside `sync.commit` is a protocol decision that is not taken here. The room also reads no clock, so the window needs a host timer. Only criterion 4 (no added delay for few subscribers) is met and tested. What counts as "many" remains open (SYN-041 Notes).

### 5. Synchronous loop (SYN-039)

SYN-039 criterion 4 is met by the room's design: no method is async. Criterion 3 (worker receives plain data) is evidenced by the SYN-001 worker test, which runs the pure functions; the room is not run in a worker by this lane. The production thread pool, its size and its saturation are BE's (story Notes). Criteria 1 and 2 (checkpoint serialisation and the 16 MiB latency target) are the host's and are not met here.

### 6. A follower refuses a viewer's submission with `read_only` (SYN-042, round 2)

The spec does not name the code for a submission on a follower (SYN-042 Notes; 06 §16). The spec default taken: `sync.reject` with code `read_only` and action `drop`, the code a read-only connection already gets (`src/room/follower.ts`, `FOLLOWER_REFUSAL`). The follower has no reference to the room, so the commit cannot reach it. Owner's decision: the spec default stands; the owner may choose another code.

### 7. A follower serves whole-document readers only (SYN-042, round 2)

A follower does not apply the per-user visibility gate of HIS-023, and it does not serve the commits resource (`page`). A viewer it cannot serve from its held commits is closed with `unavailable` and must reopen at the room. Until a follower gets the gate and the content of a `reload`, the follower is for readers of the whole document. Needed from others: BE or the host, for the per-user gate and for content on `reload`.

### 8. Criteria left open in round 2 (SYN-046, SYN-047)

SYN-046 criteria 2 and 4 are not ticked: the gateway imports ProseMirror types and `Room.open` takes no engine argument (Notes of SYN-046). SYN-047 criterion 6 is ticked on the strength of one test whose title names G1 to G7 and a test that checks the failure seed.

## Consequences

- The three stories are partly ticked. Their Notes list what is not met and why.
- Needed from others: PRO for `sync.check` on the wire and for any batched form of `sync.commit`; BE for the worker pool and checkpoint serialisation off the loop; the main session for any root-configuration change (none was made by this lane).

## Round 3 addendum (lane authority-3, 2026-11-13)

This addendum is appended, not a rewrite of sections 1 to 8. Section 7 above is unchanged; the decisions it lacks are recorded here.

### 9. Round 2 decisions of SYN-042, recorded at the request of the review

- Each viewer gets its own access, computed for that viewer, never one access shared by the followers' readers.
- An upstream `perm.changed` is not forwarded to viewers. A newer upstream revision makes each viewer's access from an older revision stale, and the viewer gets nothing more until the host passes its own recomputed access to `Follower.permissions(channel, access)`; the follower then sends that viewer `perm.changed` with it (`src/room/follower.ts`).
- Viewers wait for `permissions`: no content goes to a viewer before its access is known to the follower.
- The conservative scan: a commit or content that may carry confidential or sensitive material is treated as sensitive when the scan cannot tell, so it is withheld rather than sent.
- The history gate fails closed at the head: without an `access_since` claim, `minVisibleSeq` is the head, so a reader sees the current version only (`src/room/gate.ts`).
- SYN-042 criteria 1, 2 and 4 stay open. They need a host (BE-028) that wires a follower to a room and that calls `Follower.permissions(channel, access)` for each viewer whenever the room's permissions change, expire or are refreshed.

### 10. Relay mode defaults (SYN-044, proposed)

- A relay rejects a base that is not the head with `stale_base` and action `rebase`, as 04 §14 says. The spec's `stale_base` code table is the open question of SYN-005; a relay has no snapshot commits, so it does not distinguish a base before a snapshot.
- A relay checks the commit envelope only: id (UUID version 7), base (a safe integer), steps (a list) and origin (a client origin). It does not read the steps, which 04 §14 requires it to skip.
- A relay's commits record no scopes, retired regions, claimed suggestions or revision, and `cdm` is 0. These are empty or zero because the relay evaluates no permission. The fields of a relay's commits are therefore not evidence of a check.
- A store that fails, or throws, gives `unavailable` with action `retry`, and nothing is acknowledged. The head does not move.
- A repeated id from the same user is acknowledged with its first sequence number and is never stored twice. From another user it is `invalid_op`.
- The features that need the authority service (`content`, `catchUpBeyondWindow`, `restore`, `comparison`, `export`) are unavailable to a relay without one (04 §14; 05 §10).
- Needed from others: BE or the host, for a DEP gateway that calls `Relay.submit` and delivers its messages; PRO, for a `mode` in the wire announcement if it is not yet there; and the `core-relay` profile of PRO-111.
