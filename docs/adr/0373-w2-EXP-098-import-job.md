# 0373. The Word import job in the document service

Status: proposed (lane w2, 2026-11-17). Not owner decisions.

## Context

EXP-098 asks for `POST /documents/{id}/imports` and `GET /imports/{jid}` (05 §6.2; 07 §12). The importer is `importDocx` in `packages/export-docx`. The document service does not depend on that package, and the sandboxed worker of EXP-099 criterion 1 is not built.

## Decisions proposed

1. **The importer is a port.** `startService` takes `importer: DocxImporter` (`services/document-service/src/control-plane/imports.ts`). With it, the node offers `/imports` and runs the job in process (kind `import`, one attempt). Without it, the routes answer `not_found`. A host passes `importDocx` in. The default `main.ts` does not, because that needs `@docedit/export-docx` as a dependency of this service (a workspace link and a lock-file change), which this lane did not add.
2. **Requests are refused early, jobs check again.** The request is refused with `workflow_active` or `conflict` when a workflow is active or any region of the document is approved: an import replaces the whole content, so every approved region is a region it could change. The job repeats the check against the imported content when it stores, and fails with `conflict` if an approved region differs. The refusal until "the state is changed" is therefore on the document's regions, not on a comparison with a file that has not been read yet.
3. **The job's shape.** `ImportJob` is a placeholder in the protocol (gap G74: `id`, `warnings`). The route also returns `doc`, `state` (`queued`, `running`, `completed`, `failed`, `cancelled`), `stage` while running, `seq` and `warnings` when completed, `error` when failed, and the two times. The schema does not close the object, so this is allowed. A warning from the importer is `{ message }` when it is a string.
4. **Checks before the commit.** The job runs `readDocument` (I1 to I11, with the document's attached and retired identifiers) before it calls the data plane's `replaceContent`. Nothing is stored when it fails, and the job fails with the rules named.
5. **Features.** The job does not add features to the document. A document whose `requires` lacks a feature the import needs (`preserve` for most Word files, under A2) fails the job: the room refuses the snapshot with `validation_failed` (I1) naming the feature. Whether an import may add features is for the owner or the spec (see the Notes of EXP-098).
6. **Assets of the import.** The job stores no asset the importer makes (pictures, the original package, fragments). Content that refers to such assets fails the checks of item 4. `poi/sample.docx` imports without them. Storing them needs the asset registry and EXP-101, EXP-108.
7. **Version, event and webhook.** A completed job creates a version of kind `import` at the commit's `seq`, sends the notification `import.completed` to the requester, and raises `dep.import.completed.v1`. A failed job sends `import.failed` and raises `dep.import.failed.v1` with `seq` 0 and the code.

## Not done

`POST /documents` with `import` (criterion 6) is still refused: an asset is uploaded for a document (`AssetRecord.doc`), so no asset exists before the document does. Criterion 7 needs the workflow and the seal.
