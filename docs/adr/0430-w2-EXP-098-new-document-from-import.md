# 0430. A new document from an import (`POST /documents` with `import`)

Status: proposed (lane w2, 2026-11-26). Applies owner decision 108 of `docs/owner-decisions-2026-11-15.md`; the choices below that decision does not settle are not owner decisions.

## Context

Decision 108: "The document is created first, the source file is attached to it, then the content is written. A failed import removes the document." `CreateDocumentRequest.import` is a string, an asset identifier. An asset is registered for a document (`AssetRecord.doc`) and is uploaded through `POST /documents/{id}/assets`, so before the new document exists the only way to have a ready `.docx` asset is to have uploaded it for another document of the tenant.

## Decisions proposed

1. **The value of `import` names a ready `.docx` asset of the tenant**, uploaded for any document of the tenant (a staging document the host made for the upload). It is refused with `not_found` (no such asset), `conflict` (not yet ready) or `validation_failed` (not a Word file). The 05 §6.2 text and the schema description ("refused until imports exist") are stale and are for the PRO lane to reword.
2. **Order.** The importer is a pure function of the bytes, so it runs first and nothing is stored if it refuses the file. Then the document is created (empty, at seq 0, listing the features the imported content needs, so the room accepts the snapshot: invariant I1), the source file is attached to it as a record of its own over the same stored bytes (ready objects are shared by hash), and the content is written as a snapshot commit with origin `import`, by the code the import job uses (`storeImported`). Any failure after the document exists removes it (soft delete, as `DELETE /documents/{id}`) and removes the attached record; the response is the error.
3. **Synchronous.** The request waits for the import and answers 201 with the document and an `import` member (`asset`, `warnings`). A job and its polling are for a document that already exists (`POST /documents/{id}/imports`). The importer runs in the service process, as in ADR 0373, so a large file holds the request; the sandboxed worker of EXP-099 changes that.
4. **Not done here.** No `import` version and no `import.completed` event are made for this path; `dep.document.created` carries the commit's `seq`. Whether the new document should also get a version of kind `import` is open.
