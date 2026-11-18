# BE Document service

**Status:** first draft, 2026-11-06, written from specification draft 0.2. Not yet reviewed. Every number is a target to validate, not a measurement.

This epic covers the reference document service of [06 Backend](../spec/06-backend.md), written in Node.js: the gateway, the room host and its rooms (ownership, lifecycle, the persist pipeline with group commit, fan-out), the behaviour of the control API, the PostgreSQL schema of 06 §4.1, object storage, Redis or Valkey from stage 2, assets and the font manifest, the job queue, the indexer, the webhook dispatcher, scaling stages 1 to 3, several regions, failure modes, recovery objectives, cost instrumentation, observability and support tooling, tenancy and quotas, operations, self-hosting adapters, and the deployment of the authority service. Sources: 06 (all), [ADR 0006](../adr/0006-postgres-plus-object-storage.md), and the sync, security and product items of the [pitfall review](../review/2026-09-18-pitfall-review.md) (sections 3.1, 3.2, 3.6 and 6).

Per README §2.3, this epic leaves the following to other epics, and references them by placeholder:

- **PRO** owns the wire contract: envelope, messages, token claims and verification rules, REST conventions and resources, the error registry, the webhook contract and signatures, the authority service interface and the conformance kit. BE stories describe what the reference service does to honour that contract.
- **SYN** owns the authority algorithm (04 §5), rebase, presence rules and admission control; **PRM** owns the outcome check, grants semantics, leases, region states and the history visibility gate; **HIS** owns what a commit record holds, retention policy, restore and tamper evidence; **EXP** owns the converter, the compile workers and DOCX import; **FRW** owns fields, workflow, evidence and the signing service; **UX** owns the administration API and the reference host; **SEC** owns the threat-model verification of everything here.
- The unit-cost sheet is a phase 0 note owned by **SPK**. BE only instruments the cost drivers.

## Service shape, adapters and deployment artefacts

### BE-001 Run the stage 1 document service as one process

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 06 §1; ADR 0006 · **Requirements:** R9 · **Depends on:** FND-001, FND-002

As a maintainer, I want the gateway, the room host and the control API to start as one Node.js process with a pool of worker threads, so that stage 1 needs no forwarding between processes and no bus.

**Acceptance criteria**

- [x] Given a configured PostgreSQL database, when the service starts, then one process terminates WebSockets, serves the control API and hosts rooms, and answers the discovery request PRO-008.
- [x] Given no Redis or Valkey and no bus is configured, when two channels open on the same document, then both reach the same room inside the process and nothing is forwarded.
- [ ] Given a checkpoint serialisation, a log replay for a content read, a comparison or a conversion is requested, when it runs, then it runs in a worker thread and the main thread keeps acknowledging commits for other rooms.
- [x] Given a worker thread crashes, when the failure is detected, then the request that depended on it fails with the retryable code `internal` and the process keeps serving other rooms.
- [x] Given the database is unreachable or the schema version does not match the code, when readiness is probed, then the service reports not ready.

**Evidence:** `services/document-service/src/server.ts` composes one HTTP server: REST under `/v1`, discovery, the JWKS of minted tokens and the probes, and the WebSocket upgrades of `/dep`, which go to the data plane of packet A1; no bus. `services/document-service/test/server/server.test.ts` runs it with the real data plane: a token minted over REST says hello and opens a channel on a document created over REST; two channels on one document share one room (a commit on one reaches the other, and REST content then has it); a worker that crashes fails its task with `internal` while the next read is served (`control-plane/workers/pool.ts`); readiness is false when the database is unreachable or its newest migration is not the code's, and `/readyz` answers 200 or 503 (migration 0007 lets the service role read the bookkeeping table).

**Evidence (lane w5, 2026-11-15, criterion 3, not ticked):** `services/document-service/test/server/be-001-replay-other-rooms.test.ts` (Node.js, the one-process service over the in-memory stores with one worker thread, started inside the test process): 40 pinned content reads of a document with 120 commits, one after another, are each replayed in the worker thread (`content.replays` rises by 40, the pool's thread is not the main one, no worker is replaced) while a channel on another document submits commits; at least 10 of them are acknowledged before the reads end. Measured on this development machine (Windows 11, Node.js 22, ten runs of the test with `--silent=false`, other lanes' work running at the same time): the 40 replays took 700 to 1,313 ms, 89 to 98 commits of the other room were acknowledged meanwhile, the longest wait for one acknowledgement was 15.8 to 51.8 ms, and the event loop's longest delay (`monitorEventLoopDelay`) was 11.2 to 47.1 ms. Checkpoint serialisation in a worker thread while commits are acknowledged is `test/data-plane/be-020-worker-checkpoint.test.ts` (BE-020 criterion 3), and the encoding of imported content is in the pool in `test/data-plane/syn-039.v-syn-037-053.workers.pg.test.ts`.

**Notes:** The spec gives no figure for how long the main thread may block; the performance harness sets the budget (open question in this file). The terminate-signal behaviour is BE-022. Lane w5 (2026-11-15): criterion 3 stays unticked for one reason only. The service has no comparison yet: `GET /documents/{id}/diff` (08 §6) is not served by the control plane (`src/control-plane/history-routes.ts` names it as not in this lane), so nothing shows a comparison running in a worker thread. Checkpoint serialisation, log replay and the conversion of imported content run in worker threads and are tested (see the evidence above). A finding for the performance harness: when the same 40 pinned reads were asked for at once instead of one after another, the event loop stalled for 139 to 441 ms in six runs and only 2 to 6 commits of the other room were acknowledged meanwhile. That time is the main thread's own share of a read (reading the log, copying the document and steps to the worker, serialising the response), which no worker removes; a bound on simultaneous replays per node would limit it, and the spec names none. Packet A2 (2026-11-06): criterion 3 stays open. The log replay of content reads runs in worker threads, but checkpoint serialisation, comparison and conversion do not exist yet, and no measurement shows the main thread acknowledging other rooms while a replay runs. Settings and the platform reads are in ADR 0036 (proposed).

### BE-002 Define the adapter interfaces and their contract tests

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 06 §14, §2.1; ADR 0006; ADR 0013 · **Requirements:** R6, R9 · **Depends on:** BE-001

As a maintainer, I want the reference service to reach its environment only through named interfaces with shared contract tests, so that a self-hosted deployment can swap a part without touching rooms or the control API.

**Acceptance criteria**

- [ ] Given the service source, when its imports are listed, then each of `LogStore`, `CheckpointStore`, `AssetStore`, `GrantStore`, `TokenVerifier`, `Queue`, `Bus`, `EventSink` and `KeyService` is a TypeScript interface and rooms and handlers import no concrete driver.
- [x] Given the `LogStore` contract suite, when it runs against an implementation, then an append with a stale ownership epoch, a stale head or an existing (document, `seq`) fails and stores nothing, and an append with the right epoch and head stores the commits and advances the head atomically.
- [x] Given a candidate log store that cannot do a conditional append, when the suite runs, then it fails, so no such store passes as a `LogStore`.
- [ ] Given the PostgreSQL implementations of `LogStore`, `GrantStore` and `Queue`, when the suites run in CI, then all pass.
- [x] Given one adapter is replaced through configuration, when the service starts, then it uses the replacement with no change to room or control API code.
- [x] Given `KeyService`, when its operations are listed, then it can sign or unwrap using a key it holds and has no operation that returns private key material.

**Evidence:** `services/document-service/src/storage/types.ts` defines `LogStore`, `OwnershipStore`, `GrantStore` and `DocumentStore`; `PgLogStore`, `PgGrantStore` and `PgDocumentStore` implement them over PostgreSQL and `MemoryStore` in process. The contract checks in `test/contract/checks.ts` (stale epoch, a gap after the head, an existing `seq`, a replaced grants revision, an all-or-nothing batch, a conflict on the commit identifier alone, control commits, tenant isolation, retired regions, revisions and their history) pass against both (`test/contract/memory.test.ts`, `test/postgres/contract.pg.test.ts`). The same checks run against `UnconditionalLog`, a store that appends without conditions, fail on the epoch, the head, the existing `seq`, the revision and atomicity (`test/contract/memory.test.ts`). `KeyService` (criterion 5): `services/document-service/src/storage/key-service.ts` (the interface and `MemoryKeyService`) with `src/storage/key-service.test.ts`: a signature verifies with the public JWK alone, a data key wrapped with the public half unwraps again (property test), a disabled key refuses sign and unwrap while another key works, wrong purposes and unknown keys are refused, and the operation names carry no private material.

**Evidence (lane U-BE-001-014, round 2):** `services/document-service/test/server/be-002-adapter-config.pg.test.ts` (criterion 5, run in Node.js with PostgreSQL and the Versity S3 Gateway in Podman): `configFromEnv` with DOCEDIT_S3_* settings and a PostgreSQL URL starts `startService` with the PostgreSQL log and the `S3ObjectStore`; an object written through the service's store is read back by a separate S3 client; without S3 settings the same composition keeps objects in `MemoryObjectStore`. Criterion 4 stays open: `services/document-service/test/postgres/contract.pg.test.ts` passed locally against PostgreSQL in Podman (16 tests, 2026-11-13), but no CI workflow runs it (FND-010, a root configuration change).

**Evidence (lane w5, 2026-11-15, criterion 1, not ticked):** `services/document-service/src/adapters.ts` names the interfaces of 06 §14 and where each is declared. Eight of the nine are TypeScript interfaces: `LogStore`, `CheckpointStore`, `GrantStore` and now `AssetStore` (`src/storage/types.ts`; the class over an `ObjectStore` is renamed `ObjectAssetStore`), `TokenVerifier` (`src/control-plane/tokens.ts`, implemented by `TokenService`; the request pipeline and the test hooks depend on the interface), `Queue` (declared as `JobQueue`, `src/control-plane/jobs/queue.ts`), `EventSink` and `KeyService`. `services/document-service/test/contract/be-002-ports.test.ts` (3 tests, Node.js) checks the declarations and follows the run-time imports of the source: no module of the rooms (`src/data-plane`, without `pg/`, the command-line tools and `recovery.ts`) reaches the PostgreSQL client, the S3 or Azure adapters or a PostgreSQL adapter module, and no handler module (`handlers.ts`, `*-routes.ts`, `kit.ts`, `pipeline.ts`) imports one directly. To get there, `isUuid` and `assertUuid` moved to `src/storage/ids.ts` and `diffPermissions` to `src/storage/permission-change.ts` (both still exported from their old modules).

**Notes:** Lane w5 (2026-11-15): criterion 1 stays unticked for two reasons. (1) `Bus` has no interface: stage 1 has no bus (06 §1) and the stage 2 transport is an open issue (06 §16; BE-059), so its shape was not guessed here; the forwarding code of BE-062 takes its transport as two functions. (2) The handlers still load the PostgreSQL helpers indirectly, through three modules that keep an interface, its in-memory implementation and its PostgreSQL implementation in one file (`control-plane/assets.ts`, `idempotency.ts`, `tenants.ts`); the test pins that list so it can only shrink, and moving the three PostgreSQL classes to files of their own empties it. Criterion 4 stays unticked: `.github/workflows/ci.yml` has the job `integration`, which starts PostgreSQL and the S3-compatible store with Podman and runs `pnpm test` against them (the `LogStore` and `GrantStore` contract suite in `test/postgres/contract.pg.test.ts`, the PostgreSQL queue in `test/control-plane/be-050-priority-postgres.test.ts` and `be-052-scheduler-postgres.test.ts`), but no run of that job on a hosted runner has been observed from this checkout, and the queue has no contract suite shared between its in-memory and PostgreSQL implementations. BE-071 (a log-optimised store) and BE-072 (a managed queue) depend on these suites. Phase inferred: the interfaces are needed from the first write path and the roadmap does not place them. `KeyService` follows ADR 0013: signing keys stay in a key service and workers hold none. Still to do: `CheckpointStore` and `AssetStore` (BE-003), `TokenVerifier`, `Queue` (BE-049), `Bus` and `EventSink`; `KeyService` has an interface and an in-memory implementation (criterion 5, ADR 0105, proposed), and no PostgreSQL or KMS implementation yet; selecting adapters by configuration needs the service process (BE-001); no CI workflow starts the database yet (FND-010).

### BE-003 Store files in an S3-compatible object store

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 06 §4.2, §14; ADR 0006 · **Requirements:** R9, R10 · **Depends on:** BE-002

As a maintainer, I want `CheckpointStore` and `AssetStore` implemented over an S3-compatible API with the key layout of 06 §4.2, so that checkpoints, cold segments, assets, exports and sealed PDFs have one predictable home per tenant.

**Acceptance criteria**

- [x] Given a checkpoint, a cold segment, a quarantined upload, a final asset, an export and a sealed PDF, when each is written, then its key is `tenants/{tenant}/docs/{doc}/checkpoints/{seq}.cdm.json.zst` (with `.side.json.zst` for side data), `…/segments/{fromSeq}-{toSeq}.payloads.zst`, `tenants/{tenant}/quarantine/{asset}`, `tenants/{tenant}/assets/{sha256}`, `tenants/{tenant}/exports/{job}/…` or `tenants/{tenant}/final/{doc}/{workflow}.pdf` respectively.
- [x] Given a call made with tenant A's context, when it names a key under tenant B's prefix, then the adapter refuses it before any request is sent.
- [x] Given a sealed PDF already stored at its key, when a second write to that key is attempted, then it is refused (write-once).
- [ ] Given an S3-compatible server in CI, when the `CheckpointStore` and `AssetStore` contract suites run, then they pass.

**Evidence:** `services/document-service/src/objects/` (`store.ts` key layout of 06 §4.2 and the tenant guard, `s3.ts` Signature Version 4 adapter, `checkpoints.ts` `ObjectCheckpointStore` and `AssetStore`). `services/document-service/test/control-plane/objects.test.ts`, against memory and the Versity S3 Gateway of the test environment: every key kind of criterion 1; a key under another tenant's prefix is refused before any request (a recording store sees no call); a second write of a sealed PDF is refused; the CheckpointStore and AssetStore contract cases pass, and a signed URL reads the object without credentials while a changed one is refused.

**Notes:** How write-once is enforced (object lock or adapter rule) is not stated in the spec. Phase 1a is inferred: the demo exports a PDF, and 13 §11.2 lists object storage in the compose file; checkpoints themselves arrive in BE-020 (1b). Packet A2 (2026-11-06): criterion 4 stays open: the contract cases pass against the Versity S3 Gateway of the test environment (`services/document-service/test/control-plane/objects.test.ts`), but no CI workflow runs them yet (FND-010). Write-once checks that the key is absent and sends `If-None-Match: *`; on a server that ignores the header the two are not atomic (ADR 0036). Lane w5 (2026-11-15): criterion 4 is blocked on a hosted CI run, nothing else. The workflow now has the job: `integration` in `.github/workflows/ci.yml` starts PostgreSQL and the Versity S3 Gateway with Podman (`infra/test-env.ps1 run -NoExport pnpm test`), and `pnpm test` includes `test/control-plane/objects.test.ts`. No run of that job on a hosted runner can be observed from this checkout (nothing is pushed from a lane, and no CI client is installed here), so the criterion is not ticked on the strength of the workflow file. Local run on 2026-11-15 on this development machine, against the Versity S3 Gateway v1.10.0 container of the test environment (`docedit-test-s3`, 127.0.0.1:57070): `pnpm exec vitest run --project node services/document-service/test/control-plane/objects.test.ts`, 9 of 9 passed, the four S3 cases among them; this run was made after `AssetStore` became an interface and its class `ObjectAssetStore` (BE-002). To tick: one green run of the `integration` job, named here with its date and commit.

### BE-004 Store files in Azure Blob Storage

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | M | could | Operator |

**Spec:** 06 §14; 01 §5, §7 · **Requirements:** R9 · **Depends on:** BE-002, BE-003

As an operator running a self-hosted deployment on Azure, I want an Azure Blob adapter in the reference distribution, so that I do not need an S3-compatible gateway.

**Acceptance criteria**

- [x] Given an Azure Blob container, when the `CheckpointStore` and `AssetStore` contract suites run, then they pass.
- [x] Given the adapter writes any object, when its key is inspected, then it follows the same layout and tenant prefix as BE-003.
- [x] Given a sealed PDF already stored, when a second write is attempted, then it is refused.
- [x] Given the adapter is selected in configuration, when the service starts, then no S3 settings are required.

**Evidence (lane V-BE-001-014, Azurite emulator in Podman, not a live Azure account):** `services/document-service/src/objects/azure.ts` (`AzureBlobObjectStore`, the `ObjectStore` port over the Blob service with Shared Key requests and service SAS URLs). `services/document-service/test/objects/be-004-azure-blob.test.ts` (7 tests, run with `pnpm exec vitest run --project node services/document-service/test/objects/be-004-azure-blob.test.ts`): the object round trip and the listing return the 06 §4.2 keys under the tenant prefix (criterion 2); a sealed PDF is written once with `If-None-Match: *`, and a second write raises `ObjectExistsError` (criterion 3); the CheckpointStore and the AssetStore contract cases of BE-003 pass (criterion 1, the same cases as `test/control-plane/objects.test.ts`); a signed URL reads without credentials and a changed one gets 403. `services/document-service/test/objects/be-004-azure-config.test.ts` (4 tests): `DOCEDIT_AZURE_ACCOUNT` selects the store with no `DOCEDIT_S3_*` setting (`src/config.ts`, `src/server.ts`); both stores at once are refused; a service started with that configuration writes through its own store and the bytes are read back from Azurite (criterion 4). Scope: the emulator implements the Blob service API used here; a live Azure account was not available, so the criteria are proven against the API and not against Azure's service. Round 3 fix (V-FE-001-016): both files probe Azurite with a top-level `await` and gate on `describe.skipIf`, with a warning, so they skip without Azurite instead of failing (the three configuration-only tests still run). The endpoint is `DOCEDIT_AZURITE_ENDPOINT` (test settings, then the process environment), defaulting to `http://127.0.0.1:57321/devstoreaccount1`; the test environment has no Azurite entry yet. Run on 2026-11-14: with no Azurite, 3 passed and 8 skipped; with Azurite in Podman on 127.0.0.1:57000 (container `docedit-v-fe-001-016-azurite`, removed afterwards), 11 of 11 passed.

**Notes:** Phase inferred: 06 §14 lists the adapter as part of the reference distribution without placing it; self-hosting is not scheduled first (11 §10, decision 8), so it is placed with the reach items of phase 4.

### BE-005 Start the whole stack from a compose file

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 06 §13; 13 §11.2; 11 §3 · **Requirements:** R6, R15 · **Depends on:** BE-001, BE-003, BE-012, EXP-001

As an integrating developer, I want one compose file that starts the document service, PostgreSQL, object storage and an export worker, so that I can run the minimum demo and develop against a real service.

**Acceptance criteria**

- [ ] Given a clean checkout and a container runtime, when the compose file is started, then the document service, PostgreSQL, an S3-compatible store and one export worker are running and the service reports ready.
- [x] Given the stack is up, when a development tenant is looked up, then it exists with a key set and allowed origins seeded from the compose configuration (BE-012).
- [x] Given the stack is up, when the smoke suite of the `core` profile runs against the discovery URL PRO-108, then it passes.
- [ ] Given the export worker container in the stack, when it is inspected, then it has no network access.
- [x] Given the compose file is stopped and started again, when the same volumes are used, then documents and their history are intact.

**Review (round 3, 2026-11-13): criterion 4 unticked.** `infra/containers/compose.json` is the integration-test environment (PostgreSQL, S3, the worker image), not the stack that starts the document service. The test builds a fresh container from copied options and inspects that; it does not inspect an export worker of the stack, and the demo stack's worker (`apps/reference-host/compose.json`) has `network_mode: host`. The test shows that Podman honours `--network=none`, which is a useful check but not this criterion. The test also timed out twice at 60 s in the reviewer's runs and passed once (32 s) with `podman create` taking 3.5 s by hand; it has no timeout of its own. Round 3 fix (V-FE-001-016): criterion 4 stays unticked. The stack's worker claims jobs from PostgreSQL and writes to the store, so it cannot run with no network as defined; only its sandbox can. Whether the criterion means the worker or its sandbox is the owner's (ADR 0114). The test's header now states its partial scope, and the inspect test has a 120 s timeout (it passed in 60 s on 2026-11-14 on this machine).

**Evidence (lane V-BE-001-014, criterion 4, not accepted by review):** `services/document-service/test/stack/be-005-export-worker-inspect.test.ts` (Node.js, Podman, `pnpm exec vitest run --project node services/document-service/test/stack/be-005-export-worker-inspect.test.ts`, 2 tests passed). It reads the export-worker service of `infra/containers/compose.json` and creates a container from `localhost/docedit-export-worker:test` with that service's options (`--network=none`, read-only root, `--cap-drop=ALL`, `no-new-privileges`, user 10001:10001, tmpfs), then inspects it: NetworkMode `none`, ReadonlyRootfs `true`, EffectiveCaps and BoundingCaps empty, user `10001:10001`. The container is never started and is removed afterwards. Scope: this is the test-environment compose file that BE-005 names; the demo's `apps/reference-host/compose.json` still gives its export worker `network_mode: host` (see Notes).

**Evidence (lane w5, criteria 2, 3 and 5; criterion 1 run but not ticked):** the stack of `apps/reference-host/compose.json` was started on this development machine (Windows 11, Podman 6.0.2 in a WSL machine) with `pwsh -NoProfile -File apps/reference-host/scripts/stack.ps1 up`, under the project name `docedit-demo-w5` and the ports 58432, 58470, 58480 and 58490 (run of 2026-11-16, 01:18 to 01:35 UTC; removed afterwards with `down -Volumes`). The script reads the compose file and starts PostgreSQL 17.11 and the Versity S3 Gateway as Podman containers with named volumes, and the set-up, the document service, the seed, the reference host and the export worker as Node.js processes with the commands the file gives; the export worker compiles in the sandbox image `localhost/docedit-export-worker:demo`. `services/document-service/test/stack/be-005-stack.test.ts` (Node.js, run with `DOCEDIT_DEMO_STACK=1` and `DOCEDIT_DEMO_STACK_RESTART=1` and the same settings; skipped with a warning otherwise), 3 of 3 passed: (criterion 1) both containers are running, `/readyz` answers 200, discovery announces `regions` and `exports`, and a PDF export of a new document is claimed by the worker, completed and read back from the store through its signed URL; (criterion 2) the tenant of the stack's configuration exists in PostgreSQL (`PgTenantRegistry`), with the host's user key by its `kid`, its API key, and exactly the origins the stack's settings give the reference host; (criterion 5) a document with two commits made over the WebSocket has the same content, `seq`, incarnation and commit list after `stack.ps1 down` (containers removed, processes ended, `/readyz` unreachable) and `up` on the same volumes. Criterion 3: `stack.ps1 kit` ran the conformance kit's `core` profile against `http://127.0.0.1:58480/.well-known/dep` with the host's service credential, before and after the restart: 67 passed, 0 failed, 3 skipped (two need the server's test mode, one needs more commits than a scenario makes), exit code 0.

**Notes:** Lane w5 (2026-11-16): criterion 1 is not ticked although its outcome was seen, because the compose file itself was not started by Compose. This machine has no Compose provider (`podman compose` finds neither `podman-compose` nor `docker-compose`), and on a WSL Podman machine Compose cannot pass `--cgroups=disabled`; `stack.ps1` starts the same definitions, with the Node.js services as host processes, so the image `localhost/docedit-demo-node:dev` of `apps/reference-host/containers/Containerfile` was neither built nor run. To tick it: one run of `podman compose -f apps/reference-host/compose.json --env-file apps/reference-host/stack/.env.example up --build` on a machine with a Compose provider, followed by the test above; or the owner's word that starting the file through `stack.ps1` is what the criterion means. Criteria 2, 3 and 5 are ticked on the stack that script starts: their conditions are about the running stack and its volumes, which were real. Criterion 4 is unchanged: whether "the export worker container" is the worker or its sandbox is the owner's (ADR 0114); in this run the worker was a host process, and its sandbox is defined with `network_mode: none` (not inspected in this run). The reference host application and its own compose services are UX's. Cross-check: the hardened sandbox of phase 1b (EXP-068, EXP-070) replaces the phase 1a worker container without changing this stack. Round 2 (reference-host packet): the demo's own definition is `apps/reference-host/compose.json`, not the `infra/containers/compose.json` this story names, and it is checked only as configuration (`apps/reference-host/test/stack.test.ts`): its `export-worker` service has `network_mode: host`, so criterion 4 is not met for the worker (only its sandbox, `export-sandbox`, has `network_mode: none`). Round 4: criterion 2's seeding is tested in memory (`apps/reference-host/test/registration.test.ts`: the file that `scripts/setup.ts` writes, read by the service's `parseSeed` and `applySeed`, gives the tenant its host key and origins), but a tenant looked up on a running stack needs the containers, so it stays unticked. Criteria 1 to 3 and 5 need containers or PostgreSQL and stay unticked; the choice of the worker's network is for the owner (`docs/adr/0114-reference-host-backlog-batch.md`).

### BE-006 Install the service with a Helm chart

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | should | Operator |

**Spec:** 06 §13 · **Requirements:** R9, R15 · **Depends on:** BE-001, BE-016, BE-022

As an operator, I want a Helm chart for production, so that I can deploy, upgrade and roll back the stage 1 service on Kubernetes.

**Acceptance criteria**

- [ ] Given a cluster, a PostgreSQL database and an object store, when the chart is installed with their addresses, then the service becomes ready.
- [ ] Given secrets (database credentials, signing keys for service-minted tokens), when the chart is rendered, then they are referenced from a secret store and never written into values files or images.
- [ ] Given a new chart version, when it is upgraded in place, then migrations run before the new pods take traffic and the old pods drain as in BE-022.
- [ ] Given the chart, when it is rolled back one release, then the previous version starts against the expanded schema (BE-016).

**Notes:** Phase inferred: 11 §4 lists "Stage 1 deployment" in phase 1b without naming the artefacts.

Lane w5 (2026-11-17): no criterion ticked and no chart written. All four criteria ask for a real run: install on a cluster and see the service ready (1), render the chart (2), upgrade in place with migrations before traffic (3), and roll back one release (4). This machine has neither `helm` nor a Kubernetes cluster (`kubectl` and `minikube` are installed, but no cluster is running and there is no Helm client, so a chart cannot be rendered, linted or installed). Downloading Helm or its container image needs the owner's permission. A chart that was never rendered would be an untested artefact, so none was added. To unblock: a Helm 3 client and a cluster (for example `minikube start` with the images of the service loaded), then write `infra/helm/docedit/` with the migration as a pre-upgrade hook Job, the readiness probe on `/readyz` and the drain settings of BE-022, and run `helm lint`, `helm template`, `helm install`, `helm upgrade` and `helm rollback`. Secrets would be `secretKeyRef` or an `existingSecret` value only, so that criterion 2 can be tested on the rendered output.

### BE-007 Deploy the authority service as a container

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | M | could | Operator |

**Spec:** 06 §15; 05 §10, §9 · **Requirements:** R6, R9 · **Depends on:** PRO-102 to PRO-107, BE-005, BE-006

As an operator whose backend is not written in JavaScript, I want the authority service packaged as a container with compose and Helm entries, so that my gateway and storage can delegate document semantics to it.

**Acceptance criteria**

- [ ] Given the image, when it is started with the compose file or the chart, then it serves the interface of 05 §10 and reports ready.
- [ ] Given the container is killed and restarted, when `open(doc, checkpointRef, commits, stateId)` is called again, then it rebuilds the document from storage and the next `applyCommit` returns the same result as before the kill.
- [x] Given two replicas, when a call arrives for a `stateId` one of them does not hold, then that replica rebuilds from storage instead of failing.
- [ ] Given the authority service profile of the conformance kit, when it runs against the deployed container, then it passes.

**Evidence (lane w5, criterion 3; criteria 1 and 2 built and run, not ticked):** `services/authority-service/test/container.test.ts` (Node.js and Podman 6.0.2 in the WSL machine on this Windows 11 development machine; off unless `DOCEDIT_AUTHORITY_CONTAINER=1`; run of 2026-11-18, 2 of 2 passed in 26 s with cached layers; containers named `docedit-authority-test-w5*` on random ports, removed afterwards, and the images removed). Criterion 3: three containers on loopback: a storage container serving `GET /states/{stateId}`, and two replicas of the image started from the options of `services/authority-service/compose.json` with that storage URL. `open` is sent to replica A only; replica B, which has never seen the document, answers `GET …/content` with `200` and the canonical bytes that `@docedit/authority` gives, and a state that storage lacks stays `404 unknown_state`. In-process: `services/authority-service/test/replicas.test.ts` (8 pass: a rebuild is read from storage once and then held; also for `evaluateRules`; after a restart; storage `404`, `500` and unreachable give `unknown_state` and `storage_unavailable`; a tampered log or another state under the name is refused as `chain_broken` or `state_mismatch`; the token and the settings). Code: `services/authority-service/src/{service,storage,config,main}.ts`, `Containerfile`, `Containerfile.dockerignore`, `compose.json`. Choices: docs/adr/0392-w5-BE-007-authority-service-container.md (proposed); the wire is ADR 0314 decision 3, accepted as the starting point by owner decision 193, and the Rust backend of decision 96 does not change the Node.js service (docs/owner-decisions-2026-11-15.md).
**Notes:** The interface and its conformance profile are PRO's; the roadmap puts "the authority service as a product" in phase 4 (11 §7). The service holds no state that matters (05 §10). Lane w5, 2026-11-18: criterion 3 ticked. Criterion 1 is not ticked: the image was built and run, `/v1/authority/ready` answered `ready` and open, materialise and evaluateRules served the bytes of the package, but from `podman run` with the options of `compose.json`, not by Compose (this machine has no Compose provider; as for BE-005 criterion 1), and there is no Helm chart (BE-006 is not built), so no `helm install` ran either. To tick it: `podman compose -f services/authority-service/compose.json up --build` on a machine with a Compose provider, then the test above; or the owner's word that the `podman run` of the test is what the criterion means. Criterion 2 is not ticked: the container was killed and started again, held nothing (`404`) and rebuilt the same bytes after `open`, but the next `applyCommit` cannot be shown because `applyCommit` (PRO-104) is not built. Criterion 4 is not ticked: the authority service profile (PRO-125) has no scenarios. The Helm entry waits for BE-006. The interface has no login of its own; an optional bearer token and a private network are the guard (ADR 0392).

## Schema, tenancy and users

### BE-008 Decide the hash-partition count of the log tables

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 1a | S | must | Maintainer |

**Spec:** 06 §4.1, §13; ADR 0006 · **Requirements:** R9 · **Depends on:** —

As a maintainer, I want the partition count of `doc_commits` and `doc_commit_payloads` decided before the first migration, so that stage 3 does not need a rebuild of the log.

**Acceptance criteria**

- [ ] Given the stage 3 targets (1,000,000+ stored documents, 100,000+ connections), when the decision is taken, then a record states the chosen count and the reasoning.
- [ ] Given that the count is fixed at creation (06 §13), when the record is written, then it says so and says what changing it later would require.
- [x] Given the decision, when the migrations of BE-009 are written, then they read the count from one constant that cites the record.

**Evidence:** `services/document-service/migrations/0002_documents_and_log.sql` creates the partitions from one constant (`partitions constant int := 64`) that cites `docs/adr/0020-commit-log-storage.md`; `test/postgres/schema.pg.test.ts` checks that the constant occurs once, cites the record, and that both tables have that many hash partitions on `doc_id`.

**Notes:** The spec says the count is "chosen for stage 3" and gives no number. Time box: a day, with the evidence from BE-084 if available. Phase inferred: a one-way choice that precedes the first migration. ADR 0020 (proposed, 2026-11-06) records 64 with its reasoning, says that the count is fixed at creation, and says what a later change would take; criteria 1 and 2 stay open until the record is accepted. Its reasoning is not a measurement: BE-084 and BE-058 should confirm the count before the first production deployment. Lane w5 (2026-11-15): nothing new could be ticked. The record (ADR 0020, section "Partition count (BE-008)") states the count, the reasoning, that the count is fixed at creation and what a later change takes, but it is still proposed and the owner has not reviewed it; the decision is the owner's, so criteria 1 and 2 wait for the owner to accept 64 or name another count. BE-058 has no measurement yet that could confirm or change it. Lane w5 (2026-11-17): checked `docs/owner-decisions-2026-11-15.md` (25 answers): none names ADR 0020 or the partition count, and `docs/owner-decisions-pending.md` item 14 still lists ADR 0020 and BE-008 as waiting for acceptance. Nothing new could be ticked; the story is blocked on the owner's word.

### BE-009 Create the commit log tables

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 06 §4.1; 08 §2; ADR 0006 · **Requirements:** R4, R7, R9 · **Depends on:** BE-008, BE-011

As a maintainer, I want the document, head, commit, payload and scope tables of 06 §4.1, so that every accepted commit is stored with everything 08 §2 requires from the first release.

**Acceptance criteria**

- [ ] Given an empty database, when migrations run, then `documents`, `doc_heads`, `doc_commits`, `doc_commit_payloads` and `commit_scopes` exist with the columns, primary keys and unique constraints of 06 §4.1, including `unique (tenant_id, external_id)`, `unique (doc_id, commit_id)` and primary key (`doc_id`, `seq`), and `doc_commits` and `doc_commit_payloads` are hash-partitioned by `doc_id` with the count of BE-008.
- [x] Given a document is created, when its head row is read, then `head_seq` is 0, `epoch` is 0, `incarnation` is a new UUID and `history_visibility` on the document is `editors`.
- [x] Given the hot write path of BE-024, when statements are logged in a test, then it touches `doc_heads`, `doc_commits`, `doc_commit_payloads` and `commit_scopes` but never the wide `documents` row.
- [x] Given a commit payload is stored, when the row is read, then the payload is Zstandard-compressed JSON in `bytea`, and its metadata is in a separate `doc_commits` row that carries the fields of HIS-001, HIS-002.
- [x] Given a per-region or per-field history query, when it runs, then it uses `commit_scopes` and no index on the log is added for it.
- [x] Given the schema, when it is inspected, then no table stores position maps (they are derived from steps) and `documents.state` accepts only `active`, `locked` and `archived`.

**Evidence (lane V-BE-001-014, criterion 1, PostgreSQL in Podman):** `services/document-service/test/postgres/be-009-010-v-be-001-014-keys.pg.test.ts` (run with `pnpm exec vitest run --project node services/document-service/test/postgres/be-009-010-v-be-001-014-keys.pg.test.ts`; 10 of 10 pass). On a freshly migrated database it reads the constraints from the catalogue: the keys and unique constraints of `documents`, `doc_heads`, `doc_commits`, `doc_commit_payloads` and `commit_scopes`, and the hash partitioning of `doc_commits` and `doc_commit_payloads` into 64 partitions. The older `schema.pg.test.ts` fails on a stale table list before its key assertions run. Reviewer (round 4): criterion 1 is unticked again. This test checks keys, unique constraints and partitioning only; it asserts no column of `documents`, `doc_heads`, `doc_commits`, `doc_commit_payloads` or `commit_scopes`, which the criterion names ("with the columns"). The column assertions exist only in the stale `schema.pg.test.ts` test, which still fails. It can be ticked once a running test lists those columns (06 §4.1), and when the partition count of BE-008 is accepted.

**Evidence:** `services/document-service/migrations/0001_platform.sql`, `0002_documents_and_log.sql`, applied by `src/storage/migrate.ts`. `test/postgres/schema.pg.test.ts` checks the tables, columns, keys, partitions, the absence of position maps and the document states. The contract check "a new document starts at head 0 and epoch 0 with an incarnation of its own" covers the head row (`test/contract/checks.ts`). `test/postgres/write-path.pg.test.ts` records every statement of one write and reads `pg_stat_xact_user_tables` before COMMIT: the write touches `doc_heads`, `doc_commits`, `doc_commit_payloads`, `commit_scopes` and `grant_revisions`, never `documents`, in four statements. The same file checks that the payload is a Zstandard frame of the RFC 8785 payload, that the metadata row holds the commit's fields, its size, payload hash and chain, and that a per-scope query plan reads `commit_scopes` alone while `doc_commits` has only its two keys.

**Evidence (lane U-BE-001-014, round 2, criterion 4):** `services/document-service/test/postgres/write-path.pg.test.ts` (the payload is a Zstandard frame of the RFC 8785 payload and the metadata row holds the commit's fields and hash chain) and `test/postgres/his-001-016-record.pg.test.ts` (`base`, `rebased`, `token_jti` and `agent` read back from `doc_commits`), both run in Node.js against PostgreSQL in Podman, 2026-11-13. The room's `StoredCommit` carries the four fields (`packages/authority/src/room/room.ts`), so the earlier note that they were NULL is no longer true.

**Notes:** Tables for checkpoints, assets, document-asset links, jobs, idempotency keys and the outbox are created by the story that uses them (BE-020, BE-042, BE-044, BE-049, BE-034, BE-039). The `versions.kind` comment in 06 §4.1 omits `sent` and `completed`, which 08 §4 adds (see Open questions). Criterion 4 (round 2): `base`, `rebased`, `token_jti` and `agent` are stored and read back, as tested above. Departures from the 06 §4.1 sketch, among them `session_id` as text and an added `payload_hash`, are listed in ADR 0020 (proposed). Criterion 1 was unticked in the evidence audit (2026-11-13): the only test that checks the keys and columns (`test/postgres/schema.pg.test.ts`, "creates the log and grant tables of 06 §4.1 with their keys") fails on a stale expected table list (it omits `node_leases`, `outbox`, `versions` and other later tables), so none of its key and column assertions run; the schema itself matches 06 §4.1 when queried by hand, so the test needs its list updated and the tick can then return. Lane w5 (2026-11-15): the test's list is current and the test runs again. It now also lists the columns of the three tables the reviewer found missing: `test/postgres/schema.pg.test.ts` ("creates the log and grant tables of 06 §4.1 with their keys"; `pnpm exec vitest run --project node services/document-service/test/postgres/schema.pg.test.ts`, 9 of 9 pass against PostgreSQL in Podman on this machine) asserts the columns of `documents` (the fifteen of 06 §4.1 in order, with types and nullability, and its primary key), `doc_commit_payloads` and `commit_scopes` beside those of `doc_commits` and `doc_heads`, the keys and unique constraints, and 64 hash partitions on `doc_id`. So the first of the reviewer's two conditions (round 4) is met. Criterion 1 stays unticked on the second alone: the count of BE-008 is still a proposal (ADR 0020) that the owner has not accepted. When the owner accepts 64, or the reviewer rules that the proposed count is enough for this criterion, it can be ticked with no further work; another count means editing the one constant and the two `64` in the tests. Lane w5 (2026-11-17): the second condition is unchanged. `docs/owner-decisions-2026-11-15.md` does not accept ADR 0020 or name a count, so criterion 1 stays unticked and the story is partial (5 of 6 ticked); nothing else is left to build for it.

### BE-010 Create the grant tables

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 06 §4.1; 07 §3, §9 · **Requirements:** R3 · **Depends on:** BE-009

As a maintainer, I want `region_grants`, `grant_revisions` and `retired_regions`, so that region permissions are stored relationally and can be checked inside the write transaction.

**Acceptance criteria**

- [x] Given an empty database, when migrations run, then `region_grants` has primary key (`doc_id`, `region_id`, `principal`) with `role` and optional `expires_at`, `grant_revisions` has one row per document, and `retired_regions` has primary key (`doc_id`, `region_id`).
- [x] Given a principal string, when it is stored, then only the forms `user:…`, `group:…`, `everyone` and `role:…` are accepted.
- [x] Given a region is retired, when its grants are removed and its identifier is written to `retired_regions` in one transaction, then a later insert of a grant for the same identifier in that document is refused.
- [x] Given a grant row, when it is read, then `created_by` holds a per-tenant surrogate (BE-013).

**Evidence (lane V-BE-001-014, criterion 1, PostgreSQL in Podman):** `services/document-service/test/postgres/be-009-010-v-be-001-014-keys.pg.test.ts` (the same run as BE-009 criterion 1: `region_grants` keyed by (`doc_id`, `region_id`, `principal`), `role` not null, `expires_at` nullable, `grant_revisions` keyed by `doc_id`, `retired_regions` keyed by (`doc_id`, `region_id`)). Round 4: `src/storage/grant-store.ts` (`toJson`) keeps a lease's `id` and `acquiredAt` in `grant_history`, so a history read matches the table. The contract check "grants, region states, leases ... round-trip" still fails on its expectation at `test/contract/checks.ts` (line 407): the PostgreSQL store assigns the lease `id` and `acquiredAt` and the expectation omits them. That check is not this story's and is left to its author.

**Evidence:** `services/document-service/migrations/0003_grants.sql`. `test/postgres/schema.pg.test.ts` checks the keys and refuses principals outside the four forms and roles outside `viewer`, `commenter`, `suggester` and `editor`. The write that removes a region records it in `retired_regions` and deletes its grants, state and lease in the log transaction (`src/storage/log-store.ts`); a trigger then refuses any grant, state or lease for it (contract check "removing a region retires it", against PostgreSQL and in memory, `test/contract/checks.ts`). Grants written through `PATCH /documents/{id}/grants` carry the actor's surrogate in `created_by` and `user:<surrogate>` as principal (`services/document-service/test/control-plane/routes.content.test.ts`, PostgreSQL: "attributes grant changes to the DEP-Actor or the user, as surrogates").

**Notes:** Semantics of grants are PRM's; this story is the storage. `region_states` and `region_leases` are created in BE-015 because they are phase 2. They exist from `0003_grants.sql` already, with the columns of 06 §4.1, because the room's permission state holds region states and leases and every change of them raises the grants revision (ADR 0020, proposed); BE-015 keeps the other four tables. `created_by` holds whatever actor the caller names; mapping a `sub` to a surrogate is BE-013. Criterion 1 was unticked in the evidence audit (2026-11-13): the primary-key assertions for `region_grants`, `grant_revisions` and `retired_regions` sit in the same failing `schema.pg.test.ts` test as BE-009 criterion 1 and never run; the keys are correct when queried by hand. Separately, the PostgreSQL contract checks "removing a region retires it" and "grants, region states, leases ... round-trip" (`test/postgres/contract.pg.test.ts`) fail today, because `grant_history` stores leases without `id` and `acquiredAt` (`src/storage/grant-store.ts`, `leases: p.leases.map(...)`) while `change` returns them; criterion 3 stays ticked on `prm-003-retirement.pg.test.ts` and the "refuses a grant on a retired region" route test, which pass.

### BE-011 Isolate tenants with row-level security

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 06 §4.1, §12; 10 §3.7; ADR 0006 · **Requirements:** R10 · **Depends on:** BE-001

As a maintainer, I want every table protected by row-level security with a tenant set per transaction, so that a bug in a query cannot read or write another tenant's rows.

**Acceptance criteria**

- [ ] Given any table created by a migration, when the catalogue is inspected, then it has a `tenant_id` column, row-level security is enabled and forced, and a policy restricts rows to the current tenant.
- [x] Given a request or job, when it opens a database transaction, then the tenant is set for that transaction from the verified token, credential or job row, never from a request body or path.
- [x] Given no tenant is set, when a query runs on a tenant table, then it returns no rows and writes fail.
- [x] Given tenant A's context, when a query selects, updates or deletes a row of tenant B by primary key, then no row is affected.
- [x] Given the service's database role, when its attributes are read, then it is neither a superuser nor able to bypass row-level security; migrations run under a different role.
- [x] Given a migration adds a table without `tenant_id` or a policy, when CI runs, then the build fails.

**Evidence:** `services/document-service/migrations/0001_platform.sql` defines `docedit_current_tenant()` and `docedit_protect()`, which every later migration applies to each table and each partition. The stores set the tenant per transaction with `set_config('docedit.tenant_id', …, true)` (`src/storage/db.ts`). `test/postgres/schema.pg.test.ts` checks all 139 tables and partitions in the catalogue; it also checks that without a tenant reads return no rows and an insert fails, that tenant A selects, updates and deletes none of tenant B's rows by key, and that the service role (`docedit_service`, a member of `docedit_app`) is neither superuser nor `BYPASSRLS` nor the owner of any table, which migrations create as the admin role. The contract checks also find another tenant's log and permissions invisible (`test/contract/checks.ts`). The control plane takes the tenant from the verified credential only (`services/document-service/src/control-plane/pipeline.ts`; `tokens.ts` reads `tid` from the signed token and the tenant from the API key), and job work takes it from the claimed row (`jobs/pg.ts`, `docedit_claim_job`). `services/document-service/test/control-plane/routes.documents.test.ts` ("keeps tenants apart"): another tenant's API key reaches none of the documents, a tenant header is ignored, and a forged key fails; `services/document-service/test/control-plane/queue.test.ts` checks the row's tenant and that another tenant's job is invisible. Criterion 6: `services/document-service/src/storage/tenant-guard.ts` checks every table the migrations create for a `tenant_id` column and a `docedit_protect` call, and `src/storage/tenant-guard.test.ts` runs it over the real migrations and over synthetic ones that must fail; the test is in the Node.js suite that `pnpm test` runs in `.github/workflows/ci.yml`, and `migrate check` (`src/storage/migrate-cli.ts`) runs it too.

**Notes:** How platform-level work (scheduler, metrics across tenants) reads under RLS is not specified (see Open questions). SEC-045 verifies isolation end to end. Phase inferred: the spec requires row-level security on every table, the first demo already has tenants, and the roadmap does not name it. Criterion 2 needs the request pipeline (BE-032) and token verification: the stores take the tenant from the caller's `DocRef`. Criterion 6 is ticked on the static check above (2026-11-13). The catalogue test in `test/postgres/schema.pg.test.ts` checks the same on a database, but no CI workflow runs that against a database yet (FND-010). That test expects every table to have a `tenant_id`, which `node_leases` (0033) does not; the static check exempts it (`TENANT_EXEMPT`, with the reason), so the catalogue test's expectation needs the owner's or the test's author's update. The migrations' own bookkeeping table, `docedit_schema_migrations`, holds no tenant data and is the one exception. Criterion 1 was unticked in the evidence audit (2026-11-13): it says "any table", but `node_leases` (0033) has no `tenant_id`, no row-level security and no policy (checked on a migrated database), and the catalogue test (`schema.pg.test.ts`, "gives every table a tenant_id, forced row-level security and a tenant policy") fails on its stale count (171 tables and partitions, 149 expected) before it checks any row. Either the owner accepts `node_leases` as an exception in 06 §4.1 and the criterion says so, or the table gets the column and a policy; the catalogue test needs updating either way. Lane w5 (2026-11-15): nothing new could be ticked. The catalogue test is no longer stale: `test/postgres/schema.pg.test.ts` ("gives every table a tenant_id, forced row-level security and a tenant policy", run on this machine against PostgreSQL in Podman, 9 of 9 tests of the file pass) checks every table and partition, and passes because it exempts `node_leases` through `TENANT_EXEMPT` and checks that the exempt table really has no `tenant_id`. So every table but `node_leases` meets criterion 1. Whether that exemption meets "any table" is the owner's to say (ADR 0332, proposed); giving a lease that names a node a tenant would decide the open question of how platform-level work reads under row-level security, so the table is left as it is and criterion 1 stays unticked. Lane w5 (2026-11-17): `docs/owner-decisions-2026-11-15.md` has no answer on `node_leases` or ADR 0332, so criterion 1 stays unticked and the story is blocked on that decision.

### BE-012 Register tenants, token keys and allowed origins

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Operator |

**Spec:** 06 §4.1 (omitted tables), §12; 10 §3.2; 05 §3.1, §3.2 · **Requirements:** R6, R10 · **Depends on:** BE-011

As an operator, I want tenants stored with their public keys, service credentials and allowed origins, so that tokens and origins are checked against the tenant's own registration.

**Acceptance criteria**

- [x] Given an operator seeds a tenant (configuration or command line in phase 1a), when it is stored, then it has a tenant identifier (`tid`), a key set for user tokens with an allowed algorithm per key (ES256, EdDSA or RS256), a separate key or API-key set for service credentials, and a list of allowed origins.
- [x] Given a token with `tid`, when its verification key is looked up, then it is selected from this registration and never from a URL in the token.
- [x] Given a key or origin is added or removed, when the next connection or request arrives, then the change applies without a restart.
- [x] Given two service credentials are active for a tenant, when either is presented, then it authenticates until the older is removed.
- [x] Given a key stored for user tokens, when it is offered as a service-credential key, then it is refused.

**Evidence:** Migration `0004_tenants.sql` (`tenants`, `tenant_keys` with a use and one algorithm per key and a thumbprint, `tenant_api_keys` with an expiry, `tenant_origins`); `services/document-service/src/control-plane/tenants.ts` (memory and PostgreSQL), `seed.ts` (`DOCEDIT_TENANTS_FILE`), `src/tenant-cli.ts`. `services/document-service/test/control-plane/registrations.test.ts` stores a seeded tenant with user keys, service keys, API keys and origins, in memory and in PostgreSQL; `services/document-service/test/control-plane/tokens.test.ts` selects keys by `tid` and never from the token; `services/document-service/test/control-plane/routes.documents.test.ts` shows a key added or removed taking effect at the next request, two API keys working until the older expires, and a user key refused as a service key.

**Evidence (lane V-BE-001-014, criterion 3, in memory and PostgreSQL):** `services/document-service/test/control-plane/be-012-v-be-001-014-origins.test.ts` (2 of 2 pass, `pnpm exec vitest run --project node services/document-service/test/control-plane/be-012-v-be-001-014-origins.test.ts`): an origin is refused by a preflight until `addOrigin`, allowed at the next request, and refused again after `removeOrigin`, while a seeded origin is unaffected. The criterion says "connection or request"; the request path is tested, and the WebSocket connection check (`src/data-plane/session.ts`, `#originAllowed`) has no test of its own here.

**Notes:** The administration endpoints for tenants, keys and origins are UX-076 in phase 2. The tables are omitted from the sketch in 06 §4.1, so their columns are designed here. Phase inferred: token minting is in 1a (11 §3) and verification needs the tenant's keys. Criterion 3 was unticked in the evidence audit (2026-11-13): the tests show a key and an API key added, expired or removed taking effect at the next HTTP request, but no test removes or adds an origin and then sends a request or opens a connection (`routes.documents.test.ts` only adds another tenant's origin), and no test covers a key change at the next WebSocket connection. The registry reads without a cache, so the behaviour is likely, but it is untested.

### BE-013 Map host user identifiers to per-tenant surrogates

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 06 §4.1 (`tenant_users`); 10 §4; 08 §13 · **Requirements:** R4, R10 · **Depends on:** BE-011, BE-012

As a maintainer, I want every host `sub` mapped to a per-tenant surrogate and every table to store only the surrogate, so that erasing a person is deleting one row and the hash chain is not touched.

**Acceptance criteria**

- [x] Given a verified token with a `sub` never seen in the tenant, when the first request or hello is processed, then a `tenant_users` row with a unique surrogate is created, and later requests reuse it.
- [x] Given the same `sub` in two tenants, when both rows are read, then the surrogates are unrelated.
- [x] Given a `name` claim, when it is stored, then it is saved as the optional `display_name` and can be purged without touching any other table.
- [x] Given any table of 06 §4.1 and the audit trail, when its user columns are read, then they hold surrogates, not `sub` values.
- [x] Given an operator erases a user, when the mapping row is deleted, then history and audit rows keep the surrogate and no query can resolve it to a `sub` or a name.

**Evidence:** `tenant_users` and `document_revocations` (migration 0004); `services/document-service/src/control-plane/users.ts`; the token service maps every verified `sub` to its surrogate (`tokens.ts`). `services/document-service/test/control-plane/registrations.test.ts` and `services/document-service/test/control-plane/tokens.test.ts`, in memory and PostgreSQL: one surrogate per tenant and `sub`, also under concurrent first requests; unrelated across tenants; the `name` claim stored as the display name and purged alone; erasing deletes the mapping, after which nothing resolves the surrogate. Criterion 4 (lane U-BE-001-014, PostgreSQL in the test environment): `services/document-service/test/control-plane/be-013-surrogate-scan.pg.test.ts` creates a document with the sub as `DEP-Actor`, reads with a user token, changes a grant to `user:<sub>` over REST, appends a commit as the surrogate, then scans every readable non-bytea column of the tenant. The sub and the display name are found only in `tenant_users`, and the surrogate in the commit's author column.

**Notes:** The erase operation exists here as a service function; no resource in 05 §6.2 or in the administration outline of 13 §10 exposes it (see Open questions). User-facing erasure and payload tombstones are HIS-038, HIS-040. SEC-056 verifies. Phase inferred: 08 §2 records users from the first release, so the surrogate must exist before the first commit is stored. Packet A2 (2026-11-06): criterion 4 stays open: the tables the control plane writes (`documents`, `region_grants`, `grant_history`, `jobs`) and the commits of the data plane hold surrogates (`test/server/server.test.ts`). Criterion 4 is ticked by lane U-BE-001-014 (see Evidence); payload bytes are compressed and not scanned. The erase operation is `UserDirectory.erase`; no route exposes it.

### BE-014 Record audit events in an append-only partitioned table

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Tenant administrator |

**Spec:** 06 §4.1 (`audit_events`); 07 §14 · **Requirements:** R10 · **Depends on:** BE-011, BE-013

As a tenant administrator, I want grant changes, rejections, revocations and similar events written to a table that the service cannot alter afterwards, so that the audit trail can be trusted.

**Acceptance criteria**

- [x] Given the migration, when it runs, then `audit_events` exists partitioned by range on `at`, and partitions for the coming period are created ahead of time by a scheduled job (BE-052).
- [x] Given the service's database role, when it attempts an update or delete on `audit_events`, then the database refuses it.
- [x] Given a state change that must be audited (a grant change), when it is written, then the audit row is inserted in the same transaction as the change.
- [x] Given an event, when it is stored, then it carries tenant, optional document, actor (surrogate), `kind`, small `data` and server time, and never document text.

**Evidence (lane V-BE-001-014, criterion 1, PostgreSQL in Podman):** `services/document-service/test/control-plane/be-014-v-be-001-014-audit-schedule.pg.test.ts` (1 of 1 passes, `pnpm exec vitest run --project node services/document-service/test/control-plane/be-014-v-be-001-014-audit-schedule.pg.test.ts`). The partition of three months ahead is dropped, then the job `audit.partitions` (`src/control-plane/audit-partitions-task.ts`, registered by `src/server.ts`) runs through the scheduler, the PostgreSQL job queue and a job runner, and the partition is created again. The partitions after the migrations are checked by `test/postgres/be-014-audit-partitions.pg.test.ts`.

**Evidence:** criterion 3: `src/storage/grant-audit-transaction.test.ts` (fake pool with a statement log) shows that `PgGrantStore.change` runs the revision update, the row changes and the `audit_events` insert on one connection between BEGIN and COMMIT, and that a failed audit insert rolls back with no COMMIT (`src/storage/grant-store.ts`, `change`). This is structural: rollback by PostgreSQL itself is not run here. Criterion 4: the same file checks the insert's parameters (tenant, document, actor, `grants.changed`, `data` holding only `rev` and `scopes`, server time), and `src/data-plane/audit-schema.test.ts` checks that the migration keeps `data` a JSON object of at most 4096 bytes and has no column for text. Runs in the Node.js suite (`pnpm test`). Criterion 1, structure only (lane V-BE-001-014, PostgreSQL in Podman, `services/document-service/test/postgres/be-014-audit-partitions.pg.test.ts`, 3 tests passed with `pnpm exec vitest run services/document-service/test/postgres/be-014-audit-partitions.pg.test.ts`): `audit_events` is range-partitioned on `at`, at least four partitions exist after the migrations, and an event dated three months ahead is stored. The criterion itself stays open (see Notes). Criterion 2 (lane U-BE-001-014, PostgreSQL 16 or later in the test environment, run with `pnpm exec vitest run services/document-service/test/postgres/be-014-audit.pg.test.ts`, 4 tests passed): the service role's UPDATE and DELETE on `audit_events` are refused with SQLSTATE 42501, and the schema owner's are refused by the `audit_events_append_only` trigger ("audit_events is append-only").

**Notes:** What is audited is PRM's list (07 §14); the query endpoint `GET /audit` is UX-076. Phase: roadmap 1b "audit of rejections and grant changes". Packet storage (2026-11-13, lane BE-014-026): criterion 1 stays open. `docedit_audit_partitions` creates the partitions, and the migration, the service start and a daily check call it (`src/data-plane/pg/audit.ts`), but the scheduled job of BE-052 does not exist yet, so the story's "by a scheduled job" is not met; `audit-schema.test.ts` checks the function's presence only. Criterion 2 is ticked by lane U-BE-001-014 (see Evidence). Round 4 (lane V-BE-001-014): criterion 1 is ticked. The job `audit.partitions` is now a scheduled task (`src/control-plane/audit-partitions-task.ts`, registered by `src/server.ts`), and the test in the Evidence runs it through the scheduler on PostgreSQL. The earlier sentences of these notes describe the state before that. Phase: roadmap 1b "audit of rejections and grant changes".

### BE-015 Create the tables for history, comments, region states and leases

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | should | Maintainer |

**Spec:** 06 §4.1 · **Requirements:** R3, R4, R8 · **Depends on:** BE-009, BE-010

As a maintainer, I want `region_states`, `region_leases`, `versions`, `threads`, `comments` and `read_markers` created, so that the phase 2 features have their tables under the same tenancy rules.

**Acceptance criteria**

- [x] Given an empty database, when migrations run, then each of the six tables exists with the columns, keys and references of 06 §4.1 and passes the checks of BE-011.
- [x] Given `versions`, when a row is written, then `kind` accepts every value of 08 §4 (`named`, `export`, `pre-restore`, `restore`, `import`, `sent`, `completed`).
- [x] Given `read_markers`, when an update would lower `seq`, then it is refused (a marker only moves forward).
- [x] Given `threads`, when the current mapped range is stored, then `range_from`, `range_to` and `range_seq` are written together.

**Evidence:** `services/document-service/migrations/0050_collaboration_tables.sql` (lane U-BE-015-028) creates `versions`, `threads`, `comments` and `read_markers` with `tenant_id`, forced row-level security and the tenant policy; `region_states` and `region_leases` come from `0003_grants.sql`. `test/postgres/be-015-collaboration.pg.test.ts` checks the six tables and their RLS, the seven kinds of 08 §4 (and a refused eighth), a read marker that refuses a lower `seq` and accepts an equal or higher one, the all-or-nothing thread range, and that one tenant reads none of another's threads or comments. Run against PostgreSQL 16 or later in Podman (`docedit-test-postgres`). Criterion 1 (lane w5): `test/postgres/be-015-columns.pg.test.ts` migrates an empty database and compares, for each of the six tables, the columns (name, type, nullability), the primary key and the references with the sketch of 06 §4.1 (plus `tenant_id`; 7 tests passed); the BE-011 checks are the RLS tests of `be-015-collaboration.pg.test.ts` and the catalogue test `schema.pg.test.ts` (9 passed).

**Notes:** Tables for workflows, participants and evidence (12) and for search are omitted from 06 §4.1; FRW defines the columns of the former and BE-054 those of the latter, both under BE-011. Phase 2 follows the features that use them. Lane BE-014-026 (2026-11-13) found that no migration created these six tables; lane U-BE-015-028 added the four missing ones in migration 0050. Its wording was partly wrong: `region_states` and `region_leases` existed already, from 0003. Migration 0050 adds `tenant_id` to the four tables, which 06 §4.1 omits, to follow BE-011. Two things are not covered here: `test/postgres/schema.pg.test.ts` still lists tables and counts from an older release and fails on tables of other stories (not changed by this lane), and the criteria ask for the six tables to pass the checks of BE-011, which the new test covers only through RLS and the tenant policy. Criterion 1 was unticked by the evidence audit (2026-11-13) and is ticked again by lane w5 (see Evidence; `schema.pg.test.ts` passes now). The audit found that `be-015-collaboration.pg.test.ts` checks that the six tables exist with `tenant_id` and the tenant policy, but no test asserts their columns, primary keys or references against 06 §4.1 (the migration matches the sketch on reading), and the catalogue test of BE-011 (`schema.pg.test.ts`) fails on its stale table list and count.

### BE-016 Change the schema with expand-and-contract migrations

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 06 §13 · **Requirements:** R9 · **Depends on:** BE-009

As an operator, I want database migrations that two service versions can run against at once, so that a rolling deploy never breaks the older instances.

**Acceptance criteria**

- [ ] Given migration N+1 is an expand step, when it is applied while version N instances run, then version N keeps passing its smoke suite.
- [x] Given a contracting change (drop or rename), when it is planned, then it ships at least one release after the last version that uses the old shape.
- [ ] Given CI, when migrations run from an empty database and from the previous release's schema, then both end with the same schema.
- [x] Given a migration on partitioned tables, when it runs, then the partition count is not changed.
- [x] Given a release, when its notes are written, then they list its database steps and how to roll back (feeds BE-095).

**Evidence:** criterion 2: `services/document-service/src/storage/migrate.ts` `planProblems` (a contract step names an expand step that exists and ships in a later release; unlisted migrations belong to the next release) and `migrate check` in `src/storage/migrate-cli.ts`. `src/storage/migrate.plan.test.ts` checks the rule on synthetic plans (same release, a later release, an unreleased step, a non-expand or missing target, a release that lists a missing migration) and that the plan the repository ships has no problems. Runs in the Node.js suite (`pnpm test`).

**Evidence (lane V-BE-015-028, criterion 3, partial; criterion unticked in review 2026-11-13 because it names CI and no CI workflow runs the test, `.github/` has no PostgreSQL job, and the only release in `migrations/releases.json` is a prefix of the migration list, so the "previous release" run is the same migrations in the same order):** `services/document-service/test/postgres/be-016-v-be-015-028-upgrade.pg.test.ts` (PostgreSQL 16 or later in Podman, `pnpm exec vitest run` on that file, 1 test passed): one database is migrated from empty; another gets only the migrations of `0.1.0-phase1a` (`migrations/releases.json`), then every migration. The two schemas match in tables, columns (type, nullability, default, position), constraints, indexes, row-level security policies, functions (by source hash), triggers and partitions, and both record the same migration versions. The run uses the shared PostgreSQL container, not a CI runner: CI is root configuration and was not run.

**Evidence (criterion 5, lane w5, 2026-11-17):** the baseline files 0001 to 0007 cannot take a `-- rollback:` header (a changed file is refused, `migrate.ts`), so `releases.json` now carries a `rollback` object of notes by migration for the release that lists them (`Release.rollback`, `loadReleases`), and `releaseNotes` takes it as a third argument (the note in the file wins); `migrate notes` passes it (`src/storage/migrate-cli.ts`). `src/storage/migrate.plan.test.ts` 'documents the rollback of every migration, in every release and in the next one' builds the notes of each release in `releases.json` and of the migrations no release lists yet, and checks that each has one table row per database step and no "not documented"; a second test checks that the file note wins over the `releases.json` note. Node.js, `pnpm exec vitest run --project node services/document-service/src/storage/migrate.plan.test.ts`, 18 passed.

**Notes:** CDM migrations are separate (BE-094). Phase inferred: rolling deploys begin with the stage 1 deployment of 1b. Packet storage (2026-11-13): criterion 2 is ticked on the planning check; criterion 3 has a PostgreSQL test from lane V-BE-015-028 (see its Evidence) but stays unticked: it names CI, and no CI job runs it (review 2026-11-13); criterion 1 needs a running database and an older release's smoke suite (BE-006, FND-010), so it stays open. Criterion 4 is ticked (lane U-BE-015-028): `services/document-service/test/postgres/be-016-partitions.pg.test.ts` checks, in PostgreSQL in Podman, that after all migrations each log table still has 64 partitions and that migration 0050 is recorded as an expand step. It shows the shipped migrations keep the count, not that every future migration does. A static guard, `services/document-service/src/storage/partitions.test.ts`, checks that only the baseline sets the count (64, BE-008) and that no later migration re-partitions, attaches, detaches, drops or renames the two log tables. Criterion 5 was open because the baseline migrations 0001 to 0007 had no rollback note; lane w5 ticked it (see Evidence). The baseline note says what is true of a first release: no older release exists, there is no down migration, and the way back is the backup taken before migrating or a fresh database. Criterion 1 stays open: it needs the previous release's smoke suite running against the new schema, and there is only one release (`0.1.0-phase1a`) and no smoke suite of an older version to run (BE-006, FND-010); `compatibility` in `migrate.ts` and its unit tests are the rule behind it, not the run. Criterion 3 stays open: it names CI, and no CI job runs the empty-versus-upgrade comparison (`.github/` is root configuration); the PostgreSQL test of lane V-BE-015-028 shows the schemas match locally.

## Rooms: ownership and fencing

### BE-017 Fence log writes with the ownership epoch

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 06 §2.1, §8; 10 §3.3; ADR 0006; review ROUTE-1, LEASE-1 · **Requirements:** R7, R9 · **Depends on:** BE-009

As a maintainer, I want every log write to check the writer's ownership epoch and to be keyed by (document, `seq`), so that a node that lost ownership without noticing cannot append.

**Acceptance criteria**

- [x] Given a document with no live owner, when a node opens its room, then in one transaction it sets itself as `owner` and raises `epoch` by one.
- [x] Given a log write, when its transaction runs, then it checks the writer's epoch on the document's head row and advances the head in the same transaction.
- [x] Given node A lost ownership and node B holds the next epoch, when A attempts to append, then the transaction fails and nothing is stored.
- [x] Given two nodes append the same `seq` at the same moment, when both commit, then exactly one succeeds through the primary key and the other stops serving the document.
- [x] Given a node learns its epoch is stale, when it stops serving, then it closes the document's channels with `ch.closed` and code `unavailable`.
- [x] Given the PostgreSQL `LogStore`, when the contract suite of BE-002 runs, then all of the cases above pass.

**Evidence:** `services/document-service/src/storage/log-store.ts`: `claim` sets the owner and raises the epoch in one statement; `append` locks the head row, compares epoch and head, and advances the head in the write transaction; a unique violation of a `(doc_id, seq)` key is reported as `fenced`. The contract checks (claim and release, stale epoch, gap, existing `seq`) pass against PostgreSQL (`test/postgres/contract.pg.test.ts`). `test/postgres/fencing.pg.test.ts` uses real rooms from `packages/authority`: a room whose node lost ownership is `fenced`, stops and sends `ch.closed` with `unavailable` while the new owner's commit is stored. Two rooms holding the same epoch write `seq` 1 at once, queued on the head row: one is stored, the other room stops. A head row reset by hand lets a second commit through the head check, and the primary key refuses it. The S3 suite against PostgreSQL claims ownership at each of its 1,006 failovers (SYN-047).

**Notes:** The lease only decides who should try (BE-018). SEC-031 proves it adversarially. In 1a `claim` takes ownership unconditionally; judging that no live owner exists needs the node lease of BE-018. Opening a room from storage on the first channel is BE-019.

### BE-018 Keep a node lease and stop serving when it cannot be proved

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 06 §2.1, §8; review LEASE-1 · **Requirements:** R9 · **Depends on:** BE-017

As an operator, I want a node to own rooms only while it holds a liveness lease that it can prove, so that a partitioned node never keeps showing a frozen document.

**Acceptance criteria**

- [x] Given a node holds rooms, when it runs, then it renews its node-level lease every few seconds and the database clock alone decides when the lease has expired.
- [x] Given a node cannot prove from its own monotonic clock that its lease is still valid, when it checks, then it stops serving all its rooms, including rooms with only viewers, and closes their channels with `ch.closed` and code `unavailable`.
- [x] Given a node's lease has expired in the database, when another node opens one of its rooms, then it takes ownership with the next epoch and the first node's appends fail (BE-017).
- [x] Given the system clock of a node is stepped forward or back in a test, when leases are evaluated, then the outcome depends only on database time and the node's monotonic clock.
- [x] Given a process was killed and restarted with a new node identifier, when it asks for the dead node's documents, then it gets them only after that node's lease has expired.

**Evidence:** `services/document-service/src/data-plane/lease.test.ts` (fake timers and clocks): a renewal every `renewMs` for the lease length, and the database alone expires the lease; a node whose renewals fail stops proving at its last proven validity and reports the loss once; a stepped system clock changes neither the remaining validity nor the proof, and a stepped database clock does not move the node's own proof; release ends the lease and stops renewals (`src/data-plane/lease.ts`). Criterion 2: `services/document-service/test/data-plane/be-018-lease-fence.test.ts` runs a plane with a short lease over the in-memory stores, makes the renewals fail, and checks that an editor's and a viewer's channels both get `ch.closed` with `unavailable`, that the room is gone, and that the lease is not proved (`NodeLease` `onLost` into `RoomHost.fence`, `src/data-plane/index.ts`). Criteria 3 and 5 (lane U-BE-015-028): `services/document-service/test/postgres/be-018-node-lease.pg.test.ts` runs `PgLogStore.claimIfFree` (the call `RoomHost` makes, `src/data-plane/room-host.ts`) against PostgreSQL with `PgNodeLeases` (`src/data-plane/pg/leases.ts`, migration 0033). A claim is refused while the owner's lease is valid; the lease is expired in the database; the next claim gets epoch 2; the first node's append returns `fenced` and stores nothing. A restarted node with a new identifier is refused until the dead node's lease has expired. Run in PostgreSQL in Podman. Scope: this is the storage decision, not a killed process in a running plane.
**Notes:** The renewal interval ("every few seconds") and the lease length are not given (see Open questions). The defaults in `settings.ts` (15 s validity, renewal every 3 s, 1 s margin) are this implementation's choice, recorded in ADR 0103. Criterion 2 is ticked (lane BE-014-026): `be-018-lease-fence.test.ts` drives `RoomHost.fence` from a lost lease in a running plane, with a viewer's channel as well as an editor's. Criteria 3 and 5 were ticked by lane U-BE-015-028 at the storage level (see Evidence). The full path, a killed process whose rooms a running plane takes over, is not run here. The table for node leases is not in the 06 §4.1 sketch. Phase inferred: one process (1a) can rely on the epoch alone; the lease matters once the process can be killed and replaced, which the 1b fault test does.

## Rooms: lifecycle

### BE-019 Open a room from a checkpoint and the log tail

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 06 §2.2 (1); 00 §9 · **Requirements:** R7, R9 · **Depends on:** BE-017, BE-009, SYN-001, SYN-006, PRM-004

As a maintainer, I want a room to open from the latest checkpoint plus the log tail, so that the first editor of a document gets a working authority quickly.

**Acceptance criteria**

- [x] Given the first channel for a document, when the room opens, then it acquires ownership (BE-017), loads the latest checkpoint if one exists (BE-020), and replays the log tail from PostgreSQL; with no checkpoint it replays from `seq` 1.
- [x] Given the document is loaded, when opening completes, then position maps of recent steps are derived from the stored steps at least `maxRebaseSteps` (default 5,000) back, and the indexes for node identifiers, region ranges, definitions in use per region, fields and comment ranges are built.
- [x] Given a document, when its room opens, then grants, region states, leases and the workflow are loaded before the first channel is attached.
- [ ] Given a document whose CDM is under 1 MB, when a cold open runs, then it completes within 500 ms at the 95th percentile (target), measured by FND-007, FND-009.
- [ ] Given a document near the 16 MiB limit, when it opens, then parsing and replay run in worker threads and other rooms keep acknowledging commits.
- [x] Given a checkpoint is needed and object storage is unavailable, when a channel opens, then it is rejected with `ch.rejected` and code `unavailable`, and rooms that are already open continue.

**Evidence:** Data plane (`services/document-service/src/data-plane/room-host.ts`): the first channel claims ownership, then the room is built from the content at sequence number 0 (the checkpoint at 0, D67) and the whole log replayed from seq 1, with the permissions in force and the revision in force at seq 0 (`test/data-plane/rooms.test.ts` "claims ownership, replays the log from seq 1 and serves the head", over PostgreSQL in `test/data-plane/postgres.pg.test.ts`); grants, region states and leases are loaded before the first channel attaches ("loads grants, region states and leases before the first channel is attached"); a checkpoint store that fails refuses the channel with `ch.rejected` `unavailable` while another room keeps acknowledging ("refuses the channel with unavailable when the checkpoint store fails, and serves other rooms").

**Evidence (lane V-BE-015-028, round 3, criterion 2):** `packages/authority/src/room/node-index.ts` (`NodeIndex`, built by the room in its constructor and rebuilt on read when the durable head moves, `Room.nodeIndex` in `packages/authority/src/room/room.ts`). `packages/authority/test/be-019-v-be-015-028-open-indexes.test.ts` (Node.js, `pnpm exec vitest run` on that file, 4 tests passed): the node index holds every identified node at its position and size; the region ranges, the definitions each region uses (07 §5.3) and the form fields come from `PermissionIndex` built at open, and the comment anchors given at open are held attached; a room opened from 5,002 stored commits accepts a base 5,000 steps back (position maps from the stored steps) and refuses a base 5,001 steps back with `stale_base`.

**Evidence (lane w5, 2026-11-15, criterion 1):** `services/document-service/test/data-plane/be-019-w5-checkpoint-tail.pg.test.ts` (`pnpm exec vitest run --project node` on that file; 4 of 4 pass on this machine, two over the in-memory stores and two over the PostgreSQL stores in Podman, with the checkpoint objects in memory). A room stores five commits and writes a checkpoint at `seq` 3 (`everyCommits: 3`). A second node then opens the room cold with the content at 0 hidden: it loads the checkpoint at 3, reads the log from `seq` 4 and nothing below 3 (every `LogStore.read` range is recorded), serves head 5 with the text of all five commits, and its next commit is `seq` 6. The second test has no checkpoint above 0: the open loads the content at 0 and reads the log from `seq` 1. Ownership on open is the existing test (`test/data-plane/rooms.test.ts`, the epoch rises by one).

**Notes:** The spec says cold opens fail when object storage is down (06 §8) but also that the log alone suffices for durability; whether a cold open may fall back to a full replay is open. The `workflow` data is FRW's; position maps and indexes are built by the authority package (SYN, PRM). Second review (2026-11-06, SPK-027), SR-M7: under ADR 0019 a cold open also builds one projection per visibility class (S12: about 100 ms per class at 1,000 pages on the development machine), and content reads must check the grants revision in storage (S12 change 3); neither is in the fourth criterion's budget yet ([review](../review/2026-11-06-second-review.md)). Open after the data plane (2026-11-06): criterion 2, the room derives position maps from the whole log, but the indexes of node identifiers, region ranges, definitions in use, fields and comment ranges are the authority's and are not built; criterion 4 is not measured; criterion 5 needs worker threads, which the room host does not use. Checkpoints other than the one at 0 wait for BE-020. Lane V-BE-015-028 (round 3, 2026-11-13): criterion 2 is ticked (see its Evidence). Criterion 5 stays open: the open path runs on the main thread. `CheckpointStore.load` decodes the envelope with `decodeContent` (`services/document-service/src/data-plane/checkpoints.ts`), `#load` in `room-host.ts` calls `nodeFromJSON` and `check()`, and the `Room` constructor replays the log with `applySteps`. Only reads (`#materialise`) and checkpoint writes use the workers. A 16 MiB open in workers needs the room to be built from plain data, which is a design change (proposed in ADR 0333, round 3). Criterion 4 stays open: it is a measurement on the reference machine (BE-058). Criterion 1 was unticked in audit (2026-11-13): no test opens a room from a checkpoint at a `seq` above 0 and replays only the log after it (the cited tests start from the content at 0 and replay the whole log), so "loads the latest checkpoint if one exists" is implemented in `Checkpointer.load` but not shown. Lane w5 (2026-11-15): criterion 1 is ticked again on a test that does open from a checkpoint above 0 (see its Evidence); no code of the room host changed. The checkpoint objects of that test are in memory, not in the S3-compatible store; the object store path is BE-020's (`be-020-checkpoint-object.pg.test.ts`). Criterion 4 stays open: no cold-open time has been measured (BE-058 has no run yet, and FND-007, FND-009 name the machine). Criterion 5 stays open: the open path still parses and replays on the main thread, and moving it to workers is the design change of ADR 0333 (proposed), which is larger than this story's remaining scope and was not started. Lane w5 (2026-11-17): nothing new could be ticked. Criterion 4 needs the cold-open measurement of FND-009 (criterion 2 there, unticked; no harness for the service exists, and FND-007's tolerances stay provisional until measured on a dedicated runner, owner decision 22 in `docs/owner-decisions-2026-11-15.md`). Criterion 5 waits on the design choice of ADR 0333 (a 16 MiB open built from plain data in a worker), which the 25 owner answers of 2026-11-15 do not settle. The story is blocked on those two.

### BE-020 Write checkpoints from the durable state

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Operator |

**Spec:** 06 §2.2 (3), §4.1 (`doc_checkpoints`), §4.2; 08 §3; ADR 0006; ADR 0010; review TENT-1 · **Requirements:** R4, R9 · **Depends on:** BE-003, BE-019, SYN-006

As an operator, I want checkpoints written from the durable state on a time-and-volume rule, and verified before older ones may be thinned, so that opening a document and rebuilding a version never replays a long log.

**Acceptance criteria**

- [x] Given a room, when 2,000 commits or ten minutes of activity have passed since the last checkpoint, whichever comes first, then a checkpoint is written, but never more often than every two minutes (defaults).
- [x] Given a snapshot commit is stored or a room closes with changes, when that happens, then a checkpoint is also written.
- [x] Given a checkpoint is written, when serialisation runs, then it runs in a worker thread (SYN-039) from the durable state only, never from the tentative state, and commits keep being acknowledged.
- [ ] Given a checkpoint, when it is stored, then the object holds the canonical document, a side object holds the attribution map and the comment ranges (when they exist), and a `doc_checkpoints` row holds the object key, the `seq`, the size and the content hash.
- [x] Given older checkpoints are to be thinned (HIS-029, HIS-030), when the new checkpoint's hash is compared with a replay of the log, then thinning proceeds only if they match, and a mismatch raises an alert.
- [x] Given object storage is unavailable, when a checkpoint is due, then the write is retried, the room keeps serving, durability is unaffected because the log alone is sufficient, and the failure is counted in the metrics of BE-086.

**Evidence (criterion 2):** `test/data-plane/snapshot-checkpoint.test.ts` "writes a checkpoint at the snapshot seq once a snapshot commit is stored after changes": a step commit writes no checkpoint, then `replaceContent` stores a snapshot at seq 2 and a checkpoint at seq 2 is written. The close half is `test/data-plane/drain-handover.test.ts` "answers the write in flight, checkpoints the room with changes, and releases its ownership" (a drain writes a checkpoint at seq 1).

**Evidence:** `services/document-service/src/data-plane/checkpoint-policy.test.ts`, "checkpoint triggers (BE-020 criterion 1)" and "spec defaults": a checkpoint is written after the third stored commit and not before (`everyCommits` 3); a time-based one comes at least `everyMs` after the first uncheckpointed commit; two checkpoints are at least `minIntervalMs` apart; `settingsFrom({})` resolves to 2,000 commits, ten minutes and two minutes. Criterion 6, "keeps acknowledging commits while object storage fails, counts the failure, and checkpoints again when it returns": the failure is counted in `dep_checkpoint_failures_total`, both commits are acknowledged, and a checkpoint is written once storage returns. The trigger tests use scaled settings and real timers; no default is measured.

**Evidence (lane U-BE-015-028, criterion 4):** `services/document-service/test/data-plane/be-020-checkpoint-object.pg.test.ts` (PostgreSQL and the S3-compatible store in Podman, run with `pnpm exec vitest run` on that file, 1 test passed): a room with a checkpoint after every second commit writes the object under the key of 06 §4.2; the `doc_checkpoints` row holds that key, the object's size and the hash `contentHash` gives; the object's bytes are the canonical text of its content, and the content holds the commits up to its seq. The side object for the attribution map and comment ranges is not written or asserted: it exists only with HIS-014, which is not built. Criterion 4 was unticked in review (2026-11-13): the object and the index row are proved, the side object is not, so the criterion is met in part only.

**Evidence (lane V-BE-015-028, criterion 3, in part):** `services/document-service/test/data-plane/be-020-worker-checkpoint.test.ts` (in process, memory stores, a pool of one worker thread): the pool runs a task on another thread than the main one, a checkpoint due after the second commit is written, six commits sent meanwhile are all `sync.ack`, and the pool's counts show the checkpoint work ran on it (`run` up, `inline` and `replaced` unchanged). Not shown: that serialisation reads only the durable state and never the tentative one.

**Evidence (lane V-BE-015-028, criterion 3, durable part):** `services/document-service/test/data-plane/be-020-v-be-015-028-durable-checkpoint.test.ts` (in process, in-memory stores, a pool of one worker thread, one held log write; 1 test passed, `pnpm exec vitest run` on that file): commit A is stored, and its time-based checkpoint (200 ms) is written while commit B is held in the store and still tentative. The checkpoint at seq 1 holds A's text and not B's, and the store still held B when it was written. Commits keep being acknowledged (B is acknowledged after release, head 2). Criterion 3 is ticked on both halves: the worker half is `be-020-worker-checkpoint.test.ts`.

**Evidence (lane w5, criterion 5):** `services/document-service/src/data-plane/recovery.test.ts` "the gate before checkpoints are thinned (BE-020 criterion 5)" (Node.js, in-memory stores, 1 test passed; `pnpm exec vitest run --project node` on that file). `gateThinning` in `recovery.ts` compares the checkpoint's hash with a replay of the log (`verifyCheckpoint`): a checkpoint built from the replay gives `proceed: true` and no alert; a checkpoint at seq 3 holding the content of seq 0 gives `proceed: false`, calls the alert sink and raises `dep_checkpoint_mismatches_total` (new in `metrics.ts`, visible in the scrape text); a checkpoint that is not there rejects, so nothing is thinned for it.

**Notes:** The attribution map's content is HIS's (08 §7); it joins the side data with HIS-014, so checkpoints written earlier lack it (Open questions). Checkpoint spacing and triggers are defaults: ADR 0010 says every 500 commits or 1 MiB of steps, but 08 §3 and 06 §2.2 were revised after the review to the time-based rule above, which this story follows. The trigger, the numbers, the content and the verification of a checkpoint are all fixed here. Phase inferred: the 1a demo can open rooms by replaying the log; checkpoints serve the open-time target of the first usable release. This story absorbed HIS-004 during the cross-check. Round 4 (data plane, packet A): criterion 2 is ticked in packet storage (2026-11-13, lane BE-014-026) after `snapshot-checkpoint.test.ts` submitted a snapshot; in that run the room wrote a checkpoint at seq 2 and then one at seq 1, a write order 08 §3 ("just before a snapshot commit") does not describe, so the order is an open point for the room's owner and is not asserted; criterion 3 is ticked by lane V-BE-015-028 (a worker-pool test and a durable-state test, see its Evidence); criterion 4 is not asserted for the stored object and index row; criterion 5 waits for HIS-029 and HIS-030. Lane w5 (2026-11-17): criterion 5 is ticked for the part that is BE-020's, the verification and the alert (`gateThinning`, see its Evidence). The thinning job itself is HIS-030 (unticked there) and must call the gate before it removes anything; HIS-030 criterion 3 says so. The alert is a callback plus a counter, not a paging rule: BE-086 owns the alert rules. Criterion 4 stays unticked: the side object (`{seq}.side.json.zst`, key in `objects/store.ts`) has no producer, because the attribution map is HIS-014's (unticked there) and the service replays it from seq 0 at read time (`control-plane/history-reads.ts`), and the room keeps no comment ranges as saved data that a checkpoint worker could take. The canonical object and the `doc_checkpoints` row are proved (`be-020-checkpoint-object.pg.test.ts`).

### BE-021 Close idle rooms and bound room memory

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 06 §2.2 (4), §8, §10; 04 §12 · **Requirements:** R9 · **Depends on:** BE-020, BE-084

As an operator, I want idle rooms closed after a delay and memory bounded, so that a node does not fill with documents nobody is editing.

**Acceptance criteria**

- [x] Given the last channel of a document closed, when 60 seconds pass with no new channel (default), then the room checkpoints if it has changes since the last checkpoint, releases ownership and frees its memory.
- [x] Given a channel opens within those 60 seconds, when the timer fires, then the room stays open and the timer is cancelled.
- [x] Given memory pressure on the process, when rooms must be closed, then only idle rooms are closed; a room with a channel is never evicted.
- [ ] Given a room memory budget set from BE-084, when total room memory approaches it, then idle rooms are closed first and memory per room is reported in the metrics of BE-086.

**Evidence:** `services/document-service/src/data-plane/checkpoint-policy.test.ts`, "idle close and the memory budget (BE-021)": a room with changes is checkpointed and removed after `roomIdleMs` once its last channel has gone (the 60 s default is asserted by the settings test); a channel that opens within the window keeps the room open, with no close and no checkpoint, and its next commit is acknowledged; `enforceBudget` closes the idle room and never the room with a channel. Round 4 fix in `src/data-plane/room-host.ts`: a room that has just loaded (no channel yet, `idleSince` null) was closed by the budget check that runs at load, so the first channel was refused with `ch.rejected`; `enforceBudget` now skips such rooms. The test "does not close a room that has just loaded" covers it. Criterion 1 (lane BE-014-026): `services/document-service/test/data-plane/be-021-idle-release.test.ts` "checkpoints a room with changes, releases its ownership and frees it once its last channel has been gone for roomIdleMs".

**Notes:** What happens when the budget is exceeded and no room is idle is not specified (see Open questions). The 16 MiB document limit is invariant I7 CDM-013. Phase inferred: idle closing matters once there are many documents, from the 1b stage 1 deployment. Round 4 (data plane): criterion 1 stays unticked because ownership release is not asserted (the ownership store has no read in its interface, `src/storage/types.ts`); the room's removal and its checkpoint are asserted. Criterion 1 is ticked (lane BE-014-026) by `services/document-service/test/data-plane/be-021-idle-release.test.ts`: a spy on `OwnershipStore.release` records the release at epoch 1 after the idle close, and the checkpoint at seq 1 is recorded; the test uses a 100 ms idle delay, the 60 s default is asserted by the settings test, and "frees its memory" is observed only as the room's removal from the host. Criterion 4 stays unticked (lane V-BE-015-028). `services/document-service/test/data-plane/be-021-memory-budget.test.ts` (in process, memory stores, a small test budget) shows that when the estimate is above the budget the idle room is closed and the busy room kept, and that `dep_room_memory_bytes` and `dep_open_rooms` are reported before and after. Not shown: the budget comes from BE-084, which is not measured (a figure on the reference machine), and the gauge reports memory per tenant (and the largest room in `dep_room_memory_max_bytes`), not each room. Lane w5 (2026-11-17): criterion 4 stays unticked, nothing new could be ticked. Its first half asks for a budget "set from BE-084", and BE-084 has measured no room yet (its criteria 1, 3 and 4 are unticked), so any figure would be invented; the budget today is a setting with a test value. The second half is nearer: `dep_room_memory_bytes` (sum per tenant), `dep_room_memory_max_bytes` and `dep_open_rooms` give the mean and the largest room per node and tenant, but there is no series per room, and the owner has not said whether the spec's "memory per room" (06 §11) means that or the distribution. A per-room series would carry the document id as a label, which the spec's per-tenant and per-node labels do not allow for. The story is blocked on BE-084 and that reading.

### BE-022 Drain a node on deploy

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 06 §2.2 (5); 05 §5.1 · **Requirements:** R9 · **Depends on:** BE-020, BE-029

As an operator, I want a node to hand over its rooms cleanly when it is stopped, so that a rolling deploy does not interrupt typing for longer than a reconnect.

**Acceptance criteria**

- [x] Given a termination signal or a drain command, when the node starts to drain, then it stops accepting new connections and channels.
- [x] Given a drain has started, when each connection is told, then it receives `goaway` with `reconnectInMs` jittered across connections and a `reason`.
- [x] Given commits are in flight or waiting for a write, when the node drains, then they are written and answered before ownership is released.
- [x] Given rooms have changes since their last checkpoint, when the node finishes draining, then each is checkpointed and its ownership released, so another node can take it without waiting for a lease to expire.
- [x] Given a rolling restart with clients typing, when they reconnect with `resume`, then every client ends with the same document and no acknowledged commit is lost.

**Evidence:** `test/data-plane/drain-handover.test.ts` (in process, memory stores, a held log write): "refuses new connections and new channels once the drain starts" (criterion 1: a new connection gets 503, a channel for another document gets `ch.rejected` `unavailable`); "tells every connection to reconnect with a jittered hint and a reason, then closes it with 4503" (criterion 2: both connections get `goaway` with an integer hint from 1,000 to under 5,000 ms and a reason, then close with 4503); "answers the write in flight, checkpoints the room with changes, and releases its ownership" (criterion 4: nothing is released while the write is held; after it is answered the room is checkpointed at seq 1 and the release of epoch 1 is recorded). Existing: `test/data-plane/session-1b.test.ts` "sends goaway with a jittered reconnectInMs and a reason, then closes with 4503".

**Evidence (lane V-BE-015-028, criterion 3):** `services/document-service/test/data-plane/be-022-queued-drain.test.ts` (in process, memory stores, two held writes): alice's commit is in flight and bob's waits behind it on another channel (one commit per channel may be in flight); after the drain starts and the first write is released, bob's commit is written as the next write, and both are answered `sync.ack` and stored (head 2) before the one release of ownership is recorded.

**Evidence (lane V-BE-015-028, round 3, criterion 5):** `services/document-service/test/data-plane/be-022-rolling-restart.pg.test.ts` (two planes over PostgreSQL in Podman, `pnpm exec vitest run` on that file, 1 test passed, not skipped). Each reload is read at head with `readContent`, the data-plane method the REST content route calls (`control-plane/kit.ts`), using the client's own identity; the test checks the read sequence equals the reload's head. The content at head equals the content at 0 with every stored commit applied in order (`parseSteps` and `applySteps` from `packages/authority`), and each reloaded client's content equals that replay up to its head. Streamed clients are checked by sequence and identifier against the log.

**Notes:** Phase inferred: needed for the rolling restarts of the 1b fault test. Packet storage (2026-11-13, lane BE-014-026): criterion 2 is ticked on the range and delivery of the hint. The spread across connections is a random draw in `src/data-plane/index.ts` (`drain`); the test checks each hint's range, not the spread, since two equal draws are possible. Criterion 3 is ticked (lane V-BE-015-028) by `be-022-queued-drain.test.ts`, which holds a commit queued behind the write in flight. Its first try failed: the room did not write the queued commit, but the commit came from the same channel, which may only have one commit in flight (`busy`), so the test now uses a second channel. The product code was not changed. A commit sent during the drain is not acknowledged (the session closes first); the test checks that it is not stored, not the `unavailable` reply. Criterion 5 (lane U-BE-015-028): `services/document-service/test/data-plane/be-022-rolling-restart.pg.test.ts` runs two planes over one PostgreSQL database, drains node A with two typing clients, resumes both on node B and checks the commit sequence and identifiers each client saw against the stored log, and that each acknowledged text is in its stored commit (1 test passed in Podman). Every resume came back `reload` (the room's visibility gate, `minVisibleSeq`, was not traced further), and the data plane sends no inline content on reload (the REST content read is not served by the in-process plane). So the reloaded document was not read, the streamed path was not exercised, and the criterion stays open. The handover test, "hands the room to another node after a drain", uses the memory ownership store, whose claim is unconditional, so it does not show a lease is not needed; the release call is what criterion 4 rests on.

### BE-023 Run operations on closed documents in a transient authority

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | should | Integrating developer |

**Spec:** 06 §2.2 (last paragraph); 04 §10 · **Requirements:** R3, R13 · **Depends on:** BE-017, BE-024, SYN-001, SYN-006

As an integrating developer, I want prefill and bulk imports to work on documents nobody has open, so that I do not need an editing session to fill a form.

**Acceptance criteria**

- [x] Given a document with no open room, when a server-authored operation such as a prefill is run, then a transient authority loads the document, applies the operation through the same checks as any commit, stores the commit and exits.
- [x] Given a transient authority, when it runs, then it has no subscribers and no timers and holds no memory after it exits.
- [x] Given the operation's preconditions no longer hold, when it is applied, then no commit is stored and the requester receives the rejection.
- [x] Given a channel opens for the document while a transient operation runs, when both try to write, then the epoch check of BE-017 lets only one proceed and the other retries or waits.

**Evidence (criterion 4, lane U-BE-015-028):** `services/document-service/test/data-plane/be-023-transient-race.pg.test.ts` (PostgreSQL in Podman, run as one file with `pnpm vitest run`): a gated log store holds the prefill's write, a channel opened meanwhile does not open until that write is stored, and the room then stores the channel's commit as seq 2 on top of the prefill's seq 1 (no gap or duplicate). The test checks that the channel waits and the log order, not the epoch values.

**Evidence (lane w5, criterion 2):** `services/document-service/test/data-plane/be-023-transient-held.test.ts` (Node.js, in-memory stores, 1 test passed; `pnpm exec vitest run --project node` on that file). During a prefill on a closed document, `setTimeout` and `setInterval` are wrapped: every timer the run starts has fired or been cleared when it exits (0 pending). No room is registered, `transientCount` is 0, and `dep_open_rooms` and `dep_connections` have no series above 0, so nothing is subscribed (a transient authority is built with no channel). The permission data and the log array the room is built from are fresh objects held by weak references; after a forced garbage collection (`--expose-gc` set at run time through `v8.setFlagsFromString`) none is alive. The test was checked to fail when one of them is kept alive on purpose. The memory check is about what the room is given, not a heap measurement: it shows the room and what it refers to were released, not a number of bytes.

**Evidence (criterion 3):** `src/data-plane/transient-refusal.test.ts` "rejects a prefill whose base is ahead of the head, stores no commit and leaves no room": a prefill on a closed document with a base ahead of the head is refused with `invalid_op` (the requester's `apply` rejects with `RequestRefused`), the head stays 0, no room or transient authority is left, and a later valid prefill is stored as seq 1. The one precondition tested is the base; the grant and region preconditions are not.

**Evidence:** `services/document-service/src/data-plane/transient.test.ts`, "applies a server-authored commit to a document with no open room, stores it, and leaves nothing held" and "loads the log tail when the document already has commits": an author operation (prefill origin, `system` actor) on a closed document is applied by a transient authority at seq 1, a second run stores seq 2 from the tail, no room is registered afterwards, and a client that opens later starts from head 1.

**Notes:** The spec does not say whether a transient authority takes the ownership row; the last criterion assumes it uses the same fencing so that two authorities never write (see Open questions). Round 4 (data plane): criterion 2 is not met (only the absence of registered rooms is checked; timers and held memory are not observable from the test); criterion 3 (a refused precondition stores nothing) is ticked in packet storage (2026-11-13, lane BE-014-026, see its Evidence). Criterion 4 is ticked (lane U-BE-015-028) by `be-023-transient-race.pg.test.ts` over PostgreSQL; criterion 2 stays unticked (no timers and no held memory are observable from the test). Lane w5 (2026-11-17): criterion 2 is ticked by `be-023-transient-held.test.ts`, which observes both (a wrapper on the timer functions and weak references with a forced collection); see its Evidence. The epoch-versus-ownership question of the first Note is unchanged.

## Rooms: persist pipeline

### BE-024 Persist commits in group-commit transactions

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Author |

**Spec:** 06 §2.3; 04 §5 (steps 9, 10), G2; review SYNC-1, TENT-1 · **Requirements:** R7 · **Depends on:** BE-017, BE-009, SYN-001, HIS-002

As an author, I want a commit acknowledged only after it is durably stored, and many commits stored in one write, so that nothing I saw confirmed can be lost and the database is not the bottleneck.

**Acceptance criteria**

- [x] Given commits arrive while a write is in flight for the room, when that write completes, then everything that arrived meanwhile is stored in the next single write, and no room has more than one write in flight.
- [x] Given a write, when its transaction runs, then it (1) locks the head row and checks the ownership epoch and that the head is where the room believes, (2) reads the grants revision and compares it with the one the batch was checked against, (3) inserts the commit rows, payloads and `commit_scopes`, and (4) advances the head and `chain_head` and applies the side effects of control commits, such as retiring a deleted region's grants.
- [x] Given a commit row, when it is stored, then it holds every field listed in HIS-001, HIS-002, including `server_ts` from the server clock, `base`, `rebased`, `access_rev`, `token_jti`, `cdm_version`, `engine`, `size`, `prev_hash` and `hash`.
- [x] Given the transaction commits, when acknowledgements and broadcasts are released, then they go out in `seq` order and an acknowledgement or rejection is never sent on a channel before all lower `seq` commits have been sent on it.
- [x] Given control commits (grants revision, region state, lease break), when they are persisted, then they pass through the same pipeline with kind `control`.
- [ ] Given a load of many typists in one room, when commits are acknowledged, then the median is 50 ms and the 99th percentile 300 ms within one region (targets, measured in BE-058).

**Evidence:** `services/document-service/src/storage/log-store.ts` writes a batch in one transaction of four statements: `BEGIN` with the tenant; the head row `FOR UPDATE` with the revision row `FOR SHARE`, compared with the batch's epoch, head and revision; one statement that inserts the commits, payloads, scopes and retired regions, deletes the retired regions' grants, states and leases, and advances `head_seq` and `chain_head`; `COMMIT` (`test/postgres/write-path.pg.test.ts`, ADR 0020). The room batches whatever arrived during a write, and the S3 harness fails if a room starts a second write while one is in flight; against PostgreSQL that held over 16,836 batch writes (SYN-047). The same run checks the order of every message on every channel (`packages/authority/test/harness/sim.ts`, G5). Control commits are stored like step commits with kind `control` (contract check "control commits are stored and read back like step commits"); in a run of 100 schedules against PostgreSQL, 155 control commits that the room recorded after grant changes went through the same conditional append as 222 step commits (counted on writes that returned `ok`). Every field of HIS-001 is now recorded: `src/storage/codec.ts` writes `base`, `rebased`, the token `jti` and the agent that the room stamps, and `log-store.ts` reads them back (`test/data-plane/postgres.pg.test.ts` "records every field of a commit, the rebased steps as applied and the token jti").

**Notes:** The algorithm up to step 8 is SYN's. The payload and chain formula are HIS's (08 §2); this story writes them. The chain layout is provisional (ADR 0020, proposed) until HIS-002 publishes one. Criterion 3 waits on the room: `StoredCommit` carries no `base`, `rebased`, `token_jti` or agent, so those columns are stored as NULL. A batch holds only commits checked against one grants revision (a choice of spike S3), so commits checked against two revisions go out in two writes. Criterion 6 is measured in BE-058. Lane w5 (2026-11-15): nothing new could be ticked. Criterion 6 is a measurement of many typists in one room within one region; BE-058 (the load harness and its report) has no criterion ticked and no run, and there is no reference machine or region here, so no figure exists to put beside the targets. The sentence above that criterion 3 waits on the room is out of date: the fields are stored and read back (see Evidence). Lane w5 (2026-11-17): nothing new could be ticked. Criterion 6 is the measurement of FND-009 criterion 1 (unticked; no load harness for the service exists, and the reference machine's tolerances stay provisional until measured on a dedicated runner, owner decision 22 in `docs/owner-decisions-2026-11-15.md`). The story is blocked on that measurement.

### BE-025 Handle failed, unknown and conflicting writes

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Author |

**Spec:** 06 §2.3, §8; 04 §5 ("When a write fails"); review TENT-1 · **Requirements:** R7, R9 · **Depends on:** BE-024

As an author, I want the room to recover correctly when a database write fails or its outcome is unknown, so that no commit is lost, duplicated or half-acknowledged.

**Acceptance criteria**

- [x] Given a write fails with a definite error, when the room reacts, then it discards the tentative state, continues from the durable state, and rejects the batch's commits with the retryable code `unavailable`.
- [x] Given the connection broke during the transaction and the outcome is unknown, when the room reacts, then it re-reads the log tail before accepting any further commit, answers the commits that turn out to be stored with acknowledgements rebuilt from the log, and rejects the rest with `unavailable`.
- [x] Given the grants revision moved between the check and the write, when the transaction runs, then it fails and the commits are rejected with `unavailable`, and when resubmitted they are checked against the new permissions.
- [x] Given a unique-key conflict on the commit identifier only, when it occurs, then it is handled as a duplicate submission and not as another writer.
- [x] Given an epoch or sequence conflict, when it occurs, then the room stops serving, closes its channels with `ch.closed` and code `unavailable`, and drops its memory.
- [x] Given random failures injected before the insert, after the insert and before the commit, and after the commit and before the answer, when many clients submit for a long run, then every acknowledged commit is in the log exactly once and the log has no gaps.

**Evidence:** `services/document-service/src/storage/log-store.ts`: an error before COMMIT is sent is `failed`; an error while COMMIT is outstanding makes the store wait for the head row (`FOR SHARE`, granted only once the uncertain transaction has ended) and read the log back from the batch's first `seq`, which it returns as `unknown` with that tail; a store it cannot reach is `failed`. `test/postgres/outcomes.pg.test.ts` does this with real failures and real rooms. A session ended before COMMIT stores nothing and the commit is rejected with `unavailable`. A session ended while COMMIT sleeps in a deferred trigger gives `unknown` with an empty tail. A relay that drops the answer to a COMMIT that the server applied gives `unknown` with the stored commit, which the room acknowledges. An unreachable database gives `failed`. The contract check for a replaced revision returns `revision_moved` with the permissions in force (`test/contract/checks.ts`). The S3 suite against PostgreSQL injected 467 failures before the insert, 800 after the insert and before COMMIT, 1,236 after COMMIT and before the answer, and 1,192 unknown outcomes that were rolled back, over 3,000 schedules: every acknowledged commit was in the log once and the log had no gaps (SYN-047). A conflict on the commit identifier alone returns `duplicate` with the stored commit, from both log stores (`src/storage/log-store.ts`, `memory.ts`; contract checks "a conflict on the commit identifier alone is not another writer" and "a batch is stored entirely or not at all", `test/contract/checks.ts`, in memory and PostgreSQL), and the room answers it from the stored commit. A fenced room stops, closes its channels with `ch.closed` `unavailable` and is dropped by the room host, which opens a new room on the next channel (`test/data-plane/rooms.test.ts` "stops serving when another node holds the document"; "stops the room when even the log could not be read back" for `OutcomeUnknownError`, which the host reports to the room as `lost`).

**Notes:** The last criterion is the "failed writes" part of the S3 property tests SPK-016 run against the real service (phase 1a exit). Criterion 4: the store tells a conflict on the commit identifier alone (`failed`) from a conflict on `(doc_id, seq)` (`fenced`), so the room does not take it for another writer. It cannot be handled as a duplicate, because `WriteResult` has no outcome that carries the stored commit; see the report of SYN-047. Criterion 5: the room stops and closes its channels (`test/postgres/fencing.pg.test.ts`); dropping the room's memory is the room host's (BE-001). When even the log cannot be read after an unknown outcome, `append` rejects with `OutcomeUnknownError`, and the host must stop the room; the room has no outcome for that either.

### BE-026 Refuse commits checked against stale grants

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Owner |

**Spec:** 06 §2.3 (step 2), §3 (third bullet), §8; 04 G7; 07 §9; review PERM-1 · **Requirements:** R3 · **Depends on:** BE-010, BE-024

As an owner, I want a removed grant to stop working even if the notification to the room is lost, so that nobody keeps editing under permissions that were replaced.

**Acceptance criteria**

- [x] Given a grant change or a region-state change, when it is written, then the changed rows and a new value in `grant_revisions` are committed in one transaction, and the owning room is announced afterwards.
- [x] Given the announcement is lost, when the room persists a batch that was checked against the old revision, then the transaction refuses it, the room reloads grants, and the commits are rejected with `unavailable` for resubmission.
- [x] Given the `PATCH` of grants has returned the new revision, when any commit later reaches the write, then none is stored under the old revision (concurrency test with the change and a stream of commits interleaved).
- [x] Given the announcement arrives, when the room recomputes access, then it records a control commit and sends `perm.changed` PRM-004, PRM-019.

**Evidence:** `PgGrantStore.change` (`services/document-service/src/storage/grant-store.ts`) raises `grant_revisions.rev` first, then changes the rows and records the state in force in `grant_history`, all in one transaction; a log write holds the revision row `FOR SHARE` while it compares revisions. `test/postgres/revision-race.pg.test.ts`: a change waits behind a write that holds the row and commits after it; and in 20 rounds of a grant change interleaved with a stream of writes, nothing that began after the change returned was stored under the old revision. In PostgreSQL's own commit order (`track_commit_timestamp`), every commit checked against the old revision committed before the change. A write against a replaced revision returns `revision_moved` with the permissions in force (`test/contract/checks.ts`). The S3 suite against PostgreSQL lost 3,007 of 8,707 notifications and stored nothing under a replaced revision (SYN-047). The control plane writes the change and then calls the data plane (`src/control-plane/handlers.ts`, packet A2); the room records a control commit and sends `perm.changed` after it (`test/data-plane/permissions.test.ts` "records a control commit, then sends perm.changed with a higher rev and asOfSeq at that commit"; PostgreSQL in `test/data-plane/postgres.pg.test.ts`).

**Notes:** Grant semantics and the grants API are PRM's. SEC-026 proves the race adversarially. Criterion 1 is done in storage (rows and revision in one transaction); announcing the change to the owning room needs the control API and the room host (BE-001). Criterion 4 is the room's reaction to that announcement and waits on it as well.

## Rooms: fan-out

### BE-027 Bound each channel's send queue

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 06 §2.4, §8; 10 §3.2 · **Requirements:** R7, R9 · **Depends on:** BE-024

As an operator, I want a consumer that falls behind to be closed and resumed, so that one slow tab cannot grow a room's memory without limit.

**Acceptance criteria**

- [x] Given every channel has a bounded send queue, when a consumer's queue exceeds its bound, then the channel is closed with `ch.closed` and code `slow_consumer` and its queue is dropped.
- [x] Given the closed client reopens with `resume` at its last `seq`, when it is caught up SYN-026, SYN-027, then it receives every missing commit once and in order.
- [x] Given one channel is slow, when it is closed, then other channels in the room keep their latency and the room's memory returns to its baseline.
- [x] Given queues, when metrics are scraped, then send-queue depth is reported (BE-086).

**Evidence:** `services/document-service/test/data-plane/session-1b.test.ts`, "bounded send queues (BE-027)": a reader whose socket is paused falls behind and is closed with `ch.closed` and `slow_consumer` (the `slowConsumers` metric reads 1), its queued bytes read 0 afterwards, and a resume at its last `seq` receives every missing commit once, in order, before `sync.caughtUp`; the reader that kept up gets every commit and is never closed. Criterion 4: `services/document-service/src/data-plane/metrics.test.ts`, "reports the bytes waiting in send queues per tenant while a reader lags, and zero once it is closed (BE-027 criterion 4)" reads `dep_send_queue_bytes` for the node and tenant: above 60,000 bytes while the lagging reader holds commits, and below a tenth of the peak after it is closed.

**Evidence (lane w5, criterion 3):** `services/document-service/test/data-plane/be-027-slow-isolation.test.ts` (Node.js, in-memory stores, a real WebSocket server on an ephemeral port, 1 test passed in each of 4 runs; `pnpm exec vitest run --project node` on that file). A writer and a fast reader share a room. Phase 1: 10 commits of 60,000 characters with no slow reader; phase 2: the same commit size while a third reader's socket is paused until the service closes it with `slow_consumer` (12 commits in the run below). Latency is the time from the writer sending a commit to the fast reader receiving it. In one run on this development machine (Windows 11, Node.js 22, loopback) the medians were 18.0 ms without and 21.2 ms with the slow reader. The test allows the slow phase at most `max(5 x the first median, the first median + 50 ms)`; that allowance is the test's own, chosen to catch a fast reader that waits for the slow one, and is not a spec figure or a target. The fast reader received every seq once and in order and was never closed. Memory: the bytes queued over all connections (`sessions[].queuedBytes`, and `dep_send_queue_bytes` in the scrape) equal the value read before the slow reader joined once it is closed and the queues have drained.

**Notes:** Criterion 3 is ticked by `be-027-slow-isolation.test.ts` (lane w5, 2026-11-17). "The room's memory" is read as the send-queue memory the slow channel added, which returns to its baseline; it is not a heap measurement of the room (BE-084 measures that, unticked). The latency comparison is one machine and one commit size, not a load test. Criterion 4 reports bytes, not messages, and the gauge is per tenant (the BE-086 labels). The bound is not given in the spec. Phase inferred: the first usable release must not let a slow tab grow a room without bound.

### BE-028 Attach large audiences to follower nodes

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | L | could | Operator |

**Spec:** 06 §2.4, §6 (stage 3); 04 §12 · **Requirements:** R9 · **Depends on:** BE-062, BE-067

As an operator, I want viewers of a very popular document attached to follower nodes, so that the owning room fans out to a few followers instead of thousands of viewers.

**Acceptance criteria**

- [ ] Given a follower node subscribes to a room's ordered stream on the bus, when viewers attach to it, then they receive the same commits in the same order as on the owner.
- [ ] Given a viewer on a follower, when it sends a commit, then the follower refuses it and nothing reaches the room.
- [ ] Given the stream to a follower has a gap, when the follower detects it, then it resubscribes from its last `seq` and no viewer sees a gap or a duplicate.
- [ ] Given a document with many viewers, when the owner's fan-out count is read, then it equals the number of followers plus its own channels, not the number of viewers.

**Notes:** Only if BE-067 finds followers are needed before stage 3, or demand drives stage 3 (11 §7). Phase inferred: stage 3 is not scheduled. Lane V-BE-015-028 (2026-11-13): no follower code exists in `services/document-service/src`, and BE-062 (bus forwarding) and BE-067 (the decision) are not built, so no criterion can be tested. Left unticked; needs BE-062 and BE-067 first.

## Gateway Lane w5, 2026-11-18: nothing ticked (blocked), nothing built. Owner decision 139 (docs/owner-decisions-2026-11-15.md): read-only follower nodes are "not before stage 3, on demand", and a submission on a follower is refused with `read_only` (ADR 0147); the story's own condition is the same (BE-067 must find that followers are needed). BE-067 is unticked: its measurement needs the stage 2 load test of BE-066, which needs several room hosts and 50,000 connections and has not been run, so there is no evidence of demand. BE-062 now gives the forwarding stream (`control-plane/channel-forward.ts`, `data-plane/forwarding.ts`: ordered frames, gap detection, repair from a window) that a follower could reuse, but a follower is a different thing: a node that subscribes once per document and fans out to many local viewers, refuses submits itself, and answers an owner-side fan-out count. Building it now would decide a stage 3 design that the owner deferred; none was built. When demand is shown: criterion 1 reuses the forwarding stream per follower, criterion 2 is the `read_only` refusal of decision 139, criterion 3 is the repair or resubscribe of `channel-forward.ts` per follower, criterion 4 is a metric of the owner's channel count by kind (follower or client).

### BE-029 Accept and authenticate WebSocket connections

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 06 §1; 10 §3.2; 05 §3.1, §4, §5.1, §5.7 · **Requirements:** R6, R10 · **Depends on:** BE-012, BE-013, PRO-017, PRO-037, PRO-009, PRO-010

As a maintainer, I want the gateway to accept a connection only after a valid `hello`, so that no channel opens for an unauthenticated or foreign-origin client.

**Acceptance criteria**

- [x] Given a WebSocket upgrade with the subprotocol `dep.v1`, when no `hello` arrives within 10 seconds, then the connection closes with code 4408.
- [x] Given a `hello` with a token, when it is verified, then the key set is the one registered for `tid` (BE-012), only ES256, EdDSA and RS256 are accepted, `aud` equals the service identifier exactly, `exp` is at most 15 minutes after `iat`, 60 seconds of clock skew is allowed, and any failure ends in an `error` and close code 4401.
- [x] Given the `Origin` header is not in the tenant's allowed origins when `hello` arrives (the moment the tenant is known), when the check runs, then the connection closes with code 4403.
- [x] Given a token appears only in the URL, when the connection is made, then it is never read, no `hello` follows, the connection closes with 4408, and the URL is not logged with the token.
- [x] Given a `hello` whose versions have nothing in common with the server's, when it is processed, then an `error` lists the server's versions and the connection closes with 4406.
- [x] Given malformed JSON or an envelope that fails strict parsing, when a frame arrives, then the connection closes with 4400; given an unchunked message above `maxMessageBytes`, then it closes with 4413.
- [x] Given a valid `hello`, when `welcome` is sent, then it carries `version`, `session`, `user`, `features`, `tokenExp` and every limit of 05 §5.1 (`maxMessageBytes`, `maxCommitBytes`, `maxStepsPerCommit`, `maxRebaseSteps`, `maxChannels`, `heartbeatMs`, `ackTimeoutMs`, `presenceHz`, `presenceBytes`, `catchUpCommits`, `catchUpBytes`) with the service's configured values, and `auth.expiring` follows about 60 seconds before `tokenExp`.
- [x] Given `auth.refresh` with a token whose `tid` or `sub` differs from the session's, when it is processed, then it is refused.

**Evidence:** Data plane (`src/data-plane/session.ts`; `test/data-plane/session.test.ts`): 4408 without hello (the 10 seconds are `helloTimeoutMs`), and a token in the URL is never read (the verifier is never called); the Origin header is checked against the tenant origins when hello arrives (4403), a client without one is accepted (ADR 0035); no common version gives an error listing the versions, then 4406; malformed frames, binary frames and text that is not UTF-8 close with 4400, a frame above `maxMessageBytes` with `too_large` and 4413; welcome carries version, session, user, features, every limit and tokenExp, and auth.expiring comes about 60 seconds before it; auth.refresh with another tid or sub is refused.

**Notes:** The rules are normative in 05 §3 to §5 and covered as protocol requirements by PRO; this story is the reference service honouring them. SEC-012, SEC-013 and SEC-017 attack it. Whether a non-browser client without an `Origin` header is accepted is not stated (see Open questions). Criterion 2 is ticked (lane U-BE-029-042, 2026-11-13): the checks are the control plane's token verifier (`src/control-plane/tokens.ts`, tested in `test/control-plane/tokens.test.ts`: skew, the algorithm allow-list, key selection by tenant), which the data plane uses through `verify: tokens.verifyUser` in `src/server.ts`. `test/server/be-029-hello-verification.test.ts` (memory, real data plane, WebSocket client) shows through the service that a valid token gets `welcome`, and that a key the tenant did not register, an `aud` other than the service identifier, an `exp` more than 15 minutes after `iat` and `alg` none each get an `error` and close code 4401. The valid token in that test names one document in `docs`; with an empty `docs` the same token was refused as `unauthenticated`, and the cause was not traced. Choices where the spec is silent are in ADR 0035.

### BE-030 Rate-limit by address, connection, user and tenant

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 06 §1, §8; 10 §3.2; review S-07 · **Requirements:** R10 · **Depends on:** BE-029, BE-012, SYN-037

As an operator, I want limits applied per address before authentication and then per connection, user and tenant, so that one noisy client or tenant cannot take editing away from the others.

**Acceptance criteria**

- [x] Given an address opens connections or sends frames above its limit before authentication, when the limit is reached, then further connections are refused or closed with 4429 and no token verification work is done for them.
- [x] Given an authenticated connection, user or tenant exceeds its limit, when the next message arrives, then the socket answers `error` with `rate_limited` and `retryAfterMs` (or closes with 4429), and REST answers 429 with `rate_limited` and `Retry-After`.
- [ ] Given limits are held per tenant in the registry of BE-012, when one tenant is at its limit, then another tenant's acknowledgement latency does not rise.
- [x] Given presence updates above the per-client cap SYN-035, when they arrive, then the gateway drops or coalesces them before they reach the room.
- [x] Given stage 1, when counters are kept, then they are in process memory; given stage 2, they move to Redis or Valkey (BE-063) without changing the limits' behaviour.

**Evidence:** Criterion 1: `services/document-service/test/data-plane/session-1b.test.ts` "rate limits (BE-030)": an address over its upgrade limit gets HTTP 429 with `Retry-After` and the token verifier is not called for it; an address over its frame limit before `hello` is closed with 4429. Criterion 2, socket half only: the same file, "answers messages over the connection limit with rate_limited and retryAfterMs, and closes after repeated refusals" (a submit over the connection bucket gets `sync.reject` `rate_limited` with `retryAfterMs`, a presence update gets non-fatal `error` `rate_limited`, the third refusal closes with 4429; passes 2026-11-13). Criterion 4: `test/data-plane/presence.test.ts` "more than presenceHz updates a second are coalesced without closing"; the relay in `src/data-plane/presence.ts` runs before the room. Buckets and their keys (address, tenant, user keyed by tenant and identifier, connection): `src/data-plane/limits.test.ts` (13 tests, 2026-11-13); the REST decision and `Retry-After` seconds are `RateLimits.rest` and `retryAfterSeconds` in the same file (round 7). Criterion 2, REST half (lane U-BE-029-042, 2026-11-13): `services/document-service/test/control-plane/be-030-rest-limit.test.ts` (memory run, in process, over real HTTP): the third GET by a user over a user bucket of capacity 2 is 429 with `rate_limited` and an integer `Retry-After` of at least 1; another user of the tenant gets 200; with the default rates five requests pass. The pipeline check is in `src/control-plane/pipeline.ts`, and `server.ts` shares one `RateLimits` between the sockets and the pipeline.

**Evidence (lane w5, 2026-11-17, criterion 5 and the part of criterion 3 that is built):** Criterion 5: `RateLimits` takes its tenant and user counters from a `RateStore` (`src/data-plane/limits.ts`): `MemoryRateStore` is stage 1, and `ValkeyTokenBuckets` (BE-063) is stage 2, chosen by `DOCEDIT_VALKEY_URL` (`valkeyUrl` in `src/config.ts`, wired in `src/server.ts`). `src/data-plane/limits.test.ts` "counters behind a store" runs one scripted sequence of messages through process memory and through an asynchronous store and gets equal answers. `test/data-plane/be-030-shared-store.test.ts` (run on 2026-11-17 against Valkey 8 in Podman, `DOCEDIT_VALKEY_URL=redis://127.0.0.1:56395`, 3 of 3 pass; skipped without the variable) runs the same script against memory and against real Valkey with equal answers, both scopes refusing, `stats.degraded` 0; shows one user limit shared by two `RateLimits` on one store; and shows a real data plane with WebSocket clients refusing tenant A at its limit and not tenant B. `test/control-plane/be-030-tenant-limits.test.ts` (last case, same run) starts the service with `valkeyUrl` and gets 200, 200, 429, 429 on REST for a user limit of 2, with the counter key present in Valkey. Criterion 3, the registry half: `tenants.rate_limits` (migration `0072_be_030_tenant_rate_limits.sql`), `TenantRegistry.rateLimits` and `setRateLimits` in memory and PostgreSQL (`src/control-plane/tenants.ts`); the gateway reads a tenant's limits through `RateLimits` and the registry (`src/server.ts`), refreshed every 5 seconds or by `forget`. `test/control-plane/be-030-tenant-limits.test.ts` (memory and PostgreSQL, 5 of 5 pass) stores, returns, clears and refuses malformed limits, and shows REST answering 429 at a limit registered for the tenant; `src/data-plane/limits.test.ts` "limits held per tenant" shows one tenant on its own limits while another has the defaults, the time to live, `forget`, and a failing registry leaving the defaults. Isolation under load: `test/data-plane/be-030-tenant-isolation.test.ts`, three runs on 2026-11-17 on the development machine (Windows, Node 22.18, one process, memory stores, 60 sequential submits each): tenant A refused about 2380 of 2400 flooded messages at its registered limit and tenant B was never refused; B's acknowledgement median was 2.1, 4.0 and 4.3 ms alone and 9.7, 13.8 and 17.0 ms during the flood.

**Notes:** The spec names the layers but no limit values (see Open questions). Phase 1b inferred: abuse resistance belongs to the first usable release. Criterion 2 (2026-11-13): the socket test now uses a connection capacity of 2, since `hello` is not counted and `ch.open` is (ADR 0103), and it passes. Criterion 2 is ticked (lane U-BE-029-042): its REST half is wired, see Evidence. Round 7 (2026-11-13): the data plane now offers the decision for that route, `RateLimits.rest(tenant, user, now)` (it shares the tenant and user buckets with socket messages and returns the scope and `retryAfterSeconds`), and the control plane's pipeline now calls it after authentication (lane U-BE-029-042). Criterion 3 stays unticked (lane w5, 2026-11-17). The registry half is built (limits per tenant in `tenants.rate_limits`, read by the gateway; ADR 0380, proposed) and one tenant at its limit is shown not to refuse or slow another's buckets. The latency half is measured and does not hold as the criterion words it: B's acknowledgement median rose from about 2 to 4 ms to 10 to 17 ms while A sent about 2400 messages in under a second, and a lighter flood of about 120 to 330 messages raised it by about 1 to 3 ms. The rise follows the volume A sends, not A's bucket: one event loop reads every frame before the limit can refuse it. Closing it needs the rate limit before the read (the address limit before `hello` does this) or separate processes per tenant, which is a load test on a dedicated runner (BE-058). Criterion 5 (lane w5): the counters are in process memory by default and in Valkey with `DOCEDIT_VALKEY_URL`, with equal answers for the same messages. Address counters (upgrade and frames before `hello`) stay in the node's memory in both stages, by choice recorded in ADR 0380; so the address limit is per node, not shared. `RateLimits.message` and `rest` are now asynchronous.

### BE-031 Revoke a user's sessions

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | must | Integrating developer |

**Spec:** 05 §3.3; 06 §4.1 (`tenant_users.revoked_before`); 07 §9; 10 §3.2 · **Requirements:** R3, R10 · **Depends on:** BE-013, BE-029, BE-033, BE-014, PRO-016, PRM-022

As an integrating developer, I want the service to keep a revocation and check it at every entry point, so that a person removed from my application cannot keep editing or reconnect with an old token.

**Acceptance criteria**

- [x] Given a service credential, when `POST /sessions/revoke` names a `sub`, then the user's `revoked_before` is set to the current server time.
- [x] Given the user has open connections, when the revocation is recorded, then the room closes their channels at once.
- [x] Given a token is presented in `hello`, `ch.open`, `auth.refresh` or as a REST bearer, when the gateway checks it, then it compares the token's issue time with the user's `revoked_before` at each of these points and refuses a token issued before it.
- [x] Given the service restarts, when the old token is presented, then it is still refused (the watermark is stored, not in memory).

**Evidence (lane BE-027-039, round 2, no criterion ticked):** `services/document-service/test/control-plane/be-031-revocation.test.ts`: at the token verifier (`TokenService.verifyUser`, the verifier the REST pipeline and the data plane share, `src/server.ts`), a token issued before the watermark is refused with `revoked` and a token issued in the same second as the revocation is accepted; a revocation naming one document refuses a token for that document alone and leaves a token that also covers another document. The route and the watermark's value are exercised only by `test/control-plane/routes.content.test.ts` ("revokes a user's sessions for every document or for one", PostgreSQL and memory where the run allows).

**Evidence (lane U-BE-029-042, 2026-11-13):** services/document-service/test/control-plane/be-031-revoke-pg.pg.test.ts ('sets revoked_before of the named sub to the server time, and only for that sub'), PostgreSQL in Podman (`docedit-test-postgres`, one database of its own). The watermark is the server time to the second (D73), so the test asserts whole seconds between the start and the end of the request.

**Evidence (lane V-BE-029-042, criteria 2 and 3):** `services/document-service/test/server/be-031-revoke-gateway.test.ts` ("closes the open session of a revoked user at once, and refuses the old token at hello, ch.open and auth.refresh"), run with `pnpm vitest run` against `startService` in memory with a real WebSocket client. `POST /v1/sessions/revoke` for `ann` gives 204; the open session gets `auth.revoked` and closes 4401 `revoked` (criterion 2). The token issued five seconds earlier is refused at `hello` (error and 4401), at `ch.open` (`ch.rejected` `forbidden`), at `auth.refresh` (`error` `revoked`) and as a REST bearer (401 `revoked`); a token issued after the revocation is accepted. Memory storage here; the watermark's PostgreSQL storage is the restart test above.

**Notes:** The contract is PRO-016 and what a revocation means for access is PRM-022, including the audit entry; this story owns the stored watermark and the checks at the gateway. Lane BE-027-039 finding (not changed here): the per-document revocation is stored (`document_revocations` in `src/control-plane/users.ts`, and the per-document map of the memory directory), so the "nowhere to be recorded" sentence above no longer holds. Lane V-BE-029-042 ticks criteria 2 and 3 on the whole service (Evidence above; before, criterion 2 was only in `close-reasons.test.ts` without the route). Criterion 4 (restart) is ticked (lane U-BE-029-042, 2026-11-13): `services/document-service/test/control-plane/be-031-restart.pg.test.ts` runs against PostgreSQL in Podman (the test environment's `docedit-test-postgres`, one uniquely named database, dropped afterwards): a revocation written by `PgUserDirectory.revoke` refuses a token issued ten seconds earlier through a new verifier and a new directory, and a token issued in the same second is accepted. The only storage in 06 §4.1 is `tenant_users.revoked_before`, which is per user; the optional document in 05 §3.3 has nowhere to be recorded (see Open questions). Phase 2 follows 11 §5 (governance: session revocation), although the token rules of 05 §3.3 are earlier.

## Control API behaviour

### BE-032 Run every control-plane request through one pipeline

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 06 §3; 05 §6.1; 10 §3.2 · **Requirements:** R6, R10 · **Depends on:** BE-011, BE-012, BE-013, PRO-040, PRO-038

As a maintainer, I want one request pipeline for the REST resources, so that authentication, tenant context, errors and resource checks are done once and cannot be forgotten by a handler.

**Acceptance criteria**

- [x] Given any request, when it arrives, then the pipeline reads `Authorization: Bearer`, verifies it as a user token or a service credential (BE-033), sets the tenant context (BE-011), assigns a request identifier, and only then calls the handler; cookies are never read for authentication.
- [x] Given an error, when it is returned, then it is an RFC 9457 problem with a `code` from the registry and carries the request identifier.
- [x] Given a preflight from an origin in the tenant's allow-list, when it is answered, then it allows `Authorization`, `Content-Type`, `If-Match`, `Idempotency-Key`, `DEP-Actor` and `traceparent` and exposes `ETag`, `Retry-After`, `Deprecation` and `Sunset`; from any other origin it grants nothing.
- [x] Given a mutable resource, when it is updated with a missing or stale `If-Match`, then the answer is `precondition_failed`; reads return an `ETag`.
- [x] Given a list, when it is returned, then it is `{ items, nextCursor }` with an opaque cursor and a `limit` of at most 200.
- [ ] Given a resource addressed by a bare identifier (`/threads/{tid}`, `/comments/{cid}`, `/exports/{jid}`, `/imports/{jid}`, `/assets/{aid}`, `/workflow/participants/{pid}`), when it is requested, then it is resolved to its document and refused with `forbidden` unless the token covers that document.

**Evidence:** `services/document-service/src/control-plane/pipeline.ts` (one pipeline: request identifier, bearer credential, verification, route credentials from the protocol definition, tenant, origin, then the handler), `http.ts` (If-Match, signed cursors, limits, CORS headers), `problems.ts` (RFC 9457 with the registry's code and status, D61, D71). `services/document-service/test/control-plane/routes.documents.test.ts`: no token or a cookie is `unauthenticated`; problems carry `code` and `requestId` equal to `DEP-Request-Id`; preflights grant the six headers to an allowed origin and nothing to another; a missing If-Match is 428 and a stale one 412 with `precondition_failed`; lists are `{ items, nextCursor }` with opaque cursors and limits of 1 to 200; every problem code seen is in the registry.

**Notes:** The conventions are PRO's contract; resource-specific checks are in the stories that own the resources. Whether a hidden resource should answer `not_found` instead of `forbidden` to avoid revealing existence is not stated. SEC-016 attacks the last criterion. Packet A2 (2026-11-06): criterion 6 stays open: `/exports/{jid}` is resolved to its document and refused with `forbidden` unless the token covers it, and to anyone but its requester (SR-C4; D69); the other bare-identifier routes are not built. A hidden resource answers `forbidden` (D69). Statuses, the request header and list limits are decisions D61, D71 and D72. Lane U-BE-029-042 (2026-11-13): `services/document-service/test/control-plane/be-032-bare-identifiers.test.ts` (memory and PostgreSQL, both passing, 6 tests) shows that `/exports/{jid}` (GET, DELETE) and `/assets/{aid}/complete` refuse a token that does not cover the document, and an export to another user of the same document, with `forbidden`. Criterion 6 stays unticked: `/threads/{tid}`, `/comments/{cid}`, `/imports/{jid}` and `/workflow/participants/{pid}` are in the protocol definition (`packages/protocol/src/definition/resources.ts`) but no handler is registered for them, so the server answers `not_found` ("this server does not offer the route") and never resolves them to a document. Their handlers belong to the stories that own those resources (FRW, SYN, EXP); the bare-identifier check must be added with each of them. Lane w5 (2026-11-15): nothing new could be ticked. Since that round the thread and comment routes were built (`src/control-plane/thread-routes.ts`): `/threads/{tid}` and `/comments/{cid}` are resolved to their document, but a user token that does not cover it gets `not_found`, not `forbidden` (ADR 0312, proposed; `test/control-plane/pro-059-threads.test.ts`, "A token for another document does not learn that a thread exists here"). That contradicts this criterion's `forbidden` and D69 (ADR 0036), and is the open question of the first sentence of these Notes; which code a hidden resource answers is the owner's to settle, so the handlers were not changed. `/imports/{jid}` is in the protocol definition with no handler (imports are not offered, D62), and `/workflow/participants/{pid}` is not in `packages/protocol/src/definition/resources.ts` at all; both wait for the stories that own them. The criterion can be ticked when the owner has chosen one code for threads and comments and the last two routes exist. Lane w5 (2026-11-17): still blocked, nothing new ticked. `/imports/{jid}` now has a handler (`src/control-plane/imports.ts`, EXP-098): it resolves the job to its document and refuses a token that does not cover it. `/workflow/participants/{pid}` is only defined relative to a document (`/documents/{id}/workflow/participants/{pid}/{action}`, `packages/protocol/src/definition/frw.ts`), so it has no bare-identifier form to check unless the protocol adds one. `docs/owner-decisions-2026-11-15.md` does not list which code a hidden thread or comment answers (`forbidden` per D69 or `not_found` per ADR 0312), so that remains the owner's to settle.

### BE-033 Authenticate host backends and mint tokens

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Integrating developer |

**Spec:** 05 §3.1, §3.2; 13 §11.3; 07 §12 · **Requirements:** R6, R10 · **Depends on:** BE-012, BE-032, BE-013

As an integrating developer, I want to call the control plane with a service credential and to have the service mint user tokens for me, so that my backend can create documents and the conformance kit can run.

**Acceptance criteria**

- [x] Given an API key or a JWT with the type header `dep-svc+jwt` signed with a key registered for service credentials, when it is presented, then the caller is authenticated as a service of that tenant.
- [x] Given a user token is presented as a service credential, including one with a claim that says it is a service, when the call is made, then it is refused.
- [x] Given a service credential of tenant A, when it names a resource of tenant B, then it is refused.
- [x] Given a user token, when it calls a service-only route (`POST /tokens`, `POST` or `GET /documents`, `PUT` content, `POST /sessions/revoke`, fork, `/webhooks`, `/audit`, `/search`, import), then the answer is `forbidden`.
- [x] Given `POST /tokens` with a service credential and a body naming `sub`, optional `name`, `grp`, `docs` roles (at most 20 documents), `wfp`, `amr`, `auth_time`, `access_since` and `restrict`, when it is processed, then it returns a token that expires at most 15 minutes after issue and verifies against the keys published at `jwks_uri`.
- [x] Given a service call with `DEP-Actor`, when it changes a document, then history attributes the change to that user's surrogate; given no `DEP-Actor`, the change is attributed to `system`.
- [x] Given a user token carries `DEP-Actor`, when the call is processed, then the header is ignored.

**Evidence:** `services/document-service/src/control-plane/tokens.ts` (API keys, `dep-svc+jwt`, minting, D60), `pipeline.ts` (DEP-Actor). `services/document-service/test/control-plane/routes.documents.test.ts`: an API key and a service JWT authenticate; a user token, even one with a claim saying it is a service, is `forbidden` on every service-only route of criterion 4; a credential of tenant A finds nothing of tenant B; `POST /tokens` returns a token of at most 15 minutes that verifies with the key published at `jwks_uri`; `DEP-Actor` makes the surrogate the creator, none makes `system`. `services/document-service/test/control-plane/routes.content.test.ts` (PostgreSQL): grant history attributes a change to the DEP-Actor's surrogate, to the user's surrogate when a user token carries DEP-Actor, and to `system` without one.

**Notes:** Token claims are PRO's; this is the reference service's minting and credential handling. A conforming server must offer `POST /tokens` (05 §3.1). Phase 1a: the reference host skeleton does token minting (11 §3).

### BE-034 Make creating requests idempotent

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Integrating developer |

**Spec:** 06 §4.1 (`idempotency_keys`); 05 §6.1; 10 §3.2 · **Requirements:** R6, R10 · **Depends on:** BE-032

As an integrating developer, I want a retried create request to return the first result, so that a network failure never creates a document or a job twice.

**Acceptance criteria**

- [x] Given a `POST` that creates something and carries an `Idempotency-Key`, when it is sent twice with the same body, then the second returns the stored response and creates nothing.
- [x] Given the same key with a different body, when it is sent, then the answer is `idempotency_mismatch`.
- [x] Given a key is scoped to tenant, caller, route and body hash, when another caller or another route uses the same key, then it is an independent key and the first caller's response is never returned.
- [x] Given two requests with the same key arrive at the same moment, when both are processed, then only one creates the resource.
- [x] Given 24 hours have passed, when the key is used again, then it is treated as new, and the scheduler removes expired keys (BE-052).

**Evidence:** `services/document-service/src/control-plane/idempotency.ts` (scopes, fingerprint, the pending claim and the replay); `services/document-service/test/control-plane/idempotency.test.ts`, on the in-memory store: a retry with the same key and body gets the first response with `DEP-Idempotent-Replayed` and one document is listed (criterion 1); the same key with another body is `idempotency_mismatch` (criterion 2); another tenant, another caller on the same export route and another route are independent (criterion 3); three identical requests at once create one document (criterion 4); after the retention time the key is new, and `purge` deletes the expired record (criterion 5). The retention default is 24 hours (`pipeline.ts`, `DAY_MS`); the registered task `idempotency.purge` (`src/server.ts`) calls the same `purge`.

**Notes:** Packet C (2026-11-13): the PostgreSQL variant of `idempotency.test.ts` (the production store, with the unique key and row-level security) was skipped because no database was running. Lane U-BE-029-042 (2026-11-13) ran `idempotency.test.ts` with PostgreSQL in Podman (`docedit-test-postgres`): the postgres variant passes next to the memory one, so criteria 1 to 5 are also shown on the production store. Criterion 5's purge is run directly, not through the scheduler's timer; the scheduler's own tests are in `src/control-plane/scheduler.test.ts`. Phase inferred: the control API of 1b creates documents, exports and assets that need retry safety.

### BE-035 Create, read, update and delete documents

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | L | must | Integrating developer |

**Spec:** 05 §6.2 (`/documents`); 06 §4.1 (`documents`); 07 §12 · **Requirements:** R6, R15 · **Depends on:** BE-009, BE-033, BE-017

As an integrating developer, I want to create, find, update and delete documents from my backend, so that my catalogue can manage them while the editor never lists them.

**Acceptance criteria**

- [x] Given a service credential, when `POST /documents` is called with optional CDM content, optional template, optional `externalId` and `properties`, then a document is created with `head_seq` 0 or the seq of its initial content, a new incarnation, `history_visibility` `editors`, and `cdm_version` and `requires` set.
- [x] Given a second document with the same `externalId` in the tenant, when it is created, then the request is refused and no second document exists.
- [x] Given a service credential, when `GET /documents` is called with `externalId`, `limit` and a cursor, then it returns only the tenant's documents, filtered, at most 200 per page.
- [x] Given `PATCH /documents/{id}` with `If-Match`, when it changes `properties`, the classification label or `state` (`active`, `locked`, `archived`), then the change is stored, the room is informed, a `state` change is recorded as a control commit, and the webhook `dep.document.state_changed` is raised.
- [x] Given a document is `locked` or `archived`, when a commit arrives, then it is rejected with `read_only` SYN-001, SYN-006.
- [x] Given `DELETE /documents/{id}` by a service credential or a caller with `manage`, when it is processed, then `deleted_at` is set, channels are closed, the document disappears from lists, and its data stays until the retention policy purges it HIS-029, HIS-030.
- [x] Given a user token without `view`, when it calls `GET /documents/{id}`, then the answer is `forbidden`.

**Evidence:** `services/document-service/src/control-plane/handlers.ts` (documents), `src/storage/document-store.ts` and `memory.ts` (`list`, `update`, `remove`, the metadata revision of migration 0005, the unique `externalId`). `services/document-service/test/control-plane/routes.documents.test.ts`, in memory and PostgreSQL: creation with content, `externalId` and properties at head 0 with a new incarnation, `editors` history visibility, CDM version and `requires`, content at seq 0 as a checkpoint (D67); a duplicate `externalId` is `conflict`; lists by `externalId` in pages; PATCH under If-Match stores properties, label and state, raises the grants revision for a state, tells the room and raises `dep.document.state_changed`; DELETE by `manage` or a service credential sets `deletedAt`, hides the document and keeps its data; a token that does not cover the document is `forbidden`. `services/document-service/test/server/server.test.ts` with the real data plane: a lock reaches the channel as a control commit and `perm.changed`, a commit is then `read_only`, and a delete closes the channel.

**Notes:** The code for a duplicate `externalId` is not in the registry of 05 §5.8, and how initial content enters the log (for example a snapshot commit at seq 1) is not stated (see Open questions). `PATCH` authorisation is not in the matrix of 07 §12; the criteria assume the service credential or `manage`. Creating from a template is FRW's; from an import, EXP's. Packet A2 (2026-11-06): a duplicate `externalId` is `conflict` (D62); the content a document is created with is the content at seq 0, stored as the checkpoint at 0 (D67); PATCH needs `manage` or a service credential (D65). Webhooks are raised to the event sink; delivering them is PRO-072. `template` and `import` are refused with `validation_failed` until FRW and EXP define them.

### BE-036 Read content without opening a room

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | L | must | Author |

**Spec:** 06 §3 (first bullet); 05 §6.2 (`/content`), §5.2; 08 §3; 04 §12 · **Requirements:** R7, R9 · **Depends on:** BE-009, BE-001

As an author, I want a document to load without waiting for its room, and as a developer I want any past state to be readable at an exact `seq`, so that joining, history and export do not depend on a live process.

**Acceptance criteria**

- [x] Given a document with no open room, when `GET /documents/{id}/content` is called, then the answer comes from PostgreSQL and object storage and contains `seq`, `incarnation`, `cdm`, `requires` and `doc`, and no room is opened.
- [x] Given the head in PostgreSQL, when content is read at the head, then it includes every acknowledged commit, because a commit is visible only after it is stored; the nearest checkpoint may be served and the channel's catch-up covers the tail.
- [x] Given `?seq=N`, when it is read, then the answer is the document at exactly N, rebuilt in a worker thread from the nearest checkpoint at or before N plus at most 2,000 commits, and the rebuilt version is cached.
- [ ] Given a pinned read, when it is repeated for the same incarnation and `seq`, then the bytes are identical, the `ETag` combines incarnation and `seq`, and the cache headers allow shared caching as immutable.
- [x] Given a `seq` below the caller's visibility gate, when it is requested, then it is refused PRM-041, PRM-042, and a cached copy is never served to a caller without the check.
- [x] Given a log was given a new incarnation (BE-078), when the same `seq` is read, then the `ETag` differs.
- [x] Given a caller without `view`, when content is requested, then the answer is `forbidden`.

**Evidence:** `services/document-service/src/control-plane/content.ts` (checkpoint plus stored commits, replayed in a worker; caches by incarnation, seq, view token and grants revision). `services/document-service/test/control-plane/routes.content.test.ts`, in memory and PostgreSQL: content at the head carries `seq`, `incarnation`, `cdm`, `requires`, `doc` and `view` from storage with no room, and includes every stored commit; a new incarnation changes the ETag of the same seq (PostgreSQL); a token without the document is `forbidden`.

**Evidence (lane BE-027-039, round 3):** criterion 3: `services/document-service/src/control-plane/be-036-rebuild.test.ts`, "replays only the commits after the nearest checkpoint at or before the seq, and matches a full replay" and "keeps the rebuilt version, so a second read of the same seq replays nothing": with a checkpoint at 2 and four commits, seq 4 replays two commits and seq 3 replays one, the result equals a replay from 0, and a repeated seq replays nothing. The 2,000-commit figure is the default checkpoint cadence (`everyCommits` 2000 in `src/data-plane/settings.ts`; `src/data-plane/checkpoint-policy.test.ts`); no 2,000-commit replay was run. Criterion 5: `services/document-service/src/control-plane/be-036-pinned-gate.test.ts`, "refuses a viewer below the gate even when the owner has put that seq in the cache": the owner's pinned read fills the pinned cache (BE-075), a viewer below the gate gets `forbidden` with no hit on the copy, and the viewer reads the head.

**Notes:** Versions and restore (08 §4, §8) belong to HIS; this story owns the read path. Round 3 (lane BE-027-039, 2026-11-13): criteria 3 and 5 are ticked as above. Criterion 4 stays open: the bytes and the ETag are checked (`routes.content.test.ts`, "reads content at the head and at a pinned seq, byte for byte"), but the cache header is `private`, as D70 decides, not shared; the spec's "shared caching" is the owner's call, not decided here. A `seq` above the head: the code is not stated. Cross-check: reads pinned to a sequence number pass the history-visibility gate from phase 1b (PRM-041) and on every surface from phase 2 (PRM-042). Packet A2 (2026-11-06): criteria 3, 4 and 5 stay open. 3: rebuilt content is cached and replayed in a worker, but until BE-020 writes checkpoints a read replays every commit since 0, so the bound of 2,000 commits does not hold. 4: pinned reads are `Cache-Control: private` and immutable, not shared, following review SR-C4 and ADR 0019 (D70); whether documents without hidden scopes may be cached at shared edges is for the owner. 5: the gate of PRM-041 is the identity in phase 1a. A seq above the head is `not_found`. Lane w5 (2026-11-15): nothing new could be ticked. Criterion 4 is the only one open, and two of its three parts hold and are tested (identical bytes; an `ETag` of incarnation and `seq`). The third, shared caching, is against D70 (ADR 0036, following review SR-C4 and ADR 0019): a pinned read is `Cache-Control: private, immutable`, because the body depends on the reader's visibility class and a shared cache would serve it without the check of criterion 5. The owner either accepts D70, and the criterion's wording changes to private caching, or allows shared caching for documents with no hidden scope; no code was changed. Lane w5 (2026-11-17): blocked, nothing new ticked. `docs/owner-decisions-2026-11-15.md` does not list this question, and the code still answers `private` (pinned field-value reads follow the same rule, `field-routes.ts`). The criterion waits for the owner's word on D70.
### BE-037 Replace a document's content as a snapshot

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | should | Integrating developer |

**Spec:** 05 §6.2 (`PUT /content`); 04 §3.2, §10 · **Requirements:** R6 · **Depends on:** BE-036, BE-039, CDM-013

As an integrating developer, I want to replace a document's content from my backend, so that I can load content produced elsewhere.

**Acceptance criteria**

- [x] Given a service credential and valid CDM content, when `PUT /documents/{id}/content` is called, then a snapshot commit with origin `import` is stored through the outbox (BE-039), and connected clients receive `sync.reset` and reload.
- [x] Given content that fails the invariants of the CDM, when it is submitted, then nothing is stored and the answer is `validation_failed`.
- [x] Given content larger than the canonical limit of 16 MiB, when it is submitted, then the answer is `too_large`.
- [x] Given an approved region would change, or a workflow is active, when the request is applied, then it is refused (`workflow_active` for the latter) and no commit is stored PRM-046, PRM-047.
- [ ] Given the same `Idempotency-Key` is sent twice, when both are processed, then only one snapshot commit exists.

**Evidence:** `services/document-service/src/control-plane/content-replace.test.ts` (memory and PostgreSQL; the PostgreSQL run skips without a database). Criterion 2: a duplicate paragraph identifier gets `validation_failed` (400) and the stand-in data plane stores nothing; the valid content is then stored (204). Criterion 3: a raw body above 16 MiB gets `too_large`; this tests the request body limit of the content routes (`maxContentBodyBytes`, which is the canonical limit), not the canonical-form size check of `readDocument`, which no body can reach while the raw form is at least as large. Criterion 4: an approved region changed by the replacement gets `conflict` and the unchanged content is stored; a replacement while `workflowActive` is set gets `workflow_active`. The stand-in data plane records what it is given. The credential, If-Match and content checks are in `test/control-plane/routes.content.test.ts` (BE-037, not re-run here). Criterion 1 (lane BE-027-039, round 2): `services/document-service/src/data-plane/be-037-replace-outbox.test.ts`, "writes an import snapshot to the outbox, delivers it, and sends sync.reset to each open channel": the replacement is a snapshot row with reason `import` written to the outbox, settled done with the seq it answered, the log holds that snapshot, and both open channels get `sync.reset` with that seq and reason `import` (`snapshot-reset.test.ts` covers the reset itself).

**Evidence (lane w5, 2026-11-17, criterion 5 not ticked):** `services/document-service/test/server/be-037-w5-put-twice.test.ts` (the whole service in one process, memory storage, passes): the same `PUT /content` with the same `If-Match` sent twice answers 204 and then 412 `precondition_failed`, and the log holds one snapshot commit at seq 1. `PUT /content` now hands the data plane the ETag it matched, from which the commit identifier is derived (`test/control-plane/be-037-w5-put-head.test.ts`, `test/data-plane/be-039-w5-replace-commit-id.test.ts`).

**Notes:** Lane w5 (2026-11-17): criterion 5 stays unticked. It names `Idempotency-Key`, which the route does not read, and whether it should is Q9 of ADR 0104, still open (not in the owner's decisions of 2026-11-15 or 2026-11-17). The default of Q9 is taken and recorded as proposed in `docs/adr/0381-w5-BE-037-put-content-idempotency-key.md`, with the second option. What the criterion is for already holds without the header (see Evidence): a repeated request cannot store a second commit. Phase inferred: 11 §4 lists content among the 1b control API resources. Packet C (2026-11-13): criteria 2 to 4 ticked as above. Criterion 1 ticked (lane BE-027-039, round 2) on the real data plane with `MemoryOutbox`; the PostgreSQL outbox (`pg/outbox.ts`) is not run here. Criterion 5 is not ticked: `packages/protocol` does not set `idempotencyKey` on `replaceContent` (the route's operation definition has no flag), so the control plane does not read `Idempotency-Key` on this route. Whether this route should accept it is for the protocol owner (ADR 0104, Q9).

### BE-038 Page the commit log for catch-up

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Author |

**Spec:** 05 §6.2 (`/commits`), §5.2; 06 §3, §4.1; 07 §8 · **Requirements:** R7 · **Depends on:** BE-009, BE-036, PRM-041

As an author whose browser was away for a long time, I want to read the missing commits in pages, so that I catch up without a reload when the gap is large.

**Acceptance criteria**

- [x] Given `GET /documents/{id}/commits?after=N&limit=M`, when it is called, then it returns commits in ascending `seq` starting after N, and pages by cursor, with `limit` at most 200.
- [x] Given commits below the caller's visibility gate, when a page would include them, then they are not returned PRM-041, PRM-042.
- [ ] Given some payloads have moved to cold segments (HIS-029), when a page spans them, then the page is complete and in order.
- [x] Given a gap beyond the catch-up limits (default 5,000 commits or 5 MiB), when a client asks, then the answer remains correct page by page and the channel's own answer remains `reload`.

**Evidence:** `services/document-service/src/data-plane/read-commits-gap.test.ts` (lane BE-027-039), "still answers reload for the same gap when the host serves the commits resource, and the pages hold the whole gap" and "reloads a resume beyond the limit when the host does not serve the commits resource": with `catchUpCommits` set to 3, a resume five commits behind is `reload` (with and without the commits resource), a resume three behind streams, and six commits are read in pages of two as `[2,3]`, `[4,5]`, `[6]`. Criterion 4 is ticked on this limit, not the default 5,000 commits or 5 MiB. `services/document-service/test/control-plane/routes.commits.test.ts` (the route's own storage path, memory storage; the harness's stub data plane offers no `readCommits`, so `readCommits` in `services/document-service/src/data-plane/room-host.ts` is not run): "pages the log after `after` in ascending seq with a cursor, showing authors by sub (BE-038 criterion 1)" (criterion 1: pages of 2 by cursor, `limit` 201 refused); "refuses `after` below the history gate and returns nothing below it (PRM-041 criterion 3; HIS-024)" (a viewer's page below the gate is a 403 with no `seq` in the body; this is the control plane's gate, not the data plane's). The PostgreSQL variant of both was skipped in this run (no PostgreSQL running). `services/document-service/src/data-plane/read-commits.test.ts` runs the real `DataPlane.readCommits` (`room-host.ts`) over memory stores, each case both while the room holds the document (the room's gate) and from storage alone (a second data plane, no room: `gateOf`): "pages ascending after `after` by cursor, with limit at most 200, in the room and from storage" (criterion 1: pages of 2 by cursor, `limit` 0, 201 and 1.5 refused, `after` above the head `not_found`); "ends a page before a snapshot commit and refuses a page that would start with one"; "under `editors`, refuses a viewer any page below the head and names no seq" and "under `since_access`, returns only commits after the access time and refuses `after` below it" (criterion 2: a viewer's `after` below the gate is `forbidden` with no digit in the refusal, the page at the gate is empty, and with access from seq 2 only seqs 3 and 4 are returned). A run with the gate check removed fails both criterion 2 tests.

**Notes:** Phase inferred: resume with incarnation and paged catch-up are 1b (11 §4). Criterion 2 was unticked in review (2026-11-13) because no test ran `DataPlane.readCommits`, the path users take; it is ticked again (fixer, round 3) on `read-commits.test.ts`, which runs that method's gate, `limit` check, paging and snapshot cut in the room and from storage. Criterion 3 is not ticked: no cold segment store (HIS-029) exists in the data plane. Criterion 4 (lane BE-027-039): ticked on `read-commits-gap.test.ts`, which sets `catchUpCommits` to 3 instead of 5,000; the default value and the 5 MiB byte limit are not exercised. Discrepancy for the owner, not decided here: ADR 0034 §3 says the room answers `page` when the host serves the commits resource, but the gateway (`packages/authority/src/projection/gateway.ts`, `ch.opened`) turns every `page` into `reload`, so the channel answers `reload` in the data plane. The criterion as written follows the code; the ADR and the code disagree. Lane w5, 2026-11-17: no criterion newly ticked (blocked). Criterion 3 needs the cold segment store (HIS-029), which the data plane does not have; nothing was built to stand in for it.
### BE-039 Deliver server-authored operations through an outbox

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Author |

**Spec:** 06 §3 (second bullet), §4.1 (`outbox`); 04 §10; review SRV-1 · **Requirements:** R3, R4, R13 · **Depends on:** BE-024, BE-023, SYN-001, SYN-006

As an author, I want a restore, import or prefill to be applied exactly once or not at all, even if a process crashes between the control plane and the room, so that my document never gets a change twice or loses one.

**Acceptance criteria**

- [x] Given an operation that must change a document, when it is requested, then it is written to `outbox` with a deterministic commit identifier, in the same transaction as the control-plane state it relies on.
- [x] Given the owning room (or a transient authority, BE-023) receives the item, when it applies it, then it is applied as a server-authored commit with its reserved origin, and the preconditions the control plane relied on are re-checked.
- [x] Given an item is delivered twice, when both deliveries are applied, then the unique commit identifier means one commit exists.
- [x] Given the process crashes after the outbox row is written and before delivery, when the service restarts, then the pending item is delivered; none is lost.
- [x] Given a precondition no longer holds, when the room re-checks it, then no commit is stored, the item is marked failed with the rejection, and the requester can read the outcome.
- [x] Given an operation that would change an approved region, when it is applied, then it is refused PRM-046, PRM-047.

**Evidence:** `services/document-service/src/data-plane/outbox.test.ts`, "delivers an item whose node crashed after claiming it, once the lease has run out, and not before": node A claims the item and stops without settling it; node B, a new delivery over the same store, finds it locked at 500 ms, and at 1,001 ms (after the 1,000 ms lease) delivers it once, and it settles as done with its `seq`. The same file checks that the outbox hands a restore to the room as an author commit with origin, actor and preconditions (criterion 2 in part), and that a room that cannot take the item now leaves it pending and delivers it on the next attempt.
Lane BE-027-039, round 2: `services/document-service/src/data-plane/be-039-outbox-room.test.ts` drives `OutboxDelivery` into the real `RoomHost.apply` over the in-memory stores. "applies a server-authored commit with its reserved origin and the preconditions re-checked" (criterion 2): an item with `head` 0 settles done at seq 1, and the log holds one commit with the item's identifier. "stores one commit when the same item is delivered twice" (criterion 3): a second enqueue of the same identifier is the same item, and a redelivery and a direct apply, both with a `head` 0 precondition that the stored commit itself moved, return the stored seq with one commit in the log. "settles a redelivered snapshot that carries a head precondition as done at its stored seq" (criteria 3 and 4): an import snapshot is redelivered after it was stored, through a room loaded from the snapshot's own checkpoint, and settles done at seq 1 with one commit in the log. Round 2 fix: `packages/authority/test/be-039.dedup-before-preconditions.test.ts` checks in the room that step 2 comes before the preconditions for step and snapshot commits, stored or waiting, that a new commit with a stale precondition is still refused with `conflict`, and that a room started after the commit answers from the stored commit the host found in the log (`Room.rememberStored`). "stores no commit when a precondition no longer holds" (criterion 5): `head` 5 against a head of 0 settles failed with `conflict` and action `drop`, the log stays empty, and `outcome()` reads the failure back.

**Evidence (lane BE-027-039, round 3):** criterion 6: `services/document-service/src/data-plane/be-039-approved-outbox.test.ts`, "refuses an outbox item that would change an approved region and stores nothing, then applies it once the region leaves approved": with TERMS_ID approved (the room's own grant change), an outbox item that edits it settles failed with `permission_denied` and action `drop`, the log stays empty, and the same kind of item is applied with seq 1 once the region is `in_review`. The refusal is the room's edit check (the approval removes `edit` in the region for every actor; 07 §11).

**Evidence (lane w5, 2026-11-17, criterion 1):** Same transaction: `OutboxWriter` (`src/storage/types.ts`) writes outbox items and audit events as one unit; `PgOutboxWriter` (`src/data-plane/pg/outbox.ts`) does it in one transaction under the tenant with `insertAuditEvent` and `insertOutboxItem`, and `enqueueRepair` (`src/data-plane/repair.ts`) takes it as `writer`. `services/document-service/test/data-plane/be-039-outbox-unit.pg.test.ts` (PostgreSQL 17 from `infra/test-env.ps1`, 5 of 5 pass on 2026-11-17): item and event are stored together; an event refused by the tenant row policy leaves no item; an item refused by the `kind` check leaves no audit event; the same document and commit identifier is one item; a repair through the writer stores one item and its `repair.enqueued` event, the same request gives the same identifier and another head another one; and in memory (`MemoryOutboxWriter`) an audit store that refuses the event leaves the outbox empty. Deterministic identifier: `replaceContent` now derives it from the request (`requestId`, else the head the caller authorised the change against plus the content hash), and `PUT /content` passes the ETag it matched and a restore passes its head (`src/control-plane/handlers.ts`, `restore-route.ts`); `test/data-plane/be-039-w5-replace-commit-id.test.ts` (2 of 2) shows the same replacement of the same head is one item, one commit and one seq, and another head, actor or content is another identifier; `test/control-plane/be-037-w5-put-head.test.ts` shows the PUT handing the data plane the ETag. The prefill (`field-routes.ts`) and the import job already derived theirs (ADR 0377, SYN-030).

**Notes:** Round 4 (lane w5, 2026-11-17): criterion 1 is ticked on the Evidence above. What it covers: of the operations that change a document, the repair is the one that writes control-plane state beside its outbox item (the audit event), and that pair is now one transaction. The prefill, `PUT /content` and the import write no other state before their item, so their single-row write is the whole unit. A restore records the `pre-restore` and `restore` versions and its audit event in separate writes around the outbox item, in a different order from the item (they name the seq it will get); a crash between them can leave a `pre-restore` version without a restore, and that is not made atomic here. The restore and `PUT /content` identifiers are derived from the head; a caller with neither a request identifier nor a head still gets a random one. Old note on criterion 1 follows. Earlier round 3 (lane BE-027-039, 2026-11-13): criterion 6 is ticked as above. Criterion 1 stayed open: the outbox row written in the same transaction as the control-plane state is the control plane's, and no test shows that transaction; the PostgreSQL outbox was not run here. How the deterministic identifier is derived (for example from the idempotency key plus the operation) is not stated (see Open questions). Lane V-BE-029-042 (2026-11-13), not changed: the one control-plane enqueue (`field-routes.ts`, prefill) takes `commitId: uuid7(d.now())`, a time-based identifier, so a retried prefill would not carry the same identifier; and that route writes no control-plane state in the same transaction as the outbox row (it reads the head and grants, and writes none). Both are needed for criterion 1 and are left open for the owner's decision on derivation. Criterion 1 (the outbox row in the same transaction as the control-plane state) is the control plane's and is not tested here. Criterion 6 is the room's (PRM-046, PRM-047); round 3 tests it (see Evidence). Round 2 fix (2026-11-13): the room now re-checks the preconditions after its step 2 deduplication, in both `author` (inside `process`) and `snapshot` (room.ts), so a redelivered item that is already stored is acknowledged at its seq whatever its preconditions. A room holds only the commits after its checkpoint, and a snapshot is always its own checkpoint, so `RoomHost.apply` also looks the identifier up in the log first (`LogStore.byId`, optional; `PgLogStore` uses the `(doc_id, commit_id)` key, `MemoryStore` a scan) and hands a stored commit to the room (`Room.rememberStored`), as 04 §5 step 2 says ("then in the log"). This costs one indexed read per server-authored operation; it was not measured. The PostgreSQL `byId` was type-checked but not run (no database here). The earlier caveat (criterion 3 for items without preconditions only) no longer applies. Criterion 2 was ticked on the real room; the room's re-check is the `head` check in that test, and the `revision` and `documentState` checks are not separately exercised.

## Object storage and cold segments

> BE-040 (Move old commit payloads to cold segments) was merged into HIS-029 during the cross-check of 2026-11-06.

### BE-041 Separate and encrypt each tenant's objects

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | should | Tenant administrator |

**Spec:** 06 §4.2, §12; 10 §3.7 · **Requirements:** R10 · **Depends on:** BE-003, BE-002

As a tenant administrator, I want my files encrypted with my own key under my own prefix, so that another tenant's key or bug cannot expose them.

**Acceptance criteria**

- [ ] Given a tenant, when any of its objects is written, then it is encrypted with that tenant's key obtained through `KeyService`, and not with a shared key.
- [ ] Given a tenant, when any of its objects is written, then it is encrypted with that tenant's key obtained through `KeyService`, and not with a shared key.
- [x] Given tenant A's key is disabled in the key service, when tenant B reads its objects, then B is unaffected and A's objects are unreadable.
- [ ] Given the buckets in hosted mode, when their configuration is inspected, then versioning is on and objects replicate to a second location.
- [ ] Given a database recovery and an object store that disagree, when the recovery procedure of BE-078 runs, then it reconciles from the log, which is the source of truth.

**Evidence (lane V-BE-029-042, criterion 2):** `services/document-service/test/objects/be-041-s3-sealed.test.ts` ("criterion 2: disabling tenant A's key makes A's objects unreadable on S3 and leaves tenant B unaffected"), run with `pnpm vitest run` against the Versity S3 Gateway of the test environment (`docedit-test-s3`, Podman, bucket `docedit-test`, random tenants whose objects are deleted afterwards). A's sealed object stays in the bucket and its read is `KeyDisabledError`; B's object reads its plaintext; a new write under A's key sends nothing. Adapter level (`EncryptedObjectStore` over `S3ObjectStore`), not through the running service.

**Notes:** Optional per-document keys and tenant-owned sealing keys are the decision SEC-062. Phase 2 inferred; hosted mode is not yet decided (11 §10, decision 8). Packet storage (2026-11-13, ADR 0105, proposed): `EncryptedObjectStore` (`services/document-service/src/objects/encrypted-store.ts`, tests in `src/objects/encrypted-store.test.ts`) seals each object under the tenant's `KeyService` key. The adapter meets the part of criteria 1 and 2 that it can show alone: a disabled key refuses writes and makes that tenant's reads fail while another tenant still reads. All four criteria stay open: the service composition that writes objects is outside the storage packet, so no request through the running service has been tested, and criteria 3 and 4 concern hosted buckets and the recovery procedure. Lane V-BE-029-042: criterion 2 is ticked on the S3 store (Evidence above). Criterion 1 stays open: `EncryptedObjectStore` is not used by `server.ts` or any other service code, so the running service writes plain objects; wiring it needs a root-level composition change in the server, and no per-request run through the service has been done. Criterion 3 needs the hosted bucket configuration, which is undecided (decision 8), so it is for the owner and the operations team. Criterion 4 needs BE-078 (database recovery), which is not built. Lane w5 (2026-11-18), applying the owner's table of 2026-11-15 and 2026-11-17: decision 28 (hosted and self-hosted from the start) settles that the hosted-mode criterion 3 applies, but it does not supply a bucket configuration. The repository has no deployment definition for buckets (no chart, Terraform or provider template; `infra/` holds the Podman test environment and the webhook egress policy), so versioning and replication cannot be inspected, and a local S3 gateway does not stand for a hosted bucket: criterion 3 stays open until a hosted deployment definition exists (BE-093 and BE-095 name the chart). Criterion 1 (and its duplicate line above, which repeats it; criterion 2 of the story's first writing is the disabled-key one, ticked) stays open for two reasons that are not mine to settle. First, ADR 0105 open question 3 (every tenant from the first release, or only tenants that opt in under SEC-062) is not in the owner's tables. Second, three kinds of object are read by someone other than the service: quarantine objects are written in plain text by the client through a pre-signed URL, assets are served by the asset origin (`services/asset-worker`, which reads the bucket itself and holds no keys, ADR 0013), and export files are downloaded through signed URLs. A tenant seal over all of them would hand those readers sealed bytes. Sealing `docs/` and `final/` only would meet less than "any of its objects", so no wiring was added; the choice is the owner's: either the asset origin and the export download go through the service (or a key-service unwrap), or the criterion is narrowed to the objects only the service reads. Criterion 4 stays open with BE-078, whose criteria 1 and 2 wait on cold segments (HIS-029); the checkpoint half of the reconciliation exists.

## Assets and fonts

### BE-042 Upload an image into quarantine

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 06 §4.4, §4.1 (`assets`); 05 §6.2 (`/assets`); 07 §12; 10 §3.5 · **Requirements:** R1, R10 · **Depends on:** BE-003, BE-032, BE-049

As an author, I want to add an image to my document, so that it is stored safely before anyone can see it.

**Acceptance criteria**

- [x] Given a caller with `edit`, `suggest` or `fill` somewhere in the document, when `POST /documents/{id}/assets` is called with `filename`, `mime` and `size`, then an asset row in state `quarantined` is created with `created_by` and the document, and the answer holds the asset identifier and a pre-signed upload into `tenants/{tenant}/quarantine/{asset}` bound to the declared size.
- [x] Given a caller with only `view` or `comment`, when the call is made, then the answer is `forbidden`.
- [x] Given an upload larger than the declared size, when it is sent to the pre-signed address, then the object store rejects it.
- [x] Given the declared size is above the maximum allowed, when the call is made, then the answer is `too_large`.
- [x] Given the client declares a hash, when the asset is created, then it is ignored: `sha256` stays empty until the asset worker computes it.
- [x] Given `POST /assets/{aid}/complete`, when it is called by a caller who may upload, then an asset-worker job is queued (BE-043) and the asset stays unusable until `asset.ready`.

**Evidence:** services/document-service/test/control-plane/be-042-043-assets.test.ts ('answers forbidden to a viewer and too_large above the maximum', 'records the uploader and document, and ignores a client-declared hash'); test/control-plane/routes.assets.test.ts (memory run: 403 for a viewer, 413 `too_large`). Criteria 2, 4 and 5 are ticked on these.

**Evidence:** services/document-service/test/control-plane/be-042-complete-queues.test.ts ('queues one asset-worker job on completion and keeps the asset unusable until it is ready', memory run, no worker): criterion 6 (the job has the kind `asset` and the payload `{ asset, mime, size }`, the row is `processing`, the uploader's resolve gives no URL, and a second completion queues no second job).

**Evidence:** services/asset-worker/test/s3.test.ts ('accepts exactly the declared size and refuses more, less, or an unsized stream', against the Versity S3 Gateway of the test environment); src/s3.ts (presignUpload signs content-length) and src/upload.ts (presignQuarantineUpload).

**Evidence (lane U-BE-029-042, 2026-11-13):** services/document-service/test/control-plane/be-042-s3-quarantine.test.ts ('answers a pre-signed quarantine PUT bound to the declared size, and the bytes land at the key'; 'refuses a body whose length differs from the declared size'), run against the Versity S3 Gateway of the test environment (`docedit-test-s3`, Podman) through the harness's `config.s3`. The row fields are in be-042-043-assets.test.ts (memory run).

**Notes:** The maximum size is not given in the spec (see Open questions). Images are never embedded as data (10 §3.1). Worker side built on 2026-11-06 (packet S, services/asset-worker): `checkDeclaredUpload` gives the `too_large` answer and the accepted types, `presignQuarantineUpload` the size-bound upload of criterion 3; the maximum sizes are settings proposed in ADR 0043 (20 MiB for images, 4 MiB for SVG, 64 MiB for Word files). Criteria 1, 2 and 4 to 6 are the control plane's route, row, capability check and job (PRO-061) and stay open until it calls these functions; the job payload the worker reads (`{ asset, mime, size }`) has no place for a hash, and the worker computes `sha256` itself (BE-043). Lane BE-040-052 (2026-11-13): criteria 2, 4 and 5 ticked. Criterion 1 is ticked (lane U-BE-029-042, 2026-11-13): the key and the signed size are checked through the route on S3, see Evidence. Criterion 6 ticked in round 3 (2026-11-13; `be-042-complete-queues.test.ts`, memory run with no worker). Criterion 1 is ticked (lane U-BE-029-042, 2026-11-13): the key and the signed size are checked through the route on S3, see Evidence. The S3 settings (`config.s3`) make the route use `presignQuarantineUpload` and the object store an S3 client (`server.ts`); lane U-BE-029-042 runs that path on the S3 gateway.

### BE-043 Validate, re-encode and store assets in a sandboxed worker

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Maintainer |

**Spec:** 06 §1, §4.4; 10 §3.5; 09 §2 · **Requirements:** R10 · **Depends on:** BE-042, BE-049

As a maintainer, I want the asset worker to inspect and re-encode every upload in a sandbox and to alone write the final object, so that a hostile file cannot overwrite or claim anything.

**Acceptance criteria**

- [x] Given a completed upload, when the worker runs, then it runs in a sandbox with no network and no credentials other than a write-only location for this job.
- [x] Given the declared type differs from the detected type, when the worker checks, then the asset becomes `failed`, `asset.failed` is raised and the quarantined object is deleted.
- [x] Given a valid image, when the worker finishes, then it has decoded and re-encoded it, computed the SHA-256 itself, written `tenants/{tenant}/assets/{sha256}`, set `state` to `ready` with `sha256`, `bytes` and `object_key`, and raised `asset.ready`.
- [x] Given an image above the pixel limit or an archive above the limits on entries, sizes and ratios, when the worker checks, then the asset becomes `failed` before the content is expanded in memory.
- [x] Given an SVG upload, when it is processed, then a PDF rendition is stored for the typesetter, and the SVG is never served for inline rendering.
- [x] Given the worker crashes or exceeds its time or memory limit on a hostile file, when the job is reaped, then the job fails, the sandbox is discarded, and other jobs are unaffected.
- [x] Given the same bytes are uploaded by two tenants, when both are processed, then each tenant has its own object under its own prefix.

**Evidence:** services/document-service/test/control-plane/be-042-043-assets.test.ts ('removes the quarantined object when the declared type differs from the content'): criterion 2 on the control plane, with the failed row, the `asset.failed` notice and the quarantined object removed.

**Evidence:** services/document-service/test/control-plane/be-043-reencode.test.ts ('re-encodes a valid image, hashes the bytes it stores, and marks the row ready with their facts'): criterion 3 on the control plane (memory run): the stored object under `objectKey` has the row's `bytes` and `sha256`, is a PNG, and has lost the textual chunk the upload carried.

**Evidence:** services/asset-worker (ADR 0043). Criterion 1: test/sandbox.podman.test.ts probes in the real image (uid 10001, no capabilities, no new privileges, seccomp filtering, only lo, no DNS, no route to the store or the database, nothing writable, no credentials, the Node.js permission model), src/sandbox-podman.ts, Containerfile. Criterion 4: test/content.test.ts (pixel bombs fail before allocation, decompression and archive bombs before expansion) and the bombs of test/sandbox.podman.test.ts. Criterion 5: test/content.test.ts ('writes a sanitised SVG and a PDF rendition from the drawing alone'), test/worker.test.ts ('stores renditions for the typesetter'), test/origin.test.ts and test/origin-isolation.test.ts (SVG served only as an attachment under a sandboxing policy). Criterion 6: test/sandbox.podman.test.ts ('a hostile decoder under the same limits': hang, memory, crash, flood and a forged reply fail the job, no container is left, a concurrent job succeeds) and test/worker.test.ts ('a compromised or failing sandbox'). Criterion 7: test/worker.test.ts and test/s3.test.ts ('two tenants').

**Evidence:** Lane V-BE-043-056 (2026-11-13, round 3), criteria 1, 2, 3, 4 and 6 run in the real Podman image on this machine (`services/asset-worker/test/sandbox.podman.test.ts`, `pnpm exec vitest run`, machine route with cgroupfs, the image `localhost/docedit-asset-worker:dev`): 11 of 12 tests pass, the probes, the re-encode, the bombs and the hostile decoder included. The one skipped test is the 1 GiB JPEG run, which is opt-in (`DOCEDIT_ASSET_HEAVY_TESTS=1`). The hostile decoder block failed once, on the flood (`FLOD`): the run went past the 10 s wall limit before the supervisor saw the output overflow, so it was reported as a time limit; `src/sandbox-podman.ts` now reads an output overflow first (see the Notes).

**Notes:** The pixel, entry, size, ratio and time limits are not given in the spec (see Open questions). SEC-037, SEC-038 and SEC-040 attack this worker. Font files uploaded by tenants (BE-048) pass through the same sandbox. Built on 2026-11-06 in services/asset-worker; formats, decoders, the SVG subset, the limits (settings, with a measurement) and the serving rules are proposed in ADR 0043. Criteria 2 and 3 are met on the worker's side and tested (test/worker.test.ts, test/s3.test.ts, test/sandbox.podman.test.ts): the worker reports the outcome with every field of the row through `AssetOutcomes` and deletes the upload; they stay open until the control plane registers the `asset` job handler, writes the row and raises `asset.ready` and `asset.failed` (PRO-061 criterion 3). The sandbox holds no credential at all: the supervisor reads the upload and writes the final objects, and the sandbox returns its outputs on standard output. Each output is stored as its own content-addressed object; the `renditions` the worker reports (a PNG of a GIF's first frame, a PDF of an SVG) need a column or table in the control plane (EXP-014). Lane BE-040-052 (2026-11-13): criterion 2 ticked on the control plane. Round 3 (2026-11-13): criterion 3 ticked on the control plane (`be-043-reencode.test.ts`, memory run; the PostgreSQL run is not made here). The worker's own check of its output stays in `test/content.test.ts`. Lane V-BE-043-056 (2026-11-13, round 3): criterion 3 is also run on PostgreSQL: `services/document-service/test/control-plane/be-043-reencode-postgres.test.ts`, both storages, PostgreSQL 16 in the Podman test environment, `pnpm exec vitest run` in services/document-service: 2 of 2 tests pass (the memory and the `postgres` block, neither skipped). Two product changes in this round, both in `services/asset-worker/src/sandbox-podman.ts`: a run that went past its output limit is reported as `output_limit`, not as the time limit (the flood case of the hostile decoder); and the `podman info` and `podman image exists` readiness probes wait up to 180 s, because on the loaded shared machine `podman info` took 42 s and the 30 s limit made the probe report Podman as unavailable, which skipped every sandbox test.

### BE-044 Attach assets to documents and restrict references

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Owner |

**Spec:** 06 §4.4, §4.1 (`doc_assets`); 10 §3.5; 03 §8 (I4) · **Requirements:** R10 · **Depends on:** BE-043, BE-024, CDM-013

As an owner, I want a document to reference only assets that were uploaded for it, so that nobody can read another document's image by guessing its identifier.

**Acceptance criteria**

- [x] Given an asset uploaded for document D by the submitting user, when a commit referencing it is stored, then a `doc_assets` row with the commit's `seq` as `first_seq` is written in the persist transaction (BE-024).
- [x] Given a commit references an asset that the submitter did not upload for this document and that is not already attached, when it is checked, then it is rejected with `invalid_op`.
- [x] Given an asset of another tenant, when a commit references it, then it is rejected, because assets are scoped to a tenant.
- [x] Given an asset attached to document D1 only, when a caller with `view` on D2 asks to resolve it, then it is not returned.
- [x] Given an attachment row, when the asset is later removed from the current content, then the row stays so earlier versions still render.

**Evidence:** services/document-service/test/control-plane/routes.assets.test.ts ('resolves ready, attached assets the caller can see to short-lived URLs of the separate origin', memory run; the last step: an asset attached to another document is not returned to the owner of a second document). Criterion 4 is ticked on this route result; the attachment is still the caller's projection of the content at the head, not a `doc_assets` row (see Notes).

**Evidence (lane w5, 2026-11-17, criteria 1, 2, 3 and 5):** The room is given an `attachedAssets` set (`src/data-plane/room-host.ts`), so the model's invariant I4 refuses a commit that references an asset outside it with `invalid_op`. The set is the document's `doc_assets` rows and what its content already names, plus, for one submitter, the ready assets that user uploaded for this document (`RegistryAssetAttachments` in `src/data-plane/asset-attachments.ts`, which asks the asset registry, scoped to the tenant). The first commit that references an asset attaches it: the host passes `AppendOptions.attachments` and `PgLogStore.append` inserts the `doc_assets` rows with the commit's `seq` as `first_seq` in the same transaction (`src/storage/log-store.ts`; `MemoryStore` does the same). `src/server.ts` composes it when the service has an asset registry. `services/document-service/test/data-plane/be-044-asset-attachments.test.ts` (memory stores, real data plane and WebSocket clients, 9 of 9 pass on 2026-11-17): a figure of the submitter's own upload is stored and attaches at seq 1 (criterion 1); another user's upload, an asset of another document and an asset that does not exist are each refused `invalid_op` and nothing is attached (criterion 2); an asset of the same name in another tenant is refused (criterion 3); another editor may reference an attached asset, and when both figures are removed the row stays at `first_seq` 1 (criterion 5); the attached set is read from the store when the room opens again; a write that fails after its inserts attaches nothing and the retried commit attaches at its seq; a snapshot (import or restore) attaches the assets uploaded for the document and refuses others. `test/data-plane/be-044-doc-assets.pg.test.ts` (PostgreSQL 17, `infra/test-env.ps1`, 3 of 3 pass): the `doc_assets` row is read back with `first_seq` 1; a second figure does not move it; removing both figures keeps it (criteria 1 and 5); a write failed after its inserts leaves no row and the retry writes it; another tenant's asset and another user's upload are refused and no row is written (criteria 2 and 3).

**Notes:** Lane w5 (2026-11-17): criteria 1, 2, 3 and 5 are ticked on the Evidence above. Limits, none decided by the owner: (1) an asset the submitter uploaded stays known to the room from the lookup on, so another editor of the same document could reference it before the first commit that does so is stored; across documents and tenants it is never possible. (2) A document whose content already names assets before this check keeps them (the room starts with what the content names); those are attached by the first commit that references them again and has a registry row, not by the check at open. (3) A snapshot commit takes any upload for the document, not only the actor's, because the control plane authorised it with a service credential or `manage`; its refusal is `validation_failed`, as for any snapshot (the room's code for content that fails its invariants). (4) The check is off in a composition without an asset registry (the data plane's tests). (5) The room asks the registry only when a commit names an identifier it does not know; while that lookup waits, later commits of the room wait behind it, so their order is kept. Earlier notes: Invariant I4 itself is CDM's and SYN's; this story provides the attachment data and the persist-time write. Round 3 (2026-11-13, lane BE-040-052): criterion 4 ticked on the resolve route. Criteria 1, 2, 3 and 5 stayed open then: the `doc_assets` table exists since migration 0064 (lane U-BE-043-056, round 4; `test/postgres/be-046-orphan-assets.pg.test.ts` writes its rows directly), but the persist transaction of BE-024 does not check or write attachments, so the `first_seq` row, the `invalid_op` refusal of an unattached or foreign asset, and the kept row after removal are not built. Read access before the first attachment is not stated; the resolve route currently gives it to the uploader only (proposed in [ADR 0242](../adr/0242-lane-BE-040-052.md)). Second review (2026-11-06, SPK-027): SR-C4, under ADR 0019 read access must follow the scopes that reference an asset, not only the attachment; SR-C1 and SR-C2, the original Word file, the source map and preserved fragments (ADR 0017) are server-only, and fragments are written only by the import worker, never uploaded ([review](../review/2026-11-06-second-review.md)).

### BE-045 Serve assets by short-lived signed URL from a separate origin

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Viewer |

**Spec:** 05 §6.2 (`/assets/resolve`); 06 §4.4; 10 §3.5, §3.7 · **Requirements:** R10 · **Depends on:** BE-044

As a viewer, I want images in a document to load, so that I see the document as it was written, without the page being able to attack me through an image.

**Acceptance criteria**

- [ ] Given a caller with `view`, when `POST /documents/{id}/assets/resolve` lists asset identifiers used by the document, then each attached asset returns a signed URL scoped to that one object, and an identifier not attached to the document is not resolved.
- [x] Given a signed URL, when its lifetime has passed, then the request is refused; the lifetime is short and configured.
- [x] Given a signed URL, when its path or key is altered, then the signature check fails.
- [x] Given an asset is served, when the response is inspected, then it comes from an origin separate from the application's, with a fixed content type for its kind and `X-Content-Type-Options: nosniff`.
- [x] Given assets are immutable and content-addressed, when they are served, then the cache headers allow long caching.

**Evidence:** `services/document-service/test/control-plane/routes.assets.test.ts` ('resolves ready, attached assets the caller can see to short-lived URLs of the separate origin', memory run; criterion 1 and PRO-062): a viewer gets only the attached asset (a pending upload, a ready upload no content references, and an asset in a region it cannot see get no URL), and the URL is served from the separate origin. The uploader also gets its own ready, unreferenced upload (see Notes).

**Evidence:** services/asset-worker/src/signing.ts and src/origin.ts; test/origin.test.ts ('signed URLs', 'the asset origin'), test/s3.test.ts ('the asset origin over the store'), test/origin-isolation.test.ts (a separate origin in Chromium).

**Evidence:** Lane V-BE-043-056 (2026-11-13, round 3), criterion 1 on PostgreSQL: `services/document-service/test/control-plane/routes.assets.test.ts`, the `assets (postgres)` block, run against PostgreSQL 16 in the Podman test environment (`pnpm exec vitest run` in services/document-service): 4 of 4 tests of that block pass, not skipped, including the resolve test ("resolves ready, attached assets the caller can see to short-lived URLs of the separate origin"). Criterion 4 re-run in this round: `services/asset-worker/test/origin-isolation.test.ts` in Chromium (Playwright, `pnpm exec vitest run` in services/asset-worker): 4 of 4 tests pass, the embed and no-script checks and the storage isolation included. Firefox and WebKit were not run for it.

**Notes:** The lifetime is not given in the spec. SEC-046 attacks the URLs. The asset origin and its signed URLs are built in services/asset-worker (2026-11-06; ADR 0043): 300 s by default, rounded to a 60 s window for caching, at most an hour accepted, keys with identifiers for rotation. Criterion 1 is the control plane's resolve route (PRO-062) and stays open until it calls `signAssetUrl` after its permission check. Lane BE-040-052 (2026-11-13): criterion 1 ticked on the route test (memory run; the PostgreSQL run skips without a database). Fixer round 1 (2026-11-13): `doc_assets` (BE-044) is not built, so "attached" currently means "referenced in the caller's projection of the content at the head". The route also resolves the uploader's own ready upload for this document when no content references it yet, so the editor can show an image before its commit (PRO-096). That is not in row 7 of 07 §12 and the owner has not decided it; it is proposed in [ADR 0242](../adr/0242-lane-BE-040-052.md). Audit (2026-11-13): criterion 1 unticked, because the route resolves the uploader's own ready but unreferenced upload (`mine` in `resolveAssets`, and `loose` in the last steps of the route test), which contradicts "an identifier not attached to the document is not resolved" and 05 §6.2 ("identifiers used by the document"); it holds again when the owner decides that exception or the route drops it. Lane w5 (2026-11-17): criterion 1 stays unticked for that reason, which is unchanged. The route now also leaves out an asset that was uploaded for another document unless a `doc_assets` row attaches it here (`d.logs.attachedAssets`, with BE-044), so a document whose content names a guessable identifier of another document's asset no longer gets a URL for it. Test: `services/document-service/test/control-plane/routes.assets.test.ts` 'resolves an asset only for a document it is attached to, even when the content of another document names it' (memory and PostgreSQL, 10 of 10 tests of the file pass on 2026-11-17). What remains for criterion 1 is the uploader's own ready, unreferenced upload (`mine`), which the owner has not decided; with it dropped the criterion holds. Not decided here.

### BE-046 Delete assets that no document references

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | S | could | Operator |

**Spec:** 06 §4.4, §1 (scheduler) · **Requirements:** R10 · **Depends on:** BE-044, BE-052

As an operator, I want unreferenced assets and abandoned uploads removed after a retention period, so that storage does not fill with orphans.

**Acceptance criteria**

- [x] Given an asset with no `doc_assets` row for longer than the retention period, when the scheduled job runs, then its object and row are deleted.
- [x] Given an asset attached to any document, including only in an earlier version, when the job runs, then it is kept.
- [x] Given a quarantined upload never completed within the retention period, when the job runs, then the object and row are removed.
- [x] Given a document under legal hold HIS-029, HIS-030, when the job runs, then its assets are kept.

**Evidence:** services/document-service/test/postgres/be-046-abandoned-uploads.pg.test.ts (lane U-BE-043-056; PostgreSQL in the test environment and the S3-compatible store, both in Podman; 4 tests pass): criterion 3 through `sweepAbandonedUploads` and through the scheduler's handler (BE-052), the object and the row removed, an upload inside its window or taken by a worker kept, a tenant on hold skipped. Code: services/document-service/src/control-plane/asset-sweep.ts; the state guard of `remove` in src/control-plane/assets.ts (both registries).

**Evidence:** Lane U-BE-043-056 (2026-11-13), criterion 1: `services/document-service/test/postgres/be-046-orphan-assets.pg.test.ts`, run against PostgreSQL 16 (migration 0064 `doc_assets`, row-level security on) and the S3-compatible store, both in Podman, `pnpm exec vitest run` in services/document-service: 6 of 6 tests pass. An unattached ready asset past `orphanRetentionMs` loses its row and its object; an attached asset, an asset inside the period, an object another asset still names, another tenant's asset and a sweep with no retention set are all kept. Code: `src/control-plane/asset-sweep.ts` (`sweepOrphanAssets`), `PgAssetRegistry.orphanedReady` and `removeOrphan` in `src/control-plane/assets.ts`, `migrations/0064_doc_assets.sql`.

**Evidence:** Lane U-BE-043-056 (2026-11-13, round 5), criterion 4: `services/document-service/test/postgres/be-046-legal-hold.pg.test.ts`, run against PostgreSQL 16 (the `document_holds` table through `PgHoldStore`) and the S3-compatible store, both in Podman, `pnpm exec vitest run` in services/document-service: 4 of 4 tests pass. An orphan ready asset and an expired upload of a held document are kept with their objects; the same of a free document are removed; a hold of another tenant keeps nothing. Code: `HoldService.heldDocuments` in `src/control-plane/holds.ts`, the `heldDocuments` option of `src/control-plane/asset-sweep.ts`, and its wiring in `src/server.ts` (`assets.abandoned-uploads`).

**Evidence:** Lane U-BE-043-056 (2026-11-13, round 9), criterion 2: `services/document-service/test/postgres/be-046-earlier-version.pg.test.ts`, run against PostgreSQL 16 (migration 0064, row-level security on) and the S3-compatible store, both in Podman, `pnpm exec vitest run` in services/document-service (with `be-046-orphan-assets.pg.test.ts`): 8 of 8 tests pass, none skipped. An asset whose only `doc_assets` row starts at an earlier sequence (`first_seq` 2, and a second document at 7) is kept with its row and its object after the sweep past the retention period. The row is written by the test, as the BE-044 persist path will write it; the sweep reads rows, not content.

**Notes:** The retention period is not given in the spec (see Open questions). Lane U-BE-043-056 (2026-11-13), round 9: criterion 2 is ticked on the sweep's keep rule, with the attachment row written by the test; the production write of earlier-version rows is BE-044 criterion 1, still open. Lane U-BE-043-056 (2026-11-13), round 5: criterion 4 is ticked (see the Evidence above). A held upload stays in its batch, so more held uploads than the batch of 500 delay the other rows of that tenant until the hold is released or the batch is raised; there is no release today, so this is a known limit to revisit with HIS-031. Lane U-BE-043-056 (2026-11-13), round 4: criterion 1 is ticked on the sweep with an explicit `orphanRetentionMs`. The composition (`src/server.ts`) does not set it, so the deployed task does not yet remove orphans: until BE-044 writes `doc_assets` rows from the persist path, every referenced asset looks unattached and removing them would break documents. The owner's period is open (proposed in [ADR 0335](../adr/0335-lane-U-BE-043-056.md)). Criterion 2 stays open: the test attaches the current version only; earlier versions need the BE-044 persist write. Migration 0064 (`doc_assets`) is new; the table is empty in production until BE-044. Lane U-BE-043-056 (2026-11-13): criterion 3 is ticked with the upload window the row carries (`upload_expires_at`) as the retention period; the owner has not decided the period, so this is the proposed default in [ADR 0335](../adr/0335-lane-U-BE-043-056.md). Criterion 1 is ticked on the table of migration 0064 (round 4, see the Evidence above). Criterion 2 stays open for the same reason as before (earlier versions need the BE-044 persist write). Criterion 4 was open before round 5 (no document hold check existed); the tenant-level `onHold` hook of the scheduler is separate and is tested with a stub and with the real task. Reviewer (2026-11-13): `src/server.ts` already registers `assets.quarantine.purge`, an inline copy of the same loop (`expiredUploads`, delete the object, `remove`); the test runs `asset-sweep.ts`, which the composition does not use. The shared registry methods are what the test proves against PostgreSQL and S3, so criterion 3 stays ticked; replace the inline task with `abandonedUploadsTask` so that one copy exists and the tested one is the deployed one. Fix (U3 group 2, round 3): `src/server.ts` now registers `abandonedUploadsTask({ assets, objects, batch: 500 })` in place of the inline loop, so the deployed task is the tested one; the batch of 500 is the inline task's. The scheduled task is now named `assets.abandoned-uploads`; a queued job of the old name `assets.quarantine.purge` is not run by this release.

### BE-047 Serve the font manifest

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Author |

**Spec:** 05 §6.2 (`/fonts`); 02 §6; 09 §5 · **Requirements:** R1, R5 · **Depends on:** BE-003, BE-032, PRO-067

As an author, I want the service to build the font manifest only from licensed files and serve them by hash, so that the editor and the typesetter use the same font files and what I see matches the PDF.

**Acceptance criteria**

- [x] Given the default set, when it is built, then a font enters the manifest only if its licence permits bundling and server use, and the licence is recorded in the manifest.
- [x] Given a font file, when it is published, then its URL is addressed by its SHA-256 hash and its content is checked against that hash first.
- [x] Given the set of fonts changes, when the manifest is next read, then its `ETag` changes.

**Evidence:** `services/document-service/src/control-plane/fonts.test.ts`: a family whose licence is off the list (`FONT_LICENCES`, from `licences/policy.json`) is left out with its reason, and the manifest records each family's licence (criterion 1); a file whose content does not match its name is not published and its family is left out, each face's URL is `{base}/{sha256}.ttf`, the file is served by hash with an immutable cache header from any origin, and an unknown or non-hash name gets 404 (criterion 2); the manifest version and `fontsEtag` change when a family is added or relicensed, and stay the same when the set repeats or only the base URL changes (criterion 3). `src/control-plane/handlers.ts` sets the `GET /fonts` ETag from `fontsEtag`.

**Evidence:** Lane V-BE-043-056 (2026-11-13, round 3), criterion 3 over HTTP: `services/document-service/src/control-plane/fonts.etag.route.test.ts`, memory harness, `pnpm exec vitest run` in services/document-service: 1 of 1 test passes. `GET /v1/fonts` sends an `ETag` that matches `"f<version>"`, answers 304 to a repeat of it, and sends a new ETag (and 200 to the old one) once a family is added.

**Notes:** Packet C (2026-11-13): `fonts.test.ts` calls the loader, the file handler and `fontsEtag`; it does not call the `GET /fonts` route, so the route's header handling and its `If-None-Match` answer are not tested here. Lane V-BE-043-056 (2026-11-13): the route's header handling and `If-None-Match` are now tested in `fonts.etag.route.test.ts` (see the Evidence above). What `GET /fonts` returns (families, styles, file URLs, hashes, licences and the manifest version) is the contract of PRO-067. The font registry and aliases in the browser are FE's; the worker side is EXP's. Phase inferred: the font manifest is not placed in the roadmap; the editor and the export need it in 1b.

### BE-048 Add tenant-supplied fonts

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | could | Tenant administrator |

**Spec:** 02 §6; 09 §5; 06 §12; 11 §9 (risk 11) · **Requirements:** R5 · **Depends on:** BE-047, BE-043, UX-076

As a tenant administrator, I want to add fonts my organisation is licensed to use, so that our documents keep their typefaces.

**Acceptance criteria**

- [ ] Given a font file and a licence declaration, when the administrator adds it, then it is validated in the sandbox of BE-043 and stored under the tenant's prefix by hash.
- [ ] Given the tenant's manifest, when it is read, then it includes the added font with its licence; another tenant's manifest does not.
- [ ] Given an export job of another tenant, when it loads fonts, then the added font is not available to it.
- [ ] Given a font that fails validation, when it is added, then it is rejected and nothing is published.

**Notes:** Phase inferred: the administration API with fonts is phase 2 (13 §12). The export-side loading is EXP's. Lane V-BE-043-056 (2026-11-13, round 2): no criterion ticked. Criteria 1 and 4 need the asset sandbox to accept font files: `services/asset-worker` accepts only GIF, JPEG, PNG, SVG, PDF and DOCX (`ACCEPTED_TYPES` in `src/sandbox/types.ts`), and ADR 0043 covers no font type, so a font validator and its limits are a design decision still open. Criterion 2 needs an administration route and a manifest keyed by tenant (`src/control-plane/fonts.ts` builds one shared catalogue from `fonts.json`). Criterion 3 needs the export loader (EXP) to read the tenant manifest. Lane w5 (2026-11-18): still nothing ticked; the owner's table has one answer that shapes it, decision 62 of 2026-11-17 (EXP-048): the licence declaration carries a server-use flag that the administrator sets on upload, and a font without it is used on screen only and replaced in the PDF. So the declaration is at least `{ licence, serverUse }`, and the manifest must carry the flag for the export loader. What a build still needs, none of which exists here and none of which is the owner's table's to give: (1) a font type in the asset worker (ADR 0043 accepts GIF, JPEG, PNG, SVG and DOCX): the formats (TrueType and OpenType by 06's `fonts.json` names `ttf` and `otf`; no WOFF), the limits (bytes, tables, glyphs) and the rule on the font's own embedding flags (`OS/2` `fsType`) are a design choice for an ADR; (2) a path for an upload that belongs to a tenant and not to a document: `assets` rows and `POST /documents/{id}/assets` are bound to a document (`AssetRecord.doc`), so an administrator's font has no route and no row; (3) the administration contract of UX-076, which is not published, so the route, its authorisation (tenant administrator) and its negative tests have nothing to follow; (4) a per-tenant manifest: `GET /fonts` and `/fonts/{sha256}.{ext}` serve one shared, public, cached catalogue (`fonts.ts`, `Access-Control-Allow-Origin: *`, immutable), which a tenant's licensed font must not join, so tenant fonts need a scoped URL or a signed one. Criterion 3 is the export loader's (EXP-048), which waits on the same manifest. Nothing was built for this story in this lane because each of the four is a decision first; the status is blocked.

## Job queue, scheduler, search and indexer

### BE-049 Run background jobs from a PostgreSQL queue

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 06 §4.1 (`jobs`, notes), §6; ADR 0006 · **Requirements:** R5, R9 · **Depends on:** BE-002, BE-011

As a maintainer, I want a job queue in PostgreSQL, so that exports, asset processing, imports and deliveries run on workers without a second stateful dependency in stage 1.

**Acceptance criteria**

- [x] Given queued `jobs` rows, when workers claim them, then each claim uses `FOR UPDATE SKIP LOCKED` and sets `locked_by` and `locked_until`, and two workers never run the same job at the same time.
- [x] Given a worker dies while holding a job, when `locked_until` passes, then the job can be claimed again and `attempts` increases; after the maximum number of attempts it becomes `failed`.
- [x] Given a job has a `run_after` in the future, when workers claim, then it is not claimed before that time.
- [x] Given a job `kind`, when a worker claims it, then the registered handler for that kind runs and its outcome is stored in `state` and `result`.
- [x] Given a job row, when a worker runs it, then the tenant context of BE-011 is set from the row's `tenant_id`.
- [x] Given the PostgreSQL `Queue`, when the contract suite of BE-002 runs, then it passes.

**Evidence:** Migration `0006_jobs.sql` (`jobs`; `docedit_claim_job` with FOR UPDATE SKIP LOCKED across tenants); `services/document-service/src/control-plane/jobs/` (`queue.ts` port and memory queue, `pg.ts`, `runner.ts`). `services/document-service/test/control-plane/queue.test.ts`, one contract against memory and PostgreSQL: ten concurrent claims take six jobs once each with `locked_by` and `locked_until`; a job whose lock passed is claimed again with one more attempt and fails after the last; `run_after` holds a job back; the handler of the kind runs and its outcome is stored; each handler gets the tenant of its row.

**Evidence:** Lane U-BE-043-056 (2026-11-13): `services/document-service/test/control-plane/queue.test.ts`, the `job queue (postgres)` block, run against PostgreSQL 16 in the Podman test environment (`infra/test-env.ps1 up`), `pnpm vitest run` in services/document-service: 10 of 10 tests pass, the PostgreSQL block included (not skipped). This is the PostgreSQL run of criteria 1 to 6.

**Notes:** The state names, backoff and maximum attempts are not in the spec. The table is a stage 1 and 2 choice; a managed queue is BE-072. Phase inferred: the 1a demo produces a PDF through a job. Packet A2 (2026-11-06): the states, the lease, the attempts and the retry delay are settings recorded in ADR 0036 (proposed); the claim across tenants is a security-definer function (`docedit_claim_job`).

### BE-050 Separate previews from requested exports and cap tenants

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Author |

**Spec:** 06 §8 (export backlog), §12; 09 §9.1, §9.5 · **Requirements:** R5, R9 · **Depends on:** BE-049

As an author, I want a preview to appear promptly even while someone else runs a large export, so that a bulk export from one tenant cannot starve everyone else.

**Acceptance criteria**

- [x] Given interactive previews and user-requested exports, when they are queued, then they are claimed from separate priorities, and previews are served first.
- [x] Given a backlog of requested exports, when a preview is queued, then it starts before the backlog drains.
- [x] Given a tenant has reached its export concurrency limit, when workers claim, then that tenant's further jobs wait while other tenants' jobs run.
- [x] Given export workers are stateless, when they pull from the queue, then any worker can take any job and a job lost with its worker is retried (BE-049).
- [x] Given the queue, when metrics are scraped, then queue depth per priority is reported for autoscaling (BE-065).

**Evidence:** `services/document-service/src/control-plane/queue-metrics.test.ts` (criterion 5): a scrape of `/metrics` over HTTP, with memory storage, reads `docedit_jobs` per kind, priority and state, and the values change as jobs are queued and claimed; the scrape is refused without the metrics token.

**Evidence:** `services/document-service/src/control-plane/jobs/priority.test.ts` (in-memory queue; criteria 1 to 4): previews are claimed before the exports of a backlog, and a worker for one kind never takes the other; a preview starts while twenty exports of another tenant wait; a tenant at its limit keeps its next job queued while another tenant's job runs, and the job starts when the running one ends; `defaultLimit` applies when a tenant has no limit. Criterion 4 also rests on the lost-worker test in `services/document-service/test/control-plane/queue.test.ts` (a job whose lock passed is claimed again with one more attempt; the PostgreSQL run skips without a database) and on `priority.test.ts`. Criterion 5 (packet C, round 2): `services/document-service/src/control-plane/queue-metrics.test.ts` starts a service with a metrics credential (memory storage), enqueues two exports and a preview, and reads the `docedit_jobs` samples from `/metrics`: queued counts per kind and priority, then a claimed preview moves to `running` and its `queued` sample reads zero. The gauge is registered in `src/server.ts` from `queue.depth()`.

**Evidence:** Lane U-BE-043-056 (2026-11-13): `services/document-service/test/control-plane/be-050-priority-postgres.test.ts`, run against PostgreSQL 16 in the Podman test environment, 6 of 6 tests pass: criterion 1 (previews claimed before the exports of a backlog, and each kind claimed on its own), criterion 2 (a preview starts while twenty exports wait), criterion 3 (a tenant at its limit waits while another runs; the default limit), criterion 4 (a lost worker's job is claimed again with one more attempt), criterion 5 (`docedit_job_depth` reports queued and running per kind). The same rules as `src/control-plane/jobs/priority.test.ts`, which runs the in-memory queue only.

**Notes:** Criterion 3 is met by queueing: the job waits and is not refused, which is what EXP-007 criterion 3 says ("stay `queued`"). The choice between queueing and `quota_exceeded` for the tenant limit stays open (BE-092). The compile worker itself is EXP's. Phase inferred: interactive previews and requested exports exist from 1b. Packet C (2026-11-13, round 2): criterion 5 ticked. The gauge `docedit_jobs` is registered in `src/server.ts` (the composition root) and the test reads it from the scrape. The PostgreSQL `depth()` is not run here (no database).

### BE-051 Limit preview compiles to what someone is viewing

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | should | Operator |

**Spec:** 06 §10; 09 §9.1, §8 · **Requirements:** R5, R9 · **Depends on:** BE-050, EXP-004, EXP-005

As an operator, I want the rules that bound preview cost enforced on the server, so that preview compiles cannot run away with the compile budget.

**Acceptance criteria**

- [x] Given a preview was started for a document less than ten seconds ago, when another preview is requested, then no second compile starts and the caller receives the pending or latest result.
- [x] Given a preview request whose bundle hash and profile equal a cached result, when it is requested, then no compile runs and the cached result is returned.
- [x] Given previews and final exports, when results are cached, then they are cached separately.
- [ ] Given page-break reconciliation compiles, when a tenant has not enabled them, then they are refused; the setting is off by default.

**Evidence:** `services/document-service/src/control-plane/export-jobs.test.ts` (memory store; the PostgreSQL run skips without a database). Criterion 1: "starts no second preview compile while the window runs, and answers the same request with the pending job" (the same request returns the pending job's `id`; a different preview of the same document is `queued` and no compile starts until the ten-second window has passed; the second compile runs only after `h.advance(10_001)`), and, for a second requester, "cancels a queued preview when its viewer closes it, and holds later previews inside the window" (EXP-008 criteria 2, 4). Criterion 2: the repeat of a preview in "answers an identical request from the first result and compiles each different request" (EXP-006 criteria 1, 2; the repeat is `completed` with no compile, EXP-008 criterion 3). Criterion 3: "answers an identical request from the first result and compiles each different request" (EXP-006 criteria 1, 2: the same bundle as a preview compiles again). The request key carries `options.profile` (`exportRequestKey` in `exports.ts`).

**Evidence:** Lane U-BE-043-056 (2026-11-13, round 4), criterion 1 on PostgreSQL: `services/document-service/test/postgres/be-051-preview-window.pg.test.ts`, run against PostgreSQL 16 in the Podman test environment (`pnpm exec vitest run`, about 19 s): 1 of 1 test passes. A preview is compiled; a second requester's preview straight after is `queued`, no compile starts for it for 1.5 s, and it compiles only after the window (the job's `run_after` set from the first job's `created_at` in the database). This harness runs on the real clock and does not move it, which is why it passes where the moved-clock block of `export-jobs.test.ts` does not.

**Evidence:** Stabilisation group 4, round 1 (2026-11-13): criterion 1 in the moved-clock PostgreSQL block too. `createExport` passes `notBefore` (the latest preview's `createdAt` plus the window) and the queue sets `run_after` from it in its own clock (`jobs/queue.ts`, `jobs/pg.ts`), so no service time is compared with database time; the harness's `advance` moves the PostgreSQL jobs' times with it (`test/control-plane/support.ts`). `export-jobs.test.ts` passes in its `export jobs (postgres)` block, and `test/postgres/be-051-preview-window.pg.test.ts` still passes, against the Podman test PostgreSQL.

**Notes:** Stabiliser round 1 (control-plane, 2026-11-13): criterion 1 is unticked, because its Evidence test fails in the PostgreSQL run (clock offset of the harness and the migration `0061_fork_provenance.sql`; see EXP-008). Reopen when that run passes. Packet C (2026-11-13), round 8: criteria 1 to 3 ticked. Criterion 1 reads "the pending or latest result" as the caller's own job: the same request gets the pending job back; a different request gets a job of its own that is queued until the window ends (the default taken, recorded in docs/adr/0104-control-plane-backlog-batch.md section 8, for review). No compile starts inside the window in either case. "Only while the preview or a view that needs it is visible" is enforced by the client (FE, UX); the server enforces the ten-second and hash rules. Criterion 4 stays open: page-break reconciliation is phase 3 (EXP-057), and no request option or tenant setting for it exists in `packages/protocol` or the control plane, so there is nothing to refuse yet. PostgreSQL run (lane U-BE-043-056, 2026-11-13): `src/control-plane/export-jobs.test.ts`, its `export jobs (postgres)` block, fails two tests: EXP-008 criteria 2 and 4 (timeout) and BE-051 criterion 1 (the second compile starts inside the window). The harness moves its clock by an offset that the database clock does not share (`test/control-plane/support.ts`, `now = Date.now() + offset`), while the queue's window times (`createdAt`, `run_after`) are the database's, so the window is not measured on PostgreSQL in that test. The file is outside this lane's own files and was left alone. Criterion 1 stays ticked on the memory run; its PostgreSQL proof is now the separate file `test/postgres/be-051-preview-window.pg.test.ts` (round 4, see Evidence). The moved-clock block of `export-jobs.test.ts` is still red on PostgreSQL and is outside this lane's files. Stabilisation group 4, round 1: that block now passes (see Evidence). Phase inferred: previews exist from 1b. Lane w5, 2026-11-17: no criterion newly ticked (blocked). Criterion 4 needs page-break reconciliation (EXP-057, phase 3), which has no request option or tenant setting yet; the owner's answers of 2026-11-15 do not change that. Nothing was built to stand in for it.
### BE-052 Run scheduled maintenance jobs

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 06 §1 (scheduler) · **Requirements:** R9, R15 · **Depends on:** BE-049

As an operator, I want one place that runs retention, thinning, purge, orphan cleanup, time-stamp renewal and expiries on a schedule, so that maintenance does not depend on a person remembering it.

**Acceptance criteria**

- [x] Given a registry of scheduled job kinds, when a schedule is due, then exactly one instance runs it even with several service instances.
- [ ] Given the kinds registered by other stories, when the scheduler starts, then it runs at least: idempotency key cleanup (BE-034), audit partition creation (BE-014), orphan asset deletion (BE-046), cold segment moves (HIS-029), HIS-030, the writing of signed chain heads to write-once storage HIS-033, HIS-036, and FRW-056.
- [x] Given a run fails, when the scheduler records it, then the failure is visible in the metrics of BE-086 and the next run is not lost; the schedule survives a restart.
- [x] Given a job acts on a tenant's data, when it runs, then it sets that tenant's context and honours legal holds.

**Evidence:** `services/document-service/src/control-plane/scheduler.test.ts`, on the in-memory queue: two scheduler instances and two runners that ensure the schedule run each slot once, and the next slot runs when it is due (criterion 1); a failed run is counted as `failed` in `docedit_scheduled_runs_total` and its error is reported, the next slot stays queued, and a new instance on the same queue does not duplicate the schedule (criterion 3); for criterion 4 (not met, unticked by the reviewer 2026-11-13), the mechanism only: a task that deletes data skips a tenant that an injected `onHold` predicate reports, other tasks run for every tenant, one tenant's failure does not stop the others, and a task of the shape of `idempotency.purge` run through the scheduler on `MemoryIdempotencyStore` removes only the expired keys of the tenant it runs for and skips a held tenant until the hold is released. `src/control-plane/scheduler.ts` passes each task the tenant it runs for; the stores set that tenant's context (`inTenant`, `src/storage/db.ts`; `idempotency.ts`).

**Evidence:** Lane U-BE-043-056 (2026-11-13): `services/document-service/test/control-plane/be-052-scheduler-postgres.test.ts`, run against PostgreSQL 16 in the Podman test environment, 2 of 2 tests pass. Criterion 1: two scheduler instances and two job runners race on one database (`FOR UPDATE SKIP LOCKED` through `PgJobQueue`), and the slot runs once; the next slot is queued as a row. Criterion 3: a new instance on the same database runs the queued slot, so the schedule survives a restart (the next-slot time is moved to now by the schema owner, the database clock being the one claims use).

**Evidence (lane w5, 2026-11-17):** criterion 4: `services/document-service/test/control-plane/be-052-holds-postgres.test.ts` (PostgreSQL, row-level security on, job queue, asset registry and hold store; 3 of 3 pass): the abandoned-upload sweep runs through the scheduler's job for each listed tenant, keeps the expired upload of a document a hold covers, removes the free document's upload, never reaches a tenant that is not listed, and a hold of one tenant keeps nothing of another; with no hold source the held upload is removed (the contrast). `src/control-plane/scheduler.test.ts`, "hands a task that deletes the tenant's held documents": `deletes` tasks get `scope.held` read in that run, other tasks get none. `src/control-plane/scheduler.ts` (`heldDocuments`, `TaskScope`), wired in `src/server.ts` to the hold service; `asset-sweep.ts` uses it. Design: `docs/adr/0377-w5-BE-052-holds-in-scheduled-tasks.md` (proposed; answers Q4 of ADR 0104).

**Notes:** Lane w5 (2026-11-17): criterion 4 is ticked (document-level holds, ADR 0377, proposed); criterion 2 stays open because HIS-029, HIS-030, HIS-033, HIS-036 and FRW-056 have no scheduled task yet (`src/server.ts` registers `idempotency.purge`, the abandoned-upload sweep and, on PostgreSQL, `audit.partitions`). Reviewer (2026-11-13): criterion 4 was unticked. The scheduler has an optional `onHold` hook, tested with a stub, but `src/server.ts` passes none and no legal hold exists yet (HIS-031), so a hold placed later would not be honoured; the tenant context is set by the stores, not tested through the scheduler. Tick it when `onHold` is wired to the real hold store and a test shows a held tenant skipped. Fix pass (2026-11-13): still open; HIS-031 is phase 2 and `src/server.ts` is outside packet C. 08 §11 places a hold on a document, not a tenant, so the level at which the scheduler honours a hold is open (docs/adr/0104-control-plane-backlog-batch.md, Q4). Packet C (2026-11-13): criterion 2 stays open. `src/server.ts` registers `idempotency.purge`, `assets.quarantine.purge` and, with the PostgreSQL audit store, `audit.partitions`; the other kinds it names belong to BE-014, BE-046, HIS-029, HIS-030, HIS-033, HIS-036 and FRW-056, which are not built. Criterion 1 is run on the in-memory queue; the PostgreSQL claim (`FOR UPDATE SKIP LOCKED`) was not run here because no database was running. "Expiries" in 06 §1 is not defined: grant and lease expiries are timers in the room (07 §4), so this probably means workflow deadlines (12 §6) and key expiries (see Open questions). Phase inferred: idempotency-key expiry (BE-034) and audit partitions (BE-014) are 1b and need it; the retention, thinning and time-stamp jobs register later.

### BE-053 Decide the design of cross-document search

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 2 | M | should | Maintainer |

**Spec:** 06 §16, §1 (indexer); 13 §10; 05 §6.2 (`/search`) · **Requirements:** R15 · **Depends on:** —

As a maintainer, I want a written design for search across documents, so that the indexer and `GET /search` are built to a decision and not to a sketch, and ranking, permissions in results and cost are understood.

**Acceptance criteria**

- [x] Given the stage 1 target, when the spike ends, then a document states whether PostgreSQL full-text search is enough, compares it with a search engine on ranking, freshness and cost, and says at which size a search engine is needed and when to move.
- [x] Given the recommendation, when it is written, then it states what is indexed (text extracted after checkpoints), the query parameters and the result shape of `GET /search`.
- [x] Given a result list, when the design is written, then it says how permissions are applied to results (the route is for service credentials only, so the host's catalogue permissions apply, and a credential may name an acting user) and what a result may reveal, including for documents that user cannot view.
- [x] Given ranking, when the design is written, then it names the ranking approach and how it is tested.
- [x] Given tenant isolation, when the design is written, then every index, key and cache includes the tenant, and it says how purged documents leave the index.

**Evidence:** Lane BE-053-065 (round 2). Design in `docs/adr/0243-lane-BE-053-065.md` ("Search design", proposed): criterion 2 (what is indexed, the query parameters and the `{ doc, seq, score }` result shape); criterion 3 (service credential only, catalogue grants, acting-user class filter, what a result reveals); criterion 4 (AND over tokens, occurrence score, ties by identifier), tested by `services/document-service/src/control-plane/search-index.test.ts`; criterion 5 (tenant in every key, purge by tenant and document). Criterion 1 stayed open then: no size threshold can be stated without a measurement. Lane w5, 2026-11-18, criterion 1 ticked: `docs/adr/0386-w5-BE-053-search-design.md` (proposed) states that PostgreSQL full-text search is enough for version 1 and the stage 3 count of 1,000,000 documents, compares it with a search engine on ranking, freshness and cost (properties, not measurements: no engine was run), and gives the move as a measured rule and not a document count, because the measured cost grows with the number of documents a query matches. The measurement is `services/document-service/test/postgres/be-053-search-spike.pg.test.ts` (generated corpus, 10,000, 100,000 and 1,000,000 documents, PostgreSQL 17.11 in Podman on the WSL machine, one run; the default sizes of the test are 2,000 and 5,000 and it passes, 1 of 1, Node.js); the raw figures are in `docs/research/2026-11-18-be-053-search-spike.json`. Figures at 1,000,000 documents (p95): selective queries 4 to 18 ms; one very common word 497 ms. The built token table (BE-054) was 2 to 170 times slower at the p50 than a `tsvector` with a GIN index and took about eight times the space; the ADR proposes `tsvector`.

**Notes:** Time box: one week. 06 §16 says search "needs its own document". Phase inferred: the roadmap does not place search; 13 §10 lists listing and search under governance, which is phase 2. This story absorbed UX-083 during the cross-check. Lane w5, 2026-11-18: all five criteria are ticked. The search target (a p95 and its query mix) that would turn the proposed rule into a number is the owner's and is open; the measurement used generated text of 100 words a document, one tenant and a warm cache, so real text and concurrent searches are unmeasured (listed in the ADR). The shared test database is a 2 GiB tmpfs: a first attempt at 1,000,000 documents on it filled the disk and stopped it for some minutes; the run was repeated on a container of its own, which was removed, and the shared one was brought back with `infra/test-env.ps1 up`. Any later run of the full size needs its own database.

### BE-054 Index document text after checkpoints

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | should | Integrating developer |

**Spec:** 06 §1 (indexer); 13 §10; 05 §6.2 (`/search`) · **Requirements:** R15 · **Depends on:** BE-053, BE-020, BE-049

As an integrating developer, I want to search my tenant's documents by text, so that my catalogue can offer search without holding the content itself.

**Acceptance criteria**

- [x] Given a checkpoint is written, when the indexer job runs, then it extracts text from the checkpoint and updates the tenant's search tables, which are covered by the checks of BE-011.
- [x] Given a service credential, when `GET /search` is called, then only the tenant's results are returned; a user token receives `forbidden`.
- [x] Given a document is deleted and purged, when the purge completes, then its search entries are gone HIS-038, HIS-040.
- [x] Given hostile content, when text is extracted, then nothing in it is executed or fetched, and the indexer holds no credentials.
- [x] Given the indexer, when it runs, then it does not run on a room's event loop.

**Evidence:** Lane BE-053-065 (round 3). Criterion 4 ticked by `services/document-service/src/control-plane/search-indexer.test.ts` ("holds no credentials" block): the indexer job (`createSearchIndexHandler` in `search-indexer.ts`, kind `search-index`) takes only a checkpoint source and the index (`IndexerDeps`), and a source scan of `search-indexer.ts` and `search-index.ts` finds no import outside the package and `@docedit/model`, no `fetch(`, no `process.env` and no credential word. The job runs through the real `JobRunner` on the in-memory queue. Criterion 1's job part (the job reads the checkpoint and makes its text searchable for the job tenant) is in the same file; its PostgreSQL search tables are not built, so criterion 1 stays open. Round 2 evidence, `services/document-service/src/control-plane/search-index.test.ts`, for criterion 4 (the mechanism only): hostile markup and control characters are stored as plain text and not parsed, and a 20,000-level nested document is walked without recursion; the extraction in `search-index.ts` has no network, file or credential access. No indexer job exists and nothing but its own test imports the module, so "the indexer holds no credentials" cannot be shown yet. Reviewer finding (fixed, fixer round 2): the extraction returned one string per text node, so a word split by a mark was indexed as two tokens. `extractSearchText` now joins each run of adjacent text nodes in one block into one string; the tests "keeps a word split by a mark or a tracked insertion as one token, and finds it", "does not merge two paragraphs into one token", "ends a run at a break, a tab, an atom, a footnote and preserved text, but not at an anchor" and the property "takes one string per block ... however the block is split into text nodes" show it. Criterion 2's tenant scope and class filter are tested in the index only (`search`), and criterion 3's purge in the index only (`purgeDocument`).

**Evidence (lane w5, 2026-11-18, criteria 1, 2, 3 and 5):** migration `services/document-service/migrations/0086_be_054_search.sql` creates `search_entries` and `search_tokens` with `tenant_id`, forced row-level security and the tenant policy; `test/postgres/schema.pg.test.ts` (the catalogue check of BE-011, now listing both tables) and the tenant guard of the migrations pass. `test/postgres/be-054-wired.pg.test.ts` (3 tests, PostgreSQL 16 in Podman `docedit-test-postgres`, through the composed service with the real data plane and `searchIndex` on): a content replacement over HTTP stores a checkpoint, the data plane's `onCheckpoint` queues the `search-index` job, the runner indexes it, and `GET /v1/search` with a service credential returns that document, with `doc`, `externalId`, `seq` and `score` only (criteria 1 and 2); another tenant's credential gets `items: []`; a user token gets 403 `forbidden` (criterion 2); after `DELETE /documents/{id}` and a run of `DocumentPurge` over the purge role, no `search_entries` or `search_tokens` row remains and the search finds nothing (criterion 3). The same file shows the words were counted in the worker pool (`searchWorkers.stats.run > 0`, `inline` 0), and `src/control-plane/search-indexer.thread.test.ts` (3 tests, Node.js) shows the counting task runs in a thread other than the one that runs the job (criterion 5). `be-054-search-index.pg.test.ts` and `be-054-search-route.pg.test.ts` now run on the migrated schema as the service role (RLS applies); `be-053-search-spike.pg.test.ts` keeps its own bare tables. The whole package suite passed (450 files, 2315 tests, 27 skipped).

**Notes:** Lane BE-053-065 (round 2): `search-index.ts` holds the extraction (`extractSearchText`, which skips preserved content: `preserved_block`, `preserved_inline`, a `preserved` attribute, and a `preserved` mark) and an in-memory `SearchIndex` keyed by tenant, document and visibility class, with a sequence guard and `purgeDocument`. Not built, so criteria stay open: criterion 1 (the PostgreSQL search tables and the indexer job a checkpoint triggers; the index is in memory only); criterion 2 (no `GET /search` route, and the "user token gets `forbidden`" half is a route check; the document-level `view` grant is not applied in the index, see BE-053); criterion 3 (no purge pipeline calls `purgeDocument`, so the search entries of a real purge are not removed yet); criterion 5 (no job exists, so no run can be placed off a room's event loop). The ADR 0017 rule for preserved content and the class rule of ADR 0019 are the contracts applied here; the class names are the caller's. Word boundaries (fixer round 2, an implementation choice the spec does not settle): a run of text nodes ends at the end of its block, at `break`, `tab`, every inline atom and footnote, and at preserved text; it does not end at `anchor`, a zero-width bookmark with no text that a Word file may place inside a word. Round 3 (lane BE-053-065): `search-indexer.ts` is the indexer job, run by the existing `JobRunner` for kind `search-index` (`enqueueIndexing` queues it with the tenant on the row, `createSearchIndexHandler` reads the checkpoint through a `CheckpointSource` port and indexes it). The index is still the in-memory `SearchIndex`, so criterion 1 needs the PostgreSQL tables of BE-011, and nothing calls `enqueueIndexing` from a checkpoint write yet (the commit path is outside this lane). Criterion 5 stays open: the composition decides which process runs the runner, and nothing shows that process is off a room's event loop. Lane U-BE-043-056 (round 2): `search-index-pg.ts` (`PgSearchIndex`, `SEARCH_INDEX_DDL`) holds the PostgreSQL search tables; the indexer job now writes to either index (`IndexTarget` in `search-indexer.ts`). `test/postgres/be-054-search-index.pg.test.ts` runs the job against PostgreSQL in Podman and shows tenant scope, the sequence guard, class filtering, purge of a document's entries, preserved content left out, and the ranking matching the in-memory index. Criteria 1 and 3 stay open: the DDL is not in a migration (the main session sequences that), no call queues an indexing job after a checkpoint write, and no purge pipeline calls `purgeDocument`. A token longer than the PostgreSQL index row limit makes the insert fail and the job fail; the spec does not say what to do (proposed in [ADR 0335](../adr/0335-lane-U-BE-043-056.md)).

**Notes:** Lane U-BE-043-056 (2026-11-13, round 5): the route `GET /search` (operation `search`) is built in `src/control-plane/search-routes.ts` and tested on PostgreSQL in `test/postgres/be-054-search-route.pg.test.ts` (5 of 5 pass): the hits of the caller's tenant only, one hit per document, the class `full` only, no class or text in the reply, `validation_failed` for a missing `q` or a `limit` that is not a positive integer, and the protocol's `service` security for the operation. Criterion 2 stays open: `src/server.ts` passes no search index (`Kit.search` is absent, so the deployed route answers `not_found`), because the search tables are not in a migration (the main session sequences that); the acting-user filter and the document-level `view` check are not built (ADR 0243). Search entries hold document text, so they are in scope of SEC-045 and SEC-057. Lane U-BE-043-056 (2026-11-13, round 9), read-only check: criterion 3 has no purge pipeline to call `purgeDocument` (the control plane runs only the idempotency, asset-quarantine and evidence purges; the document purge of HIS-038 and HIS-040 is not built), and criterion 1 has no hook at the checkpoint write (`Checkpointer.save` in `src/data-plane/checkpoints.ts` is the one place a checkpoint is stored, but it takes no callback and nothing queues the indexing job). The PostgreSQL search tables are not in any migration, so the BE-011 check of `test/postgres/schema.pg.test.ts` does not see them; when they are added they need a `tenant_id` column (they now use `tenant`), forced row-level security and the tenant policy, and the table count in that check changes with them. None of this is ticked this round. Phase inferred: as BE-053. Lane w5 (2026-11-18): criteria 1, 2, 3 and 5 are ticked; the composition is `startService` with `config.searchIndex` (`DOCEDIT_SEARCH_INDEX`), proposed in ADR 0388, which also records what is left to the owner: the index is off by default, and only the class `full` is indexed (the acting-user filter of ADR 0243 is still unbuilt). Criterion 5 rests on the counting of words, the one CPU-bound step, running in a worker thread of a pool of its own (one thread, 30 s a task: proposed defaults, not measurements); the job runner itself runs in the service process and its database writes are asynchronous input and output, so this is not a separate process. While doing criterion 3 the purge was found to delete `outbox` after `doc_heads`, which it references, so a document that had an outbox row (any content replacement) could not be purged; `outbox` now goes first in `PURGE_TABLES` (HIS-039's code, a one-line change, `his-039-purge.pg.test.ts` still passes). The search tables moved from `tenant` and `doc` text columns to `tenant_id` and `doc_id` uuid columns, as BE-011 needs; `SEARCH_INDEX_DDL` is gone. Second review (2026-11-06, SPK-027), SR-M5: under ADR 0019 the index must record which visibility class each entry belongs to, so that a search made for a principal returns only what that principal can read; text inside preserved content (ADR 0017) is not indexed at all today ([review](../review/2026-11-06-second-review.md)).

## Webhook dispatcher

### BE-055 Run the webhook dispatcher

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | L | must | Integrating developer |

**Spec:** 06 §1 (webhook dispatcher); 05 §7; 10 §3.2; ADR 0013 · **Requirements:** R6, R10 · **Depends on:** BE-049, BE-056, PRO-069, PRO-070, PRO-071

As an integrating developer, I want signed events sent to my endpoint by a dispatcher that applies the delivery contract, so that my backend learns what happened without polling.

**Acceptance criteria**

- [x] Given an event matches a subscription, when it is raised, then a delivery row is created and the event is sent as a CloudEvents 1.0 structured JSON body with the headers `webhook-id`, `webhook-timestamp` and `webhook-signature` (HMAC-SHA256, Standard Webhooks).
- [x] Given `dep.document.changed`, when edits are frequent, then at most one is raised per document per 10 seconds, and its `data` includes the `seq` and the hash-chain head.
- [x] Given a slow or failing target, when other targets are due, then their deliveries are not delayed by it.
- [x] Given `dep.commit.rejected`, when many rejections occur, then it is throttled.
- [x] Given a delivery, when it is logged, then the log holds identifiers and status but not the body.

**Evidence:** Lane BE-053-065 (round 1). `services/document-service/src/control-plane/webhook-dispatcher.test.ts` (in-memory delivery store, fake transport): criterion 1 (one row per matching subscription; CloudEvents body; `webhook-id`, `webhook-timestamp` and `webhook-signature` checked by `verifyDelivery`); criterion 2 (`DocumentChangeDebounce` in front of the dispatcher: one send at once, the latest change after the window, with `seq` and `chainHead`); criterion 3 (a held target does not hold back another target); criterion 4 (`dep.commit.rejected.v1` admitted at most `max` times per window, and again after it); criterion 5 (log entries carry identifiers, event name and status, never the body or a secret). The send path is `webhook-egress.test.ts` (BE-056).

**Evidence:** Lane U-BE-043-056 (2026-11-13, round 4), criterion 1 on PostgreSQL: `services/document-service/test/postgres/be-055-dispatch.pg.test.ts`, run against PostgreSQL 16 in the Podman test environment (`pnpm exec vitest run` in services/document-service): 1 of 1 test passes. An event matching two subscriptions writes one `webhook_deliveries` row per subscription (`PgDeliveryStore`, `WEBHOOK_DELIVERIES_DDL`), each row ends `delivered` with the sent `webhook-id` and the sent body, and the request verifies with its subscription's secret; a subscription that does not list the event gets no row.

**Evidence (lane w5, 2026-11-17, criterion 2):** `DebouncedEventSink` (`services/document-service/src/control-plane/event-throttle.ts`) is the `DocumentChangeDebounce` with its own unreferenced flush timer; `startService` (`src/server.ts`) puts one in front of the event sink (the dispatcher when `config.webhooks` is set), passes it to the data plane and to the REST handlers (the kit does not debounce a second time), and raises what waits when the service stops. A room raises `dep.document.changed.v1` for each stored commit from `RoomHost` (`src/data-plane/room-host.ts`, `#raiseChanged`) with `seq` and `chainHead` read from the log's head state. Tests (Node.js, `pnpm exec vitest run --project node <file>`, this machine): `test/data-plane/be-055-w5-change-event.test.ts` (2 of 2; real room over a WebSocket client with the in-memory log: the first commit raises one event with `seq` 1 and the 64-digit head the log reports; two more commits in the window raise nothing; one millisecond short of 10 s a flush raises nothing, at 10 s it raises the last, with `seq` 3 and the new head; two documents keep their windows apart); `test/control-plane/be-055-w5-service-change.test.ts` (1 of 1; the composed service with the real data plane and webhooks: two content replacements over HTTP make one delivery with `seq` and `chainHead`, and stopping the service delivers the second). The 10-second window is the spec's figure (05 §7); the tests move a fake clock for the room test and wait for no real window. The send path is unchanged (`webhook-dispatcher.test.ts`, BE-056).

**Notes:** Lane w5 (2026-11-17): criterion 2 is ticked on the evidence above. A commit stored by a room raises the event only when the log store reports a head state (`LogStore.state`, both stores do) and a chain head; a document whose log has no chain head yet raises nothing, because the envelope refuses an event without one. The event is raised after the write returns, so a later write may already be stored when the head is read; `seq` and `chainHead` are read together, so they agree. The event names the head, not the commit, which fits "the document head the event refers to" in the schema.
The event catalogue and signature details are PRO's.
Lane BE-053-065 (round 1): `webhook-dispatcher.ts` is built and tested with `MemoryDeliveryStore`. Lane U-BE-043-056 (round 4): the PostgreSQL delivery table (`webhook-deliveries-pg.ts`) is run for criterion 1 in the evidence above; the subscriptions stay in memory in that test (their table is not this criterion). The retry schedule of PRO-071 (a failed send stays failed until replayed); the composition wiring (`src/server.ts`, `config.ts` are outside the lane), including a timer that drives `DocumentChangeDebounce.flush`. The rejection rate is the input `rejectedThrottle`, with no default, because the spec gives none. Suppressed rejections are counted in the log and not sent later. The retry schedule, the `webhook-id` rule on retries and the rule on which addresses may be reached are the contract of PRO-071; this story is the dispatcher that applies them, and BE-056 is the egress proxy. The throttle rate is not given. Phase 2 follows 12 §13 ("webhooks"); the reference host's e-mail webhooks (13 §11.2) depend on it. The document service sends no e-mail or text messages (ADR 0013); hosts act on webhooks.
Audit 2026-11-13 (BE-055 to BE-060), criterion 2 unticked: `DocumentChangeDebounce` has no caller outside its tests, and the only code that raises `dep.document.changed` (`handlers.ts`, the snapshot replace) sends `data` with `seq` and no `chainHead`, so `toCloudEvent` refuses it as `envelope_refused`; commits made in a room raise no such event at all, so in the running service no change event reaches a subscriber with the hash-chain head and none is debounced. Tick it when the commit path raises the event through the debounce with the chain head.

### BE-056 Refuse private addresses through an egress proxy

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Operator |

**Spec:** 06 §1; 05 §7; 10 §3.2 · **Requirements:** R10 · **Depends on:** BE-049, PRO-071

As an operator, I want webhooks to reach customers only through a proxy that refuses internal addresses, so that a webhook target cannot be used to attack my network.

**Acceptance criteria**

- [x] Given the proxy refuses a target, when the delivery fails, then the delivery records the reason.
- [x] Given the proxy connects to a target, when it connects, then it checks the address it is actually connecting to and not an address resolved earlier.
- [x] Given a public target that redirects to a private address, when the proxy follows the redirect, then the second request is refused.
- [x] Given the dispatcher's network policy, when it is tested, then its only route out is the proxy.

**Evidence:** Lane V-BE-043-056 (2026-11-13), criterion 4: `infra/webhook-egress-policy.ps1` runs Podman containers (`docedit-v-be-043-056-*`, the image `node:24.21.0-slim`, no published ports): the dispatcher probe (`infra/containers/webhook-egress/probe.mjs`) sits on an internal network only, and the proxy (`infra/containers/webhook-egress/proxy.mjs`, which runs the product's `EgressProxy` from `webhook-egress.ts`) is the one container on both networks. Run once: 6 of 6 checks hold (no direct connection to the outside host or to 1.1.1.1; the proxy answers; the proxy refuses a private target, the metadata address and loopback with their reasons). A negative control (the dispatcher on the outside network) was not run.

**Evidence:** Lane BE-053-065 (round 1). `services/document-service/src/control-plane/webhook-egress.test.ts` (fake resolver and connector, plus a loopback server for the Node connector): criterion 1 (a refused host returns its reason with no connection; `webhook-dispatcher.test.ts` records the reason on the delivery row); criterion 2 (the name is resolved once and the checked address is connected to; a socket that reports another address is refused as `address_changed`; one refused address refuses the host); criterion 3 (a public target that redirects to `169.254.169.254` is refused on the second request, and the connector is called once). A fast-check property covers the 10/8 and 127/8 ranges.

**Notes:** Which addresses are refused (loopback, private, link-local, the cloud metadata address) and the outcome for a name that changes its address between registration and delivery are the contract of PRO-071; this story is the proxy that enforces it. SEC-020 attacks this with the full address-encoding corpus. Phase inferred: ships with BE-055.
Lane BE-053-065 (round 1): `webhook-egress.ts` holds the policy (`refusedAddressReason`), `EgressProxy` and `nodeConnector`. Criterion 4 (lane V-BE-043-056, 2026-11-13) is ticked for the topology the repository defines in `infra/webhook-egress-policy.ps1`, tested in Podman (see Evidence). The production network of a deployment is still deployment infrastructure and must be the same topology; that is in needsFromOthers of the lane (ADR 0335-lane-V-BE-043-056). The redirect bound used by the test (3) is a test value, not a decided default. The redirect bound `maxRedirects` has no default, because the spec gives none. The policy refuses CGNAT (100.64/10) as private and NAT64-embedded IPv4 by the address it carries; the PRO-071 list is not in the repository, so the list must be checked against it.

### BE-057 Rotate secrets, send test pings and replay deliveries

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Integrating developer |

**Spec:** 05 §6.2 (`/webhooks`), §7; 10 §3.7 · **Requirements:** R6, R10 · **Depends on:** BE-055

As an integrating developer, I want to rotate a webhook secret without dropping events, to send a test event, and to replay recent deliveries, so that I can operate my receiver safely.

**Acceptance criteria**

- [x] Given a secret rotation, when a new secret is added, then two secrets are active, deliveries are signed so that a receiver holding either verifies them, and the old secret can then be retired.
- [x] Given a retired secret, when a receiver verifies with only that one, then verification fails.
- [ ] Given a test ping is requested, when it is sent, then it uses the same signing and proxy as real events and is marked as a test.
- [ ] Given a recent delivery, when a replay is requested, then it is sent again with the same `webhook-id`.
- [x] Given subscriptions can filter events, when an event does not match the filter, then no delivery is made.
- [ ] Given secrets, when they are stored and logged, then they come from the secret store and never appear in logs.

**Evidence:** Lane BE-053-065 (round 1). `services/document-service/src/control-plane/webhook-dispatcher.test.ts`: criterion 1 (during a rotation each delivery carries two `v1` signatures and a receiver holding either secret verifies it); criterion 2 (after retirement a receiver holding only the old secret fails with `bad_signature`); criterion 3 (a test ping is signed with the subscription's secret and sent through the same transport, its body marked `test: true` and its row marked `test`); criterion 4 (a replay keeps the `webhook-id` with a new timestamp, and another tenant's delivery is not found); criterion 5 (a subscription receives only the event names it lists).

**Notes:** The resource contract is PRO's; the replay window is not stated. Phase inferred: ships with BE-055.
Lane BE-053-065 (round 1): the ping's event name `dep.webhook.test.v1` is a placeholder, because the published catalogue has no test event (a gap for PRO). Replay covers every row kept, since no window is stated. Criterion 6 stays open: secrets live in the subscription store (`webhook-subscriptions.ts`), which is not a secret store, and the source of secrets is not built. The log test shows no secret reaches the log, but that alone does not meet "come from the secret store". Rows and replays are in memory; no PostgreSQL table exists.
Audit 2026-11-13 (BE-055 to BE-060), criteria 3 and 4 unticked: `WebhookDispatcher.ping` and `replay` have no caller outside `webhook-dispatcher.test.ts`, and `webhook-routes.ts` (and the `PATCH` of `webhook-subscriptions.ts`) offers no way to request a test ping or a replay, so an integrating developer cannot request either in the running service; the dispatcher methods themselves pass their tests. Tick them when a `/webhooks` operation calls them. Lane V-BE-057-070 (round 4): still blocked by the spec. `spec/dep/dep-1.gaps.json` records that the test ping and the replay have no route or body, and the generated registry lists none, so no route was added (inventing its shape is an owner or PRO decision). Proposal in `docs/adr/0336-lane-V-BE-057-070.md`.
Lane w5 (2026-11-17), nothing new ticked; criteria 3, 4 and 6 stay open. Checked this round: (a) criteria 3 and 4 still have no route to hang on. `spec/dep/dep-1.gaps.json` has no route or body for a test ping or a replay, `docs/owner-decisions-2026-11-15.md` does not settle them, and the paths proposed in ADR 0312 section 5 and ADR 0336 are still proposals; the dispatcher methods (`ping`, `replay`) work and go through the same egress rules (PRO-071, `webhook-pro-071-egress.test.ts`), so the route is the only part missing. (b) Criterion 6 needs a secret manager, which spec 10 §3.7 names ("Secrets are held in a secret manager and rotated") and no story or decision chooses; secrets stay in the subscription store (memory, or the PostgreSQL store of the service), and a port with an in-memory or environment adapter would not meet "come from the secret store". The half of the criterion that can be shown, that no secret appears in a log line, is covered by `webhook-dispatcher.test.ts` (BE-055 criterion 5) and is not ticked on its own.

## Scaling stages

### BE-058 Hold the stage 1 targets under load

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | should | Operator |

**Spec:** 06 §6; 00 §9; 06 §10 · **Requirements:** R9 · **Depends on:** BE-019, BE-024, BE-027, BE-086, FND-007, FND-009

As an operator, I want a repeatable load test of one node, so that the stage 1 numbers are measured and the target figures are replaced by evidence.

**Acceptance criteria**

- [ ] Given one node, 2,000 connections and 500 open documents (targets), when typists produce a few commits a second each, then commit acknowledgement has a median of 50 ms and a 99th percentile of 300 ms within one region (targets).
- [ ] Given documents whose CDM is under 1 MB, when rooms are opened cold during the run, then opening has a 95th percentile of 500 ms (target).
- [x] Given the run, when it ends, then no healthy client was closed with `slow_consumer`, the number of open rooms returns to zero after the clients leave, and event-loop delay stayed within the budget the harness sets.
- [x] Given the run, when the report is written, then it lists measured values beside the targets, with node size and database settings.
- [ ] Given the harness, when CI runs nightly, then a regression beyond the harness's threshold fails the gate.

**Evidence (lane w5, 2026-11-18):** The command is `services/document-service/scripts/load/be-058.ts` with the scenario and the gate in `stage1.ts`; it builds on the FND-009 harness (`lib.ts`). The service now reports the delay of its event loop, its CPU and its memory (`services/document-service/src/control-plane/process-metrics.ts`, registered in `src/server.ts`, read from `/metrics`). `services/document-service/test/load/be-058.harness.test.ts` (10 tests pass, with the FND-009 harness test) runs the scenario at a small size against the real service process, checks the metrics text, the process metrics and the gate. Criterion 3: in all four full runs (memory, and PostgreSQL twice, 2,000 connections on 500 documents) no client was closed, none with `slow_consumer` (the counter and the clients' `ch.closed` messages both read 0), the open rooms went from about 520 to 0 after the clients left, and the event loop stayed within the 300 ms budget in the gate phase. Criterion 4: the report (`docs/research/data/be-058-*.json`, written up in `docs/research/2026-11-17-be-058-stage1-load.md`) lists the measured values beside the targets, the machine, the Node.js version and heap setting, and for PostgreSQL its settings.

**Notes:** All figures are targets from 00 §9 and 06 §6. Memory per room comes from BE-084. Phase inferred: the stage 1 numbers should be measured before the first usable release.
Lane w5 (2026-11-18): criteria 3 and 4 are ticked. Criteria 1 and 2 stay unticked because the targets are not met where stage 1 runs: on PostgreSQL the acknowledgement median and 99th percentile and the cold-open 95th percentile were above their targets at the 50-typist gate phase in both runs (median 116 and 126 ms; cold open 909 and 2,134 ms), and met only at 25 typists in one of two runs. On memory storage they were met up to 100 typists (300 commits a second) in one run and missed at 150. The specification does not say how many of the 500 documents have a busy typist, so the number of typists is a setting of the run and the phases give the curve; the gate phase of 50 is a setting too. The machine was shared with other agents and its load was not recorded; runs of the same settings differ widely, so the tables are single runs. Criterion 5 stays unticked: the nightly job needs `.github/` (root configuration, not edited by this lane) and a runner whose baseline means something (the reference runner of ADR 0037 does not exist). The gate is built and checked (`--baseline`, exit code 1 on a regression beyond the tolerance); the job would run `node services/document-service/scripts/load/be-058.ts --storage postgres --baseline <report of the reference runner>`. Findings for other stories: a watcher that never sends is closed after two heartbeat intervals (05 §4; the load client now pings), PostgreSQL acknowledgement latency is high at about 140 commits a second with the service at 60% of one core (BE-024, SYN-040), and the service's memory grows by about 1.1 GiB over five phases (BE-084).

### BE-059 Decide the internal bus

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 4 | S | must | Maintainer |

**Spec:** 06 §16, §4.3, §2.1 · **Requirements:** R9 · **Depends on:** BE-002

As a maintainer, I want the stage 2 bus chosen before it is built, so that forwarding and presence are written once.

**Acceptance criteria**

- [x] Given Redis streams and NATS as the candidates, when the decision is recorded, then it compares them on ordered per-room streams, gap detection, operating cost, and footprint for a self-hosted install.
- [x] Given the decision, when it is recorded, then it states that the protocol is unaffected, as 06 §16 says.
- [ ] Given the `Bus` interface of BE-002, when the decision is taken, then the interface is checked against the choice and changed only if the choice cannot satisfy it.

**Evidence:** Lane BE-053-065 (round 2). `docs/adr/0243-lane-BE-053-065.md`, section "Internal bus" (proposed): criterion 1 (Redis streams and NATS compared on ordered per-room streams, gap detection, operating cost and footprint); criterion 2 (the protocol is unaffected).

**Notes:** Time box: three days.
Lane BE-053-065 (round 2): the recommendation (Redis or Valkey streams, for footprint, since BE-063 already needs Redis or Valkey) was proposed for the owner. Lane w5, 2026-11-18: the owner decided it on 2026-11-15 (decision 136 in docs/owner-decisions-2026-11-15.md: Valkey streams). Applied: the decision is recorded in docs/adr/0243-lane-BE-053-065.md (status, recommendation, open items) and in 06 §16 and §4.3; criteria 1 and 2 were already ticked on the written comparison and the statement that the protocol is unaffected. Nothing else could be ticked. Criterion 3 stays open (re-checked 2026-11-18 on the merged branch: still no `Bus` interface in `services/document-service/src`, `packages/authority/src`, `packages/backend-dep/src` or `services/authority-service/src`; checking an interface that is not written against the choice would be a claim without an object, and writing it is BE-002 criterion 1): no `Bus` interface is declared anywhere in `services/document-service/src`, `packages/authority/src` or `packages/backend-dep/src`, so the interface cannot be checked against the choice (BE-002 lists it, but it is not built).

### BE-060 Route each document to one owning node

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | L | must | Operator |

**Spec:** 06 §2.1, §6 · **Requirements:** R9 · **Depends on:** BE-018, BE-017, BE-059

As an operator, I want each document routed to one room host by rendezvous hashing over the live hosts, so that a document's room lives in one place and nodes can come and go.

**Acceptance criteria**

- [x] Given a set of live room hosts (those holding a valid node lease), when a document is routed, then rendezvous hashing of the document identifier over that set names the host that should try to own it.
- [x] Given a host joins or leaves, when routing is recomputed, then only the documents that hash to that host move.
- [x] Given routing names a host, when ownership is decided, then the epoch check of BE-017 still decides; routing never grants ownership.
- [x] Given a gateway that is not the named owner, when it receives a channel, then it forwards it (BE-062).

**Evidence:** Review of 2026-11-13: criteria 1 and 2 unticked, because `routeDocument` is called by nothing but its test (no route or gateway uses it; BE-061 and BE-062 are not built). Tick them when the connect route routes through it. `services/document-service/src/control-plane/room-routing.test.ts` (criteria 1 and 2; fast-check property runs): `routeDocument` names one of the hosts it is given, the same host in any order, and throws for an empty set; `liveRoomHosts` keeps the hosts the lease store reports alive; when a host joins, a document changes owner only to that host, and when a host leaves, a document changes owner only if that host owned it. The routing hash is `rendezvousScore` in `room-routing.ts`. Lane U-BE-057-070 (round 2) ticked criteria 1 and 2 on the same test; the group 3 round 2 reviewer unticked them again (2026-11-13): `routeDocument` and `liveRoomHosts` still have no caller outside their test, the lease store in the test is a stub, and the standing review condition (tick when the connect route routes through it) was overridden by a proposed ADR the owner has not confirmed. The test passes (5 tests, Node.js) and stays as the evidence for when BE-061 wires it. Lane w5 (2026-11-18), criteria 1 to 3 ticked: `services/document-service/test/data-plane/be-060-placement.test.ts` (5 tests, Node.js). `Placement` (`room-routing.ts`) takes its live hosts from `NodeLeaseStore.live()` (new; in memory and in PostgreSQL), so routing runs over lease rows judged by the store's clock: it names the rendezvous winner over the live nodes only, and a node whose lease runs out is no longer named (criterion 1); over 300 documents a join moves documents only to the joining node and a leave moves only the leaving node's documents (criterion 2). Criterion 3: two data planes over one set of stores; routing names node-a for a document that node-b owns, node-a's `ch.open` is refused `unavailable`, and owner and epoch are unchanged; after node-b's lease ends node-a wins the epoch claim (epoch + 1). Owner decision 136 (docs/owner-decisions-2026-11-15.md) fixes the bus as Valkey streams, which BE-062 uses. Lane w5 (2026-11-18), criterion 4 ticked with BE-062: `services/document-service/test/data-plane/be-062-forwarding.test.ts` ('works as if it had landed on the owner'): a channel opened on node-b for a document owned by node-a is forwarded to node-a (`Forwarder.route`, `data-plane/forwarding.ts`, called by `Session.#openChannel`); the room exists on node-a only. The same flow ran over Valkey streams in `be-062-forwarding.valkey.test.ts`.

**Notes:** Lane control-plane-3 (round 1): `room-routing.ts` routes by rendezvous hashing of the document identifier alone (as the story names it), over hosts that `NodeLeaseStore.alive` reports. Criterion 3 stays open: the epoch check of BE-017 is in the data plane and is not invoked by this module, so nothing here can be shown to leave ownership to the epoch. Criterion 4 stays open: forwarding is BE-062, not built. No route calls `routeDocument` yet (BE-061 is not built). Lane U-BE-057-070 (round 2): criteria 1 and 2 are about the routing function and its inputs, which the property test covers, so they are ticked; the earlier condition "when the connect route routes through it" concerns wiring in BE-061 and is not in the criteria text. Proposed in `docs/adr/0336-lane-U-BE-057-070.md` for the owner to confirm. Criteria 3 and 4 stay open. Lane w5 (2026-11-18): criteria 1 to 3 are met by `Placement` and the test above; the earlier condition that the connect route call it is wired in BE-061 (`GET /documents/{id}/connect`). Criterion 4 stays open until BE-062 forwards a channel in the gateway. Lane w5 (2026-11-18): all four criteria are ticked. Routing is used by the connect route (BE-061) and by the gateway (`Forwarder.route`).

### BE-061 Tell clients which node owns their document

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 4 | M | should | Operator |

**Spec:** 06 §2.1, §8 · **Requirements:** R9 · **Depends on:** BE-060

As an operator, I want a client to be told the WebSocket address of its document's owner, so that in the normal case a channel lands where its room lives and nothing is forwarded.

**Acceptance criteria**

- [x] Given a caller with `view`, when `GET /documents/{id}/connect` is called, then it returns the WebSocket URL of the owning node, or of the node routing would choose if the document has no owner.
- [x] Given a client follows the hint, when it opens its channel, then in a normal run the share of channels that need forwarding is near zero.
- [x] Given a stale hint, when the channel lands on another node, then it is forwarded and still works.
- [x] Given a caller without `view`, when the route is called, then the answer is `forbidden`.

**Evidence:** Lane w5 (2026-11-18), criteria 1 and 4 ticked: `services/document-service/src/control-plane/be-061-connect.route.test.ts` (7 tests, Node.js, over HTTP with in-memory storage). `GET /documents/{id}/connect` (`connect-route.ts`, operation `getConnect`; 05 §6.2 row added, gap G78 resolved, spec/ regenerated) answers `{ url, node, source }`: the owner named by the document head when its lease is live (`owner`), otherwise the rendezvous host over the live leases (`routing`), with the address the node wrote on its lease row (migration 0090, `DOCEDIT_NODE_ADDRESS`, owner decision 200 in docs/owner-decisions-2026-11-15.md); a node with no address, or no live node, gives the address of the service itself (`entry`). A token that does not cover the document is `forbidden`, a missing document `not_found`. The route is also called in `tests/security/test/sec-064-w8-surfaces.test.ts` for the read-projection review. Criteria 2 and 3: see Notes. Lane w5 (2026-11-18), criteria 2 and 3 ticked with BE-062: `services/document-service/test/data-plane/be-062-forwarding.test.ts` ('a stale hint costs latency only'): ten clients take the hint (`chooseNode`) and open on the node it names; `dep_channel_routes_total{route="forwarded"}` is 0 on both nodes against 11 `local` opens on the owner. A client that opens on the other node (a stale hint) is forwarded, opens, submits and is acknowledged (`forwarded` is 1). The share is one test run with ten clients, not a measurement of a deployment.

**Notes:** The route is named in 06 §2.1 but is not in the resource table of 05 §6.2 (see Open questions). Lane BE-053-065 (round 4): ADR 0243, section "Connect hint and node addresses", proposes the address source (an address on the node lease row) and the owner lookup (the head's `owner`, falling back to `routeDocument`). Proposed only; the owner has not chosen, and no criterion is ticked. Lane w5 (2026-11-18): the reply shape `{ url, node, source }` and the `entry` fallback are proposals (G78 resolution text); owner decision 200 settles only the source of the address and the fall back to routing. `view` is checked with row `read.head`, as `GET /documents/{id}` does (07 §12 has no row for the route). Criteria 2 and 3 need a gateway that forwards a channel that lands on a non-owner (BE-062) and a count of forwarded channels; they are ticked with BE-062 if its test shows them. Lane w5 (2026-11-18): all four criteria are ticked. The counter `dep_channel_routes_total{tenant,route}` (`data-plane/metrics.ts`) is the share of channels that needed forwarding.
Lane BE-053-065 (round 3): not built, all four criteria stay unticked. `NodeLeaseStore` (`storage/types.ts`) holds node names and liveness only, with no address, so the WebSocket URL of a node has no source; a node-to-URL map would be new configuration (`config.ts` is outside the lane). The owner of a document is not a port either: the epoch of BE-017 is held per room in the data plane, so "the owning node" has no lookup to call. The owner needs to decide where node addresses come from, and whether the hint falls back to `routeDocument` when no owner is recorded (the spec's default, as 06 §2.1 states it).

### BE-062 Forward channels between nodes over the bus

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | L | must | Author |

**Spec:** 06 §2.1 (last paragraph), §4.3, §6; 04 §12 · **Requirements:** R7, R9 · **Depends on:** BE-060, BE-063

As an author, I want a channel that lands on the wrong node to work as if it had landed on the right one, so that routing mistakes cost latency, not correctness.

**Acceptance criteria**

- [x] Given a channel lands on a non-owner node, when it opens, then the node forwards it over the internal bus on a reliable ordered stream with gap detection, and the client sees the same messages as on the owner.
- [x] Given packets between nodes are dropped or delayed in a test, when many commits flow, then no client misses, duplicates or reorders a commit.
- [x] Given the stream has a gap that cannot be repaired, when the forwarding node detects it, then it closes the channel with `ch.closed` and code `unavailable` and a `retryInMs`, and the client resumes.
- [x] Given the owner changes, when forwarded channels exist, then they are closed and re-routed.
- [x] Given a forwarded channel, when it carries a submit, then authentication happened at the gateway and the authority checks still run in the owning room.

**Evidence:** Lane w5 (2026-11-18), criteria 1 to 5 ticked; owner decisions 136 (bus: Valkey streams) and 200 (node address on the lease row, routing fallback) in docs/owner-decisions-2026-11-15.md; settings proposed in docs/adr/0393-w5-BE-062-forwarding-settings.md. `services/document-service/src/data-plane/forwarding.ts` joins the stream core (`control-plane/channel-forward.ts`) to `Session.#openChannel`, the room host and the bus (`data-plane/bus.ts`; `valkey-bus.ts`). Tests (Node.js, two data planes over one set of in-memory stores with node leases): `test/data-plane/be-062-forwarding.test.ts` (10 tests): (1) a forwarded client gets `ch.opened`, its commits are acknowledged and reach the owner's client, the owner's commits reach it, one room on the owner and none on the gateway, the log is whole; (2) with 25 percent of packets dropped and delayed up to 25 ms by a seeded fault bus, 40 commits reach the forwarded client once each in order, its own 10 commits are acknowledged once, repairs happened and no gap close; (3) with a window of 2 frames and 60 percent loss, the forwarded channel closes with `ch.closed` code `unavailable` and `retryInMs`, and a reopened channel with `resume` is brought up to date from the log; (4) when the owner's lease ends the forwarded channel closes `unavailable` and a new channel is routed to the new owner, which claims the document (epoch check); (5) a viewer on the gateway is refused by the owning room as on the owner, and a token without a role is refused at the gateway with nothing sent on the bus. `be-062-forwarding.valkey.test.ts` (2 tests) ran the same flow over a real Valkey 8 in Podman (container `valkey-w5`, 127.0.0.1:56375). Not measured: throughput, latency or the cost of heartbeats; the figures of the settings are defaults, not measurements.

**Notes:** Lane V-BE-057-070 (round 2): `services/document-service/src/control-plane/channel-forward.ts` builds the forwarding stream core (sender with a bounded repair window, receiver with gap detection, nacks, `gone`, a `head` heartbeat, and `ForwardedChannels` for owner change). `channel-forward.test.ts` runs in Node.js, 9 tests passed: in-order clean delivery, 200 seeded runs with 30% loss and delay (no miss, duplicate or reorder, stream level), an evicted frame closing `unavailable` with `retryInMs`, an unrepaired gap closing after `maxNacks`, a lost last frame repaired by the head, duplicate handling, and owner change closing only that document's channels. Criteria stay unticked. Criterion 1 needs the gateway to forward a channel to the owner: no bus transport exists (BE-059 criterion 3 open, the bus choice is the owner's) and no route calls `routeDocument` (BE-061). Criterion 2 is proven at the stream only, not at a client. Criterion 3: the close is produced, but no channel carries it to a client. Criterion 4: `setOwner` closes the channels, but nothing re-routes them. Criterion 5 needs the gateway and the owning room (BE-017 authority). Decisions for the owner: `docs/adr/0336-lane-V-BE-057-070.md`. Lane w5 (2026-11-18): the forwarded channel carries presence, events and checks as well as commits (all `ChannelPort` calls); `ForwardedChannels.setOwner` is driven by `Forwarder` through a watch of the document head and the owner's lease. A close of a gateway or an owner is sent outside the stream and, if lost, ends by silence (`silenceMs`).

### BE-063 Share presence, rate limits and the bus through Redis or Valkey

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | M | must | Operator |

**Spec:** 06 §4.3, §8; 01 §7 · **Requirements:** R9 · **Depends on:** BE-059, BE-030

As an operator, I want Redis or Valkey used only for presence, the bus and rate-limit counters, so that losing it degrades the experience and never the data.

**Acceptance criteria**

- [x] Given several nodes, when clients are present on different nodes, then presence reaches all of them through Redis or Valkey.
- [x] Given rate-limit counters, when a client connects through different nodes, then its limit is shared across them.
- [x] Given Redis or Valkey is flushed or lost, when the service continues, then no commit, grant, lease or ownership is lost, because none is stored there.
- [x] Given Redis or Valkey is unavailable, when nodes run, then each serves the rooms it owns, presence and forwarding degrade, and clients reach owners directly with the connect hint.
- [x] Given an announcement sent through the bus is lost, when a commit is persisted, then correctness is unaffected (BE-026).

**Evidence:** Lane U-BE-057-070 (round 1), store level only. `services/document-service/src/data-plane/valkey-buckets.test.ts` run against Valkey 8 in Podman (`DOCEDIT_VALKEY_URL=redis://127.0.0.1:56360`): two nodes share one bucket and the fourth take waits; 40 concurrent takes from two nodes admit exactly the capacity; refill follows the caller's clock; deleting one key (a loss) gives that bucket its capacity again and nothing else; with no server the buckets answer from a local fallback and count it as `degraded` (9 tests, all passed). Lane w5 (2026-11-18), criteria 2 and 3 ticked; owner decision 136 (docs/owner-decisions-2026-11-15.md) fixes the bus as Valkey streams. Real server: Valkey 8 in Podman (`--cgroups=disabled --network host`, container `valkey-w5`, 127.0.0.1:56375, `DOCEDIT_VALKEY_URL`). Criterion 2: the tenant and user counters go through `RateLimits` with a `ValkeyTokenBuckets` store, built from `DOCEDIT_VALKEY_URL` in `server.ts`; `services/document-service/test/data-plane/be-030-shared-store.test.ts` ('shares one user limit between two nodes') passed against that server (3 tests, run of 2026-11-18). Address counters stay in the node's memory by design (`limits.ts`). Criterion 3: `services/document-service/test/data-plane/be-063-valkey-loss.test.ts` (2 tests): a static check that only `valkey-buckets.ts` and `valkey-bus.ts` (and the composition) name Valkey, and never `storage/`, `data-plane/pg/` or `memory-ports.ts`; and a data plane with counters on Valkey, `FLUSHALL` between two commits: both commits acknowledged and in the log, owner and epoch unchanged, lease alive. New: the `Bus` interface and `MemoryBus` with faults (`data-plane/bus.ts`), the Valkey streams adapter (`data-plane/valkey-bus.ts`), `data-plane/bus.test.ts` (7 tests: order, drop, delay, down, flush, unreachable server; the 4 Valkey cases ran against the real server). Lane w5 (2026-11-18), criteria 1, 4 and 5 ticked with BE-062. Criterion 1: `test/data-plane/be-062-forwarding.valkey.test.ts` over a real Valkey (127.0.0.1:56375): a client on node-b (forwarded) and a client on the owner node-a see each other's `presence.state`, both ways, through the Valkey streams bus; also in memory in `be-062-forwarding.test.ts`. Criterion 4: the same file with the bus pointing at a closed port: the owner node serves its room (commit acknowledged and stored), a channel that needs forwarding is refused `unavailable` after `openTimeoutMs`, and a client that opens on the owner directly is served; `be-062-forwarding.test.ts` ('the bus is lost') shows the owner of each document serving its clients with the bus down, a forwarded channel closing on silence with no commit lost, and the connect hint (`chooseNode`, which reads leases and the head, not the bus) naming the owner. Criterion 5: `test/data-plane/be-063-announcements.test.ts` (2 tests; `data-plane/announcements.ts`, composed in `server.ts`): a grant change written on node-b is announced over the bus and the room on node-a sends `perm.changed`; with every message dropped the room is not told, and a commit by the owner of the document inside a region approved in storage is refused (`sync.reject` with `retry`, or the channel closed `unavailable`) and no step commit is stored; the resubmitted commit is refused `permission_denied`.

**Notes:** Lane U-BE-057-070 (round 1): the shared buckets (`valkey-buckets.ts`, Lua take script, RESP client over `node:net`, no new dependency) are not wired into `RateLimits` (`data-plane/limits.ts`). Its methods are synchronous and called by the session, so criterion 2 stays open until the gateway takes from the shared store; that change is outside this round. Criterion 1 stays open: no bus or presence transport exists (BE-059 criterion 3 is open too). Criterion 3 is shown only for the counters, and no commit, grant, lease or owner is stored in Valkey by this code, but the service does not run the shared store yet. Criterion 4: the store falls back to local buckets, a choice recorded as proposed in `docs/adr/0336-lane-U-BE-057-070.md`; forwarding and presence do not exist yet. Criterion 5 stays open with the bus. Podman note: on the WSL machine a published port is not reachable from Windows loopback, so the test container runs with `--network host` and binds `127.0.0.1` (as `infra/test-env.ps1` does). Lane w5 (2026-11-18): criteria 1, 4 and 5 stay open until the gateway forwards channels over this bus (BE-062): presence of clients on different nodes reaches them through the forwarded channel (criterion 1), the degraded behaviour when the bus is down needs forwarding to degrade (criterion 4), and a lost announcement needs something announced (criterion 5). They are ticked with BE-062 if its tests show them. Lane w5 (2026-11-18): all five criteria are ticked. Address counters stay in the node's memory by design (`limits.ts`).

### BE-064 Serve control-plane reads from replicas

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | M | should | Operator |

**Spec:** 06 §6 (PostgreSQL row) · **Requirements:** R9 · **Depends on:** BE-036

As an operator, I want read-only control-plane routes served from read replicas, so that the primary's capacity goes to the commit log.

**Acceptance criteria**

- [x] Given read-only routes (lists, pinned content, history reads), when a replica is configured, then they read from it.
- [x] Given a pinned read for a `seq` the replica does not have yet, when it arrives, then it falls back to the primary and the answer is correct.
- [x] Given a write followed by a read in the same session, when the read could be stale, then it is served from the primary or after the replica reaches the write.
- [x] Given replica lag, when metrics are scraped, then the lag is reported.

**Evidence:** Lane BE-053-065 (round 3): criterion 4 ticked. `services/document-service/src/control-plane/read-routing.lag.test.ts`: the router samples again, at each scrape, the lag of the documents it read on the replica (the gauge `docedit_replica_lag_seq` collects through `#sampleRecent` in `read-routing.ts`). The set is bounded by the start option `readLagDocuments` (`server.ts`, passed to `ReadRouter` as `lagDocuments`). The test shows a rendered scrape with lag 3, then lag 1 after the replica catches up, with no `observeLag` call; the largest lag per tenant; a document beyond the limit forgotten; and no sampling when no limit is set. Fix round of 2026-11-13: criteria 2 and 3 ticked again at route level. `src/server.ts` builds a `ReadRouter` when `parts.replica` is given (a replica's own `ContentReader` over the shared checkpoints; applied `seq` from the replica's log head); `kit.readAs` sends pinned content reads through it and `listDocuments` sends lists through it; creating, replacing, renaming and deleting a document record the write in the caller's `ReadSessions` session (one credential and actor). `services/document-service/src/control-plane/scaling.route.test.ts` (over HTTP, in-memory storage, a replica that lags by a set amount): a pinned read the replica lacks is answered by the primary with the same body and ETag, then by the replica once it has the `seq`, and a `seq` above the head is 404 (criterion 2); the writer's list waits for its new document on the primary while another caller's list comes from the lagging replica, the writer moves to the replica once it has caught up, and after a metadata change the writer's pinned reads stay on the primary while another caller's come from the replica (criterion 3). Review of 2026-11-13: criteria 2 and 3 unticked (a duplicate of criterion 1 was also removed), because `ReadRouter` is imported only by its test and no route reads through it. Tick them when the routes call the router. `services/document-service/src/control-plane/read-routing.test.ts` (in-memory primary and replica; the PostgreSQL replica was not run, no database): criterion 2 is "answers a pinned read from the primary when the replica has not applied that sequence" and "answers not found from the primary, not from the replica, for a missing pinned sequence", with the answer checked against the primary's; criterion 3 is "reads from the primary in the same session until the replica reaches the write" and "holds a tenant list back for a document the session wrote"; a fast-check property run checks that a session never reads a value older than its own writes and that a pinned value is the sequence asked for, whichever store answered. Lane w5 (2026-11-18), criterion 1 ticked. `services/document-service/src/control-plane/scaling.route.test.ts` (10 tests, over HTTP, in-memory storage; the replica is a second store seen through a lag the test sets): lists and pinned content already read through the router (criteria 2 and 3 above); history reads now do too. `createHandlers` (`handlers.ts`) builds a second kit over the replica's stores and content reader (`HandlerDeps.replicaDeps`, set by `server.ts` from `parts.replica`) and runs `listHistory`, `getDiff` and `getAttribution` through `ReadRouter` with kind `history`: the new test shows each answered by the primary while the replica lacks the document (`replica-error`), then by the replica with the same bytes once it has it (`docedit_read_route_total` counts 3 `replica`), and a document the caller cannot see refused 403 from the primary's answer. The replica is configured by `DOCEDIT_REPLICA_DATABASE_URL` (with `DOCEDIT_READ_SESSIONS`, no default, and `DOCEDIT_READ_LAG_DOCUMENTS`): `startService` opens a second pool and builds the PostgreSQL log, document, grant and version stores on it (`config.ts`, `server.ts`); `checkConfig` refuses a replica without a primary URL or without sessions (tested).

**Notes:** Fix round of 2026-11-13: the replica is a `ServiceParts` member and the number of sessions kept is the start option `readSessions` (a setting, no default); no configuration variable and no PostgreSQL standby are wired yet (`config.ts` is outside the lane), so criterion 1 stays open: history reads (`history-routes.ts`) do not go through the router, and no deployment reads from a real replica. A change of metadata has no log position, so it keeps the writer's later reads on the primary while its session is kept (`METADATA_WRITE` in `handlers.ts`). Lane control-plane-3 (round 1): `read-routing.ts` is the router, built and tested; the control-plane routes do not yet call it, so criterion 1 stays open (no route reads from a replica in the running service). Criterion 4 stays open: `observeLag` records lag when it is called, but nothing calls it on a schedule, so a scrape reports nothing until a sampler is wired by the composition. The route counters `docedit_read_route_total` are registered when a `Metrics` instance is passed. The replica port is an interface; no PostgreSQL standby is configured here. Round 3 (lane BE-053-065): the scrape samples the remembered documents itself, so `observeLag` is no longer needed for the gauge to be current. The start option `readLagDocuments` is wired in `server.ts`, but `config.ts` is outside the lane, so no configuration variable exists yet. Criterion 1 stays open: history reads (`history-routes.ts`) do not go through the router, and no deployment reads from a real replica. Lane w5 (2026-11-18): not run against a real PostgreSQL standby: the replica of the tests is an in-process store with a set lag, and the PostgreSQL path (second pool, `DOCEDIT_REPLICA_DATABASE_URL`) type-checks and its configuration is tested, but no streaming standby was started here (the one harness that starts a primary and a standby, `test/data-plane/be-082-sync-standby.pg.test.ts`, is not reused). Other history-family reads (`listVersions`, `getActivity`, threads) still read the primary; the three routes named above are the history reads that go through the router. A history list read on the replica is as stale as the replica lags (the lag gauge reports it); the caller's own writes are never missed (criterion 3). All four criteria are ticked.

### BE-065 Autoscale export workers on queue depth

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | M | should | Operator |

**Spec:** 06 §6, §8; 09 §9.5 · **Requirements:** R5, R9 · **Depends on:** BE-050

As an operator, I want the worker pool to follow the queue with a warm floor, so that previews stay fast without paying for idle workers.

**Acceptance criteria**

- [x] Given queue depth rises, when the autoscaler reacts, then workers are added until the backlog drains.
- [x] Given a warm minimum, when the queue is empty, then at least that many workers stay up.
- [x] Given workers are removed, when a job is running, then the worker finishes it before it stops.
- [x] Given priorities and tenant limits (BE-050), when the pool scales, then they are unchanged.

**Evidence:** Fix round of 2026-11-13: criteria 1 to 4 ticked again at route level. With the start option `exportScaling` (policy and tick interval), `src/server.ts` runs the export kinds in a `jobs/autoscale.ts` `WorkerPool` with the same claim options and hooks as the single runner, and an `Autoscaler` that reads the queue depth on a timer and whenever a job is queued; `close()` stops the pool, each worker after its running job. `services/document-service/src/control-plane/scaling.route.test.ts` (over HTTP, in-memory queue, floor 1, ceiling 3, one job per worker): three exports requested through `POST /documents/{id}/exports` take the pool from one worker to three and run together, and the pool returns to one once they complete and stays there over later readings (criteria 1 and 2); closing the service while an export runs waits for it, and it ends `completed` after one attempt (criterion 3); with a tenant limit of one, three workers run one export of the tenant at a time beside another tenant's, and a job of priority 5 is claimed before an earlier one of priority 0 (criterion 4). Review of 2026-11-13: criteria 1 to 4 unticked, because nothing but the test starts a `WorkerPool` or calls `Autoscaler.tick` (server.ts does not), so the product does not autoscale. Tick them when the composition starts the pool and a scheduler drives `tick`. `services/document-service/src/control-plane/jobs/autoscale.test.ts` (in-memory queue, real job runners, test-set policy numbers): `desiredWorkers` keeps the floor and ceiling and never falls while the backlog rises (property runs, fast-check); a backlog of ten exports takes the pool from one worker to its ceiling of four and the queue drains; an empty queue keeps the floor of two up over repeated ticks and the pool falls back to the floor once drained; a shrink to zero waits while the job it runs is still `running` and resolves only after it is `completed`; with three workers a preview is claimed first and a tenant at its export limit keeps its second job `queued` while another tenant's job runs; the default limit of two holds with four workers. The pool is not started by `src/server.ts`, so the production export workers are not autoscaled yet (see Notes). Lane U-BE-057-070 (round 3, 2026-11-13): `services/document-service/test/control-plane/be-065-autoscale-postgres.test.ts` runs the same rules on PostgreSQL (`PgJobQueue` over a database of its own, `createTestDatabase`, PostgreSQL in Podman `docedit-test-postgres`; `pnpm vitest run` on that file, 5 of 5 passed, none skipped): ten exports take the pool from one worker to four and the queue drains, after which the pool returns to one (criterion 1); an empty queue keeps the floor of two, and a gated backlog of forty asks for and gets the ceiling of five (criterion 2); a running export finishes before its worker stops (criterion 3); with a tenant limit of one and three workers, that tenant never runs two exports at once (criterion 4); a preview is claimed before an earlier export (criterion 4).

**Notes:** Fix round of 2026-11-13: the in-process export workers are autoscaled when the composition passes `exportScaling`; previews keep their own runner (EXP-007 criterion 1). The policy has no configuration variable yet (`config.ts` is outside the lane), and workers in separate processes (`externalWorkers`) are scaled by the platform, not by this service. Lane control-plane-3 (round 1): `jobs/autoscale.ts` holds the policy (`desiredWorkers`), the `WorkerPool` and the `Autoscaler`. The floor, the ceiling and the jobs per worker are inputs with no default, because the spec gives no measured numbers. Criteria 1 to 4 are ticked for the pool as a unit. Not done: `src/server.ts` does not start a pool or call `tick`, and no scheduler drives `tick` (the production workers are not autoscaled yet; the composition is outside this packet). The metric of queue depth per priority is BE-050 criterion 5, still open. The PostgreSQL queue was not run in lane control-plane-3 (no database); lane U-BE-057-070 ran the same rules on PostgreSQL (see Evidence), and the in-memory tests remain. The criteria are proven for the pool and the PostgreSQL queue, not for a deployed service (no deployed service is run here).

### BE-066 Meet the stage 2 targets under load

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | L | should | Operator |

**Spec:** 06 §6; 00 §9; 11 §7 · **Requirements:** R9 · **Depends on:** BE-060, BE-061, BE-062, BE-063, BE-058, FND-007, FND-009

As an operator, I want the stage 2 load test run, so that 50,000 connections and 10,000 open documents (targets) are shown on several room hosts, not asserted.

**Acceptance criteria**

- [ ] Given several room hosts, 50,000 connections and 10,000 open documents (targets), when typists produce load, then acknowledgement stays within the targets of BE-058.
- [ ] Given clients use the connect hint, when the run ends, then the forwarded share is reported.
- [ ] Given a host is killed during the run, when its leases expire, then its rooms are taken over by others and no acknowledged commit is lost.
- [ ] Given Redis or Valkey is stopped during the run, when it returns, then rooms recover without a restart.

**Notes:** Lane w5, 2026-11-18: nothing ticked (blocked). Every criterion asks for a measurement of a real run: 50,000 connections and 10,000 open documents on several room hosts, with typists, a killed host and a stopped Redis or Valkey. No such environment exists here: there is one shared development machine, no reference runner (ADR 0037) and no set of room hosts, and BE-062 and BE-063 give the forwarding and lease code but not a deployment of several hosts. Criterion 1 also depends on the stage 1 targets of BE-058, which are not met yet (criteria 1 and 2 of BE-058 are unticked, with the measured figures in its Notes). A load test of one process on this machine would not be the stage 2 run, so no scaffolding was built and no figure is reported. Findings for other stories: none. What the run needs: several hosts or containers (Podman, one room host each), a Redis or Valkey instance, a load client able to hold 50,000 connections (file descriptor and port limits raised on the client hosts), and a report of the forwarded share (BE-062) and of the takeover time after a lease expires (BE-063).

### BE-067 Decide whether follower nodes are needed before stage 3

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 4 | S | could | Maintainer |

**Spec:** 06 §16, §2.4 · **Requirements:** R9 · **Depends on:** BE-066

As a maintainer, I want to know at which audience size a room needs followers, so that BE-028 is built only if it is needed.

**Acceptance criteria**

- [ ] Given a room with a growing number of viewers, when CPU and bandwidth per viewer are measured, then the spike reports the audience size at which a core saturates.
- [ ] Given coalesced broadcasts (04 §12), when the measurement is repeated, then the effect of coalescing is reported.
- [ ] Given the data, when the spike ends, then a recommendation says whether followers are needed before stage 3.

**Notes:** Time box: three days. Phase inferred: the answer is needed before the stage 2 build. Lane w5, 2026-11-18: nothing ticked (blocked). All three criteria are measurements of a room with a growing audience on real room hosts, the spike's input. BE-066 (the stage 2 load test on several room hosts, a dependency here) is not built, and no multi-host setup exists to measure on. A single-process measurement would not show a core's saturation on the reference machine (ADR 0037), so no figure is reported.

### BE-068 Run gateway, room and API tiers as separate deployables

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | L | could | Operator |

**Spec:** 06 §1, §6 (stage 3); 01 §9 · **Requirements:** R9 · **Depends on:** BE-066

As an operator at very large scale, I want the gateway, room and API tiers scaled independently, so that each follows its own load.

**Acceptance criteria**

- [ ] Given the three tiers as separate deployables, when they run, then the conformance kit passes unchanged, because the protocol, the CDM and the storage model do not change between stages.
- [ ] Given the gateway tier, when it is restarted, then no room state is lost, because it holds none beyond connections.
- [ ] Given the API tier is scaled to zero, when clients edit, then rooms keep serving.
- [ ] Given the charts, when they are rendered, then each tier has its own deployment and scaling rules.

**Notes:** Phase `cond`: stage 3 is driven by demand and not scheduled (11 §7). 01 §9 leaves open whether to split earlier. Lane w5, 2026-11-18: nothing ticked (blocked), nothing built. Phase `cond`, stage 3, and BE-066 (its dependency) has not been run: it needs several room hosts, a Redis or Valkey and a load client, none of which exist here (BE-066 Notes). Criterion 1 needs three deployables run together and the kit passed against them, criterion 2 and 3 need a restarted gateway and an API tier scaled to zero under editing clients, and criterion 4 needs charts with a deployment per tier; the repository has one service image (`services/document-service/Containerfile`) and no charts. Owner decision 139 puts stage 3 at "on demand". Splitting the tiers would also need the ADR that 01 §9 leaves open (whether to split earlier), which no one has decided. What would be built first: a start-up setting that makes the document service serve only the gateway, only the rooms or only the REST API, with the others reached over the bus and the lease table that BE-060 to BE-063 provide.

### BE-069 Design the placement service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | cond | M | could | Maintainer |

**Spec:** 06 §6 (stage 3) · **Requirements:** R9 · **Depends on:** BE-066

As a maintainer, I want a design for the placement service named in the stage 3 column, so that it replaces rendezvous hashing with evidence.

**Acceptance criteria**

- [x] Given the stage 2 routing, when the spike ends, then a document states what placement adds (for example moving a hot document) and what it costs.
- [x] Given ownership is decided by epoch, when the design is written, then it keeps that rule.
- [x] Given a placement outage, when the design is written, then it states what happens to rooms already placed.

**Evidence:** Lane control-plane-3, round 2 (2026-11-13): section "BE-069: placement service design" of `docs/adr/0152-control-plane-3-backlog-batch.md` (status proposed). Criterion 1 names what an explicit table adds (a hot document moved to a host with headroom, placement by tenant or region) and the qualitative costs; no figure is given because none was measured. Criterion 2: placement only proposes a host and the epoch transaction of BE-017 decides ownership. Criterion 3: open rooms keep their owners while their leases hold, new channels fall back to rendezvous, and a dead host's rooms are taken over after lease expiry (BE-076).

**Notes:** 06 names the service in a table and does not describe it. Time box: one week (the design took one pass, with no prototype and no measurement). `cond`: stage 3 only. The design is a proposal for the owner: the placement table's rules (who may move a document) are open question Q6 in ADR 0152, not decided.

### BE-070 Shard PostgreSQL by tenant

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | L | could | Operator |

**Spec:** 06 §6; ADR 0006 · **Requirements:** R9 · **Depends on:** BE-066, BE-011

As an operator at very large scale, I want tenants spread over several PostgreSQL clusters, so that the commit log's insert rate is not limited by one primary.

**Acceptance criteria**

- [x] Given a tenant-to-shard map, when a request or job runs, then every query goes to its tenant's shard.
- [x] Given a commit transaction, when it runs, then it never spans shards, because all of a tenant's tables live on one shard.
- [x] Given a migration, when it is rolled out, then it applies to every shard with the same expand-and-contract rules (BE-016).
- [ ] Given a sharded configuration, when the conformance kit and the fault tests (BE-080) run, then they pass.

**Evidence:** Lane w5 (2026-11-18): `services/document-service/src/storage/shards.ts` (`routeByTenant`, `ShardPools`, `migrateShards`, `shardCompatibility`, `ShardedOutbox`, `FanOutNodeLeases`), `src/sharded-parts.ts` (`shardedPgParts`, `shardedReadiness`) and `ServiceParts.readiness` in `server.ts`; `migrate-cli.ts` takes `DOCEDIT_SHARD_DATABASE_URLS`. Tests: `src/storage/shards.test.ts` (routing rules) and `test/postgres/be-070-shards.pg.test.ts` (23 tests, run against the test cluster's PostgreSQL). Criterion 1: documents, jobs and audit events of two tenants are written through the sharded parts, and every table with a `tenant_id` is counted on both databases, so each tenant has rows on its own shard and none on the other; an unknown tenant is refused before any pool connects. Criterion 2: a commit append connects to the tenant's pool only, and an audit batch naming tenants of two shards is refused with `CrossShardError` before either pool connects. Criterion 3: `migrateShards` runs `migrate` on each shard in turn (checksums, one transaction per file, phase recorded), `shardCompatibility` applies the BE-016 rule per shard, and a failure stops the rollout and names the shard. The two shards of the tests are two databases of one PostgreSQL server, so routing and isolation are tested, a second primary's insert rate is not.

**Notes:** `cond`: ADR 0006 "revisit when sustained log inserts approach what one primary handles". Lane control-plane-3, round 2 (2026-11-13): `src/control-plane/jobs/sharding.ts` routes the job queue. Lane w5 (2026-11-18) carried the rule over the request path: every store whose methods start with a tenant or a `DocRef` is routed by it, and a call whose first argument names no tenant is refused rather than sent to a default shard. Operations that belong to no tenant run on every shard: the tenant registry's `list` and `originRegistered`, the outbox claim, and node leases (a node renews on every shard, because the claim of a document reads `node_leases` in its own shard's database; a lease counts as live only when every shard holds it, which can cost a takeover but not a second owner, as the epoch decides ownership). Not sharded: the search index (`parts.pool` is null, so the in-memory index is used), the read replica of `startService`, and the stores that need the `docedit_purge` role; none has a sharded composition yet. Adding a tenant needs it in the map first, and moving a tenant between shards is not designed (06 §6). Criterion 4 stays open: the contract checks of BE-002 (log and grant stores, 16 checks) pass over the two shards, with the checks' tenant on one shard and its other tenant on the other, but the fault tests are BE-080, which is blocked (see its Notes), so "the conformance kit and the fault tests pass" is not met. Open question Q5 in ADR 0152 (claim priority across shards is per shard only) is unchanged.
### BE-071 Evaluate moving the commit log to a log store

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | cond | M | could | Maintainer |

**Spec:** 06 §6, §2.1; ADR 0006 ("Revisit when") · **Requirements:** R9 · **Depends on:** BE-002

As a maintainer, I want the evidence for moving the log off PostgreSQL, so that the move happens only when insert rate demands it and only to a store that can fence.

**Acceptance criteria**

- [x] Given measured log insert rates on one primary, when the spike ends, then it states the rate at which PostgreSQL stops being enough.
- [ ] Given each candidate store, when it is tested, then it either passes the `LogStore` conditional-append suite of BE-002 or is rejected.
- [x] Given the recommendation, when it is written, then it covers the hash chain, the cold segments and the recovery tool.

**Evidence:** Lane control-plane-3, round 2 (2026-11-13): section "BE-071: moving the commit log off PostgreSQL" of `docs/adr/0152-control-plane-3-backlog-batch.md`. The recommendation (stay on PostgreSQL, ADR 0006) requires any candidate to keep the hash chain unbroken across the boundary, to keep the cold segments (BE-041 keys) verifiable, and to be read by the recovery tool (BE-081) that checks the chain. It is a written requirement, not a test; no candidate store was run. Lane w5 (2026-11-18), criterion 1: docs/research/2026-11-18-be-071-log-insert-rate.md, from services/document-service/scripts/load/be-071.ts. On the development machine (i9-10900KF, PostgreSQL 17.11 in a Podman container with its data on tmpfs, one run per setting), appends of one commit each stopped gaining at about 1,000 transactions per second from 16 writers on, and appends of ten commits each at about 4,300 to 4,400 commits per second. The figures carry the machine and the settings listed there.

**Notes:** `cond`: only if insert rate approaches the limit (ADR 0006). Criterion 1 was met by lane w5: the rate is stated for the development machine only, because the reference machine and a database on real disk were not available, so the figure for production hardware is still unknown and the spike owner should rerun the command there. Criterion 2 stays open: no candidate store was run against the BE-002 `LogStore` suite (a managed or log store is not available here). Time box: one pass; the spike owner should measure before the recommendation is relied on.

### BE-072 Use a managed queue

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | could | Operator |

**Spec:** 06 §6 (queue row), §14 · **Requirements:** R9 · **Depends on:** BE-049, BE-002

As an operator at very large scale, I want the job queue on a managed queue service, so that job volume does not load the database.

**Acceptance criteria**

- [ ] Given a managed-queue `Queue` adapter, when the contract suite of BE-002 runs, then it passes.
- [ ] Given the adapter is selected, when jobs are enqueued and claimed, then priorities, tenant limits and retries behave as in BE-050.
- [ ] Given jobs in flight at the switch, when the queue is changed, then none is lost or run twice.

**Notes:** `cond`: 06 §6 puts a managed queue at stage 3 (and optionally stage 2). Lane w5 (2026-11-18): blocked; nothing ticked. No managed queue service is chosen (an owner decision) and the test environment has neither a service nor an emulator of one, so an adapter could not run the contract suite of BE-002 (criterion 1), and the switch of criterion 3 has nothing to switch to. The port is wider than a message queue (priorities, per-tenant limits, cache lookup, depth, enqueue-if-absent), so the adapter cannot be written from the service's documentation alone; `docs/adr/0401-w5-BE-072-managed-queue.md` (proposed) sets out what each managed queue gives, a design that uses the queue for dispatch only and keeps the job rows in PostgreSQL, and the three questions for the owner. No code was written, so that no scaffolding stands in for the adapter.

### BE-073 Run a hot document in a dedicated process

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | could | Operator |

**Spec:** 06 §6, §8 (hot document) · **Requirements:** R9 · **Depends on:** BE-060, BE-067

As an operator, I want a document that saturates a core moved to its own process, so that it cannot slow other rooms.

**Acceptance criteria**

- [ ] Given a document marked hot, when its room opens, then it runs in a dedicated process on its own core.
- [ ] Given the dedicated process, when other rooms on the node run, then their acknowledgement latency is not affected by it.
- [x] Given ownership, when the dedicated process starts, then it takes the epoch like any other owner.

**Evidence:** Lane w5 (2026-11-18), criterion 3: `services/document-service/test/data-plane/be-073-074-placement.test.ts` ("a hot document runs on the node dedicated to it"). Three data planes (two general nodes and one dedicated to a document) run over one set of stores with node leases and a memory bus. A channel for the hot document, opened on a general node, is forwarded to the dedicated node, whose room is the only one for it; the head goes from owner null, epoch 0 to owner `node-h`, epoch 1, by the same `claimIfFree` path as any owner; a commit through the forwarded channel is acknowledged and stored. Code: `eligibleHosts` in `control-plane/room-routing.ts`, `Forwarder.route` in `data-plane/forwarding.ts`, `NodeTraits` on the lease row (`storage/types.ts`, `data-plane/pg/leases.ts`, migration 0091), `DOCEDIT_DEDICATED_DOCUMENT` in `config.ts`.

**Notes:** 06 §8 lists coalesced broadcasts and followers before a dedicated process. Lane w5 (2026-11-18): the design is in docs/adr/0402-w5-BE-073-hot-document-node.md (proposed): a dedicated process is an ordinary node with a dedicated trait on its lease row, and a document is hot while such a node is live for it. Criterion 1 stays open: the nodes of the test are data planes in one operating-system process, so uns in a dedicated process on its own core is not shown; the process and the core belong to the deployment (BE-068, which is not built) and no core was pinned. Criterion 2 stays open: it needs a measurement of other rooms' acknowledgement latency while the hot document saturates its node, and none was made. Depends on BE-067 (not built; the decision on followers does not change this routing).

## Several regions

### BE-074 Assign a home region and forward channels to it

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | L | could | Tenant administrator |

**Spec:** 06 §7 · **Requirements:** R9, R10 · **Depends on:** BE-068

As a tenant administrator, I want my data kept in one home region while my users connect to the nearest gateway, so that residency holds and typing still feels local.

**Acceptance criteria**

- [x] Given a tenant, and optionally a document, when a home region is assigned, then it is stored and used for routing.
- [x] Given a client connects to the nearest gateway, when it opens a channel, then the gateway forwards it to the home region's room.
- [ ] Given a tenant's content, history, evidence and control-plane metadata, when they are written, then they are stored only in the home region.
- [x] Given the home region is unreachable, when a client connects, then the channel fails with `unavailable` and no data is written elsewhere.
- [ ] Given several regions, when each is deployed, then each has its own object storage, Redis or Valkey and autoscaled export worker pool with a warm floor (06 §6, stage 3).

**Evidence:** Lane w5 (2026-11-18): `services/document-service/test/data-plane/be-073-074-placement.test.ts` ("a tenant with a home region is served by the nodes of that region") and `test/postgres/be-074-home-regions.pg.test.ts` (4 tests on PostgreSQL). Criterion 1: `PgHomeRegions` stores the region of a tenant and of one document (migration 0092, under row-level security); a document's own region wins; assignments are replaced, listed and cleared; another tenant sees none; `eligibleHosts` and `Placement.route` use the region with the regions the nodes wrote on their lease rows (migration 0091). Criterion 2: with the tenant assigned `eu`, a client that connects to the node in `us` has its channel forwarded to the node in `eu`: the room is there, the other node has none, the commit is acknowledged and the head names the `eu` node as owner. Criterion 4: with only the `us` node live, the channel is refused `unavailable` before any room opens; the head (owner, epoch) and the log are unchanged. The connect route is written to answer `unavailable` in the same case (`connect-route.ts`); that branch has no test of its own. The nodes of the tests are data planes in one process over shared in-memory stores, so the test shows the routing and the refusal, not a network between regions.

**Notes:** `cond`: several regions belong to stage 3. Local application of edits (hiding the round trip) is in the client (FE). Lane w5 (2026-11-18): the design is in `docs/adr/0403-w5-BE-074-home-region.md` (proposed). Criterion 3 stays open: the writes of a forwarded channel are made by the home region's room and the refused channel writes nothing, but the gateway still reads the document's head and the tenant's region from the stores it is given, so a gateway outside the region is not kept from the tenant's rows (open question 2 of the ADR, an owner's decision), and the per-region databases are composed by hand from BE-070's routed parts, not tested here as regions. Criterion 5 stays open: it needs several regions deployed, each with its own object storage, Valkey and export worker pool with a warm floor, which needs the separate tiers of BE-068 (not built). Moving a tenant to another region is not designed (ADR 0403 item 5).

### BE-075 Cache version-pinned content and assets near users

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | could | Viewer |

**Spec:** 06 §7; 10 §3.7 · **Requirements:** R9, R10 · **Depends on:** BE-074, BE-036, BE-045

As a viewer far from the home region, I want old versions and images to load from nearby, so that reading history is quick.

**Acceptance criteria**

- [ ] Given a version-pinned content read or an asset, when it is requested from another region, then it may be served from a nearby cache.
- [x] Given a cache entry, when it is stored, then its key includes the tenant, and it holds only immutable resources.
- [x] Given a request for cached content, when it arrives, then the permission check and the visibility gate run before the copy is served.
- [x] Given a tenant switches caching off, when a request arrives from another region, then it goes to the home region and nothing is stored near the user.

**Evidence:** Fix round of 2026-11-13: criteria 2 to 4 ticked again at route level. With the start option `pinnedCache` (the tenant switch and the copies held at most), `src/server.ts` builds a `PinnedCache` and `getContent` in `handlers.ts` serves `GET /documents/{id}/content?seq=` through it: the permission check, the document lookup and the history gate run inside `serve` before any copy is served, the key carries the tenant, the document, the log incarnation, the `seq` and the class, and a deployment with read restrictions caches nothing. `services/document-service/src/control-plane/scaling.route.test.ts` (over HTTP, in-memory storage): a head read stores nothing, a pinned read is stored under its tenant and served again with the same bytes and ETag (and 304), and another tenant's copies are its own (criterion 2); a user without a role is refused (403), another tenant gets 404, a deleted document is 404 although its copy is held, no copy is served to any of them, and with read restrictions nothing is stored (criterion 3); a tenant that switches caching off gets the same bytes from home, nothing is stored and its copies are dropped (criterion 4). The cache runs in the home region's process, the only region there is: no request arrives from another region until BE-074, which is why criterion 1 stays open. Review of 2026-11-13: criteria 2 to 4 unticked, because `PinnedCache` is imported only by its test and no request path, gate or tenant switch is connected to it. Tick them when the composition wires it. `services/document-service/src/control-plane/pinned-cache.test.ts` (in-memory home region and stubs; criteria 2 to 4): `pinnedKey` builds a key only for content pinned to a `seq` and for assets addressed by a 64-character hash, and refuses a mutable read before anything is read; the key carries the tenant and the visibility class, so two tenants and two classes never share a copy; the permission check runs on every request, so a copy is refused once access ends, without asking the home region; a document with hidden scopes is neither stored nor read at the edge; with caching off, every read goes home, nothing is stored, and the tenant's copies are dropped; a fast-check property run checks that each served body equals the home body and that refused requests serve nothing.

**Notes:** Fix round of 2026-11-13: the tenant switch is a function passed by the composition; no tenant setting or configuration variable stores it yet (`tenants.ts` and `config.ts` are outside the lane). Assets are not served through the cache yet. Lane control-plane-3 (round 1): criteria 2 to 4 are ticked for `src/control-plane/pinned-cache.ts`, which takes the permission check, the visibility gate and the switch as injected functions; the composition must pass the real visibility gate and the tenant switch, which are not wired here. Criterion 1 stays open: no cache sits near a reader in another region, because BE-074 (the home region routing) is not built, so no request from another region reaches this code. Lane w5 (2026-11-18): BE-074 is now partial, but only channels are forwarded to the home region (`data-plane/forwarding.ts`); an HTTP read for content or an asset has no gateway in another region to arrive at, and the cache is built in the home region's process. Criterion 1 needs a gateway outside the home region with its own cache and a fetch to the home region for a pinned read, deployed in at least two regions (the separate tiers of BE-068 and BE-074 criterion 5, not built). A cache wired in one process by hand would not test "requested from another region", so nothing is ticked and no scaffolding is added. The caller says whether a document is `restricted` (SR-C4). The permission check on cache hits follows from 10 §3.7 (signed URLs only after a permission check); the spec states only that caches exist and can be switched off. Second review (2026-11-06, SPK-027), SR-C4: under ADR 0019 pinned content differs by visibility class and stops being valid when access changes, so cache keys must include the class, and documents with hidden scopes are not cached at shared edges ([review](../review/2026-11-06-second-review.md)).

## Failure modes

### BE-076 Recover after a room host crash

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Author |

**Spec:** 06 §8 (first row); 04 §9; 00 §9 · **Requirements:** R7, R9 · **Depends on:** BE-018, BE-024, BE-025, BE-019, SYN-026, SYN-027

As an author, I want every change I saw confirmed to survive a crashed server process, so that a restart costs me a reconnect and nothing else.

**Acceptance criteria**

- [x] Given a commit was acknowledged, when the process is killed with no warning and restarted, then after clients reconnect the commit is in the log and in a content read at the head.
- [x] Given a commit was in flight at the kill, when the client reconnects with `resume.inflight`, then `ch.opened` reports `accepted` with its `seq` or `unknown`, and after `sync.caughtUp` a resubmission with the same identifier results in exactly one stored commit.
- [x] Given the dead node's lease expires, when a new process asks for its documents, then it opens them from storage and clients are served again.
- [x] Given kills at random points of the persist pipeline over many runs, when clients reconnect, then no client's confirmed `seq` is above the log's head.
- [ ] Given the recovery time is measured, when a node is lost in hosted mode, then editing is restored within 15 minutes (target).

**Evidence:** `services/document-service/src/data-plane/crash-recovery.test.ts` (data-plane-2, round 1): "keeps an acknowledged commit" (criterion 1: the room is killed with `killRoom` (BE-079), a new node opens the same stores, and the commits are in the log and in `readContent` at seq 3); "a dead node keeps its documents until its lease expires" (criterion 3: the database clock alone decides; the new node is refused while the lease is good, then opens at head 2 and commits at seq 3); "kills at random points of the persist pipeline" (criterion 4: fast-check, 12 runs, one commit held before or after its store write, then killed; no confirmed `seq` is above the head, and each commit is stored once, in order).

**Evidence (lane w5, 2026-11-18):** Criterion 2: the same file's test "a commit in flight at the kill ..." now resumes with the view token the client was given and the deployment's view key shared by both nodes (`DOCEDIT_VIEW_KEY`). With the write held before the store and with it stored before the kill (both cases), the new node answers `ch.opened` with `inflight` `unknown` or `accepted` with `seq` 2 and `catchUp` `stream`; it streams the missed commit (only in the stored case), sends `sync.caughtUp` at the head, and only then does the client resubmit the same identifier: the log holds each commit once, also after a second resubmission. 4 of 4 tests pass (`pnpm exec vitest run --project node services/document-service/src/data-plane/crash-recovery.test.ts`), in-memory stores and the `killRoom` hook.

**Notes:** One half of the phase 1b exit test (BE-080). Criterion 2 was open because the reconnect answered `catchUp` `reload`. Lane w5 (2026-11-18): the test did not send the `view` token in `resume`, and each test node drew its own random view key, so the new node could not match it; a client that sends the token it was given, to a node that shares the deployment's `DOCEDIT_VIEW_KEY`, gets `stream` and `sync.caughtUp` (criterion 2 ticked). A deployment without `DOCEDIT_VIEW_KEY` draws a key per process (`server.ts`), so after a crash every client is told to `reload`; that is safe but costs each client a reload, and the key should be set for any deployment of more than one process. The kill is the test hook of BE-079, which stops the room with no checkpoint and no release of ownership; it is not an operating-system kill. The PostgreSQL side of the same crash needs a database and is not run here. Criterion 5 is a measurement of a hosted deployment and is not run. Lane w5 (2026-11-18): the owner's decision 28 of 2026-11-15 (`docs/owner-decisions-2026-11-15.md`: both hosted and self-hosted from the start) means criterion 5 applies, not that it is met: there is no hosted deployment to lose a node from, so no recovery time was measured. The nearest figure is the FND-009 kill on PostgreSQL (a new process acknowledged a commit 13.3 s after its start, waiting out the dead process's lease; `docs/research/2026-11-17-fnd-009-service-load.md`), which is a process restart and says nothing about provisioning a replacement node.

### BE-077 Reject safely while PostgreSQL is unavailable

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 06 §8 (PostgreSQL unavailable); 04 §5 · **Requirements:** R7, R9 · **Depends on:** BE-025, BE-018

As an author, I want a database outage to stop saving without losing or corrupting my work, so that my document is intact when the service comes back.

**Acceptance criteria**

- [x] Given the database becomes unreachable, when commits arrive, then rooms reject them with the retryable `unavailable` and a delay, and nothing is acknowledged that was not stored.
- [x] Given commits are rejected for this reason, when the channel is observed, then it is not closed only because of the rejection.
- [x] Given the database returns, when the next commit arrives, then the room re-reads the log tail and grants, resumes without a restart, and resubmitted commits with the same identifiers are stored once.
- [x] Given the outage lasts longer than the node lease can be proved, when the node checks, then it stops serving as in BE-018.
- [x] Given the outage, when readiness is probed, then the service is not ready, and content reads return `unavailable`.

**Evidence:** Lane U-BE-071-084 (round 1): criterion 1 is ticked by `services/document-service/test/data-plane/be-077-outage.pg.test.ts`, run with `pnpm exec vitest run` on that file against PostgreSQL in Podman (`docedit-test-postgres`). With the database unreachable for the node (the BE-079 hook), a commit is answered `sync.reject` `unavailable`, `retry`, with `retryAfterMs` above zero; PostgreSQL holds nothing for the document; a content read answers `unavailable`; the channel stays open; after the database returns, the same channel stores a resubmitted commit once and the next commit takes seq 2. The delay comes from the change in `packages/authority/src/room/room.ts` (`discard`: `retryAfterMs: 1000`, the value the draining node already gives); `packages/authority/test/room*.test.ts` and `relay.test.ts` pass (120 tests). Data plane (`services/document-service/src/data-plane/outage.test.ts`, round 5): with the test hook that makes the database unreachable (BE-079), a commit is answered `sync.reject` with `unavailable`, `action` `retry` and the head, nothing is acknowledged and nothing is stored, and the channel stays open ("rejects commits with the retryable unavailable, acknowledges none, and keeps the channel open"); content reads return `unavailable` during the outage and serve again after it ("answers content reads with unavailable while the database is down"). Lane V-BE-071-084 (round 2): criterion 5 ticked by `services/document-service/test/data-plane/v-be-071-084-be-077-readiness.pg.test.ts`, run with `pnpm vitest run --project node` on that file against PostgreSQL in Podman (`docedit-test-postgres`): `readiness` (`src/server.ts`, the function `/readyz` uses) is ready on the service pool and not ready on a pool whose TCP port refuses connections (reason "the database is unreachable", no port in it), and `readContent` through that pool answers `unavailable`. The unreachable pool is a real refused connection, not a hook.

**Evidence (lane w5, 2026-11-17):** `services/document-service/test/data-plane/be-077-recovery.test.ts`, plane over the in-memory stores, 2 of 2 pass. Criterion 3: during an outage (the BE-079 hook) a commit is rejected `unavailable`, the grants of the document change in storage with the announcement lost, the database returns with no restart, and the first write is refused because the grants revision moved; the room takes the new grants (`perm.changed` rev 2) and the control commit it did not write (the resubmission at base 1 is accepted for the position and checked against the new grants, `permission_denied`), the channel stays open, and a commit under the new state is stored once when sent twice with one identifier (log: seq 1 control, seq 2 steps). Criterion 4: with a short lease (800 ms, renewal every 100 ms) and the same hook, a commit is first rejected `unavailable` with the channels open, then the renewals fail, the node stops proving its lease, and an editor's and a viewer's channels are closed with `ch.closed` and `unavailable` and the room is gone (the stop of BE-018, `RoomHost.fence`). To make the hook cover the lease, `src/data-plane/index.ts` now fails the lease renewals while `databaseDown` is set.

**Notes:** The "unsaved" indicator and the journal are FE and UX; this story supplies the server behaviour they react to. Open after round 5 (2026-11-13): criterion 1's delay is not delivered: a write that fails is answered by the authority's `discard` (`packages/authority/src/room/room.ts`, case `failed`) without `retryAfterMs`, and the room host adds none; this needs the authority owner's change. Criterion 3: the test shows that the same channel resumes and that a resubmitted identifier is stored once, but it does not show that the room re-reads the log tail and grants, so it stays open. Criterion 4 needs the node lease (BE-018) and criterion 5's readiness probe is the server's (`src/server.ts`), neither is in the data plane. Lane BE-066-078, round 1: no criterion ticked. Criterion 3 (the room re-reads the log tail and grants after the database returns, without a restart) is not shown by a test: the room's handling of a failed write is in `room-host.ts` and the authority, and a test that counts reads would assert an implementation detail, not the behaviour. Criterion 1 is ticked since lane U-BE-071-084 (round 1): the delay is now delivered (`retryAfterMs` 1000 in the authority's `discard`, a value chosen to match the draining node; the owner may prefer another, which is a one-line change). Lane V-BE-071-084 (round 2): criterion 5 is ticked, by the readiness and unreachable-pool test named in its Evidence. Criterion 3 stays open: the test shows that the same channel resumes, not that the room re-reads the log tail and grants. Criterion 4 needs the node lease (BE-018). Lane w5 (2026-11-17): criteria 3 and 4 are ticked, all five are met. They run on the in-memory stores with the hook, not on PostgreSQL with a real outage: the lease's PostgreSQL renewal under a refused port and the room's re-read on PostgreSQL are not run together here; the readiness and unreachable-pool test of round 2 and the lease test of BE-018 cover those pieces against PostgreSQL.

### BE-078 Give a document a new incarnation after a database recovery

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Operator |

**Spec:** 06 §8 (database recovery), §4.2; 04 §1, §9; review DR-1 · **Requirements:** R9 · **Depends on:** BE-009, BE-081, BE-036, SYN-026, SYN-027

As an operator who restored a database to an earlier point, I want the affected documents to start a new incarnation, so that no client silently keeps commits the log no longer has.

**Acceptance criteria**

- [ ] Given a restored database and the object store, when the operator runs the command in dry-run mode, then it lists documents whose checkpoints or segments reach past the restored head and changes nothing.
- [ ] Given the command runs for those documents, when it finishes, then each has a new `incarnation`, an audit event records it, and checkpoints and segments beyond the restored head are set aside and not used.
- [x] Given a client reconnects with the old incarnation or with a `seq` above the head, when the channel opens, then `catchUp` is `reload`.
- [x] Given documents that were not affected, when the command runs, then their incarnations are unchanged.
- [x] Given a content read after the change, when its `ETag` is compared, then it differs from before.

**Evidence:** Lane U-BE-071-084 (round 1): criterion 1 ticked by `services/document-service/test/data-plane/be-078-dry-run.pg.test.ts`, run with `pnpm vitest run` on that file against PostgreSQL in Podman (`docedit-test-postgres`) and the S3-compatible store (`docedit-test-s3`). It runs `recovery-cli.ts incarnation --dry-run` as a child process over a database whose head was moved to 2 below a checkpoint at 3: the document is listed as `head 2, checkpoint 3`, the documents whose checkpoint is at or below the head are not, the line "1 documents would get a new incarnation; nothing was changed" is printed, and the incarnations, the checkpoints' `set_aside_at` and the object stay unchanged. The listing covers checkpoints only (the function `docedit_checkpoints_beyond_head()` does not read segments). `services/document-service/src/data-plane/recovery.ts` (`newIncarnation`), tested in `services/document-service/src/data-plane/recovery.test.ts` (round 5): "gives the document a new incarnation, sets aside checkpoints past the head, and audits it" (criterion 2 is not ticked: the object-store set-aside is not exercised by the in-memory store); criterion 4 (fixer, round 5): the command's procedure is now `runIncarnation` in `recovery.ts`, which `recovery-cli.ts` calls with the PostgreSQL selection (`affected`); "selects only the documents whose checkpoints reach past the head, and leaves the others their incarnation" runs it on the memory log and an `ObjectCheckpointStore` over `MemoryObjectStore`, with the selection for stores without an index (`affectedAmong`, built on `beyondHead`): of three documents, only the one with a checkpoint past its restored head is selected and changed, the one with a checkpoint below its head and the one without are not selected and keep their incarnation, the dry run changes nothing, and the checkpoint past the head leaves the object store's checkpoints. The PostgreSQL selection itself (`affected`) is still not run. Lane BE-066-078, round 1: `services/document-service/src/data-plane/incarnation-reload.test.ts` ("sets the checkpoint past the head aside, audits it, and reloads every old client"; in-memory stores, the plane closed and started again over them): the new incarnation is audited with the operator as actor and the set-aside checkpoint is gone from the object store and the index (criterion 2, partly); a client with the old incarnation at its old `seq` or below the head, and a client with a `seq` above the head under the new incarnation, each get `catchUp` `reload` (criterion 3, ticked); the content read after the change carries the new incarnation, so its ETag formula (`content.ts`) differs (data-plane part of criterion 5). Lane V-BE-071-084 (round 2): criterion 5 ticked by the PostgreSQL run of `services/document-service/test/control-plane/routes.content.test.ts`, test "changes the ETag of a seq when the log gets a new incarnation" (postgres variant, passed with `pnpm vitest run --project node` on that file against PostgreSQL in Podman, `docedit-test-postgres`). The test reads content over HTTP, sets the incarnation of the document's head row (`doc_heads`) to a new value with a direct SQL update, and checks that the ETag and the `incarnation` in the next read differ. The change is made in SQL, as the recovery command makes it, not by running the command over HTTP; criterion 2 (set-aside segments) stays open.

**Notes:** Recovered edits on the client are FE and SYN. Lane U-BE-071-084 (round 1): criterion 1 is ticked on the checkpoint reading of "checkpoints or segments"; the dry run does not list documents whose only excess is in payload segments, which the owner should confirm is acceptable or extend the function. Criterion 2 stays open (segments not set aside; see the Notes above). Criterion 5 stays open (the ETag over HTTP is not compared in a PostgreSQL run). The procedure that reconciles from the log is the same one BE-041 relies on. Open after round 5 (2026-11-13): criterion 1 (the dry run) rests on `affected`, which needs PostgreSQL and the `docedit_checkpoints_beyond_head()` function, not run here; criterion 2 is partly evidenced (see above); criterion 3 is ticked (lane BE-066-078, round 1; `incarnation-reload.test.ts`). Criterion 2 stays open: `newIncarnation` (`recovery.ts`) sets aside checkpoints only, not the payload segments (`objects/store.ts` `segment`) beyond the restored head, so "segments ... set aside" is not met. Criterion 5 stays open: the ETag is built by the control plane (`content.ts`, `"${incarnation}.${seq}.${view}"`), and the only test of it over HTTP that changes the incarnation is PostgreSQL-only (`test/control-plane/routes.content.test.ts`, skipped here); the data-plane test shows the incarnation changes but does not compare an ETag over HTTP. Lane V-BE-071-084 (round 2): the ETag comparison over HTTP is now run against PostgreSQL (criterion 5 ticked, see its Evidence); the set-aside of segments (criterion 2) and the command's own run over HTTP are not. Audit of 2026-11-13: criterion 1 unticked, because the dry run (`affected`, `docedit_checkpoints_beyond_head()`) and its PostgreSQL test cover checkpoints only, so a document whose only excess is in payload segments is not listed, although the criterion says "checkpoints or segments"; tick it when segments are listed too, or the owner narrows the wording. Lane w5 (2026-11-18): criteria 1 and 2 are still blocked, both by the same thing. Both name segments, and no cold segment is written or read anywhere in `services/` or `packages/` (`objects/store.ts` names the key and nothing uses it; the segment writer and reader are HIS-029, phase 2, which depends on BE-081). The checkpoint half of both is built and tested (dry run on PostgreSQL and S3; `newIncarnation` and `runIncarnation` on in-memory stores), so the only open part is segments; code to list or set aside segments would have to invent their format. The owner's table of 2026-11-15 does not name BE-078. Two choices stay with the owner and were not made: narrow criteria 1 and 2 to checkpoints until HIS-029 lands, or keep them open until segments exist. Not run: the full command (not the dry run) against PostgreSQL and S3 as a child process.

### BE-079 Expose fault-injection hooks for the conformance kit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | should | Maintainer |

**Spec:** 05 §11; 06 §8 · **Requirements:** R6, R9 · **Depends on:** BE-024, BE-017, PRO-108

As a maintainer, I want test hooks that make the service fail on demand, so that durability, fencing and the hash chain, which cannot be seen from outside, can be tested.

**Acceptance criteria**

- [x] Given the test-mode switch is off (the default), when a hook is called, then it does not exist, and the production configuration refuses to enable test mode.
- [x] Given test mode is on, when the kit asks, then timers are shortened (token lifetime, lease expiry, idle timeouts).
- [x] Given test mode is on, when the kit calls the hooks, then it can drop the database connection, make the next write fail before the insert or after it, kill a room, and drop one grant announcement.
- [x] Given test mode is on, when the kit reads state, then it can read a test document's chain head, ownership epoch and audit events.
- [x] Given a hook is used, when the log is read, then the use is recorded.

**Evidence:** Criterion 1 (packet C, round 2): `services/document-service/src/control-plane/test-mode.test.ts`. The switch is off by default; `configFromEnv` refuses it in the production environment (the default one) and accepts it in `test` and `development`; with the switch off every path under `/_test/` answers `not_found` (404), and with it on `GET /_test/timers` answers the shortened timers and an unsigned call answers `unauthenticated`. Memory storage. Criteria 3 and 4 re-ticked by the fixer (round 5) on the real data plane, `services/document-service/src/data-plane/hooks.test.ts` (test mode, in-memory stores): "fails the next write before its insert ..." and "fails the next write after its insert ..." (the commit is rejected `unavailable` `retry`, the store received the fault, nothing is stored, `state` is unchanged, and the next write is stored); "drops exactly one grant announcement ..." (no `perm.changed`, no control commit and the old revision in the room, then the next announcement arrives); "reads the chain head, the ownership epoch and the audit events ..." (the chain head equals the chain recomputed from the log, the epoch and owner are the claim's, and `auditEvents` returns the `test.hook` events). The memory log now carries out the faults at PgLogStore's points (`AppendOptions.fault`, `src/storage/memory.ts`) and gives the chain head (`MemoryStore.state`), tested in `services/document-service/src/storage/memory-faults.test.ts`; `dropDatabase` is in `outage.test.ts` and `killRoom` in `test/data-plane/session-1b.test.ts`. The PostgreSQL side of the faults and of `state` needs a database and was not run. Before that, criteria 3 and 4 were unticked by review (round 5): `test-hooks.test.ts` checks the handler's routing against a stub whose hooks record calls and return constants, so it does not show that a write fails before or after its insert, that an announcement is dropped, or that the real `state` and `auditEvents` return the chain head, epoch and events; only `dropDatabase` (`outage.test.ts`) and `killRoom` (`test/data-plane/session-1b.test.ts`) have a test on the real data plane. Criterion 5 stands. `services/document-service/src/control-plane/test-hooks.test.ts` (Node.js suite). Routing of criterion 3: "lets the kit drop the database and fail the next write before or after its insert" and "kills a room, drops one grant announcement ..." (each hook reaches the stub data plane's `DataPlaneTestHooks` with the tenant and document). Criterion 4: the same file's `GET .../state` and `GET .../audit` checks. Criterion 5: each call is logged as `test.hook` with its name and document. The stub data plane stands in for the data plane's own hook implementation (packet A), so the effect of each hook on a real room is not tested here. Round 10 (lane BE-079-091, criterion 2, leases): `services/document-service/test/control-plane/be-079-lease-timers.test.ts` records the durations handed to the lease stores: in test mode every node lease renewal gives 3 s (`TEST_TIMERS.nodeLeaseMs`) and every job claim gives 2 s (`jobLeaseMs`); with test mode off they are 15 s and 30 s. The memory stores stand in for PostgreSQL, and expiry on the database clock is not run.

**Notes:** The hooks' shape is not in the spec; 05 §11 only says an optional fault-injection profile exists. Phase inferred: 05 §11 calls the profile optional; the 1b fault test needs the hooks. Packet C (2026-11-13, round 2): criterion 1 ticked on `test-mode.test.ts`. Gap for the composition owner: the comment on `checkConfig` in `config.ts` says that `startService` also refuses test mode, but `startService` in `src/server.ts` does not call `checkConfig`, so a configuration built in code (not from the environment) is not refused. The refusal is tested only through `configFromEnv`. Criterion 2 stays open: the hook reports the timers in force, but no test shows the token, lease and idle timers changing behaviour. Round 6 (lane BE-079-091): `services/document-service/test/control-plane/be-079-token-lifetime.test.ts` shows that `POST /v1/tokens` mints 60 s tokens in test mode and the default lifetime when the switch is off; `idempotency-retention.test.ts` shows the shortened idempotency TTL. Not shown: the room idle timeout, the hello timeout, and the node and job lease expiry at their shortened values (`server.ts` wires them, `TEST_TIMERS`), so the criterion stays open. Round 7 (lane BE-079-091, 2026-11-13): `services/document-service/test/control-plane/be-079-idle-timeout.test.ts` runs the real data plane (the new `realDataPlane` option of `test/control-plane/support.ts`, default off) over a real WebSocket: in test mode an idle room's owner is released about 1 s after the disconnect (no sooner than 0.9 s, polled for up to 10 s; the shortened 1 s idle timer, where the default with test mode off is 60 s, `roomIdleMs ?? 60_000` in `src/data-plane/settings.ts`), and with test mode off (the `/_test/` hooks answer 404) the owner, read from the log store's head row because no hook is served, is still held 1.5 s after the disconnect. Round 8 (lane BE-079-091, 2026-11-13): the switch-off test now reads the owner from the store instead of the absent hook, which had made it pass whatever the room did. The lease expiry and the hello timer are still not shown, so the criterion stays open. Round 9 (lane BE-079-091, 2026-11-13): `services/document-service/test/control-plane/be-079-hello-timeout.test.ts` shows the hello timer: in test mode a socket that sends no `hello` is closed with 4408 (`CLOSE.helloTimeout`) about 2 s after it connects (`TEST_TIMERS.helloTimeoutMs`), and with test mode off the same silent socket is still open after 3 s. Still not shown: the node lease expiry (`nodeLeaseMs`, 3 s in test mode) and the job lease (`jobLeaseMs`, 2 s), so the criterion stays open. Round 10 (lane BE-079-091): the two leases now reach their stores shortened (`be-079-lease-timers.test.ts`, see Evidence), so criterion 2 is ticked. The store judges expiry from the duration it is given; a wall-clock expiry test was not written, and the criterion is ticked on the duration.

### BE-080 Run an hour of faults against the stage 1 service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Maintainer |

**Spec:** 11 §4 (exit criteria); 06 §8; 04 §5, §9 · **Requirements:** R3, R7, R9, R13, R15 · **Depends on:** BE-079, BE-076, BE-077, SPK-016, FE-008, FE-009, EXP-004, EXP-005, SYN-028, SYN-029, SYN-047

As a maintainer, I want the phase 1b exit test automated at the service and at the sync level, so that the first usable release is shown to survive faults and to lose no work, not assumed to.

**Acceptance criteria**

- [ ] Given two users with different region grants and one fill-only participant editing one document for an hour, when faults are injected at random (dropped connections, a killed process, a database outage), then at the end every client and the server hold identical documents.
- [ ] Given the run, when the rejection records are read, then every rejected change was a real violation of the permissions or the invariants in force, judged by the independent oracle of SPK-016.
- [ ] Given a client tab is closed with unconfirmed commits and reopened during the run, when it returns, then the commits are resubmitted from the journal and nothing typed was lost.
- [ ] Given the run uses resume, incarnation and `catchUp` of all three kinds, when the run ends, then each kind was exercised at least once.
- [ ] Given a log is rewound and given a new incarnation during the run, when clients reconnect, then they reload and their unconfirmed work appears in recovered edits.
- [ ] Given the run ends, when a PDF is exported at the final `seq`, then it matches the content and validates.
- [ ] Given the run, when CI schedules it nightly, then its seed, fault schedule and result are stored so a failure can be replayed.

**Notes:** The exit criteria are shared by several epics; this story is the harness, the server-side half and the sync-level checks (resume, incarnation, `catchUp`, rewound logs). The convergence property suite itself is SYN-047. This story absorbed SYN-048 during the cross-check.
Lane w5 (2026-11-18): not started, blocked; nothing ticked. The pieces that exist are the halves: the server's recovery after a kill (BE-076), the outage (BE-077), the fault hooks (BE-079), the load harness with dropped connections, a killed process and an outage on PostgreSQL (FND-009, `services/document-service/scripts/load/`), the client's journal and resubmission against backend-mock's room (FE-009 criterion 7, `packages/engine/test/fe-009-fault-injection.test.ts`), the convergence suite against the authority (SYN-047), and the oracle of SPK-016 (`packages/authority/test/harness/oracle.ts`). What is missing is the run that joins them, and it needs things this lane did not have: (1) a package that holds the engine's `DocumentCore`, the `@docedit/backend-dep` backend and the real service together (no package depends on all three; `backend-dep` has the service and backend-mock as dev dependencies and the engine has backend-mock only, so a workspace dependency has to be added, which this lane may not do; a relative import across packages would work for a test but would pull the engine's DOM-typed sources into the service's type-check and cross a boundary the dependency rules do not name); (2) a PDF export at the final `seq` of a running service, which needs the export worker image and a TeX sandbox in the run (the image is present in the test environment; the run was not built); (3) an hour of wall time per run and a nightly job, which is `.github/` (root configuration) and a runner; (4) a fixed listening port across the process kill, since the backend-dep client reconnects to the discovery URL (the FND-009 harness binds an ephemeral port and the restart gets another). None of it was started, so that no scaffolding stands in for the run. The convergence of `every client and the server` (criterion 1) and the oracle judgement of rejections (criterion 2) are the parts that cannot be done without real engine clients; criteria 4 and 5 (the three kinds of `catchUp`, and a rewound log with a new incarnation) can be exercised by raw DEP clients at the service level, but only as parts of the one run, so they are not ticked alone. The client half is FE-009 criterion 7, which waits for this story.

## Recovery objectives

### BE-081 Rebuild and verify a document from a checkpoint and the log

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 06 §9, §11; 08 §12 · **Requirements:** R4, R9 · **Depends on:** BE-009, BE-020, HIS-001, HIS-002

As an operator, I want a command-line tool that rebuilds any document from a checkpoint plus the log and checks the hash chain, so that recovery and corruption can be judged by evidence.

**Acceptance criteria**

- [x] Given a checkpoint and the log after it, when the tool runs, then it prints the canonical document's hash at the requested `seq` and exits 0 if the replay succeeds.
- [ ] Given the commit rows of a document, when the tool verifies the chain, then it recomputes each `hash` from `prev_hash`, the metadata and the payload hash, including payloads read from cold segments, and exits non-zero naming the first broken `seq`.
- [x] Given a checkpoint, when its hash is compared with a replay of the log from an earlier checkpoint, then a mismatch is reported.
- [x] Given a database dump and an object store, when the tool runs, then it needs no running service.

**Evidence:** Lane U-BE-071-084 (round 1): `services/document-service/test/data-plane/be-081-recovery-cli.pg.test.ts`, run with `pnpm vitest run` on that file against PostgreSQL in Podman (`docedit-test-postgres`) and the S3-compatible store (`docedit-test-s3`). It runs `src/data-plane/recovery-cli.ts` as a child process: "criterion 1" test, `rebuild` at the head and at `--seq 2` prints a 64-digit hex hash with `seq N` and exits 0, and asking again gives the same hash (criterion 1 ticked). "criterion 2" test, `verify` exits 0 with `chain ok up to seq 3`, then, after a size change to commit 2 made under session replication role `replica`, exits 1 with `broken at seq 2` (chain part only; payloads in cold segments are not tested, so criterion 2 stays open). `services/document-service/src/data-plane/recovery.ts` (`verifyCheckpoint`, `rebuild`), tested in `services/document-service/src/data-plane/recovery.test.ts` (round 5): "reports a stored checkpoint that differs from the replay, and accepts one that matches" (criterion 3: a wrong checkpoint at 3 gives `ok` false, a checkpoint built from the replay gives `ok` true); "rebuilds the head and any earlier seq to a hash, from the stores alone" (criterion 4: the plane is closed and the stores alone are used, in-memory, not a PostgreSQL dump).

**Notes:** The same function backs the checkpoint verification of BE-020 and the audit export of HIS-033, HIS-036. Phase inferred: checkpoint verification (BE-020) and incarnation recovery (BE-078) in 1b need it. Open after round 5 (2026-11-13): criterion 1 gives the hash through `rebuild`, but the command's exit code (`recovery-cli.ts`) was not run, so it stays open; criterion 2 (chain verification and the first broken `seq`) is in `recovery-cli.ts` over PostgreSQL and has no test. Lane U-BE-071-084 (round 1): the PostgreSQL test above ticks criterion 1 and shows the chain part of criterion 2. Criterion 2 stays open: the cold-segment payload check ("including payloads read from cold segments") is not exercised, and the segment path of `verify` has no test. Round 10 (lane BE-079-091, 2026-11-13): no cold segments exist in the code (a search of `src/` finds no segment store; `LogStore.verify` with `payloads` reads `doc_commit_payloads` in PostgreSQL only), so the cold-segment part cannot be tested until that storage is built; the memory store has no `verify`. Criterion 2 stays unticked, not a test gap alone. Lane w5 (2026-11-18): rechecked, still blocked. Nothing in `services/` or `packages/` writes or reads a cold segment: `objects/store.ts` only names the key (`segment()`, `docs/{doc}/segments/{from}-{to}.payloads.zst`), and `payload-absent.ts` says the service does not read segments yet. The segment format, its writer and its reader are HIS-029 (phase 2), which lists BE-081 as a dependency. A verifier written here would have to invent the format, so no code was added; the chain and the hot payloads are verified as before. When HIS-029 lands, `LogStore.verify` takes the payload of a thinned or moved commit from the segment and the PostgreSQL test of `be-081-recovery-cli.pg.test.ts` gets a case with a moved payload.

### BE-082 Recover hosted deployments within the stated objectives

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Operator |

**Spec:** 06 §9, §6; 00 §9 · **Requirements:** R9 · **Depends on:** BE-081, BE-078, BE-096

As an operator of the hosted service, I want the log replicated synchronously and restores rehearsed, so that losing a database node loses nothing and recovery takes under 15 minutes (target).

**Acceptance criteria**

- [x] Given PostgreSQL with a synchronous standby for the log, when the primary is lost, then no acknowledged commit is lost (recovery point zero for one failure).
- [ ] Given the loss of a whole location, when the service is restored elsewhere, then the recovery point is the last replicated transaction, it is documented as such, and affected documents get new incarnations (BE-078).
- [x] Given a rehearsal, when it runs, then it restores into an empty environment, verifies sample documents with BE-081, records the duration, and fails if the time is above 15 minutes (target).
- [ ] Given rehearsals, when they are scheduled, then each one is recorded with its date and result.

**Evidence:** Lane U-BE-071-084 (round 1): criterion 3 is ticked by `services/document-service/test/data-plane/be-082-rehearsal.pg.test.ts`, run with `pnpm exec vitest run` on that file against PostgreSQL in Podman (`docedit-test-postgres`, read only apart from its own database). Three documents are written, the source database is dumped with `pg_dump -Fc` inside the container, a new empty database is created and `pg_restore`d into, and `recovery-cli.ts verify` (chain and checkpoints) and `rebuild` (head hash, equal to the source's) run over the restored database. The test fails if the rehearsal takes 15 minutes or more; it prints one JSON record (date, duration, result) to the test log. The duration on this machine is not the reference machine's figure and is not quoted here. Lane V-BE-071-084 (round 2): criterion 1 is ticked by `services/document-service/test/data-plane/be-082-sync-standby.pg.test.ts`, run with `pnpm vitest run` on that file (one test, passed, about 750 s on this machine, not a reference figure). It starts a primary and a streaming standby in Podman (`docedit-v-be-071-084-sync-primary` and `-standby`, host ports 57370 and 57371, `--cgroups=disabled`, removed afterwards), makes the standby synchronous only after it streams, writes four commits through the data plane over WebSocket, each answered `sync.ack`, kills the primary with SIGKILL, promotes the standby with `pg_promote`, and checks that the commit log read there equals the log read from the primary before the kill, and that the head matches.

**Notes:** `cond`: only if the owner chooses to run a hosted service (11 §10, decision 8). Lane U-BE-071-084 (round 1): the rehearsal restores into a second database in the same PostgreSQL instance, not a new environment, and does not restore the object store (it shares the test bucket). Lane V-BE-071-084 (round 2): criterion 1 is now ticked on a standby that the test starts itself in Podman (see Evidence); the shared test environment still has no standby. Criterion 2 needs a second location, which is not in the test environment and is not simulated; it stays open. Criterion 4 needs the rehearsals to be scheduled and their records kept, which is not built, and the record is printed to the test log only. Those stay open. Lane w5 (2026-11-18): checked again, nothing new can be ticked. Criterion 2 needs a restore in another location (a second site or region), which this machine and the shared test environment do not have, and the incarnation step it names depends on BE-078 for a restore that crosses locations. Criterion 4 needs a schedule (a recurring CI or operator job) and a kept record of each run; the only scheduler of this repository is hosted CI under `.github/`, which a lane does not edit and which cannot be run here, and a record file written by the test on a developer's machine is not a scheduled rehearsal. The next step is a scheduled job that runs `be-082-rehearsal.pg.test.ts` and appends its JSON record to a store the operator keeps.

### BE-083 State the recovery point of self-hosted deployments

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | cond | S | should | Operator |

**Spec:** 06 §9 (self-hosted row) · **Requirements:** R9, R15 · **Depends on:** BE-081

As an operator who runs the service myself, I want the documentation to say plainly what my recovery point and time depend on, so that I plan my PostgreSQL accordingly.

**Acceptance criteria**

- [ ] Given the self-hosting guide, when it describes recovery, then it states that the recovery point is whatever the operator's PostgreSQL provides and the recovery time is the operator's.
- [ ] Given the guide, when it lists settings, then it names synchronous replication as the way to a recovery point of zero for one failure.
- [ ] Given the guide, when it describes a restore, then it includes the reconciliation of the object store from the log and the verification tool (BE-081, BE-078).

**Notes:** `cond`: only if self-hosted distribution ships.

## Cost model, observability and support

### BE-084 Measure memory per open document

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 1b | S | must | Maintainer |

**Spec:** 06 §10, §16; review PD-6 · **Requirements:** R9 · **Depends on:** BE-019

As a maintainer, I want the real memory cost of an open room, so that the room budget, the idle close and the unit-cost sheet use measurements.

**Acceptance criteria**

- [ ] Given documents of several sizes (a short one, about 20 pages, about 100 pages, one near the 16 MiB limit), when rooms are opened, then the spike reports resident memory per room including durable and tentative states, indexes and position maps.
- [x] Given a room is closed, when memory is read, then it reports how much is returned.
- [ ] Given the results, when the spike ends, then it recommends a room memory budget and a number of rooms per node for stage 1.
- [ ] Given the results, when they are handed over, then SPK-025 can quote them.

**Evidence:** Lane U-BE-071-084 (round 3): criterion 2 ticked by the same test's `returnedMiB` assertions (after `closeIdle`, the closed room returns memory, and the returned amount is at least 90 % of the resident amount it reports); run with `pnpm exec vitest run` on that file in Node.js on this machine, which passed. Lane V-BE-071-084 (round 2): `services/document-service/test/data-plane/v-be-071-084-be-084-room-memory.test.ts`, run with `pnpm vitest run --project node` on that file, in the Node.js worker on this machine (not the reference machine). It opens the authority's `Room` (`packages/authority`) over an initial document of four sizes and reads `heapUsed` after two forced collections, before and after the room is opened, and again after it is released. Printed records (MiB, heap; JSON size of the content): short, 10 paragraphs, 0.00 JSON, resident 0.11, returned 0.00; about 20 pages, 200 paragraphs, 0.08, resident 0.48, returned 0.12; about 100 pages, 1,000 paragraphs, 0.38, resident 2.33, returned 0.60; near 16 MiB, 41,186 paragraphs, 15.48, resident 94.69, returned 25.38. Criterion 2 was ticked on the returned figure and was unticked by the reviewer (round 2): the returned figures above are wrong. The test's `expect(holder.room).not.toBeNull()` keeps the room reachable after the reference is cleared, so only about a quarter of the heap came back. With that line removed, a reviewer's run on this machine returned nearly all of it (near 16 MiB: resident 94.69, returned 94.59; about 100 pages: 2.33 and 2.29; about 20 pages: 0.48 and 0.47). Also, "closed" in the test is a dropped reference to the authority's `Room`, not the room host closing a room (`room-host.ts`), and the test does not assert on the returned figure.

**Evidence (lane V-BE-071-084, fixer round 1, 2026-11-13), criterion 2:** the same test file, rewritten. The room is now opened and closed by the data plane's room host, in process over the in-memory stores: `RoomHost.acquire` loads it from storage (record, checkpoint at 0, empty log, permissions) as a first channel does, and `HostedRoom.closeIdle` closes it as the idle close does (stop, release ownership, removed from the host; the test checks the host no longer holds it). The stored checkpoint is in the heap before the room opens and is not counted. No reference to the room is kept by the test after the close. Heap is `heapUsed` after two forced collections, Node.js test worker on this development machine (not the reference machine), `pnpm vitest run --project node --silent=false` on that file, two runs with the same figures to 0.02 MiB. Printed records (MiB; resident, returned, host estimate `estimatedBytes`): short (10 paragraphs) 0.40, 0.04, 0.00; about 20 pages (200) 0.55, 0.52, 0.08; about 100 pages (1,000) 2.54, 2.50, 0.38; near 16 MiB (41,186 paragraphs, 15.48 MiB JSON) 102.66, 102.48, 15.48. The test asserts that, for every room of 1 MiB resident or more, the returned figure is positive and at least 90 per cent of the resident one. The short room's low return is the first open on the plane (one-time module and metric state), not the room: it is too small to read above that.

**Notes:** Time box: three days. Unmeasured in the spec (06 §10, §16). Lane V-BE-071-084 (round 2): criterion 1 stays open: the figures cover the room's own state (durable and tentative documents, indexes) over an empty log; position maps and per-commit state exist only after commits, and no commits were applied in this measurement, and the room host and channels are not included. Criterion 3 (a budget and rooms per node) and criterion 4 (SPK-025 quotes them) stay open: the figures are a first reading on a development machine and do not support a recommendation for the reference machine. The retained share reported in round 2 was a test artefact (fixer round 1): closed through the room host, a room returns nearly all it held. The host's estimate (`estimatedBytes`, the JSON size, used by the BE-021 budget) is about one sixth of the heap figure for the larger rooms (2.54 against 0.38; 102.66 against 15.48 MiB); whether the budget should use a factor is a decision for BE-021, not made here. Phase inferred: the cost sheet is phase 0, but a measurement needs a running room. Lane w5, 2026-11-17: no criterion newly ticked (blocked). Criterion 1 asks for the figures with durable and tentative states, indexes and position maps; the test above measures an empty log with no channel and no commits, and position maps exist only after commits are applied. Adding commits would need a channel path that the test does not yet drive; it was not built in this round. Criteria 3 and 4 need a measurement that supports a recommendation for the reference machine (SPK-025 quotes it), and the figures here are from a development machine. Nothing was changed in the measurement.

### BE-085 Meter the cost drivers per tenant

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | should | Operator |

**Spec:** 06 §10, §11; review PD-6 · **Requirements:** R9, R15 · **Depends on:** BE-086

As an operator, I want per-tenant counters for the things that cost money, so that the unit-cost sheet and the quotas work from data.

**Acceptance criteria**

- [x] Given a tenant, when it works, then counters exist for commits and log bytes, payload bytes, checkpoints written and their bytes, open-room time and memory, connection time, preview compiles and final compiles with their compile minutes, and stored bytes by kind.
- [x] Given the counters, when metrics are scraped, then they carry the tenant label and no document content.
- [ ] Given the quotas of BE-091 and BE-092, when they are evaluated, then they read these counters.
- [ ] Given usage figures are requested by an administrator UX-076, when they are read, then they come from these counters.

**Evidence:** Criterion 1, compile minutes (lane V-BE-085-098, memory storage): `services/document-service/test/control-plane/be-085-compile-meter.test.ts` checks that a settled export's `docedit_tenant_compile_seconds_total` (at least the compile time) and `docedit_tenant_final_compiles_total` (one) are in a scrape with the tenant label. Criterion 1 stays unticked for the other drivers (log bytes as a counter of their own, stored bytes of exports). `services/document-service/src/control-plane/metrics.test.ts` (criterion 2): a commit metered through `meteredLogs` and an added checkpoint are scraped with `Metrics.render()`; every tenant sample carries `tenant="..."` and only the `kind` label besides it, and neither the commit's marker text nor the document identifier appears in the scrape.

**Evidence (lane w5, 2026-11-17):** criterion 1, the rest of the drivers. `services/document-service/src/control-plane/metrics.test.ts` ("counts the whole commit as log bytes"): `docedit_tenant_log_bytes_total` is the UTF-8 size of the whole stored commit as JSON, larger than `docedit_tenant_payload_bytes_total` (the steps alone). `services/document-service/test/control-plane/be-085-drivers.test.ts` (memory storage, in-process service over HTTP, scraped from `/metrics`): a preview counts in `docedit_tenant_preview_compiles_total` and not in the final counter, a final export then counts in `docedit_tenant_final_compiles_total`, the compile seconds carry the job `kind`, and the export output bytes are in `docedit_tenant_stored_bytes_total{kind="export"}` (13 per output, 26 after two). With the earlier tests: commits, payload bytes, checkpoints and their bytes and stored bytes of kind `checkpoint` (`metrics.test.ts`), compile seconds and final compiles (`be-085-compile-meter.test.ts`), open-room time and connection time (`test/data-plane/be-085-open-time.test.ts`), and the estimated memory of open rooms per tenant (`dep_room_memory_bytes`, `test/data-plane/be-021-memory-budget.test.ts`). `src/server.ts` passes the meter to `ObjectAssetStore` (`src/objects/checkpoints.ts`), which counts export outputs (`kind="export"`) and sealed PDFs (`kind="sealed"`).

**Notes:** Lane w5 (2026-11-17): criterion 1 is ticked. Reading of the words, not decided by the owner: "log bytes" is the whole stored commit as JSON and "payload bytes" its steps; "memory" is the existing per-tenant gauge of the room's estimated size (a gauge, because memory is held, not consumed; 06 §10 calls it unmeasured, so it is an estimate); the `asset` and `sealed` kinds of stored bytes are written by the code but have no test of their own here. Criteria 3 and 4 stay open. 3: the quotas read their own state, not these counters (the compile budget is a ledger in `exp-009-compile-budget.ts`, the others are the quota source of BE-091), and the counters are cumulative since the process started while a quota period is a month, so reading them would need a durable, period-bound meter first; BE-092 criterion 5 (the storage quota) is not built either. 4: no administration usage route exists (UX-076 has the contract only), and the counters are per process and lost on restart, so a usage figure from them would not survive a deployment. `TenantMeter.read` is the reader both would use. The unit-cost sheet itself is SPK-025. Phase inferred: cost instrumentation accompanies the stage 1 deployment. Packet C (2026-11-13): criterion 1 stays open: the meter counts commits, payload bytes, checkpoints and their bytes, and stored checkpoint bytes, but no counter exists for open-room time or memory or for connection time (`DRIVERS` in `metrics.ts` has none), and the compile-seconds counter is not checked by a test here. Criterion 3 stays open: the quotas of BE-091 and BE-092 are not built. Criterion 4 stays open: UX-076 is not built. Lane BE-079-091 (2026-11-13): the open-room time and the connection time now exist in the data plane's registry, `dep_room_open_seconds_total` (`room-host.ts`, counted when the room finishes) and `dep_connection_seconds_total` (`session.ts`, counted when the socket ends), per tenant, tested in `services/document-service/test/data-plane/be-085-open-time.test.ts` (wall-clock bounds). Decision (spec silent): a connection that never sent `hello` has no tenant and is not counted. Criterion 1 stays open: the memory per open room is the existing gauge `dep_room_memory_max_bytes` (a maximum, not a total), the "log bytes" counter is not separate from the payload bytes, the compile-minutes counter is not checked by a test, and the stored-bytes kinds of exports are not checked. Side effect for the owner of `src/data-plane/metrics.test.ts`: its check at line 175 (every declared metric is written) now lists `dep_connection_seconds_total`, because that test never closes an identified connection; that test is not changed here.

### BE-086 Emit metrics per node and per tenant

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 06 §11 · **Requirements:** R9, R15 · **Depends on:** BE-001

As an operator, I want the metrics of 06 §11 per node and per tenant, so that I can see the system's health and bill and limit tenants.

**Acceptance criteria**

- [x] Given a running node, when metrics are scraped, then they include acknowledgement latency, persist batch size and latency, rebase rate, rejections by code, open rooms, memory per room, send-queue depth, catch-up sizes, cold-open time, export queue depth and compile time.
- [x] Given a metric that is per tenant, when it is scraped, then it carries the tenant label as well as the node.
- [x] Given rejections, when they are counted, then the label is the code of the registry PRO-038.
- [x] Given any metric, when its labels and values are inspected, then none holds document text, field values or tokens.

**Evidence:** Criteria 3 and 4 (lane BE-079-091, round 6): `services/document-service/src/data-plane/metrics-registry.test.ts`: "finds every rejection code the authority answers with in the registry PRO-038" (each key of `DEFAULT_ACTION` is in `definition.ERROR_CODES`), "labels the rejections a data plane counts with codes of the registry" (the `code` labels of `dep_rejections_total` are registry codes), and "keeps document text and a rejected commit text out of every label and value" (canary text in an accepted commit and in a rejected one is absent from the scrape, no `eyJ` token appears, and every label value except the histogram bound `le` is an identifier or a code). Criterion 2: `services/document-service/src/data-plane/metrics.test.ts`, "per-tenant metrics from the call sites": a data plane over in-memory ports, driven by WebSocket clients, writes every metric it declares from its own call sites (cold open, commits, a rebase, a rejection, a failed log write, a resume, connection rate limits, a failed and a written checkpoint, an outbox item, a fenced and an idle room close, the room and session gauges, and a slow consumer); every series of each scrape carries `node` and the tenant, no tenant label is empty, and a check against the registry's `# TYPE` lines finds no declared metric left unwritten. Code: `room-host.ts` (`roomsClosed` and `dep_room_memory_max_bytes` per tenant), `session.ts` (`slowConsumers` from the channel's identity), `index.ts` (`dep_connections`, `dep_send_queue_bytes` per tenant), `metrics.ts` (an empty tenant label is refused). Criterion 1 (lane BE-079-091, round 10): `services/document-service/test/control-plane/be-086-scrape.test.ts` declares the families of 06 §11 on a running node, and `services/document-service/test/control-plane/be-086-compile-scrape.test.ts` runs one export job that compiles (a stand-in compile handler) and scrapes `/metrics`: every listed family is declared, `docedit_tenant_compile_seconds_total` among them, carrying the tenant label, and the scrape holds no document text. The export queue depth is read as `docedit_jobs` (queued and running jobs by kind), and the catch-up and rebase families are declared without traffic in that scrape. Criterion 2 (lane V-BE-085-098, round 3): `services/document-service/src/control-plane/metrics.ts` takes the node as a base label (`new Metrics({ node })` in `src/server.ts`), so every control-plane series carries `node`; `src/control-plane/be-086-node-label.test.ts` (unit) and `services/document-service/test/control-plane/be-086-tenant-node-label.test.ts` (a running node over a real WebSocket, memory storage, Node.js) check that every series with a tenant label has the node label too.
**Notes:** Criterion 2 was unticked by review (group 1, round 2) and re-ticked in the fix round: the call sites now label the tenant and the test drives them. Decision (spec silent, listed for review): before `hello` no tenant is known, so address rate limits and the share of sessions not yet identified are series with the node label only; no series is given an empty or invented tenant. Phase inferred: the 1b load and fault tests read these metrics. Criterion 1 is not ticked: the list of 06 §11 is not complete in `metrics.ts` (export queue depth and compile time belong to other packets). Round 7 (lane BE-079-091): the names exist across the registries (`dep_*` in the data plane, joined into the node's `/metrics` by `server.ts`, and `docedit_jobs` and `docedit_tenant_compile_seconds_total` in the control plane), but no test yet scrapes a running node with traffic (commits, a rebase, a rejection, a catch-up, a compile) to see each family carry a sample; the harness's `realDataPlane` option now allows that test. Criteria 3 and 4 ticked in round 6 by `metrics-registry.test.ts`. Round 9 (lane BE-079-091): `services/document-service/test/control-plane/be-086-scrape.test.ts` runs the full service with the real data plane and the metrics token, drives a cold open, a commit and a rejection over a WebSocket, and scrapes `/metrics`: every listed family except the compile time is declared, and the data plane's cold-open, ack-latency and rejection series carry the node label. Criterion 1 stays unticked: `docedit_tenant_compile_seconds_total` is declared in a scrape only after a compile, which the test does not run; the catch-up and rebase series have no traffic in that test (their call sites are in `src/data-plane/metrics.test.ts`). Round 10 (lane BE-079-091): the compile family is declared in `be-086-compile-scrape.test.ts` after an export job, so criterion 1 is ticked on declared families; the samples of the catch-up and rebase families are not in that scrape. Evidence audit (2026-11-13): criterion 2 unticked, because only the data plane's `dep_*` registry (`new Metrics(node)`) puts the node label on its series, while the control plane's per-tenant series (`docedit_tenant_*` including `docedit_tenant_compile_seconds_total`, `new Metrics()` in `server.ts`) carry the tenant but no node label, and no test checks them for it.

### BE-087 Trace requests across REST, rooms and jobs

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | should | Operator |

**Spec:** 06 §11; 05 §5.1 (`traceparent`), §6.1 · **Requirements:** R9 · **Depends on:** BE-032, BE-039, BE-049

As an operator, I want one trace to follow a request from the REST call through the room to the job, so that I can find where time went.

**Acceptance criteria**

- [x] Given a REST request with `traceparent`, when it is handled, then the response carries a request identifier and the trace continues in the handler.
- [x] Given a `hello` with `traceparent`, when it is accepted, then room operations for that session carry the trace.
- [x] Given a restore requested over REST, when it passes through the outbox, the room and a checkpoint, then the spans appear under one trace.
- [x] Given a job is queued by a request, when a worker runs it, then the job's spans belong to the request's trace.

**Evidence:** `services/document-service/src/data-plane/trace.test.ts` (round 5): "makes the session, its channel and its commits spans of the hello trace" (a `hello` with `traceparent` gives the session span the caller's parent, and the channel and commit spans the same trace, with no typed text in the attributes); "starts a trace of its own when hello carries no traceparent". Criterion 1, handler half (lane BE-079-091, round 12): `services/document-service/src/control-plane/be-087-handler-trace.test.ts` runs the real pipeline on a public route with a probe handler: the handler gets `ctx.trace` (the request span's trace and span identifiers, `Ctx.trace` in `src/control-plane/pipeline.ts`), and a span it opens with it has the caller's trace and the request span as parent; without `traceparent` the request and handler share a new trace. `services/document-service/test/control-plane/be-087-rest-trace.test.ts` shows the response's request identifier. Criteria 3 and 4 (lane V-BE-085-098, round 3): `services/document-service/test/control-plane/be-087-restore-trace.test.ts` (full service, real data plane, memory storage, a WebSocket commit, then `POST .../restore` with `traceparent`): the `http.request` span and the `dep.outbox` and `dep.checkpoint` spans of the restore are in the caller's trace (the restore passes the request's span to `replaceContent` as a `traceparent`, `src/control-plane/restore-route.ts`; the outbox keeps it in the item request). `services/document-service/test/control-plane/be-087-job-trace.test.ts` (an export request with `traceparent`, a stand-in compile handler): the `job.run` span is in the caller's trace and its parent is the request span (the export route puts the request's trace in the job payload, `src/control-plane/export-routes.ts`; `JobRunner` records the span with the `tracer` option, `src/control-plane/jobs/runner.ts`, wired in `src/server.ts`). Both Node.js with memory storage; not run against PostgreSQL.

**Notes:** Phase inferred: tracing accompanies the stage 1 deployment. Open after round 5 (2026-11-13): criteria 1 (REST, control plane), 3 (restore through the outbox and a checkpoint) and 4 (jobs, control plane) are outside the data plane and are not tested here. Round 6 (lane BE-079-091, 2026-11-13): `services/document-service/test/control-plane/be-087-rest-trace.test.ts` shows the request half of criterion 1: the response carries a `DEP-Request-Id`, and the `http.request` span has the caller's trace and parent (and a fresh trace without `traceparent`). Criterion 1 stays unticked: `Ctx` in `src/control-plane/pipeline.ts` carries no span or trace, so spans a REST handler opens are not under the request's trace. Criteria 3 and 4 stay open (outside the data plane). Round 12 (lane BE-079-091): criterion 1 ticked; the gap named above is closed by `Ctx.trace`, which a REST handler uses as the parent of its spans. Criterion 3 (the restore's outbox, room and checkpoint spans) and criterion 4 (job spans under the request's trace, which needs the job to carry the `traceparent`) stay open: no test drives a restore or a queued job through the traced path. Round 3 (lane V-BE-085-098): criteria 3 and 4 ticked by the two tests named in Evidence. Decisions (spec silent; for review): the job carries its trace in its payload (`traceparent`, no schema change, so the job row is unchanged), and the span a worker records is `job.run` (the handler opens no spans of its own, so the job's spans are that one span); the trace is visible to a caller who reads the job, as the payload is returned to the tenant. The room's own commit span (`dep.commit`) is not part of a restore, which is a snapshot apply; the checkpoint span (`dep.checkpoint`) is written by a worker after the restore is acknowledged, so the test waits for it.

### BE-088 Write structured logs without content or tokens

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 06 §11; 10 §3.7 · **Requirements:** R10 · **Depends on:** BE-001

As a maintainer, I want logs that carry identifiers and never content, so that support can read them without reading customers' documents.

**Acceptance criteria**

- [x] Given any log line, when it is written, then it is structured and carries tenant, document and session identifiers where they apply.
- [x] Given document text, comment bodies, field values, filenames, tokens, service credentials, webhook secrets and signed-URL signatures, when they pass through the service, then none appears in any log line.
- [x] Given a parse or validation error, when it is logged, then the message names the position and rule, not the offending text.
- [x] Given access logs, when a request has an `Authorization` header or a signed URL, then the header and the query signature are redacted.

**Evidence:** `services/document-service/src/log.ts` (fixed members only, query values dropped, errors by name and stack frames), used by the pipeline's access log and by the data plane's `onError` (`src/server.ts`). Criterion 3 (lane V-BE-085-098, round 3): `violationSummary` in `src/log.ts` writes the path and rule of each violation (a parse error is `(body): valid JSON (RFC 8259)`; a key the client chose is written as `(key)`), and the pipeline puts it in the `message` of the access line (`src/control-plane/pipeline.ts`); `services/document-service/test/control-plane/be-088-rule-log.test.ts` runs the real service over HTTP and reads the 400 access lines (Node.js, memory storage). `services/document-service/test/control-plane/logs.test.ts` sends canaries in document text, title, properties (a file name among them), a query signature, a forged bearer token and a `sub`, with a real API key and a minted token: no line holds any of them; every line is JSON with an event, access lines a request identifier and the tenant and document; validation errors name the pointer and the rule.

**Evidence (lane w5, 2026-11-15, criterion 1):** `onError` of the data plane takes a third argument, `ErrorContext` (`tenant`, `doc`, `session`; `services/document-service/src/seams.ts`). A session reports with its identifier, its tenant once `hello` is accepted and the document of the channel (`#report` in `src/data-plane/session.ts`); a room reports with its tenant and document, and with the session where the error belongs to one channel (`#report` in `src/data-plane/room-host.ts`); room loads, refreshes, REST reads and the outbox name the tenant and document. `src/server.ts` writes these members on the `data-plane.error` line. The three webhook lines now carry the tenant (`src/control-plane/webhook-dispatcher.ts`, `webhook-composition.ts`). `services/document-service/test/control-plane/be-088-w5-data-plane-context.test.ts` runs the real service with the real data plane over a WebSocket (Node.js, memory storage; `pnpm exec vitest run --project node` on that file, 1 of 1 passes): a permission store that fails during `ch.open` gives one line with the tenant, the document and the session of `welcome`; a log store that fails while a room loads gives a line with the tenant and the document and no session; every line is JSON with `time`, `level` and `event`; the injected error text is in no line.

**Notes:** SEC-047 proves this with canary strings. Phase inferred: logs must be free of content from the first deployment. Evidence audit (2026-11-13): criterion 1 unticked, because no log call in the service passes a `session` member (the data plane's `data-plane.error` line in `server.ts` carries only `message` and the error name, with no tenant, document or session member) and `logs.test.ts` only feeds `session: 's'` to `createLogger` by hand and runs the REST path over a `StubDataPlane`. Criterion 3 unticked, because the log line of a rejected request holds only `code: validation_failed` (the position and rule are in the response body, not the log) and no test asserts a logged position or rule; only absence of the canary text is tested. Round 3 (lane V-BE-085-098): criterion 3 ticked, the access line of a refused request now names the position and rule (see Evidence). Criterion 1 stays unticked: the data plane's error lines (`data-plane.error` in `src/server.ts`, fed by `onError` from about thirty call sites in `src/data-plane/`) carry no tenant, document or session member, and no session member is logged anywhere; giving them one needs `onError` to take the context of each call, a change across the data plane's files (not made in this round). Lane w5 (2026-11-15): that change is made and criterion 1 is ticked (see Evidence). Lines that belong to no single tenant keep no identifier, which is what "where they apply" allows: the service's start and stop, the scheduler and the autoscaler, the node lease, skipped tenant files, and a failed audit flush (one batch may hold entries of several tenants). A room failing to load is logged by the room host, which serves every session of the document, so that line names no session; the session that asked is answered `unavailable`. The reviewer may untick the criterion if such a line should also name the asking session.

### BE-089 Debug a broken document without reading it

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Operator |

**Spec:** 06 §11 · **Requirements:** R9, R10 · **Depends on:** BE-081

As an operator, I want a structural dump in which text is replaced by filler of the same length, so that I can reproduce a failure without reading the customer's text.

**Acceptance criteria**

- [x] Given a document's checkpoint and log, when the dump tool runs, then every text run is replaced by filler of the same length, and the dumped log still replays to a document with the same structure.
- [x] Given the dump, when it is searched for any text run of the source, then none is found.
- [x] Given the tool is run, when the audit trail is read, then the run is recorded with the operator's identity and the document, and logs hold no content.
- [x] Given the tool is run against a document of a tenant the operator is not assigned, when it starts, then it refuses.

**Evidence:** Criteria 3 and 4 (re-ticked in the review fix, H group 1 round 2, after being unticked for lack of a tool): the command `services/document-service/src/data-plane/structural-dump-cli.ts` (PostgreSQL log and checkpoint index, S3 checkpoints, PostgreSQL audit trail; operator = the operating-system account; assignments from the file named by `DOCEDIT_OPERATOR_ASSIGNMENTS`, `operator-assignments.ts`) over `structural-dump-tool.ts` (`runDumpTool`, `readDumpSource`). `services/document-service/test/data-plane/be-089-dump-tool.test.ts`: "structural-dump-cli.ts against PostgreSQL" runs the command line as a child process against PostgreSQL and the S3-compatible store: not assigned, it exits 3 with no dump and no audit event; assigned, the audit trail holds one `document.structural_dump` event with `operator:<account>` and the document, and no canary text is in the event, the log lines (standard error) or the dump. Over the memory stores: the log lines and the audit event hold no canary; a refused run (unassigned tenant, unlisted operator, unreadable identity, usage error) reads nothing from the log store; a tenant the operator is assigned to does not reach another tenant's document. Criteria 1 and 2: `services/document-service/src/data-plane/structural-dump.ts` (`dumpStructure`, `fillTextRuns`, `containsSourceRun`, `runStructuralDump`), tested in `services/document-service/src/data-plane/be-089-structural-dump.test.ts` (lane BE-079-091, round 6): "replaces every text run by filler of its length, replays to the same structure, and leaves no run of the source" (three commits written through the data plane, then the dump built from the stores alone: every text value of the dump is filler of the source's length, no source text occurs in the dump, the dumped steps replay to the source structure with the filler, and the audit event names the operator, the document and counts only); "refuses a document of a tenant the operator is not assigned to, before reading it"; the property test "keeps the length of every run and leaves no source run in the dump" (300 generated documents).

**Notes:** The spec replaces text runs only. Round 6 (lane BE-079-091, 2026-11-13): criteria 1 to 4 were ticked on the module level; review unticked 3 and 4, which describe running the tool as an assigned operator. The review fix (H group 1, round 2) built the command line, its PostgreSQL read path and an assignment source, and re-ticked them. The operator identity (the operating-system account) and the assignment file are decisions the spec leaves open: proposed in docs/adr/0245-lane-BE-079-091.md decision 7, for the owner to confirm (a PostgreSQL table or single sign-on groups are the alternatives). A refused run is logged, not written to the tenant's audit trail. No `pnpm` script runs the command (package.json is not changed here); it is run with `node src/data-plane/structural-dump-cli.ts`. Attributes that can hold user text (field values, alt text, region titles, link targets, `latex`) are not text runs and are not replaced; this stays the open question of the story, and the dump is not yet safe for those attributes. Decisions (spec silent, see docs/adr/0245-lane-BE-079-091.md): filler is one repeated code unit chosen to occur in no source text; lengths are in code units. Phase inferred: support tooling is not placed in the roadmap; it is needed once customers' documents are in production.

### BE-090 Repair a broken document with an audited commit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Operator |

**Spec:** 06 §11; 04 §10; 07 §11 · **Requirements:** R4, R9 · **Depends on:** BE-081, BE-039, BE-089

As an operator, I want a documented repair procedure that ends in an ordinary, attributable commit, so that fixing a document leaves the history intact.

**Acceptance criteria**

- [x] Given a document that BE-081 shows to be broken, when the operator follows the procedure, then the repair ends in a server-authored commit with origin `repair` delivered through the outbox.
- [x] Given a repair commit, when it is applied, then it passes the same authority checks as any commit, and one that would change an approved region is refused until the region's state is changed PRM-046, PRM-047.
- [x] Given the repair, when the audit trail is read, then it names the operator, the document and the reason, and the hash chain continues unbroken.
- [x] Given a dry run, when it is requested, then it shows the change the repair would make without storing it.
- [x] Given the procedure document, when it is rehearsed on a deliberately damaged test document, then it succeeds.

**Evidence:** Lane U-BE-085-098 (2026-11-13), PostgreSQL and the S3-compatible store in Podman. `services/document-service/src/data-plane/repair.ts` (`planRepair`, `enqueueRepair`) and `services/document-service/test/data-plane/be-090-repair.pg.test.ts` (2 tests). A checkpoint at seq 2 is written with the content of seq 0, and BE-081's `verifyCheckpoint` shows it differs. Criterion 1: the dry run plans from checkpoint 0, the snapshot item is enqueued and delivered by `OutboxDelivery` into the running room, and commit 4 is stored with origin `repair` and user `system`, its content at the head equal to the planned hash. Criterion 3: the chain verifies after the repair, and the audit trail holds `repair.enqueued` with the operator as actor, the document and the reason. Criterion 4: the dry run changes no log head and no outbox item, and `enqueueRepair` refuses a plan that changes nothing (a sound document, same test file). Procedure: `services/document-service/docs/repair-procedure.md`.

**Evidence (lane w5, 2026-11-17, criteria 2 and 5):** Criterion 2: `services/document-service/test/data-plane/be-090-w5-approved-region.test.ts` (Node.js, `pnpm exec vitest run --project node` on that file, 1 of 1 passes on this machine; real data plane over the in-memory stores). A document has an edit in the Terms region and one in the introduction; a checkpoint at seq 2 is written with the content of seq 0; a second node opens it, so its room holds content without both edits; the Terms region is approved. The plan (head 3, from checkpoint 0, `changes` true) is enqueued and delivered: the item settles `failed` with `forbidden` and the message `region:rTerms000000000A: needs edit in the region (P1)`, the log head does not move and no commit has origin `repair`. The region is set back to `in_review`; the same procedure (new plan, item, delivery) settles `done` with `seq` the head plus one, the commit has origin `repair` and user `system`, the content hashes to the plan's target, and the audit trail holds both `repair.enqueued` events with the operator. The refusal is the room's own check of a snapshot commit (`room.ts`, `snapshot`, 07 §11), so a repair needs no check of its own. Criterion 5: `services/document-service/test/data-plane/be-090-w5-rehearsal.pg.test.ts` (1 of 1 passes on this machine against PostgreSQL 17.11 and the S3-compatible store in Podman, `docedit-test-postgres` and `docedit-test-s3`, in a database of its own that the test drops) does each numbered step of `services/document-service/docs/repair-procedure.md` on a damaged document (the same damage, with the Terms region approved), including the room's refusal and the success after the region's state is changed, checks that the document still has exactly six numbered steps, and writes `services/document-service/test/postgres/rehearsals/be-090-repair.json` with each step, its outcome and the time (8 records, `allPassed` true; the form of SEC-048's record).

**Notes:** Lane w5 (2026-11-17): criteria 2 and 5 are ticked on the evidence above. Criterion 5 is a rehearsal run by a test that follows the written steps and records them, the same form SEC-048 uses for its rotation procedure; no person has followed the document at a terminal, and the record says `not an operator at a terminal`. If the owner wants a rehearsal by a person, that is a separate sign-off and criterion 5 should be reopened. The procedure document now says the room refuses a repair that would change an approved region and that the region's owners, not the operator, change the state. Phase inferred: as BE-089. Lane U-BE-085-098 (2026-11-13): criterion 2 stays open: the repair goes through the room's apply path as any outbox item (BE-039 tests the preconditions), but no test puts a region under approval and checks that a snapshot which would change it is refused. Criterion 5 stays open: the test runs the functions the procedure names, but no operator has followed the written procedure; the procedure's approved-region check is manual. The plan refuses a replay across a snapshot above the checkpoint (repair by hand). Lane V-BE-085-098 (2026-11-13) reviewed criterion 2 and left it open: a repair's target is the content the log replays to at the head, which equals the room's content for a sound log, so a repair changes an approved region only when the log and the room disagree. No test puts such a snapshot item against an approved region; the approved-refusal tests (`src/data-plane/pro-053-approved-refusal.test.ts`) cover commits. Decision (spec silent; proposed in `docs/adr/0338-lane-U-BE-085-098.md`): the repair content is the content the log replays to from the newest checkpoint that verifies, so a damaged checkpoint is skipped and history is not rewritten; the operator's reason is kept in the audit trail, not in the commit. Phase inferred: as BE-089.

## Tenancy and quotas

### BE-091 Enforce live-use quotas per tenant

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | should | Operator |

**Spec:** 06 §12; 05 §5.8 · **Requirements:** R10 · **Depends on:** BE-085, BE-030, UX-076

As an operator, I want per-tenant limits on connections, open documents, commit rate and room CPU, so that one tenant cannot take capacity from the others.

**Acceptance criteria**

- [x] Given a tenant has quotas for connections, open documents, commit rate and CPU budget in rooms, when a quota is exceeded, then the request is answered with `quota_exceeded` and a retry delay (`retryAfterMs` on the socket, `Retry-After` on REST).
- [ ] Given one tenant is at its quota, when another tenant works, then the other's acknowledgement latency is unchanged.
- [x] Given a quota is changed through the administration API, when the next request arrives, then the new value applies.
- [x] Given a quota is exceeded, when the event is counted, then the tenant and the quota appear in the metrics of BE-086.

**Evidence:** Lane V-BE-085-098 (2026-11-13), criterion 4 on a running node, memory storage, real data plane: `services/document-service/test/control-plane/be-091-node-quota.test.ts` (2 tests, run with `pnpm exec vitest run <file>`). A hello over the connection quota is answered `quota_exceeded` with `retryAfterMs`, and a released connection admits the next session; a commit over the commit-rate quota is answered `sync.reject` `quota_exceeded` with `retryAfterMs` and is not submitted; a raised quota applies at the next commit; the node's `/metrics` scrape carries `docedit_tenant_quota_refusals_total` with the tenant and `quota="commitRate"`. Wiring: `src/data-plane/session.ts` (`LiveQuotaGate`, the hello admission, `#commitRefused`), `src/data-plane/index.ts`, `src/seams.ts`, `src/server.ts` (`LiveQuotas` composed when `parts.quotas` is set). The windows are settings of this lane (`LIVE_QUOTA_WINDOW_MS`, `LIVE_QUOTA_COUNT_RETRY_MS`), not spec figures; see `docs/adr/0338-lane-V-BE-085-098.md`. Criteria 1 to 3 stay open: the open-documents and CPU quotas and the REST `Retry-After` are not wired, the administration API (UX-076) is not built, and criterion 2 is a latency measurement not made. **Evidence (lane w5, 2026-11-17):** criteria 1 and 3, on the composed node with the real data plane, values written through `PUT /v1/quotas` (memory, and PostgreSQL in Podman): `services/document-service/test/control-plane/be-091-composed-quotas.test.ts` (9 tests, `pnpm exec vitest run --project node <file>`, all passed). A connection quota written through the API refuses the next `hello` with `quota_exceeded` and `retryAfterMs`, and a raised one admits the hello after; a `ch.open` over the open-documents quota is answered with an `error` `quota_exceeded` and `retryAfterMs` (a second session on the same document is not counted twice; the document stops counting when its sessions end); a spent room CPU budget (`roomCpuBudget` 0) answers a commit with `sync.reject` `rate_limited`, action `retry`, `retryAfterMs`, and a raised budget admits it; `PUT /documents/{id}/content` over the commit-rate quota is 429 with `quota_exceeded`, `Retry-After` of whole seconds at least 1 (`checkProblem` finds no violation on either surface). Unit tests of the gate: `services/document-service/src/control-plane/be-091-live-quotas.test.ts` (open documents by channel, CPU budget). Wiring: `data-plane/session.ts` (`#openChannel`, `#commitRefused`, `#submit`, `#hello`), `control-plane/live-quota-rest.ts`, `control-plane/quota-admin.ts` (`CachedQuotaSource`), `server.ts`; the choices are in `docs/adr/0370-w5-BE-091-quota-cache.md` (proposed). Criterion 2 measurement (one Node.js process, memory storage, loopback, a development machine, 40 commits each): the median acknowledgement of the second tenant was 4.42 ms idle and 6.46 ms while the first tenant was refused in a loop. Earlier: partial, criterion 4 unticked by review (group 1, round 7). `services/document-service/src/control-plane/be-091-refusal-scrape.test.ts` (round 11, lane BE-079-091) renders a standalone control-plane `Metrics` registry, fed by a test-built `LiveQuotas`, and finds `docedit_tenant_quota_refusals_total` samples with `tenant`, `quota` and `code` labels (counts 2 and 1); another tenant without a refusal has no sample. It does not scrape a node: `server.ts` does not construct `LiveQuotas` and nothing outside the tests imports `live-quotas.ts`, so no running node counts a refusal.

**Notes:** 04 §12 says a spent per-connection or per-tenant CPU budget is `rate_limited`; 06 §12 says exceeding the CPU quota is `quota_exceeded` (see Open questions). Quota defaults are not in the spec. Phase inferred: the administration API is phase 2 (13 §12) and quotas are set through it. Round 6 (lane BE-079-091, 2026-11-13): `services/document-service/src/control-plane/live-quotas.ts` decides admission per tenant for connections, open documents, commit rate and the room CPU budget, tested in `services/document-service/src/control-plane/be-091-live-quotas.test.ts` (nine tests, property tests among them). No criterion is ticked: the answers on the socket and REST (`retryAfterMs`, `Retry-After`) are not wired to the decisions, the administration API (UX-076) does not write the values, and the refusals are counted in the control-plane registry, not in the data plane's registry of BE-086. Decisions (spec silent, see docs/adr/0245-lane-BE-079-091.md): the commit rate and the CPU budget use a sliding window (`windowMs`, no figure set), and the retry delay of a count quota is supplied by the caller. The CPU refusal is `rate_limited` with action `retry`, as 06 §12 states for the CPU budget, not `quota_exceeded`. Round 11 (lane BE-079-091): criterion 4 was ticked on a rendered standalone registry; unticked by review (group 1, round 7) because `LiveQuotas` is not constructed by `server.ts` or imported by any product code, so no running node's `/metrics` can show a quota refusal. It can be ticked once the gate is wired into the node and a scrape of that node shows the sample. Criteria 1 to 3 stay open: the socket and REST answers are not wired, the administration API (UX-076) is not built, and no test measures the latency of criterion 2 (the isolation of the decisions themselves is tested in `be-091-live-quotas.test.ts`). Lane w5 (2026-11-17): criteria 1 and 3 ticked (see Evidence). In criterion 1 the CPU budget is answered `rate_limited` with action `retry`, not `quota_exceeded`: 06 §12 makes that one exception and ADR 0245 follows it; the other three quotas are `quota_exceeded`. An open-documents refusal is an `error` reply to `ch.open` because `ch.rejected` has no such code (ADR 0370). The quotas are counted per node, and a change written through another node is seen within the cache time (ADR 0370, proposed). Criterion 2 stays unticked: the one measurement here shows the second tenant's median acknowledgement 2 ms higher while the first was refused in a loop, because both share one event loop; it is not "unchanged", and a measurement on a dedicated runner with a separate process per tenant load is not made.

### BE-092 Enforce storage and export quotas per tenant

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | should | Operator |

**Spec:** 06 §12; 09 §9.1 · **Requirements:** R5, R10 · **Depends on:** BE-085, BE-050

As an operator, I want per-tenant limits on storage, export concurrency and export minutes, so that exports and files stay inside what each tenant has bought.

**Acceptance criteria**

- [ ] Given a tenant's storage quota is reached, when it uploads an asset or an import, then the request is answered with `quota_exceeded`.
- [x] Given a tenant's monthly budget of compile minutes is spent, when it requests an export, then the answer is `quota_exceeded` with `Retry-After` until the next period.
- [x] Given a tenant is at its export concurrency limit, when it requests another export, then the behaviour (queue or `quota_exceeded`) is the one recorded in the Open questions decision, and no other tenant is affected.
- [x] Given jobs already running when a quota is reached, when they finish, then they are not killed.
- [ ] Given usage figures, when an administrator reads them, then they match the counters of BE-085.

**Evidence:** Lane V-BE-085-098 (2026-11-13), memory storage, in-process service over HTTP. `services/document-service/test/control-plane/be-092-compile-budget.test.ts` (2 tests, run with `pnpm exec vitest run <file>`): criterion 2, a spent budget answers `429` with `quota_exceeded` and `Retry-After` between the seconds to the next UTC month at the request's start and end; criterion 4, a compile running when the budget is set to zero completes and is not killed, and the next request is refused. Criterion 3 is not ticked: the code queues an export at the concurrency limit (`queue.ts`, `defaultLimit`), while the proposed decision in `docs/adr/0246-lane-BE-092-098.md` says `quota_exceeded`; the two differ and the owner must decide. Criterion 1 is not built (no storage quota check on upload). Criterion 5 is not ticked: the administrator read (UX-076) is not built.

**Evidence (lane w5, 2026-11-17):** criterion 3, with the quota written through `PUT /v1/quotas`: `services/document-service/test/control-plane/be-092-composed-quotas.test.ts` (5 tests, memory and PostgreSQL in Podman, `pnpm exec vitest run --project node <file>`, all passed). A tenant with `exportConcurrency` 1 and one export queued or running is answered 429 `quota_exceeded` with `Retry-After` (`checkProblem` finds no violation) and nothing is queued; the job already there is not killed and completes; the next export is admitted once it has; a second tenant with no quota has both its exports admitted while the first is refused. The behaviour is the proposed decision 1 of `docs/adr/0246-lane-BE-092-098.md`, recorded again in `docs/adr/0371-w5-BE-092-storage-and-concurrency.md`. Criterion 1, the asset half, in the same file: an upload over `storage` is 429 `quota_exceeded` with `Retry-After`, a raised quota applies to the next upload (`assets.ts` `storedBytes`, `live-quota-rest.ts` `admitStorage`, `asset-routes.ts`). Code: `export-routes.ts`, `jobs/queue.ts`, `jobs/pg.ts`, `jobs/sharding.ts` (`activeCount`).

**Notes:** 06 §12 says exceeding any quota returns `quota_exceeded`, while 09 §9.1 describes a concurrency limit that reads like queueing. Phase inferred: as BE-091. Lane BE-092-098 (2026-11-13): no quota is enforced yet and BE-091 is not built, so no criterion is ticked. The concurrency question of criterion 3 is decided by the spec default in `docs/adr/0246-lane-BE-092-098.md` (proposed): `quota_exceeded`, for the owner to confirm. Lane w5 (2026-11-17): criterion 3 is ticked on that proposed default; if the owner chooses queueing, the check in `export-routes.ts` goes and the criterion is read again. Criterion 1 stays unticked: the asset upload is built, but the import half is not (there is no import route, PRO-066), so a tenant at its storage quota cannot yet be shown refused on an import. Criterion 5 stays unticked: there is no usage route in the administration API (UX-076 has quotas, retention, holds and webhooks, not usage figures), and BE-085 has no counter of stored bytes by kind. Storage counts assets only (ADR 0371, proposed).

### BE-093 Run a dedicated deployment for one tenant

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | could | Tenant administrator |

**Spec:** 06 §12; 10 §3.7 · **Requirements:** R10 · **Depends on:** BE-006, BE-041

As a tenant administrator with strict isolation needs, I want my own deployment, so that no infrastructure is shared with other customers.

**Acceptance criteria**

- [ ] Given a dedicated deployment, when it is installed from the chart, then it has its own database, object store bucket and keys.
- [x] Given the deployment, when the conformance kit runs, then it passes unchanged.
- [ ] Given an upgrade, when it is rolled out, then it follows the same release steps as shared deployments (BE-095).

**Evidence (lane w5, 2026-11-18):** criterion 2: `services/document-service/test/postgres/be-093-dedicated-deployment.pg.test.ts` (2 tests, `pnpm exec vitest run --project node <file>`, both passed, 61 s on this machine, PostgreSQL and the S3-compatible store of `infra/test-env.ps1` in Podman). The reference service runs on its own database, bucket and generated Ed25519 signing key, cursor secret and view key, and the kit's `core` profile runs against it with no known difference listed (`CORE_KNOWN` is empty, since a silent peer is closed with 1001, decision 194) and no scenario failing; the only scenario not run is `core.channel.page`, which the kit skips when the advertised `catchUpCommits` (5000 here) is above the number of commits the scenario is bounded to provoke; that skip is the kit's own rule and not a failure.

**Notes:** `cond`: for customers who need one; 06 §12 does not place it. Lane w5 (2026-11-18): criterion 2 is ticked because the open question of ADR 0315 no longer shows as a known difference (see Evidence). The kit was not modified and its scenarios and profile are the ones used for the shared deployment. Lane U-BE-085-098 (2026-11-13), earlier text, now partly out of date: `services/document-service/test/postgres/be-093-dedicated-deployment.pg.test.ts` (2 tests, PostgreSQL and the S3-compatible store in Podman, run as one file with `pnpm exec vitest run`) starts one reference service with its own database, bucket and Ed25519 signing key, and runs the conformance kit's `core` profile against it: every scenario passes except `core.session.silence` (the open question of ADR 0315, the same known difference as the shared-database test) and the page scenario's catch-up skip. Criterion 2 therefore stays unticked: the kit does not pass unchanged while that question is open. Criterion 1 stays unticked: it names the Helm chart, and `helm` and a cluster are not on this machine (BE-006). Criterion 3 stays unticked: it depends on BE-095, which has no release pair to test.

## Operations

### BE-094 Run CDM migrations only when an operator starts them

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 2 | M | should | Operator |

**Spec:** 06 §13; 03 §11.3; 04 §3.2; review MIG-1; 11 §9 (risk 6) · **Requirements:** R9 · **Depends on:** CDM-049, BE-039, BE-020

As an operator, I want a document's model version changed only when I decide, so that a rolling deploy or a user opening a document never migrates it.

**Acceptance criteria**

- [x] Given a document at CDM version N and a service that supports N+1, when a user opens it, then nothing is migrated.
- [ ] Given the operator starts a migration for a document, a tenant or a batch, with a dry run first, when it runs, then each document migrates through a snapshot commit with origin `migration`, with a checkpoint before and after, and connected clients receive `sync.reset`.
- [ ] Given a migration is stopped part-way, when documents remain unmigrated, then they still open and edit at version N.
- [x] Given a component pinned to version N-1, when it opens a migrated document, then the channel is rejected with `unsupported_cdm`; when it opens an unmigrated one, it works.

**Evidence (lane w5, 2026-11-17):** criteria 1 and 4: `services/document-service/test/data-plane/be-094-operator-gated.test.ts` (3 tests, `pnpm exec vitest run --project node <file>`, all passed). A data plane that lets channels use CDM 1 and 2 (new setting `cdm` of `DataPlaneSettings`, `seams.ts`, `data-plane/settings.ts`) opens a document stored at 1 for a component at 1, refuses a component at 2 on it with `unsupported_cdm` ("the document is CDM 1"), and after three opens the document is still stored at 1, its log head is unchanged and no snapshot commit exists. A document stored at 2 is refused to a component at 1 with `unsupported_cdm` ("the document is CDM 2") while the document stored at 1 opens, and neither stored version changes.

**Notes:** Phase inferred: CDM version 1 needs none, so the first need is the first model change after phase 1b. The window of old packages kept runnable is an open issue of 08 §15. Lane w5 (2026-11-17): criteria 2 and 3 stay unticked because the operator's migration cannot be built honestly here. (a) No CDM version 2 exists: the model package has one definition (`CDM1`), CDM-049's migrations are not written (its criteria 1 to 4 are open), and the reader supports exactly one version, so a migrated document cannot be validated or opened. (b) The data plane has nothing for a document whose version changes: the authority `Room` stamps every commit with `cdm: 1` (`packages/authority/src/room/room.ts`), replayers are keyed by engine and version and only CDM 1 is registered (CDM-050 is open), the room keeps the `DocumentRecord` it loaded (`room-host.ts` `record.cdmVersion`, used for checkpoints and content reads), and `DocumentStore` has no way to change `cdmVersion`. A runner built on those would write a snapshot commit that no node can replay. The runner (dry run, snapshot commit with origin `migration` through `replaceContent`, a checkpoint on each side, `sync.reset`, a stop that leaves the rest at N) is the work that follows CDM-049 and CDM-050; the snapshot reason `migration` and the framework `migrate()` already exist. Criteria 1 and 4 are ticked on the stored-version rule of `session.ts` (`#openChannel`), which is built and is what the criteria test; the "migrated" document of criterion 4 is created directly at version 2 in the stores, because no migration can produce one yet. The setting `cdm` is additive and defaults to 1 to 1, as before; which versions a deployment lets through is the operator's, not decided here.

### BE-095 Upgrade self-hosted deployments across one skipped minor version

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | should | Operator |

**Spec:** 06 §13 · **Requirements:** R9, R15 · **Depends on:** BE-016, BE-094, FND-012

As an operator who upgrades rarely, I want to skip at most one minor version, with every step documented, so that I am not forced through every release.

**Acceptance criteria**

- [ ] Given release N, when a deployment at N-1 and a deployment at N-2 (one minor skipped) are upgraded with the documented steps, then both end working with their data intact in CI.
- [x] Given each release, when its notes are written, then they list the database steps, the CDM steps and how to roll back.
- [ ] Given the latest release is rolled back by the documented steps, when it is tested, then the previous version runs against the data.
- [x] Given the guide, when it describes skipping, then it says that more than one minor is not supported.

**Evidence (lane w5, 2026-11-18):** criteria 2 and 4: `services/document-service/src/storage/be-095-release-notes.test.ts` (7 tests, `pnpm exec vitest run --project node <file>`, passed, with `migrate.plan.test.ts`). Every release in `migrations/releases.json` must state its CDM steps and a rollback note for them (`releaseNoteProblems`, also run by `migrate check`, which exits 0), and `migrate notes <release>` prints the database steps with their rollback and then the CDM steps with theirs (`cdmNotes`). `services/document-service/docs/upgrade-guide.md` describes a skip of one minor and states that more than one skipped minor version is not supported; the test reads the guide for both sentences. Decision 28 of `docs/owner-decisions-2026-11-15.md` (self-hosted applies from the start) makes the story apply.

**Notes:** `cond`: only if a self-hosted distribution ships (11 §10, decision 8; decision 28 of the owner's answers: both modes apply). Lane w5 (2026-11-18): criteria 1 and 3 stay open. The repository has one release (`0.1.0-phase1a`), so there is no N-1 and N-2 pair to upgrade between and no previous version to roll back to; they need two or three tagged releases built and a CI job that installs the old one, loads data, upgrades by the guide and checks the data (hosted CI is not edited by a lane). The guide says so. The one release states no CDM steps, because no CDM migration exists (BE-094 criteria 2 and 3, CDM-049); the `cdm` field of `releases.json` is the place for them. The word "minor" follows the release names once they are semantic versions; `0.1.0-phase1a` is not one yet.

### BE-096 Encrypt backups and audit access to them

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Operator |

**Spec:** 06 §13; 10 §3.7 · **Requirements:** R10 · **Depends on:** BE-041, BE-014

As an operator, I want backups encrypted and every access to them recorded, so that a backup is not an easier way into customers' data than the service.

**Acceptance criteria**

- [x] Given backups of the database and the object store, when they are written, then they are encrypted with keys separate from the live data's keys.
- [x] Given someone reads, copies or restores a backup, when it happens, then an audit event records who, what and when.
- [x] Given a restore rehearsal, when it runs, then it records its date, its result and the verification of sample documents (BE-081).

**Evidence:** Lane U-BE-085-098 (2026-11-13), PostgreSQL 17 and the S3-compatible store in Podman (`pwsh -NoProfile -File infra/test-env.ps1 up`). `services/document-service/src/data-plane/backup.ts` (`sealBackup`, `openBackup`, `writeBackup`, `readBackup`, `copyBackup`, `rehearse`). `services/document-service/src/data-plane/be-096-backup.test.ts` (12 tests, module level). `services/document-service/test/data-plane/be-096-backup.pg.test.ts` (3 tests): `pg_dump` and `psql` run inside the test container, the objects are in the bucket, and the rehearsal restores into a scratch database that is dropped afterwards. Criterion 1: the sealed file holds no document text and no SQL, another backup key does not open it, and the backup key identifier is not a tenant key identifier. Criterion 2: the live audit trail holds `backup.written`, `backup.read`, `backup.copied` and `backup.rehearsed` with the actor, the backup key and counts, and no text. Criterion 3: the rehearsal record has the date, the result and each sample's check (chain, head hash against the live hash, checkpoints), and a wrong expected hash gives `failed`.

**Notes:** Phase inferred: the first hosted or production deployment; stage 1 development does not need it. SEC-049 proves it. Lane U-BE-085-098 (2026-11-13): the functions are built and tested against the real environment; no command line is built yet, so an operator runs them from a script (a `backup`, `open` and `rehearse` command is the next step and is not a criterion here). Decisions (spec silent; proposed in `docs/adr/0338-lane-U-BE-085-098.md` for the owner): the backup key is a 256-bit secret of its own, not a KeyService key, and its storage and rotation are open; the bundle is held in memory, so there is no streamed backup; the database is dumped and restored with the PostgreSQL client tools, and tenants' objects are copied sealed under their own keys. Retention and restore windows have no number in the spec.

### BE-097 Define the on-call process for hosted mode

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | cond | S | should | Operator |

**Spec:** 06 §16; review PD-11 to PD-14 · **Requirements:** R9, R15 · **Depends on:** BE-086

As an operator of the hosted service, I want an on-call process written before launch, so that incidents have owners and a routine.

**Acceptance criteria**

- [ ] Given the metrics of BE-086, when the process is written, then it names the alerts, thresholds and who is paged.
- [ ] Given an incident, when the process is followed, then it covers escalation, communication to tenants, and a written review afterwards.
- [ ] Given abuse reports, when the process meets them, then it refers to the policy of SEC-061 for what may be done to content.

**Notes:** `cond`: only if the owner chooses hosted mode (11 §10, decision 8).

## Read restrictions (ADR 0019)

Added on 2026-11-06 from spike S12 (SPK-029; `docs/spikes/2026-11-06-s12-read-restrictions.md`), after the owner decided that version 1 can hide regions and field values from some readers (SPK-005). Every other story that serves content, steps, positions, history, search, exports, comments, presence or field values applies the requester's projection: README §2.2 rule 8.

### BE-098 Serve projections for reads outside a room

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** ADR 0019 (decision items 2 and 5, change 3); 06 §3, §5 · **Requirements:** R3, R10 · **Depends on:** SYN-050, PRM-067

As a maintainer, I want content, commits, field values and previews read over REST or through a transient authority to be projected for the requester, so that no read path bypasses read restrictions.

**Acceptance criteria**

- [x] Given a content read, a page of commits, a field read or a preview, when the document has content hidden from the requester, then the response is the requester's projection at the grants revision in storage, and carries the view token.
- [x] Given a cache in front of any of these reads, then its key includes the visibility class, its responses are private, and a change of the grants revision invalidates it.
- [ ] Given every read route of 05 §6, when the negative tests run, then each refuses or projects for a reader without access.

**Evidence:** Criterion 1, page of commits (lane w5, 2026-11-17): `packages/authority/src/projection/page.ts` (`projectCommitPage`, `visibleScopes`) maps a page of stored commits to the steps of the reader's class, with `packages/authority/test/be-098.commit-page.test.ts` (mapped step, empty commit for a hidden-only change, hidden scope and retired region dropped, projected steps replayed on the class projection equal the projection after the page, full class unchanged). `DataPlane.readCommits` (`services/document-service/src/data-plane/room-host.ts`) and the storage path of `GET /documents/{id}/commits` (`src/control-plane/commit-routes.ts`) now serve it with the class's view token instead of a 503: `src/data-plane/read-commits.test.ts` ("serves the steps of the reader's class...", in the room and from storage; the hidden word appears nowhere in the page), `test/control-plane/routes.commits.test.ts` (over HTTP: the editor's first commit is empty, the editor's token equals the token of the editor's content read and differs from the owner's), `test/control-plane/be-098-read-sweep.test.ts`. Earlier evidence: Criterion 1 (lane U-BE-085-098, 2026-11-13, PostgreSQL in Podman and in memory): `services/document-service/test/control-plane/be-098-field-projection.test.ts` (now both storages: a hidden field is absent from the list and the values, and the reader's view token differs), `test/control-plane/be-098-export-projection.test.ts` (new: an export and a preview of a reader name the hidden region and the reader's view in the job payload, the owner's name none), `routes.content.test.ts`, `routes.commits.test.ts`, `routes.assets.test.ts`, `field-values-gate.test.ts`, `routes.exports-gate.test.ts` (all passed on PostgreSQL in this run). Criterion 2: `services/document-service/src/control-plane/pinned-cache.ts` (the key is built from the tenant, the resource and the visibility class, and a key without a class is refused) with `src/control-plane/pinned-cache.test.ts` ("does not serve a copy made for one visibility class to another class"); responses are private (`test/control-plane/routes.content.test.ts` checks `private, no-cache` and `private, max-age=31536000, immutable`, `routes.commits.test.ts` checks `private, no-cache`); a change of the grants revision invalidates the cached projection (`routes.content.test.ts`, "serves each reader the content of their class...": a PATCH of the grants changes the view token and the ETag of the next read). Criterion 1 (partial, not ticked): `test/control-plane/be-098-field-projection.test.ts` (new) runs a field list and field values over HTTP, where a field inside a hidden region is absent for the reader and present for the owner, and the reader's view token differs; content, commits and assets are projected in `routes.content.test.ts`, `routes.commits.test.ts` and `routes.assets.test.ts`. The memory variants pass in this run; the PostgreSQL variants are skipped (no database).

**Notes:** Audit (2026-11-13): criterion 1 is unticked because a page of commits is not projected: for a reader whose class hides content `GET /documents/{id}/commits` answers 503 `unavailable` with no projection and no view token (`commit-routes.ts`, `room-host.ts` `readCommits`; the test "serves no page to a reader whose class hides content" asserts the refusal; ADR 0034 §1.4 says the resource does not serve a class's steps "yet"), while content, field reads and previews are projected and pass. Lane U-BE-085-098 (2026-11-13): criterion 1 was ticked. The field reads and the export and preview projection now run against PostgreSQL too (the earlier note said the PostgreSQL variants were skipped). Previews and exports are projected in `export-routes.ts` (`readerView`, `exportView`), and the new test checks the job payload for a hidden class. Criterion 3 (lane V-BE-085-098, 2026-11-13, not ticked): `services/document-service/test/control-plane/be-098-read-sweep.test.ts` (new; memory and PostgreSQL in Podman) sends every user-readable GET of `DEP1.operations` for one document with no credential, with a stranger's token and with a reader restricted from one region. The first two get 4xx, and the third never returns the hidden text; for the third, a 503 `unavailable` with `Retry-After: 0` (the reload refusal of ADR 0019, as `GET /documents/{id}/commits` answers) counts as a refusal, and a separate case checks that answer. The reviewer's two runs gave 8 passed, 2 failed (the activity route then answered 503); after the fix, `pnpm vitest run` on that file at 21:04 gave 12 passed, 0 failed, on this machine against the shared `docedit-test-postgres` container. Left open: `GET /fonts` is tenant-wide and outside the sweep, pending the owner's answer in `docs/adr/0338-lane-V-BE-085-098.md` (item 1); bare identifiers (threads, exports, imports) are sent with random ids (item 2). Lane BE-092-098 (2026-11-13). Lane w5 (2026-11-17): criterion 1 is ticked. The commits resource now serves a reader whose class hides content the steps of the class (the hidden set is derived from the head document under the grants in storage, as the content read does; ADR 0019 change 3) and the class's view token; the earlier 503 is gone. A gateway channel still answers such a reader `reload` at open (ADR 0034 item 4 is unchanged). Criterion 3 stays unticked: it waits on the owner's answer to `docs/adr/0338-lane-V-BE-085-098.md` item 1 (whether `GET /fonts` is tenant-wide for every user), which `docs/owner-decisions-2026-11-15.md` does not list.

## Coverage

| Section of 06 | Covered by |
|---|---|
| §1 Services | Gateway BE-029, BE-030, BE-031; room host BE-017 to BE-028; control API BE-032 to BE-039; asset worker BE-042 to BE-046; indexer BE-053, BE-054; webhook dispatcher BE-055 to BE-057; scheduler BE-052; process model BE-001. Export service: none: owned by EXP (queue side BE-049 to BE-051). Signing service: none: owned by FRW |
| §2.1 Ownership | BE-017, BE-018, BE-060, BE-061, BE-062 |
| §2.2 Lifecycle | BE-019, BE-020, BE-021, BE-022, BE-023 |
| §2.3 Persist pipeline | BE-024, BE-025, BE-026 |
| §2.4 Fan-out | BE-027, BE-028 |
| §3 Control API behaviour | BE-032 to BE-039 (content reads BE-036, outbox BE-039, grants revision BE-026) |
| §4.1 PostgreSQL | BE-008, BE-009, BE-010, BE-011, BE-012, BE-013, BE-014, BE-015, BE-016; `doc_checkpoints` BE-020; `assets` BE-042; `doc_assets` BE-044; `jobs` BE-049; `idempotency_keys` BE-034; `outbox` BE-039; omitted tables: tenants and keys BE-012, webhooks and deliveries BE-055, search BE-054, workflows and evidence: none: owned by FRW |
| §4.2 Object storage | BE-003, BE-004, HIS-029, BE-041 |
| §4.3 Redis or Valkey | BE-063 |
| §4.4 Assets | BE-042, BE-043, BE-044, BE-045, BE-046 |
| §5 Why SQL and not a document database | none: informative (the reasoning is the premise of BE-009 and BE-002) |
| §6 Scaling stages | Stage 1 BE-001, BE-058; stage 2 BE-059 to BE-067; stage 3 BE-068 to BE-073 |
| §7 Several regions | BE-074, BE-075 |
| §8 Failure modes | See the table below |
| §9 Recovery objectives | BE-081, BE-082, BE-083, BE-078 |
| §10 Cost model | BE-051 (previews), HIS-029 (log volume), BE-020 (checkpoints), BE-021 and BE-084 (open rooms), BE-085 (instrumentation); unit-cost sheet: none: owned by SPK |
| §11 Observability and support | BE-086, BE-087, BE-088, BE-089, BE-090 |
| §12 Tenancy and quotas | BE-011, BE-041, BE-091, BE-092, BE-093; administration resources: none: owned by UX |
| §13 Operations | BE-005, BE-006 (artefacts), BE-016 (database migrations), BE-094 (CDM migrations), BE-095 (upgrades), BE-096 (backups) |
| §14 Self-hosting adapters | BE-002, BE-003, BE-004 |
| §15 Authority service | BE-007 (deployment); interface: none: owned by PRO |
| §16 Open issues | BE-059 (bus), BE-067 (followers), BE-084 (memory), BE-053 (search), BE-097 (on-call); abuse handling SEC-061 |

Failure modes of 06 §8:

| Failure | Covered by |
|---|---|
| Room host crashes | BE-076, BE-018 |
| Two hosts believe they own a document | BE-017 |
| A host is partitioned and serves only viewers | BE-018 |
| Write outcome unknown | BE-025 |
| PostgreSQL unavailable | BE-077 |
| Database recovery rewinds the log | BE-078 |
| Object storage unavailable | BE-019, BE-020 |
| Redis or Valkey unavailable | BE-063 |
| Grant-change announcement lost | BE-026 |
| Slow consumer | BE-027 |
| A commit that crashes or stalls validation | none: owned by SYN (admission control); verified by SEC-028 |
| Hot document | BE-067, BE-028, BE-073 |
| Huge document | BE-019, BE-021 |
| Export backlog | BE-050, BE-065 |

## Open questions

| Question | Source | Stories affected |
|---|---|---|
| Which hash-partition count for the log tables? The spec says it is fixed at creation and chosen for stage 3, and gives no number | 06 §13 | BE-008, BE-009 |
| Which bus in stage 2, Redis streams or NATS? | 06 §16 | BE-059, BE-062, BE-063 |
| Are follower nodes needed before stage 3? | 06 §16 | BE-067, BE-028, BE-073 |
| What does an open document cost in memory, and what happens when the room budget is reached and no room is idle? | 06 §16, §8 | BE-084, BE-021, BE-058 |
| Search across documents needs its own design: ranking, permissions in results, PostgreSQL full-text search versus a search engine | 06 §16 | BE-053, BE-054 |
| On-call and abuse handling for hosted mode | 06 §16; 10 §6 | BE-097, SEC-061 |
| Hosted, self-hosted or both first? Stories marked `cond` for hosted mode (BE-082, BE-097) and self-hosted (BE-083, BE-095) wait on this | 11 §10 (decision 8) | BE-004, BE-082, BE-083, BE-095, BE-097 |
| How long is the node lease and how often is it renewed? The spec says "every few seconds" | 06 §2.1 | BE-018, BE-076 |
| May a cold open fall back to replaying the whole log when object storage is down? 06 §8 says cold opens fail, 06 §2.1 and §8 say the log alone is sufficient for durability | 06 §8 | BE-019 |
| Does a transient authority take the ownership row? The criteria assume it uses the same fencing | 06 §2.2 | BE-023 |
| How is the deterministic commit identifier of an outbox item derived? | 06 §3 | BE-039 |
| How does initial content of a created document enter the log, and which code does a duplicate `externalId` return? | 05 §6.2 | BE-035 |
| `POST /sessions/revoke` takes an optional document, but the only stored watermark is per user | 05 §3.3; 06 §4.1 | BE-031 |
| Is a non-browser client without an `Origin` header accepted at `hello`? | 05 §4; 10 §3.2 | BE-029, SEC-012 |
| Should a resource hidden by the token answer `forbidden` or `not_found`? | 05 §6.1 | BE-032, SEC-016 |
| Numbers the spec does not give: rate-limit values per layer, the send-queue bound, maximum upload size, pixel, entry and ratio limits for assets, signed-URL lifetime, retention period for orphan assets, maximum job attempts, the replay window of webhook deliveries, the throttle of `dep.commit.rejected` | 06 §1, §2.4, §4.4; 05 §7 | BE-027, BE-030, BE-042, BE-043, BE-045, BE-046, BE-049, BE-055, BE-057 |
| A node-lease table, tenant and key tables, search tables and webhook delivery tables are omitted from the 06 §4.1 sketch; `jobs.state` values are not listed | 06 §4.1 | BE-012, BE-015, BE-018, BE-049, BE-054, BE-055 |
| The `versions.kind` comment in 06 §4.1 omits `sent` and `completed`, which 08 §4 adds | 06 §4.1; 08 §4 | BE-015 |
| `GET /documents/{id}/connect` is in 06 §2.1 but not in the resource table of 05 §6.2 | 06 §2.1; 05 §6.2 | BE-061 |
| No resource exposes erasing a user's mapping (08 §13) | 08 §13; 13 §10 | BE-013 |
| A spent per-tenant CPU budget is `rate_limited` in 04 §12 and `quota_exceeded` in 06 §12; a concurrency limit on exports reads like queueing but 06 §12 says exceeding any quota returns `quota_exceeded` | 04 §12; 06 §12; 09 §9.1 | BE-050, BE-091, BE-092 |
| How platform-level work (scheduler, metrics) reads across tenants under row-level security, and what "expiries" in the scheduler means | 06 §1, §12 | BE-011, BE-052 |
| Does the structural dump also replace attribute strings that carry user text (field values, alt text, region titles, link targets, `latex`)? | 06 §11 | BE-089, SEC-047 |
| The placement service of stage 3 is named and not described | 06 §6 | BE-069, BE-068 |
| How long the main thread may block, and how long a room-loop task may take | 04 §12; 06 §1 | BE-001, BE-058 |
