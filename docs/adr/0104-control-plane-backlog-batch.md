# ADR 0104: Control-plane backlog batch

**Status:** proposed, 2026-11-13. Packet C-1b (control plane) of `docs/stories/PLAN-1b.md`. The
project owner has not reviewed any of it.

## About this record

This record has three sections. The first is the earlier packet C pass on the export job stories
(EXP-004 to EXP-008). Its text was overwritten in round 1 by a pass that did not read it, and no
git history exists to recover it. Section 1 is therefore rebuilt from the story Notes and code
comments that cite this record or name packet C (`docs/stories/EXP-export.md` EXP-004 to EXP-008,
`services/document-service/src/control-plane/exports.ts`). It keeps every question those Notes
point to, but it may not match the lost text word for word, and a decision the lost text held that
no Note repeats is lost. Section 2 is round 1 as it was written. Section 3 is the review fix of
round 1.

## 1. Earlier pass: export jobs (EXP-004 to EXP-008), rebuilt

### Stories and what stays open

| Story | Left open | Why |
|---|---|---|
| EXP-004 export jobs | 4, 6, 7 | 4: `export.cancelled` is sent and the job ends `cancelled`, but stopping the worker and discarding its sandbox are packet D's (the compile worker). 6: the version of kind `export` is HIS-007's. 7: a `seq` below the head is built from the content at that `seq`, but the manifest that records it is packet D's. |
| EXP-005 export options | 4, 6 | 4: no defaults for `locale` and `timeZone` are set, and the values used are not recorded in `manifest.json` (packet D). 6: the manifest, as for 4; the request key already includes the options (EXP-006). |
| EXP-006 first result for the same bundle | 3 | The request key includes the house class version (`exportRequestKey`, unit-tested), but the route-level check needs two services that share one job queue, which the harness does not build. |
| EXP-008 previews only while someone looks | 1, 5 | 1: needs a test that drives a commit through the commit route and checks that no job is queued. 5: page-break reconciliation is phase 3 (EXP-057). |

### Decision taken (spec default, recorded for review)

1. **The `pdfStandard` values accepted.** The service accepts the published definition's `known`
   list, `ua-2` and `a-4` (`packages/protocol/src/definition/resources.ts`,
   `ExportOptions.pdfStandard`; `PDF_STANDARDS` in `exports.ts`). The schema's `examples` name the
   same two. The wire format takes any string, so any other value is refused with
   `validation_failed` (EXP-005 criterion 3).

### Open questions

- **Q1. Does the `pdfStandard` list grow?** 09 §13 names PDF/UA-2 and PDF/A-4. Whether other
  standards (for example other PDF/A parts) are accepted is not specified. Cited by EXP-005 Notes
  and `exports.ts`.
- **Q2. What are the defaults of `locale` and `timeZone`?** 09 §9.1 does not give them. Until they
  are decided the job sets none, and EXP-005 criterion 4 stays open. Also in the Open questions of
  `EXP-export.md` (EXP-005, EXP-019, EXP-084).
- **Q3. May `final` be combined with `tagging` set to `draft` or `off`?** Not specified. The
  service accepts every combination today. Also in the Open questions of `EXP-export.md`.

## 2. Round 1 (2026-11-13)

### Context

Packet C owns `services/document-service/src/control-plane`. Most of its stories were built in
phase 1a or earlier in packet C; several have code and tests with open criteria. This round takes
the stories whose remaining criteria can be met inside that directory and tests them there.

### Stories taken this round

| Story | Ticked | Left open | Why |
|---|---|---|---|
| BE-034 idempotent creates | 1 to 5 | none | Tests exist (`test/control-plane/idempotency.test.ts`); the PostgreSQL variant was skipped (no database). |
| BE-047 font manifest | 1 to 3 | none | New unit tests in `src/control-plane/fonts.test.ts`. The `GET /fonts` route is not exercised by them. |
| BE-052 scheduled maintenance | 1, 3 | 2, 4 | New tests in `src/control-plane/scheduler.test.ts`. Criterion 2 names kinds that other stories build. Criterion 4 was ticked in this round and unticked by the reviewer; see section 3. |

### Decisions taken (spec defaults, recorded for review)

1. **Test placement.** New tests for this packet go in `src/control-plane/*.test.ts`, the owned
   directory, not in `test/control-plane` (outside it). Existing tests in `test/control-plane`
   are cited by their story Evidence and were not edited.
2. **Criterion 5 of BE-034.** The 24-hour retention is the default (`DAY_MS` in `pipeline.ts`).
   The test runs the registered purge function directly, not the scheduler's timer. The scheduler
   is tested on its own in `scheduler.test.ts`.
3. **Criterion 3 of BE-047.** `fontsEtag` is tested as the source of the ETag. Whether the route
   returns `304` on a repeated `If-None-Match` is not decided here and is not claimed.

### Not verified in this round

- PostgreSQL variants (`test/control-plane/idempotency.test.ts`, `queue.test.ts`) skipped: no
  database running. The production stores are therefore verified only through their in-memory
  contract in this round.
- No Podman, container or browser run.

### Needs from other packets or the main session

- `test/control-plane/routes.assets.test.ts` ("resolves ready, attached assets the caller can see
  to short-lived URLs", PRO-061 criterion 4) fails here with `400` where `200` is expected (line
  256). The asset routes or the test body changed; the owner of PRO-061 and the asset packet
  (S) should look at it. Not in this packet's directory.
- BE-052 criterion 2 needs the other maintenance kinds (BE-014, BE-046, HIS-029, HIS-030,
  HIS-033, HIS-036, FRW-056).

## 3. Review fix of round 1 (2026-11-13)

### BE-052 criterion 4 stays open

Criterion 4 ("sets that tenant's context and honours legal holds") was ticked on a test that
injects its own `onHold` predicate. `src/server.ts` builds the `Scheduler` without one, and no hold
store exists (HIS-031, phase 2), so in the running service no tenant is ever skipped. The criterion
stays unticked.

What exists and is tested, as the mechanism only (`src/control-plane/scheduler.test.ts`):

- a task that deletes data skips a tenant for which `onHold` says yes, and other tasks still run
  for every tenant;
- a task of the same shape as `idempotency.purge` in `src/server.ts`, run through the scheduler on
  `MemoryIdempotencyStore`, removes only the expired keys of the tenant it runs for, skips a held
  tenant, and purges that tenant in the next slot once the hold is released.

The tenant context in PostgreSQL is set by the store (`inTenant` in `src/storage/db.ts`, called by
`PgIdempotencyStore.purge`). That path was not run here: no database.

### Open question

- **Q4. At what level does the scheduler honour a hold?** 08 §11 says a legal hold "suspends
  thinning and purge for a document", and HIS-031 places it on a document. The scheduler's
  `onHold` takes a tenant, so wiring it to a document hold would stop every deleting task for the
  whole tenant. It is also not stated whether idempotency keys and quarantined uploads are held
  data at all: 08 §11 speaks of history. This is not decided here. The likely shape is a per-document
  check inside the tasks that thin or purge history (HIS-030, HIS-032, HIS-039), with `onHold`
  kept or removed when HIS-031 is built.

### Needs from the main session

- Wiring `onHold` (or its replacement after Q4) to the hold store in `src/server.ts`, with a test
  through the server composition that a held document's data is not purged. `src/server.ts` is
  outside this packet's directory, and the hold store waits for HIS-031.

## 4. Round 2 (2026-11-13)

### Stories taken

| Story | Ticked | Left open | Why |
|---|---|---|---|
| BE-050 separate previews from requested exports | 1 to 4 | 5 | Queue claim rules tested in `jobs/priority.test.ts`. Criterion 5 needs the queue depth in `/metrics`, which `src/server.ts` (outside the packet) must register. |
| EXP-007 separate queues with per-tenant limits | 1 to 4 | 5 | Same test file. Criterion 5 needs a capacity sheet, which the repository does not hold. |
| PRO-067 read the font manifest | 1 to 4 | none | `fonts.route.test.ts` over `GET /v1/fonts` and the service's `/fonts/` route. |

BE-052 criterion 4 stays unticked, as the review of round 1 left it. Its Notes and Q4 above
carry the reason. Nothing in round 2 changes that.

### Decisions taken (spec defaults, recorded for review)

1. **Tenant limit queues the job.** When a tenant is at its limit of running jobs of a kind, its
   further jobs wait `queued` (EXP-007 criterion 3, "stay `queued`"). The alternative,
   `quota_exceeded`, is the open question of BE-092 and EXP-007 Notes; it is not decided here.
2. **One queue, two kinds.** The queue serves previews and exports from one table, separated by
   kind and priority (ADR 0054), not from two physical queues. EXP-007 criterion 1 is ticked on the
   claim rules: a worker for one kind never takes the other kind, and a waiting preview is taken
   first. Whether a deployment needs two physical queues is a phase 2 question, not decided here.
3. **Font route test uses a service token.** `GET /v1/fonts` is `security: BOTH` in
   `packages/protocol/src/definition/resources.ts`; the test calls it with a service JWT. The user
   token path is not tested here.

### Not verified in this round

- PostgreSQL variants of the queue tests (`priority.test.ts` runs on the memory queue only).
- BE-050 criterion 5 and EXP-007 criterion 5: left open, see the table.
- No Podman, container or browser run.

### Needs from the main session

- Register a queue-depth gauge (`Metrics.gauge` in `src/control-plane/metrics.ts`) in
  `src/server.ts`, so BE-050 criterion 5 can be ticked.
- An owner or main-session decision on BE-092 (queue or `quota_exceeded` over the tenant limit)
  and on ADR 0104 Q4 (the level at which a hold applies), before the hold wiring.

## 4. Round 3 (2026-11-13): PRO-013, PRO-043, PRO-050

### Context

This round is the third packet C pass. It re-checks stories whose code and tests already exist and
whose checkboxes were never ticked. It writes no code. Every test named below exists and passed
(`pnpm vitest run services/document-service/test/control-plane/idempotency.test.ts
services/document-service/test/control-plane/routes.documents.test.ts` and the owned directory:
7 files, 51 tests passed, 30 skipped; the skips are the PostgreSQL variants, no database here).

### Stories taken this round

| Story | Ticked | Left open | Why |
|---|---|---|---|
| PRO-013 service credential | 1, 2, 4 | 3 | 3: the control plane gives the data plane the `DEP-Actor` surrogate; the history record is HIS-014 and HIS-015. |
| PRO-043 idempotency keys | 2 to 6 | 1 | 1: tested for documents and exports only. Versions, threads, comments, imports and webhooks are not built or not tested for replay. |
| PRO-050 import snapshot | 3 | 1, 2, 4 | 1 and 2: the snapshot commit and `sync.reset` are the data plane's. 4: the invalid-content refusal is tested; that the content is unchanged and that an approved region is refused are not. |

### Decisions taken (spec defaults, recorded for review)

1. **Test placement.** The Evidence lines cite the existing tests in `test/control-plane`, as the
   earlier Evidence lines of these stories do. No test file was added this round, so the owned
   directory has no new tests here.
2. **PRO-043 criterion 4.** The test shortens the retention with the harness setting
   `idempotencyTtlMs`, which is the mechanism of `test-hooks.ts`. It is not the kit's test-mode
   timers (PRO-109, packet K). The criterion is ticked on that basis and the Note says so. Owner
   may prefer to leave it open until packet K.
3. **PRO-043 criterion 1.** Left open rather than ticked for the kinds that are not built. The
   spec does not say whether a kind not yet built blocks the criterion. Owner question.

### Open questions

- **Q4. Does PRO-043 criterion 1 wait for every creating route?** It names versions, threads,
  comments, assets, exports, imports and webhooks. The default taken here: the criterion waits
  until each kind exists and is tested for replay.

### Not verified in this round

- PostgreSQL variants of `idempotency.test.ts` and `routes.documents.test.ts` skipped: no database.
- No Podman, container, browser, or whole-repository check was run.

## 5. Round 5 (2026-11-13): FRW-060, FRW-061, PRO-047, PRO-043 fix

### Context

The round starts with the review fix of PRO-043 criterion 4. Packet K (`packages/tck`) exists, but no kit scenario reads the idempotency retention from `/_test/timers`. The criterion's kit clause is therefore unmet, and the criterion is unticked again. The round then covers the field routes, which had code but no tests.

### Stories taken this round

- **FRW-060** (criteria 1, 2, 5 ticked; 3, 4 and the redaction clause of 6 open). Tests in `services/document-service/src/control-plane/fields.test.ts`. Memory store; PostgreSQL skipped (no database here).
- **FRW-061** (criteria 2, 3 ticked; 1, 4, 5, 6, 7 open). Same test file. The accepted path needs a room or a transient authority to apply the commit, which the harness does not run, so the tests refuse before the outbox.
- **PRO-047** (criteria 2, 5 ticked; 1, 3, 4 open). Evidence in the existing `test/control-plane/routes.documents.test.ts`, which passes in this round.
- **PRO-043** (criterion 4 unticked again, with a Note).

### Decisions taken (spec defaults, recorded for review)

- **D-R5-1. PRO-043 criterion 4 is unticked.** Its kit clause ("the kit uses the test-mode timers of PRO-109") is read literally as mandatory, which is the reviewer's stated alternative. The service side remains tested. Owner question below.
- **D-R5-2. Refusals in FRW-061 return the codes of the registry.** `field_invalid` is 422 (the registry's status), not 400. The tests assert 422.
- **D-R5-3. Server-set kinds are refused one request at a time.** The test sends each of `signature`, `initials`, `dateSigned` and `formula` by key, as criterion 2 lists them.

### Open questions

- **Q5. Is the kit clause of PRO-043 criterion 4 mandatory?** If so, the criterion stays unticked until packet K has a scenario that reads `/_test/timers`. Default taken: unticked.
- **Q6. Does a `seq` below the caller's gate return `not_found` or `forbidden` on the field routes?** FRW-060 criterion 4 says "as for content at a `seq`". The content route's code is reused; no test covers a gate refusal on this route yet.

### Not verified in this round

- PostgreSQL variants of `fields.test.ts` skipped: no database running.
- No Podman, container, browser, or whole-repository check was run.
- The accepted prefill path (FRW-061 criterion 1) was not run: it needs the outbox consumer.

## 6. Round 5, second pass (2026-11-13): PRO-061, PRO-062, BE-079, BE-085

### Stories taken

| Story | Ticked | Left open | Why |
|---|---|---|---|
| PRO-061 upload through quarantine | 1, 3, 5 | 2, 4 | 1, 3, 5 pass in `test/control-plane/routes.assets.test.ts` (memory). 2: no test shows the store refusing a body over its declared size. 4: only a failed asset is tested as not ready. |
| PRO-062 resolve to short-lived URLs | none | 1 to 4 | The resolve test in the same file fails at HEAD (see below), so no criterion is ticked. |
| BE-079 fault-injection hooks | 5 (3 and 4 unticked by review) | 1, 2, 3, 4 | New `src/control-plane/test-hooks.test.ts` tests the handler with a stub data plane. 1: the mount in `server.ts` and the production refusal in `config.ts` are not tested here. 2: the timers are reported, not shown to change behaviour. |
| BE-085 cost meter | 2 | 1, 3, 4 | New `src/control-plane/metrics.test.ts`: the scrape carries the tenant label and no content. 1: open-room time, memory and connection time have no counter. 3 and 4: BE-091, BE-092 and UX-076 are not built. |

### Finding: a failing test outside the packet

`services/document-service/test/control-plane/routes.assets.test.ts`, test "resolves ready, attached
assets ...", fails with `400` where `200` is expected. Cause: the test sends `randomUUID()`, a
version 4 identifier, in `assets`. `ResolveAssetsRequest` in `spec/dep/dep-1.openapi.json` requires a
version 7 UUID, so the body is refused before the handler runs. This replaces the earlier guess in
section 2 that the asset routes had changed; they have not. The fix is `uuid7()` in that test. The
file is outside `src/control-plane`, so it is listed for the main session and was not edited.

### Decisions taken (spec defaults, recorded for review)

1. **Tests for this packet live in `src/control-plane`.** `test-hooks.test.ts` and `metrics.test.ts`
   are new; the Evidence of PRO-061 and BE-079 cites the existing test files where the behaviour is
   tested there.
2. **BE-079 criteria 3 and 4 were ticked on the handler and unticked by review.** The stub returns
   constants and records calls, so the tests show routing only; the data plane's own hook
   implementation (packet A) is not run for these criteria.
3. **BE-085 criterion 2 is ticked on the scrape of a tenant's own counters.** A tenant label that
   differs from another tenant's is not separately asserted beyond the `OTHER` samples in the same
   scrape.

### Open questions

- **Q7. Does PRO-062 criterion 2 (expiry) need a fetch after the expiry, or is the signature check
  enough?** The existing test checks the verifier's `expired` result, which is the function the asset
  origin uses. Default taken: that is enough, once the test passes.
- **Q8. Where does the "production refuses test mode" check of BE-079 criterion 1 belong?** `config.ts`
  is outside this packet. Default taken: a test in the composition's package, not here.

### Needs from other packets or the main session

- Fix `randomUUID()` to `uuid7()` in `services/document-service/test/control-plane/routes.assets.test.ts`
  (line 256 region), then PRO-062 criteria 1 to 4 can be ticked on that test.
- Register the queue-depth gauge (BE-050 criterion 5) and the compile-seconds recording in `src/server.ts`.

### Not verified in this round

- PostgreSQL variants of `routes.assets.test.ts` skipped: no database running.
- No Podman, container, browser, or whole-repository check was run.
- Type-check of `services/document-service/tsconfig.json`: no errors in the new files; two errors
  remain in `src/data-plane/recovery.test.ts` (another packet).

## 7. Round 6 (2026-11-13): EXP-006, EXP-008, BE-037

### Stories taken

| Story | Ticked | Left open | Why |
|---|---|---|---|
| EXP-008 previews only while someone looks | 1 | 5 (and the rest already ticked) | New test in `src/control-plane/export-jobs.test.ts`: a commit appended to the log store leaves no preview job; a preview asked for afterwards is queued (the control). Criterion 5 is phase 3 (EXP-057). |
| EXP-006 first result for the same bundle | 3 | none | New test in `src/control-plane/export-jobs.test.ts`: a second `startService` over the same stores, with another `exportClassVersion`, compiles the same request again; the first service still answers from its result. Memory storage only; the PostgreSQL run is skipped. |
| BE-037 replace content as a snapshot | 2, 3, 4 | 1, 5 | New `src/control-plane/content-replace.test.ts` with a stand-in data plane that records its calls. 1 needs the outbox (BE-039) and `sync.reset`, which are the data plane's. 5 needs the route to accept `Idempotency-Key` (Q9). |

### Decisions taken (spec defaults, recorded for review)

1. **Stand-in data plane for BE-037.** The data plane's `replaceContent` is replaced by a recorder in the test, so criteria 2 to 4 test what the control plane refuses or passes on. Criterion 1 is not claimed.
2. **Criterion 3 of BE-037 tests the request body limit.** The content routes use `maxContentBodyBytes`, which equals the canonical limit (`config.ts`). A raw body above it is refused as `too_large` before the canonical check runs. The canonical-form size check of `readDocument` cannot be reached by a body, since canonical form is no larger than the raw JSON in these tests; the Evidence says so.
3. **Second service for EXP-006 criterion 3.** The test starts a second service over the first harness's stores rather than changing the harness, so the existing harness and its callers are untouched.

### Open questions

- **Q9. Does `PUT /documents/{id}/content` accept `Idempotency-Key`?** 05 §6.1 and 05 §6.2 are read here as saying that a creating route accepts it. `packages/protocol` sets `idempotencyKey` on `createDocument` and the other creating routes, but not on `replaceContent`. The control plane only reads the header on routes with the flag. Default taken: the route does not accept it, and BE-037 criterion 5 stays open. Owner of `packages/protocol` (PRO) to decide.

### Needs from other packets or the main session

- `services/document-service/test/control-plane/routes.assets.test.ts` still fails at its resolve test (`randomUUID()` where `ResolveAssetsRequest` needs a version 7 UUID). The file is outside this packet. The fix is `uuid7()` for the unknown asset identifier; PRO-062 criteria 1 to 4 and PRO-061 criterion 4 wait for it.
- The file `test/control-plane/routes.content.test.ts` already covers the BE-037 credential, If-Match and content checks; it was not edited.

### Not verified in this round

- PostgreSQL variants of the new tests skipped: no database running.
- No Podman, container, browser or whole-repository check was run.
- Type-check: `pnpm exec tsc --noEmit -p services/document-service/tsconfig.json` reported no errors in `src/control-plane` (exit 0 at the time of the run).

## 8. Round 8 (2026-11-13): BE-051

### Stories taken

| Story | Ticked | Left open | Why |
|---|---|---|---|
| BE-051 preview compile limits | 1, 2, 3 | 4 | New test in `src/control-plane/export-jobs.test.ts`: "starts no second preview compile while the window runs, and answers the same request with the pending job" (memory store). Criteria 2 and 3 are covered by existing tests of that file (EXP-006, EXP-008). Criterion 4 needs a reconciliation request option or a tenant setting, neither of which exists. |

### Decisions taken (spec defaults, recorded for review)

- **D-R8-1. "The pending or latest result" (BE-051 criterion 1).** The same request inside the window gets the pending job back. A different request gets its own job, queued until the window ends (`export-routes.ts`, `delayMs`). No compile starts inside the window in either case. The reading that the different request should instead receive the latest result of another bundle was not taken, because that result is not the one asked for.
- **D-R8-2. Criterion 4 stays open.** No request option names page-break reconciliation, and no tenant setting exists. Adding either would invent a wire name, which the spec does not give. Phase 3 (EXP-057) decides both.

### Open questions

- **Q10. Should a different preview request inside the window get a queued job or the latest result of the document?** BE-051 criterion 1 is read as a queued job of its own (D-R8-1). The owner may prefer otherwise.

### Not verified in this round

- PostgreSQL variant of `export-jobs.test.ts` skipped: no database running.
- No Podman, container, browser or whole-repository check was run.

## 9. Round 9 (2026-11-13): PRO-047, PRO-050, FRW-060

### Stories taken

| Story | Ticked | Left open | Why |
|---|---|---|---|
| PRO-047 read a document | 1 | 3, 4 | 1: new `src/control-plane/document-state.test.ts` (memory; PostgreSQL skips here). GET returns `properties` and `state` through `locked`, `archived` and `active`, the ETag changes each time, and a stale `If-Match` gets `precondition_failed`. 3: `test/server/server.test.ts` shows a lock refused with `read_only` and `perm.changed`, but not `document.updated`, the revision increase, or an archived document. 4: `ch.open` `not_found` and purging are the data plane's and HIS-029/HIS-030. |
| PRO-050 import snapshot | 4 | 1, 2 | 4: `src/control-plane/content-replace.test.ts` shows that refused content (invalid, or a change to an approved region) never reaches the stand-in data plane, and that the valid control is stored. 1 and 2 are the data plane's (snapshot origin `import`, `sync.reset`). |
| FRW-060 read fields and field values | 3 | 4, 6 (redaction clause) | 3: new `src/control-plane/field-values-seq.test.ts`. A commit built with the prefill steps of FRW-061 is appended to the log; the head shows the new value, and `?seq=` before it still shows the old one, immutable and identical on repeat. 4: no test sets up a caller whose `minVisibleSeq` is above zero. 6: no hidden region is set up. |

### Stories checked and left open

- PRO-061 criterion 2 (the store refuses an upload over its declared size): the presigned upload is bound to the size (`assets.ts`, `presign`), but no test shows a store refusing a larger body. Left open.
- FRW-061 criterion 4 (TeX and markup stored as typed data and escaped on the PDF): the PDF half is packet X's emitters. Left open.
- BE-032 criterion 6 (bare identifiers resolved to their document): only `/exports/{jid}` and `/assets/{aid}` exist; threads, comments, imports and workflow participants are not built. Left open.
- BE-085 criterion 1: `DRIVERS` in `metrics.ts` has no counter for open-room time, room memory or connection time; those are the data plane's. Left open.
- BE-036 criteria 3 to 5: a bound of 2,000 commits needs BE-020 checkpoints, and the shared-cache rule of criterion 4 contradicts the private cache required by ADR 0019 (D70). Left open.

### Decisions taken (spec defaults, recorded for review)

- **D-R9-1. PRO-047 criterion 1 reads "state" as the state field of the GET body.** The test changes state through PATCH, so the value is shown as the route returns it, not as stored in the grants.
- **D-R9-2. The field-values test builds its commit with `prefillSteps`.** The steps are the same pure function the prefill route uses (FRW-061), so the test does not depend on the outbox, which is not run here.

### Not verified in this round

- PostgreSQL variants of the new tests skipped: no database running.
- No Podman, container, browser or whole-repository check was run. `pnpm exec tsc --noEmit -p services/document-service/tsconfig.json` reported no errors; `pnpm vitest run services/document-service/src/control-plane` passed 162 tests and skipped 24 (PostgreSQL variants).
