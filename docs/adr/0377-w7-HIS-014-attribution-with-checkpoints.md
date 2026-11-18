# ADR 0377: The room's attribution map and its checkpoints (HIS-014)

Status: proposed. Lane w7, 2026-11-17.

## Context

08 §7 says the room keeps an attribution map next to the document, updates it with each step, and saves it with every checkpoint. `@docedit/history` has the map, `applyCommit`, `attributionAt` and the serial form (`AttributionMap.toJSON`). Nothing in the room or the data plane holds a map: `GET /documents/{id}/attribution` (PRO-055) rebuilds one on every request by replaying the whole log from the content at seq 0 (`attributionMapAt` in `services/document-service/src/control-plane/history-reads.ts`). The checkpoint effect of the room (`packages/authority/src/room/room.ts`) carries `seq`, `doc`, `reason` and `threads` only, and the checkpoint object is the canonical envelope of the document, whose hash `sync.check` carries (`documentHash`), so the map cannot go inside it.

HIS-014 criteria 1 and 4 stay open for this reason. Criterion 1 needs the room host to hold a map and update it as commits become durable. Criterion 4 needs the map to be stored with each checkpoint and read back when a room opens.

## Proposed design

1. **Where the map lives.** The data plane's room host holds an `AttributionTracker` next to the room (`services/document-service/src/data-plane`). It is not in `packages/authority`: `@docedit/history` depends on `@docedit/authority`, so the room cannot import the map. The tracker calls `applyCommit` for each stored steps commit, in order, and replaces its map with a single run of the commit's user and `seq` for a snapshot commit (08 §7).
2. **How it is saved.** A second object beside each checkpoint, `docs/{doc}/attribution/{seq}.json.zst`, written by the checkpointer in the same step as the checkpoint and read by `load`. The checkpoint object itself does not change, so its hash and every reader of it stay as they are.
3. **How a room opens.** From the checkpoint's map plus a replay of the commits after it (`attributionAt`). A checkpoint written before this change has no map: the room builds one by replaying from seq 0, once, and the next checkpoint saves it. This backfill is the open question that HIS-014 Notes already records; the default taken here is to backfill lazily on the first read of a map, not at upgrade time.
4. **The route.** `attributionMapAt` takes the nearest saved map at or before the `seq`, as `attributionAt` already allows, and replays only the commits after it.

## Needs a decision before it is built

- **Erasure.** The sidecar holds user identifiers. The erasure of a person (HIS-038) and the purge of checkpoints (HIS-035, HIS-037) must rewrite or delete these objects, or an erased person stays named in storage. This is a rule for the erasure story and needs the owner's confirmation that the sidecar is in scope of an erasure request.
- **Retention.** Whether thinning keeps a map for every checkpoint it keeps, and drops the rest with their checkpoints.
- **Set-aside after recovery** (BE-078): `setAside` moves checkpoints above a recovered head; the sidecars must move with them.

## Consequences

Nothing is built under this record. Without it a room opens with no map and the route replays the log, which is correct but costs time in proportion to the length of the log.
