# 0432. UX-082: the audit feed for security tools

Status: proposed (lane w3, 2026-11-26). Owner decision 59 is applied; the settings below are proposals.

## Applied from the owner's decisions

Decision 59: the audit feed to outside systems is a poll of `GET /audit` with a stated cadence. No new route. The feed is therefore a client of the existing route, and it needs nothing new on the service. A user token is refused by the route as before (07 §12).

## What was built

`AuditFeed` and `AuditFeedPoller` in `packages/protocol/src/client/audit-feed.ts`, exported from `@docedit/protocol/client`. `AuditFeed` is a state machine that does no I/O, like the other client machines: `query()` gives the next request, `receive(page)` gives the events not delivered before, `position()` gives a small JSON value to save. `AuditFeedPoller` is a driver over an injected `fetch` and timers.

## Proposed

1. Cadence: one poll every 5 000 ms (`AUDIT_FEED_CADENCE_MS`). A consumer sets its own. "Near real time" is therefore up to one cadence plus the time of a poll. This is a setting, not a measurement.
2. Window: each poll starts 60 000 ms before the newest event delivered (`AUDIT_FEED_OVERLAP_MS`), because `GET /audit` has no cursor at the end of the trail (`nextCursor` is null on the last page) and an event can be recorded with a time a little earlier than one already read when node clocks differ. The window must be longer than the largest skew between nodes; the value is a setting, not a measurement.
3. Order: events come in the order of the service (time, then identifier), so the events of one document keep their order. A late event inside the window is delivered after the later ones it overtook.
4. Resume: the consumer saves `position()` (the time of the newest event and the identifiers delivered inside the window) and gives it back after a disconnect. Events recorded in the meantime are delivered once. A position older than the retention of the trail resumes from what the trail still holds.
5. Identifier: the `id` of an event (UUID version 7) is the key for deduplication.
6. No server-side cursor is added. If the owner wants a cursor that works at the end of the trail, that is a change to `GET /audit` (a `cursor` on the last page), not made here.
