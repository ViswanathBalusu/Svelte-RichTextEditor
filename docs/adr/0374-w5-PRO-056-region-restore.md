# ADR 0374: Region restore and the restore dry run (PRO-056)

Status: proposed. Lane w5, 2026-11-17.

## Context

`POST /documents/{id}/restore` restored a whole document only. A region restore and a dry run (HIS-018, HIS-021) were refused with `not_found`. `planRestore` in `@docedit/history` checks the gate, the capability, the region's approval and lease, and an active workflow, and computes the result and the dry-run comparison. The control plane has no way to hand a steps commit to a room: its only write path for content is `replaceContent`, a snapshot commit.

## Decisions

1. A region restore and every dry run go through `planRestore`. A caller without `edit` anywhere in the document is refused with `forbidden` before the region is looked at; an unknown region is `not_found`; an approved region or one leased to someone else is `conflict`; a restricted region the caller cannot edit is `forbidden`.
2. A region restore is applied as a snapshot commit with reason `restore` whose content is the current document with only that region restored (the plan's `result`). This is the fallback HIS-018 criterion 4 allows. The review SR-M29 asks for another answer (several commits, or `too_large`); this ADR does not settle that. A restore that changes nothing stores nothing and answers `{ seq, toSeq, unchanged: true }`.
3. The route re-reads the head just before it applies the snapshot and answers `conflict` when a commit has landed since the plan was made. A commit that lands between that read and the room's apply would still be overwritten; closing this needs the room to apply the restore with the plan's preconditions (04 §5), which is a data-plane change.
4. The dry run answers `{ dryRun: true, toSeq, headSeq, region?, kind, unchanged, notes, comparison }` and stores nothing: no version, no commit, no event, no change of grants. `comparison` is the comparison between the head and the result, with user identifiers as `sub` values.
5. Whole-document and region restores share the recording of the `pre-restore` and `restore` versions and the events `dep.document.changed`, `dep.version.restored` and the notice `version.restored` (the notice carries `region` for a region restore).
6. Grants, approvals and leases are never restored.

## Consequences

A region restore replaces the whole document's snapshot, so open channels receive `sync.reset` for it, as for a whole-document restore. Attribution after a restore names the restoring user for the snapshot content (ADR 0373 decision 2).
