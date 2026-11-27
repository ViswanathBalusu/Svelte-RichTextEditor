# Migrate documents to a newer model version

A document's model version (CDM) changes only when an operator runs this procedure (BE-094; 06 §13;
03 §11.3). Opening a document, a rolling deploy and a client never change it. The design is in
ADR 0435. Until a model version 2 ships, only the tests exercise it (owner decisions 75 and 76).

## Before you start

- Every service node and every embedded component that must keep working has to support the new
  version. `supportedVersions()` of `@docedit/model` gives the range a package supports (CDM-050).
  A component that supports only the older version is refused with `unsupported_cdm` on a migrated
  document and works on one that is not migrated.
- The service serves a version only when the deployment registers its schema and definition
  (`registerCdmSchema`, `src/cdm-schemas.ts`) and the data plane setting `cdm` lets channels use it.
- Hand the runner the migrations of the deployment, one per step (`Migration` of `@docedit/model`).
  A migration is pure: it reads an envelope and returns the next one.
- Decide the scope: one document, a batch (a list of identifiers) or a tenant. Migrate a small batch
  first.

## Steps

1. Dry run: `new MigrationRunner(...).dryRun(scope, target)`. It reads each document, runs the
   migrations, checks the result in the schema of the target version, and writes nothing. Each item
   says `would_migrate` with the steps it would take, `current` (already at the target), `ahead`
   (above the target) or `refused` with the reason (a missing step, a result that is not a valid
   document of the target version).
2. Read the report. A `refused` item is not retried until its cause is fixed.
3. Run: `run(scope, target, { stop, onItem })`. For each document the runner stores one snapshot
   commit with origin `migration`, stamped with the target version:
   - the room writes the checkpoint of the state before the commit when commits came after the last
     checkpoint, then the checkpoint that holds the migrated content, then the commit (08 §3);
   - every channel open on the document receives `sync.reset` with reason `migration`, and the room
     then closes, so each client reconnects;
   - the stored version of the document changes after the commit is stored.
4. To stop, make `stop()` return true. The run ends after the document it is on. Documents it did not
   reach are reported `not_reached`: they keep their version and open and edit as before. Run again
   with the same scope to continue.

## If a run is cut off

The commit may be stored while the stored version still says N. A document in that state refuses to
open (the checkpoint and the stored version disagree) until the run is repeated: the runner sees that
the head of the log is a migration commit of a higher version and only changes the stored version.

## What the room refuses

A migration commit is checked like any other commit. A document with an active workflow is not
migrated (a snapshot commit is refused while a workflow is active), and a migration that would change
an approved region is refused (07 §11). The item is reported `refused` with the room's reason, and
the document is unchanged.

## Not covered yet

The control-plane routes that read or write whole documents (content, import, restore, export,
comments, fields) still read version 1 only. They must read the version of the document before a
version 2 ships. The data plane (rooms, checkpoints, replay, the commit log) already reads each
document in the schema of its own version.
