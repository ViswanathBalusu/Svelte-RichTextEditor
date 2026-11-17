# 0366: The count of images without alternative text in an export result (lane w2, EXP-113)

- Status: proposed
- Date: 2026-11-15
- Story: EXP-113 criterion 2

## Context

09 §13 says that the export job reports images without alternative text. EXP-113 criterion 2 asks that the job result includes their count. The DEP `ExportResult` (05 §6.2; `packages/protocol/src/definition/resources.ts`) had no member for it, and its schema lists its properties, so a count on the wire is a protocol change. The specification does not name the member, say what is counted, or say which targets carry it.

The job's `diagnostics` cannot give the count. The worker joins equal diagnostics (`dedupe` in `services/export-worker/src/job.ts`), and two pictures without alternative text in one paragraph give two equal diagnostics, so the list is shorter than the number of pictures.

## Decision (proposed; the protocol's owner may change it)

1. `ExportResult` gains an optional member `imagesWithoutAlt`, a count (an integer of 0 or more). Optional, so a client or server of the earlier schema stays valid, in the same way as `chainHead`.
2. It counts occurrences: each `image` and each `figure` node without alternative text counts once, as the shared preflight reports them (`image_without_alt`; EXP-003). Two pictures in one paragraph count as two.
3. The worker sets it for the targets it typesets from a bundle (`pdf` and `tex`), including 0. It is absent for `cdm` and for a worker that does not report it. A client must read an absent member as unknown, not as zero.
4. The count is of the content the job exported. A projected export (ADR 0019) counts only what the requester may read.
5. The control plane copies the worker's number into the result only when it is a non-negative integer.

## Not decided here

- Whether a `final` export with `pdfStandard` `ua-2` must fail when the count is above zero. 09 §13 says only that the job reports it (EXP-113 Notes). The job does not fail.
- Whether the `export.completed` event and the `dep.export.completed` webhook should carry the count. They carry the job as before.

## Consequences

`spec/dep/dep-1.schema.json`, `spec/dep/dep-1.openapi.json`, `spec/dep/dep-1.manifest.json` and `packages/protocol/src/generated/types.ts` were regenerated with `pnpm --filter @docedit/protocol generate`. The prose of decision D68 in `packages/protocol/src/definition/decisions.ts` lists the members of a result and does not name the new one; it was left as it is for the protocol's owner.
