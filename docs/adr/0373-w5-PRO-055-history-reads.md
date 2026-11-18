# ADR 0373: The diff and attribution routes (PRO-055)

Status: proposed. Lane w5, 2026-11-17.

## Context

`GET /documents/{id}/diff` and `GET /documents/{id}/attribution` (05 §6.2) are served from the algorithms in `@docedit/history` (`compare`, `attributionAt`, `attributionFor`). The spec leaves the attribution parameters and the result open (gap G68), and the service keeps no saved attribution maps yet (06 §4.2).

## Decisions

1. `attribution` takes `region`, `atSeq` (the version asked about; the head when omitted) and `blocks` (block identifiers, separated by commas) as query parameters. The spec says "a region or a block range" and names no members. `atSeq` is the name the table of sequence inputs already listed (HIS-024 criterion 4, `SEQ_INPUTS`). `atSeq` and `blocks` are added to the operation in `packages/protocol/src/definition/resources.ts` and the generated artifacts are regenerated.
2. The attribution map is replayed from the content at seq 0, which is attributed to the user who created the document, over the stored commits up to `seq`. The content of a snapshot commit (an import or a restore) is attributed to the user of that commit. A restore therefore does not keep the original authors in this route. Saved maps with the checkpoints (06 §4.2) would remove the replay and the restore limit.
3. The reply of `diff` is the comparison as `@docedit/history` builds it: `{ fromSeq, toSeq, method, granularity, region?, changes }`. User identifiers are the tenant's `sub` values, as everywhere on the wire. The reply of `attribution` is `{ seq, spans }`, each span `{ blockId, from, to, user, seq, agent?, restoredBy?, restoredSeq? }`.
4. Both routes need `view` (row `read.history`) and apply the history gate of 07 §8 before any rebuild: a `seq` above the head is `not_found`, one below the gate is `forbidden`. The hidden set of the reader is the union over the head and the versions read (ADR 0019).
5. A comparison of versions that need the aligned method reads the attribution map at `toSeq`, which replays the log. This is a cost to measure; no figure is claimed here.

## Consequences

The routes work in memory and PostgreSQL storage without new tables. The replay grows with the log; saved maps are the later fix.
