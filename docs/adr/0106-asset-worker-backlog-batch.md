# ADR 0106: Asset-worker backlog batch (BE-042 to BE-045, SEC-037, SEC-038, SEC-040, SEC-046)

Status: proposed (2026-11-13, backlog round 1 for `services/asset-worker`)

## Context

`services/asset-worker` owns the worker side of uploads: the quarantine upload, the sandboxed
checks and re-encoding, the content-addressed final object, and the signed-URL asset origin. Most
of the criteria in the stories above are split between the worker and the control plane (routes,
rows, capability checks, `asset.ready` and `asset.failed` events, PRO-061 and PRO-062). This batch
ticked only the criteria that the worker's own tests prove.

## What this batch did

- SEC-037 criteria 1 and 2 ticked. Criterion 1 gained a test that declares the hash of an existing
  asset, of the same tenant and of another, and checks that the object is keyed by the worker's own
  hash and that no write reaches the owner's key (`test/worker.test.ts`, "ignores a declared hash of
  an existing asset ..."). Criterion 2 is covered by the existing two-tenant tests.
- SEC-046 criteria 2, 3 and 4 ticked, on the serving side (`test/origin.test.ts`). Criteria 1 and 5
  (issuing and revocation) stay open: they need the control plane's capability check.
- No other criterion changed. The tests that need Podman (`test/sandbox.podman.test.ts`) and the
  Versity S3 gateway (`test/s3.test.ts`, part of it) were not run in this batch: they were skipped
  because no container engine or gateway was running in the session.

## Criteria that stay open, and why

| Story | Criterion | Reason |
|---|---|---|
| BE-042 | 1, 2, 4, 5, 6 | Control-plane route, row, capability check, job queueing and the registry answer (PRO-061). The worker's `checkDeclaredUpload` and `presignQuarantineUpload` are built and tested. |
| BE-043 | 2, 3 | The spec says the asset becomes `failed` or `ready` and that `asset.failed` or `asset.ready` is raised, and the row is written by the control plane (PRO-061 criterion 3). The worker reports the outcome; the events are not raised here. |
| BE-044 | all | Attachments and `doc_assets` rows belong to the control plane and the persist transaction (BE-024). Not in this package. |
| BE-045 | 1 | Resolve route and permission check (PRO-062). |
| SEC-037 | 3 to 6 | Commit rejection (`invalid_op`), resolve by another document, quarantined asset URLs and guessed identifiers all go through the control plane. |
| SEC-038 | 4 | The hang and memory kill is tested in the Podman sandbox (not run here). The criterion also requires `asset.failed` to be raised, which the control plane does. |
| SEC-046 | 1, 5 | Issuing after the capability check and revocation are control-plane behaviour. |

## Open questions (not decided here)

1. Reading of "asset.failed is raised" and "asset.ready is raised" in BE-043 criteria 2 and 3.
   This batch reads them as control-plane criteria, as the story's own Notes say. The owner should
   confirm that the worker's outcome record counts as the worker's half. Spec default: keep open
   until the control plane raises the events.
2. SEC-046 criterion 4 ("a signed URL for one object, used for another object, is refused") is
   ticked on the reading that the object's hash is part of the signed text, so an altered path
   fails the signature. The owner should confirm that this reading is enough, or ask for a test
   that signs two objects with the same key and crosses them.
   Round 2 (2026-11-13): that test now exists. `test/origin.test.ts`, "refuses a URL for one object
   used for another, even with the same key and expiry", crosses the signatures of two objects and
   passes. The owner still confirms the reading.

## Consequences

The next round for this package needs the control plane (PRO-061, PRO-062, BE-024 persist
transaction) before the remaining criteria above can be ticked. Podman and the S3 gateway are
needed to re-run the sandbox and object-store tests in full.

## Round 3 check (2026-11-13)

No criterion was ticked in this round. Every criterion still open in the eight stories needs the
control plane, the S3 gateway or a browser, as the table above says. The worker's own tests were
re-run and pass.

- `pnpm vitest run services/asset-worker` (Node.js): 96 passed, 8 skipped.
- `test/sandbox.podman.test.ts`, `test/origin-isolation.test.ts` and `test/s3.test.ts`, run on
  their own: 15 tests passed and 8 skipped, across 2 files passed and 1 file skipped. The Podman
  image `localhost/docedit-asset-worker:dev` was present and the sandbox tests ran. The skip reasons
  were not inspected one by one. The S3 gateway (`infra/test-env.ps1`) was not running, and
  Playwright's Chromium is not installed, so the S3 and browser evidence for BE-042 criterion 3,
  SEC-037 criterion 2, BE-043 criterion 7 and SEC-040 criteria 4 and 5 was not re-run this round.
- Correction to the table above, SEC-046: the file has six criteria. Criterion 2 is an exact
  duplicate of criterion 1 (issuing after the capability check, which the control plane owns) and
  stays open. Ticked are criteria 3 (expiry), 4 (altered path, key, tenant or query) and 5 (a URL
  used for another object). The round 2 line "criteria 2, 3 and 4 ticked" refers to the same
  three behaviours under the earlier numbering. The duplicate criterion in
  `docs/stories/SEC-security.md` should be removed by the owner or the main session.

Open, not decided here: whether SEC-046 criterion 1 should keep its wording or be merged with
criterion 2. The spec default is to leave the story text as it is. Owner to confirm.
