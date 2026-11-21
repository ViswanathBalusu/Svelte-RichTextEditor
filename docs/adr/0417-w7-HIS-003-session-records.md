# ADR 0417: Session records (HIS-003)

Status: proposed (lane w7, 2026-11-20). Owner decision 24 of
`docs/owner-decisions-2026-11-15.md` settles where session records are kept, for how long, and that
a user agent string is reduced to family and major version. The points below are what that decision
and 08 section 2 leave open. They are built as written here and are not decided by the owner.

## Context

08 section 2 says the document service stores, per session, the user agent family and the client
version, and no other personal data about a user beyond the surrogate identifier and a display name
that can be purged. Decision 24 adds: the control plane holds the records in a table of its own, they
are kept as long as the document's history, and a user agent string is reduced to family and major
version. Nothing stored these records before (ADR 0357, choice 15).

## Decisions (proposed)

1. **One row per session and document.** The table is `doc_sessions` (migration 0096), with the key
   `(doc_id, session_id)`. A session that opens three documents has three rows. This is what "kept as
   long as the document's history" needs: the row is removed by the purge of its document (HIS-039)
   and by nothing else. Alternative: one row per session, with a separate rule for when it may go.
2. **The families are a closed list.** `chrome`, `edge`, `firefox`, `safari`, `opera`, `samsung` and
   `other`. Browsers built on another engine keep that engine's family (a Chromium browser that does
   not name itself is `chrome`). An absent header and an unknown agent are both `other`, with no
   version. The major version is a number from 0 to 9999, or unknown. The table refuses any other
   value with check constraints, so no text of a `User-Agent` header can be stored. Alternative: a
   longer list, or a separate value for an absent header.
3. **The client version is kept only when it is shaped like a version.** One to four numbers joined
   by dots, then an optional pre-release tag after `-` and build tag after `+` (letters, digits, dots
   and hyphens), 64 characters at most. `hello.client.version` is any string the client chooses, so
   anything else is stored as unknown. The client's name is not stored: 08 section 2 names the
   version only. Alternative: store the name too, from a list of known clients.
4. **No time is stored.** The row has no column for when the session opened. The commits of a session
   carry their server time; a session that only read would otherwise leave a record of when a person
   looked at a document, which 08 section 2 does not ask for. Alternative: an `opened_at` column.
5. **The channel waits for the record.** The data plane tells the control plane before a channel
   opens, once per session and document, and the channel opens only after the row is stored. When
   the row cannot be stored the channel is refused with `unavailable`, and the failure is logged by
   name with the tenant, the document and the session. So no commit is stored for a session without
   its record. Alternative: record in the background and accept that a commit may name a session
   with no record after a database error.
6. **A forwarded channel is recorded by the node that holds the connection** (BE-062). Only that node
   has the `User-Agent` header and the `hello`. It writes the row before it asks the owning node to
   open the channel. If the owner then refuses the channel (a missing feature, another CDM version),
   the row stays; it holds nothing beyond what is listed above.
7. **Erasing a person leaves their session records** (HIS-038). They name the surrogate, which leads
   nowhere once the mapping row is deleted, as for commits. Alternative: delete them with the read
   markers.

## Consequences

- `services/document-service/src/seams.ts` gains `SessionOpened` and `DataPlaneDeps.sessionOpened`
  (additive). `ServiceParts` gains `sessionRecords`, and the sharded parts route it by tenant.
- A release with this migration does not open a channel while `doc_sessions` is missing. The
  migration is an expand step; its header says how to roll back.
- If the owner chooses an alternative of points 2 to 4, the reducers
  (`services/document-service/src/control-plane/session-records.ts`) and the check constraints change
  together; rows already stored keep what they hold.
