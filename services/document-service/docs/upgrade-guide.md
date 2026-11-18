# Upgrading a self-hosted deployment

For operators of a self-hosted document service (BE-095; 06 §13). It covers an upgrade to the next release, an upgrade that skips one minor version, and a rollback.

## What is supported

- An upgrade from the previous minor version (N-1 to N).
- An upgrade that skips one minor version (N-2 to N).
- More than one skipped minor version is not supported. Upgrade to the newest release of each intermediate minor version first, one hop at a time, so that no hop skips more than one.
- A rollback to the previous version, by the steps below.

This guide has not been exercised across two real releases yet. The repository has one release (`0.1.0-phase1a`), so the upgrade and rollback tests of BE-095 criteria 1 and 3 are still open.

## Before you start

1. Read the release notes of every release between your version and the target. A skip does not skip the notes: the database steps and CDM steps of the skipped release still run. Print them from the target release's source tree:

   ```
   pnpm --filter @docedit/document-service migrate notes <release>
   ```

   The output has three parts: the database steps (with the phase of each, expand or contract), the CDM steps, and how to roll back each of them.

2. Take a backup of the database and the object store, and check that it restores (BE-082, BE-096).
3. Check that the target release lists every contract step one release after its expand step (`pnpm --filter @docedit/document-service migrate check`). A contract step that would drop what your version still uses is the reason a skip is limited to one minor version.

## Upgrade

1. Apply the database migrations as the schema owner: `pnpm --filter @docedit/document-service migrate`. They are applied in order, so a skip applies the migrations of the skipped release first. Instances of your current version may keep running while expand steps are applied.
2. Roll out the new service version.
3. Start the CDM migrations the release notes name, if any, when you decide to. Nothing migrates a document when it is opened (BE-094). A release that states no CDM steps changes no document.
4. Check readiness and the health endpoints before you send traffic to the new version.

## Roll back

1. Stop the new version and start the previous one. Expand steps are compatible with the previous version, so it runs against the migrated schema.
2. A contract step cannot be undone by running the old version. Use the rollback note in the release notes for that step, or restore the backup taken before the upgrade.
3. Undo the CDM steps by the note of the release. A document migrated to a newer model version is refused by a component pinned to an older one (`unsupported_cdm`).

## Where the facts are kept

- `migrations/releases.json`: the migrations and CDM steps of each release, with the rollback notes.
- `src/storage/migrate.ts`: the plan check and the release notes.
