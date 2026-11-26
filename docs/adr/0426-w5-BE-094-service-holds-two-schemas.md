# ADR 0426: The service holds one schema per CDM version it serves (BE-094)

Status: proposed (lane w5, 2026-11-26). The owner has not decided this.

## Context

BE-094 asks for an operator command that migrates documents from CDM version N to N+1. The owner's
decisions 75 and 76 settle that the service supports n and n-1 and that a test-only version 2 exists
to exercise migrations. `@docedit/model` has the migration framework (`migrate()`), the test-only
version 2 and its migration (CDM-049), and the room can store a migration result as a snapshot commit
with origin `migration` (`Room.snapshot`, tested in `packages/authority/test/cdm-049-migration-snapshot.test.ts`).

What the service lacks is a second schema. Twelve modules of `services/document-service/src` call `cdmSchema()` (version 1) to
read or write a document: `data-plane/room-host.ts`, `data-plane/tasks.ts`,
`control-plane/workers/replay-worker.ts`, the history, restore, thread, visibility and workflow
routes. `Room` stamps every commit `cdm: 1`, and `DocumentStore` has no operation that changes
`cdmVersion`. A document whose content holds a version 2 attribute would lose that attribute the
first time version 1 ProseMirror code read it (a ProseMirror node drops attributes its schema does
not declare), so a runner written now would corrupt what it migrates.

## Proposal

1. `DataPlaneSettings` and the control plane's content readers get a map `schemas` from a CDM
   version to a ProseMirror schema, built with `buildSchema(definition)` from `@docedit/model`. It
   holds the versions the deployment serves (decision 75: n and n-1). Version 1 is the default.
2. A function `schemaFor(record.cdmVersion)` replaces `cdmSchema()` at each of those call sites. The
   room host, the checkpoint replay and the control-plane reads then use the schema of the document's
   stored version.
3. `Room` takes `cdm` in `RoomInit` (default 1) and stamps it on every commit. The service registers
   a replayer per `(engine, cdm)` (`replayerKey`), so history written before and after a migration
   replays under the schema it was written with.
4. `DocumentStore.setCdmVersion(ref, from, to)` changes the version with a compare-and-set on `from`.
5. The runner (`control-plane/cdm-migration.ts`) takes a document, a tenant or a list, and a target.
   A dry run calls `migrate()` on the head content and reports, per document, the steps and any
   refusal, and writes nothing. A real run, one document at a time: puts the checkpoint of the head,
   calls `replaceContent` with reason `migration`, then `setCdmVersion`. Open channels receive
   `sync.reset`. A stop leaves every document that has not been reached at version N, where it opens
   and edits as before.

## Consequences

- The change touches the data plane and several control-plane routes at once, so it should be made by
  one lane in one pass, with the conformance kit and the history tests run on a document at version 2.
- Until then BE-094 criteria 2 and 3 stay open, and the operator-gated rule (criteria 1 and 4) is
  already tested.
- Open for the owner: whether a document at version N-1 may keep being edited after the tenant has
  moved on (this proposal says yes, until the operator migrates it, as 06 §13 reads).
