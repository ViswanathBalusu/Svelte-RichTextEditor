# ADR 0035: The data plane of the reference document service

**Status:** proposed, 2026-11-06. Records the choices made while building `services/document-service/src/data-plane/` (PLAN-1a packet A1) where the spec is silent or leaves a question open. The project owner has not reviewed any of it. Protocol decisions of the same work are D40 (empty steps and visible scopes, G102), D41 (`ch.closed.cause`, G103) and D42 (users on the wire, G11) in the protocol's decision register (`packages/protocol/src/definition/decisions.ts`).

## Context

05 §4 and §5 define the real-time plane; 06 §2 describes the room host of the reference service; ADR 0019 (proposed) requires that no code path assumes a reader sees the whole document. The room of `@docedit/authority` speaks DEP's message names in an in-process form (S6 report, section 6). Several behaviours a server must have are not stated, and the data plane cannot be built without choosing them.

## Decision

### Structure

- One `Session` per WebSocket, one `HostedRoom` per open document, one `RoomHost` per node. A session handles its frames one after another, in arrival order, including the asynchronous ones (`hello`, `ch.open`, `auth.refresh`), so that a channel's messages reach its room in the order sent (05 §4). A slow room load therefore delays the other channels of the same connection; per-channel queues can replace this when a measurement asks for it.
- The room's output goes through one bridge, `@docedit/protocol/bridge`, which `backend-mock` uses too (moved there from the mock). It coalesces commits, holds `perm.changed` until the control commit of its revision (D12), sends it at once after an expiry (`Room.expire()`, PRM-007), and recomputes access after a commit that changed the region list.
- Every room is wrapped in the projection gateway of `@docedit/authority`, even while the visibility function hides nothing (the default). Content reads, the stream and presence all use the same function.

### Session

| Question | Choice |
|---|---|
| A client that does not offer the subprotocol `dep.v1` | The upgrade is refused with HTTP 400 (05 §4 says the client connects with it). |
| A connection without an `Origin` header (BE-029 notes) | Accepted: it is not a browser, and a non-browser client can send any origin anyway. With an `Origin` header that the tenant does not allow, `error` `forbidden` and 4403. Without `allowedOrigins` in the composition no origin is checked; a production composition must pass it. |
| A first message that is not `hello`, or a `hello` that breaks its schema | `error` `bad_message`, fatal, then 4400 (PRO-021 notes infer it). |
| A `chunk` before `hello` | As any other first message that is not `hello`: 4400. |
| Binary frames, text that is not UTF-8 | 4400. `pm-steps/1` uses no binary frames. The WebSocket layer's own UTF-8 check is off, so that the close code is DEP's, not 1007. |
| Frames above `maxMessageBytes` | `error` `too_large` and 4413, for frames up to eight times `maxMessageBytes` (at least 1 MiB). A larger frame is cut by the WebSocket layer before it is buffered, with its own close code 1009: reading it to answer with 4413 would let a client make the server buffer any amount. |
| A reassembled message | Bounded by `maxCommitBytes` plus 64 KiB; above that `too_large` and 4413. A broken reassembly (G14) is `bad_message` and 4400. A partial message older than 10 seconds is dropped when the next chunk arrives. |
| A peer silent for two heartbeat intervals | The server sends a close frame with code 1001 and ends the socket after one second if the peer does not finish the closing handshake (owner decision 194, 2026-11-15; before it the socket was terminated without a close frame). |
| A token verifier that rejects without a registry code | Treated as `unauthenticated` (fail closed), and reported to `onError`. |
| `welcome.user.id` and every other user on the wire (G11) | The host's `sub` (decision D42): `welcome.user.id`, `author.user`, presence, lease holders. The log, grants and leases keep the per-tenant surrogate (HIS-003), and the room host maps it when it sends, from the control plane's `users.subsOf` (loaded with the room, and from each session's own token). Without that lookup the wire shows surrogates throughout, so that a client still recognises its own commits. |
| `welcome.features` | The server's features, not intersected with the client's. |
| A refused `auth.refresh` (another tenant or `sub`) | A non-fatal `error` `forbidden` with `re`; the session continues under the old token until it expires. |
| A refreshed token that changes a channel's role or groups | The room holds the connection the channel was opened with, so the channel is closed with `ch.closed` `unavailable` (`retryInMs` 0) and the client reopens it under the new token; a token that no longer names the document closes it with `forbidden`. 05 §3.1 asks for `perm.changed` instead; that needs the room to swap a channel's connection (asked of R2). |
| A channel token (`ch.open.token`, `auth.refresh` with `ch`) that expires | The channel closes with `ch.closed` `forbidden`. |
| A channel number already open on the connection | `ch.rejected` `already_open`. |
| A document the token does not name | `ch.rejected` `forbidden`, whether or not it exists, so that existence is not revealed. |
| A document whose CDM version is not the one the client will use | `ch.rejected` `unsupported_cdm`. |
| A `sync.submit` on a channel that is not open | A non-fatal `error` `bad_message` with `re` and `ch`. |
| Revocation of all of a user's documents (05 §3.3) | `auth.revoked`, then 4401; of one document, `ch.closed` `forbidden` on its channels. |
| A deleted document's open channels | `ch.closed` `unavailable`; the reopen is answered `not_found`. |
| Shutdown | `goaway` with a reconnect hint of 1 to 5 seconds, then 4503; writes in flight finish and rooms release ownership. New upgrades get HTTP 503. |

Defaults that the spec does not name (G18): `maxMessageBytes` 131,072 (the example of 05 §5.9) and `maxChannels` 16 (the mock's). Every other limit is the target of 04.

### Rooms

- **Opening (BE-019).** Claim first, which fences any earlier owner, then read the head, the whole log, the permissions in force and their history, and the content at sequence number 0, which is the checkpoint at 0 (D67 of packet A2). The grants revision in force at sequence number 0 is the first of the history. A room has no checkpoint other than the one at 0 yet (BE-020).
- **Before every open,** the channel reads the permission state in storage and the gateway brings the room up to it when it is newer (ADR 0019 change 3). So does a content read.
- **Grants changed while no room was open.** The revision in force is not yet in the log, so a room that opens records its control commit first, before any channel can submit: every commit checked against a revision follows that revision's control commit (04 G7; 07 §9).
- **A failed write** makes the room ask again at once (its control commit, for one). The host backs off before the next write, 25 ms doubling to 5 seconds while writes keep failing, so that a store that fails at once cannot hold a room in a tight loop. The S3 run through the data plane found this as a hang.
- **A change of the document** (`documentChanged`) sends `event` `document.updated` on its channels after the room took the permission state in storage.
- **A resume** further back than `catchUpCommits` is answered with a reload.
- **Idle rooms** release ownership `roomIdleMs` (60 seconds) after their last channel closed, once no write is in flight.
- **A stopped room** (fenced, lost) is dropped at once; the next channel opens a new one from storage, which claims again. In stage 1 the claim is unconditional (BE-018 brings the node lease).
- **Inflight on resume (D08)** is answered from the room's own index of stored commits, on a reload as well as on a stream.

### View tokens (ADR 0019 change 1; PRO-130)

A token is `v1.` and the first 18 bytes, base64url, of HMAC-SHA-256 under a deployment key of the visibility class key. It is opaque to clients and names nothing that the class hides. The same function serves `ch.opened` and content reads (`keyedViewToken`, exported for the REST route of packet A2, decision D70), and every node that serves the same documents must share the key; without one configured, each process draws its own, and a failover makes readers reload once.

### Presence

Presence is relayed only between channels of the same visibility class, because its positions refer to the sender's projection. Only the members of 05 §5.4 are relayed; anything else a client puts into `state` is dropped. Coalescing keeps the latest update of a channel and sends it at the next slot of `presenceHz`. A channel that joins receives the peers of its class that have published a state; a channel that closes is listed in `left` for everyone.

### Storage

- A conflict on the commit identifier alone is reported as `duplicate`, with the stored commit, by both log stores (BE-025; 04 §5); the room answers the duplicate from it.
- The log records `base`, `rebased`, the token's `jti` and the agent when the room stamps them; a control commit has none of them. The room's session for server-authored commits (`system`) is stored as NULL and read back as `system`; DEP renders it as a null session. This changes the provisional hash input of control commits (ADR 0020).
- A write with a snapshot commit is refused until `PUT …/content` exists (BE-037, phase 1b): the store has no payload for a checkpoint reference yet.

## Consequences

Good:
- The service, the mock and the property tests all put the room on the wire through the same bridge.
- Read restrictions can be switched on by passing a visibility function (for example `visibility(now)` of `@docedit/authority`), without touching the data plane.

Bad:
- One slow `ch.open` delays the other channels of its connection.
- A token refresh that changes roles reopens channels instead of sending `perm.changed`.
- Content at sequence numbers other than the head is replayed from the log in the main thread (06 §3 asks for a worker; packet A2's replay worker can take it).
- Slow consumers (06 §2.4) are not detected yet.

## Revisit when

The room can swap a channel's connection; checkpoints other than the one at 0 exist (BE-020); stage 2 brings several nodes, which must share the view-token key; a measurement shows that per-connection ordering costs latency.
