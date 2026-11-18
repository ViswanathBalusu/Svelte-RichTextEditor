# ADR 0377: The room's attribution map and its checkpoints (HIS-014)

Status: accepted as proposed (owner decisions 83, 84 and 196 to 220 of `docs/owner-decisions-2026-11-15.md`), with the amendments below. Written by lane w7 on 2026-11-17; built on 2026-11-18.

## Context

08 §7 says the room keeps an attribution map next to the document, updates it with each step, and saves it with every checkpoint. `@docedit/history` has the map, `applyCommit`, `attributionAt` and the serial form (`AttributionMap.toJSON`). Nothing in the room or the data plane holds a map: `GET /documents/{id}/attribution` (PRO-055) rebuilds one on every request by replaying the whole log from the content at seq 0 (`attributionMapAt` in `services/document-service/src/control-plane/history-reads.ts`). The checkpoint effect of the room (`packages/authority/src/room/room.ts`) carries `seq`, `doc`, `reason` and `threads` only, and the checkpoint object is the canonical envelope of the document, whose hash `sync.check` carries (`documentHash`), so the map cannot go inside it.

HIS-014 criteria 1 and 4 stay open for this reason. Criterion 1 needs the room host to hold a map and update it as commits become durable. Criterion 4 needs the map to be stored with each checkpoint and read back when a room opens.

## Proposed design

1. **Where the map lives.** The data plane's room host holds an `AttributionTracker` next to the room (`services/document-service/src/data-plane`). It is not in `packages/authority`: `@docedit/history` depends on `@docedit/authority`, so the room cannot import the map. The tracker calls `applyCommit` for each stored steps commit, in order, and replaces its map with a single run of the commit's user and `seq` for a snapshot commit (08 §7).
2. **How it is saved.** A second object beside each checkpoint, `docs/{doc}/attribution/{seq}.json.zst`, written by the checkpointer in the same step as the checkpoint and read by `load`. The checkpoint object itself does not change, so its hash and every reader of it stay as they are.
3. **How a room opens.** From the checkpoint's map plus a replay of the commits after it (`attributionAt`). A checkpoint written before this change has no map: the room builds one by replaying from seq 0, once, and the next checkpoint saves it. This backfill is the open question that HIS-014 Notes already records; the default taken here is to backfill lazily on the first read of a map, not at upgrade time.
4. **The route.** `attributionMapAt` takes the nearest saved map at or before the `seq`, as `attributionAt` already allows, and replays only the commits after it.

## Amendments when it was built (2026-11-18)

- **Key.** The side object is the one 06 §4.2 already names, `checkpoints/{seq}.side.json.zst` (`objectKeys.checkpointSide`), not `docs/{doc}/attribution/{seq}.json.zst`. Its content is `{ "v": 1, "attribution": <AttributionJson> }`, canonical JSON compressed with Zstandard; the member leaves room for the comment ranges that 06 §4.2 also puts there. The `CheckpointStore` port gained the optional `putSide` and `getSide`; `ObjectCheckpointStore` implements them.
- **Where.** `AttributionTracker` is in `services/document-service/src/data-plane/attribution.ts`. It keeps the map at the last checkpoint and the commits stored since, so the map at the `seq` of a checkpoint is known when later commits are already stored. A room opens one only when the checkpoint store keeps side objects. If the commits it is given cannot be applied, the room drops the map, writes no side object, and the route replays.
- **Order of writes.** The side object is written before the checkpoint. A side object without a recorded checkpoint is never read. A failure to write it is reported and does not fail the checkpoint.
- **Opening.** The saved map must fit the content (same size) or it is dropped and the map is rebuilt from seq 0; the rebuilt map is saved with the next checkpoint. Backfill is lazy, as proposed.
- **Snapshot commits.** The map is one run of the user and `seq` of the commit. A region restore is a snapshot commit (ADR 0374), so a restore does not keep the original authors in the room's map (HIS-018, Notes).

## Decisions taken (the three points the first version left open)

- **Erasure.** The side object holds surrogate identifiers, as the log does. The erase operation of HIS-038 deletes the mapping from a surrogate to a person, so nothing in a side object leads to a person after it (decision 84). Tombstoning a commit (`commit-tombstone.ts`) must still rewrite the side objects at or after it; that belongs to HIS-040 and is not built here.
- **Retention.** A side object lives and dies with its checkpoint. Thinning that drops a checkpoint drops its side object; one that keeps a checkpoint keeps it.
- **Set-aside after a recovery (BE-078).** `ObjectCheckpointStore.setAside` moves the side object with its checkpoint, under the same tag.

## Not built

- The route `GET /documents/{id}/attribution` (PRO-055) still replays the log. Reading the nearest saved map (point 4) is a change to `history-reads.ts` in the control plane and is left to the lane that owns it.
- No thinning of checkpoints exists yet, so the retention rule is stated and not exercised.

## Consequences

A room opens with the map of its checkpoint plus a replay of the commits after it. The commit log stays the source of truth: the map can always be rebuilt from it.
