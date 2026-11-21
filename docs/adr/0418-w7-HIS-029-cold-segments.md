# ADR 0418: Cold segments of commit payloads (HIS-029)

Status: proposed (lane w7, 2026-11-20). 08 section 11 and 06 sections 4.1, 4.2 and 10 say that
commit payloads older than 30 days move from PostgreSQL to compressed segment objects, that the
metadata rows stay, and that history across the boundary reads both. No owner decision of
`docs/owner-decisions-2026-11-15.md` covers this story. The points below are what the spec leaves
open. They are built as written here and are not decided by the owner.

## Context

`@docedit/history` already held the rules (`coldMovePlan`, `moveSegment`, `readPayloads`), tested on
in-memory stores. Nothing in the document service called them. The earlier notes of HIS-029 stopped
at one question: a payload can leave PostgreSQL only through a role that may delete from
`doc_commit_payloads`, and the service role may not (migration 0002; SEC-029 rests on that).

## Decisions (proposed)

1. **The role is `docedit_purge`.** The job runs over the pool of `DOCEDIT_PURGE_DATABASE_URL`, the
   login the purge of deleted documents (HIS-039), the payload thinning (HIS-032), the tombstone
   (HIS-040) and the checkpoint thinning (HIS-030) already use. That role holds `delete` on
   `doc_commit_payloads` since migration 0073, so the service role gains nothing and the log stays
   append-only for it. Migration 0097 gives the purge role `select, insert, update, delete` on the
   new index table and the service role `select`. Alternative: a role of its own, `docedit_retention`,
   with a pool of its own (the note of 2026-11-17). It would separate moving from purging in the
   database, at the price of a third login for operators.
2. **The index is `commit_cold_segments`, with a `pending` state.** One row per segment: the range,
   the object key, the state and the number of payloads the object holds. A move writes a `pending`
   row in a transaction of its own before it writes the object, so that a move that dies leaves a
   record of the object it may have written. The payload rows are deleted, and the row becomes
   `moved`, in one transaction, only after the object was written and read back with every payload
   hash equal to the hash in its commit. A read never looks at a `pending` row. The next run starts by
   deleting the objects and rows that are `pending`. No hash of the whole object is stored (the note
   of 2026-11-17 proposed one): each payload is checked against the hash the chain covers when it is
   read, which is the stronger check.
3. **One lock per document.** Every change to a document's segment objects (a move, the clearing of a
   half-done move, a rewrite) holds a transaction-level advisory lock named after the document. Two
   runs, or a move and a removal, therefore never write the same object at the same time. The
   transaction stays open while its holder talks to object storage; the server ends a session that
   waits too long in a transaction, which rolls it back.
4. **Nothing above the newest checkpoint moves.** A room loads from the newest checkpoint and replays
   what follows it, so with this rule opening and editing a document never need a cold segment
   (criterion 5). A document without a checkpoint above 0 moves nothing. It is the rule HIS-032 and
   HIS-040 already use. Opening a room also read the payload of the commit at the checkpoint, for
   its access revision; that revision is now read from the commit's metadata.
5. **A segment holds at most 2,000 payloads and 5 MiB of canonical payload.** A longer run is cut into
   several segments. The numbers are the commits between two checkpoints (08 section 3) and the
   catch-up limit (04), so that a read of one old commit loads a bounded object. They are proposed
   defaults, not measurements, and are options of `ColdSegments`. A segment's name is its range,
   as 06 section 4.2 says.
6. **30 days, per deployment.** `DOCEDIT_COLD_AFTER_DAYS` (default 30). ADR 0010 said 180 days; 08
   section 11, 06 section 10 and the later note in ADR 0006 say 30, which this follows. The job is
   daily and per tenant (`payloads.cold`), over live documents only; a soft-deleted document is left
   to the purge.
7. **A legal hold does not stop the move** (criterion 6). The task is not one of the scheduler's
   deleting tasks. The audit event of a move, `history.moved`, says whether a hold was in force,
   with the counts of segments, payloads and bytes, and never content.
8. **A segment that cannot be read is `unavailable`, with `Retry-After`.** So is a payload that does
   not match its hash: nothing is served in its place. A payload that its segment no longer holds is
   answered as any removed payload is (`not_found`, owner decision 206).
9. **Thinning and tombstones reach into segments.** With payloads moving at 30 days, a tenant's
   thinning period would otherwise never remove anything. `payloads.thin` plans over the payloads in
   the table and in segments together, and takes the removed ones out of their segment objects,
   which are written again under the same name and read back. A segment left with nothing is
   deleted, object and row. A tombstone takes the one payload out of its segment and then records
   the tombstone. The daily thinning opens a segment only when it holds more payloads than the plan
   would keep in its range (the index row has the count), so a segment that was thinned is not read
   again each day. Alternative for tombstones: only report the segment as a copy, as HIS-040 did
   while no segment existed.
10. **A stored start does not hide a nearer checkpoint.** The REST content reader replays from the
    newest state it has rebuilt before. When that replay needs a payload that is removed or in an
    unreadable segment, it now tries the newest checkpoint at or before the wanted state, so the
    answer does not depend on what the process has in memory.

## Consequences and limits

- After a move the segment object is the only copy of its payloads outside backups. The bucket's
  versioning and replication (06 section 4.2) carry them, as they carry checkpoints.
- In a bucket with versioning, an object that was written again or deleted (thinning, a tombstone,
  the purge) leaves earlier versions until the bucket's lifecycle rule expires them. The service
  does not delete versions. The same holds for checkpoints and for the purge of HIS-039.
- The job runs only where a purge login is configured. Without one no payload moves and nothing
  else changes. Reading moved payloads needs no such login.
- The sharded composition (`shardedPgParts`, BE-070) has no purge login per shard, so no payload
  moves there, and its log stores are not given the object store to read segments from. It is not
  built here.
- An older release reads a moved payload as a removed one. A rollback after payloads have moved
  hides the detail of that history until this release runs again; no payload is lost by it.
- A room that opens without a stored attribution map rebuilds it from the whole log, which now
  reads the segments. If one cannot be read the room opens without the map, as it does after any
  failure of that rebuild.
- The first run on a deployment with years of history moves all of it, one document after the
  other, in segments of the size above. No run time is stated because none has been measured.
- If the owner chooses the separate role of point 1, only the grants of migration 0097 and the pool
  the job is given change.
