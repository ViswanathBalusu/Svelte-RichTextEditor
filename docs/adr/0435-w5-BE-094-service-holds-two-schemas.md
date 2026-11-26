# ADR 0435: The service holds the schemas of the versions it serves (BE-094)

**Status:** proposed, 2026-11-26. Recorded by lane w5. Not built. The owner's decisions 75 (n and n-1 are the supported format versions) and 76 (a test-only CDM 2, nothing ships) are the basis; no owner decision chooses the design below, so it is a proposal under the spec's default (06 §13, 03 §11.3).

**Story:** BE-094 (`docs/stories/BE-backend.md`), criteria 2 and 3. **Related:** CDM-049 (ticked, `packages/authority/test/cdm-049-migration-snapshot.test.ts`), CDM-050 (open), BE-039, BE-020.

## Context

BE-094 needs an operator-started migration: a dry run, then a snapshot commit with origin `migration` per document, a checkpoint before and after, `sync.reset` to connected clients, and a stop that leaves the rest of the documents at version N.

The service has one schema today:

- `services/document-service/src` calls `cdmSchema()` (version 1) in 24 places.
- `packages/authority/src/room/room.ts` stamps every commit with `cdm: 1`.
- The checkpoint worker replays onto version 1.
- `DocumentStore` (`room-host.ts` keeps the `DocumentRecord` it loaded) has no way to change a document's `cdmVersion`.

A runner built on these would write a version 2 snapshot that the next read turns into a version 1 document. A ProseMirror node drops attributes its schema does not declare, so the migrated attribute would be lost without an error.

## Decision (proposed)

1. **One schema per served version.** The service keeps a registry of CDM schemas keyed by version (1 and, for tests only, 2). Every `cdmSchema()` call takes the version of the document it works on. Calls without a document (for example the default for a new document) use the newest version the deployment serves.
2. **The room stamps the document's version.** `Room` takes the version from the document record, not a constant, and stamps commits with it. The replayers are looked up by version, as CDM-050 already plans.
3. **`DocumentStore.setCdmVersion(documentId, version)`.** Written only by the migration runner, and only after the snapshot commit and the checkpoint after it are stored.
4. **The runner.** Operator-started only (BE-094 criterion 2). A dry run reports the documents that would change and their counts, and writes nothing. A real run, per document: checkpoint before; snapshot commit with origin `migration`; `setCdmVersion`; checkpoint after; `sync.reset` to the channels open on the document. A stop request ends after the current document, so documents not yet reached keep version N and still open (criterion 3).
5. **Configuration.** The versions a deployment serves are the `cdm` setting already added to `DataPlaneSettings` (BE-094 Evidence). Which versions to serve is the operator's choice; this ADR does not set a default beyond the existing 1 to 1.

## Consequences

- Twelve or more modules change signature. This is one pass across the data plane and the control-plane routes, as the BE-094 Notes say; it should not be split, because a half-done state corrupts documents.
- Criterion 2 of BE-094 needs a test-only version 2 (CDM-050 fixtures). Criterion 3 needs the stop request and a test that stops mid-run.
- No version 2 ships. The migration is exercised only by tests.

## Not decided here

- The rule for a component that opens a document at a version it does not support is already built (`unsupported_cdm`, BE-094 criterion 4) and is not changed.
- The window of old packages kept runnable (08 §15) stays open.
