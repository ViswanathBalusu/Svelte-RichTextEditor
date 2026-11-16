# 0364. Lane w4, SYN-020: how the client's permissions are refreshed after `permission_denied`

**Status:** proposed (2026-11-15). Written by the developer of lane w4 for SYN-020. Not reviewed by the owner. It answers the question ADR 0260 item 4 and ADR 0349 §2 left open: "whether the client asks the room for the access object or the host supplies it".

## Context

04 §8 says that on `permission_denied` the client discards the rejected steps, keeps them as recovered edits, "and refresh permissions". PRM-020 criterion 4 gives the result wanted: the client's `access` matches the server's.

DEP (05 §5.5) carries `access` in two messages only, `ch.opened` and `perm.changed`. It has no request for the access object. So the client cannot ask without a new message, and a new message is a protocol change.

Most denials need nothing: the commit raced a `perm.changed` that is already on its way. One case did need something. The room computes access afresh for every commit, so a grant or lease that has run out is not counted even before the host calls `expire`. The room then stored that access as the channel's own without sending it, so the later expiry run found nothing changed and the client was never told. The client kept an access that let it type into the region, and every attempt was refused.

## Decision (proposed)

The server pushes; the client does not ask. No message is added to DEP.

- When the room rejects a commit with `permission_denied` and the access it judged the commit under is not the access the channel was last sent, it sends `perm.changed` with that access first, then `sync.reject`. The in-process message carries `refresh: true`.
- The room no longer replaces the channel's recorded access when a commit is submitted. It stays the access last sent, so a later expiry run still sends `perm.changed` to a channel whose commit was accepted in the meantime.
- The bridge (`packages/protocol/src/bridge/room-bridge.ts`) sends a `refresh` at once, with a higher `rev` and `asOfSeq` at the durable head. It does not hold it for a control commit, because the grants revision it names is already stored.
- The client does nothing new: it applies `perm.changed` as it always does. The engine's `permissions-stale` event stays, for a host that wants to explain the denial (07 §9).

## Alternatives

- A `perm.get` request in DEP. Simple for the client, but a protocol change, and it adds a round trip after every denial, most of which are races that need none.
- Reopen the channel after a denial. It works with today's messages but replays the catch-up and loses the in-flight state for a common event.

## Consequences

- SYN-020 criterion 2 is met: `packages/authority/test/syn-020-refresh-access.test.ts` and `packages/engine/test/sync.mock.test.ts` ("permission_denied after a grant ran out").
- PRM-020 criterion 4 describes the same result; it is not ticked by this lane.
- `read_only` rejections do not carry a refresh; the document state reaches the client through `perm.changed` from the state change itself.
- `backend-mock` grants accept an optional `expiresAt`, used by the engine test. The mock still runs no expiry timer.
