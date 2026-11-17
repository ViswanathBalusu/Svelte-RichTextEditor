# SYN Sync engine `pm-steps/1` and the authority package

**Status:** first draft, 2026-11-06, written from specification draft 0.2. Not yet reviewed. Every number is a target to validate, not a measurement.

**Scope.** This epic turns [04 Sync engine](../spec/04-sync-engine.md) (normative, all sections) and [ADR 0001](../adr/0001-server-authoritative-sync.md) into stories. It also covers the range mapping that [ADR 0015](../adr/0015-comments-as-mapped-ranges.md) puts in the authority, and the sync findings of the [review](../review/2026-09-18-pitfall-review.md) (section 3.1, PERM-1, SYNC-1, TENT-1, CONV-1, DR-1, ROUTE-1, MIG-1, SRV-1, CPU-1, RELAY-1, PRES-1; and the open items of section 6). The epic owns the `authority` package's pure functions (rebase, apply, invariant checks, range mapping), the three commit types, the authority algorithm, acknowledgement and the client's confirmed document, the client algorithm, reconnect and resume with incarnation, server-authored commits, the presence engine, admission control, the divergence check, relay mode, other engines as an extension point, and the production property-test and fuzzing suite.

**Left to other epics (README section 2.3).**

- PRM owns the permission outcome check (07 §5), the effective-capability map and the rules P1 to P9. SYN writes only where the authority calls the check (SYN-013) and where the grants-revision conditional write sits in the algorithm.
- PRO owns the socket message formats, the error registry, the authority-service interface, the conformance kit and the embedding contract. SYN owns the behaviour behind them.
- BE owns persistence: group commit, fencing in PostgreSQL, the outbox, the room lifecycle, checkpoint writing, followers as a deployment and the recovery procedure. SYN references them.
- SPK owns spike S3 (authority correctness) and spike S1 (input methods with remote commits). SYN writes the production suite that S3's prototype leads to (SYN-047 to SYN-049).
- HIS owns what is recorded for each commit, checkpoints and the visibility gate. FE owns the editing core, the recovery journal and decorations. UX owns the presence, save-state and recovered-edits interface. FRW owns field rules and the rules engine. CDM owns the schema, the canonical form and the definitions of invariants I1 to I12.

Reject codes are those of 04 §8 and 05 §5.8. Where the spec names no code, the story says so and the gap is listed under Open questions.

## Authority package and pinned step semantics

### SYN-001 Build the authority as a package of pure functions

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 04 §5, §6; 05 §10; ADR 0001 · **Requirements:** R6, R7 · **Depends on:** CDM-008

As a maintainer, I want the authority's logic in one package of pure functions with no input or output of its own, so that the room, the transient authority, the authority service and the local backend run exactly the same code.

**Acceptance criteria**

- [x] Given the `authority` package, when it is imported in Node.js with no database, network, clock or DOM, then it exports `rebase`, `apply`, `checkInvariants` and `mapRanges`, each callable with plain data (documents, commits, position maps) and each returning a result value.
- [x] Given a commit that must be rejected, when `rebase`, `apply` or `checkInvariants` is called, then the result carries the rejection code of 04 §5 (`rebase_failed` or `invalid_op`) and the function does not throw.
- [x] Given the same inputs, when any of the four functions is called twice, then the outputs are identical (no reads of time, randomness or global state).
- [x] Given the room, the transient authority (SYN-031), the local backend and the authority service, when their dependency graphs are checked in CI, then each imports this package and none contains its own implementation of the four functions.
- [x] Given the package, when it runs inside a worker thread, then it needs no state from the room: all inputs arrive as structured-cloneable data (see SYN-039).

**Evidence:** `packages/authority/src/index.ts` exports `rebaseOver` (rebase, 04 §6), `applySteps` (apply), `checkInvariants` and `mapRanges`. `packages/authority/test/pure.test.ts`: a step that throws inside prosemirror-transform and content that does not fit give `invalid_op`, the same step rebased gives `rebase_failed`, an identifier change and steps foreign to the documents give `invalid_op`, and nothing throws; two runs with the same inputs give identical JSON; no file in `src/` reads a clock, a random source or a timer. `fuzz.test.ts` (69,600 hostile submissions in 10 s on 2026-11-06, no exception). Criterion 5 (2026-11-13): `packages/authority/test/worker-boundary.test.ts` runs `parseSteps`, `applySteps`, `rebaseOver`, `checkInvariants` and `mapRanges` in a worker thread (`test/harness/authority-worker.ts`) on JSON steps, a JSON base document and numeric ranges, and the worker's result equals the in-process result of the same function (`test/harness/authority-run.ts`); the input is checked to survive `structuredClone` unchanged, and a crafted step gives `invalid_op` in the worker without a crash. Criterion 4 (lane U-SYN-001-018, 2026-11-13): `packages/authority/test/syn-001-single-implementation.test.ts` reads the production sources of `packages/*`, `services/*` and `apps/*` in Node.js (`pnpm exec vitest run --project node <file>`): each function is declared once, in `packages/authority/src`, and nowhere else; the local backend (`packages/backend-mock/src/document.ts`, `content`) now replays stored steps through the package's `applySteps` instead of its own `Step.apply`, and the backend, the engine and the document service import the functions from `@docedit/authority`. Not run by CI (no workflow exists yet).

**Notes:** the outcome check (07 §5.1) is PRM's and is called from SYN-013. If the WASM epic supplies a kernel behind any of these functions, the golden fixtures of SYN-002 are its acceptance test. `evaluateRules` (05 §10) is FRW's. Criterion (4) was not met until 2026-11-13; the room is in this package, the transient authority is the document service's `Room` host (SYN-031), and the local backend's own step application was removed in lane U-SYN-001-018. (5) the functions take ProseMirror nodes, steps and maps, which lose their prototypes when cloned, so a worker needs a JSON boundary; the step JSON and canonical documents of the SYN-002 fixtures are that boundary's natural form (SYN-039). Criterion 5 is met (2026-11-13) by a JSON boundary in the test harness (`authority-run.ts`); the functions are not yet called from a production worker, which the transient authority (SYN-031) will need.

### SYN-002 Pin the step semantics with an engine definition file and golden fixtures

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 04 §4; 05 §11; ADR 0001; review CONV-1, MIG-1 · **Requirements:** R6, R7 · **Depends on:** SYN-001

As a maintainer, I want the exact release of prosemirror-transform named in a file that ships with the conformance kit, with golden fixtures, so that an independent authority can reproduce the semantics and no upgrade can change them silently.

**Acceptance criteria**

- [x] Given the repository, when the engine definition file for `pm-steps/1` is read, then it names the exact prosemirror-transform release and the version of the generated schema, and the lock file resolves to that release and no other.
- [x] Given the pinned release, when the fixture generator runs, then it writes golden fixtures for apply, map and rebase as language-neutral JSON (inputs, outputs, schema version), suitable for a backend written in another language.
- [x] Given the fixtures, when the authority package runs them in CI, then every fixture passes.
- [x] Given a dependency update that changes the output of any fixture, when CI runs, then it fails unless the engine identifier has changed (a new identifier, not a silent upgrade).
- [x] Given the conformance kit, when it is built, then it contains the engine definition file, the generated schema artifact and the fixtures PRO-111.

**Evidence (criterion 5, lane U-SYN-001-018, 2026-11-13):** `podman build -f packages/tck/Containerfile --ignorefile packages/tck/Containerfile.ignore -t localhost/docedit-tck:u-syn-001-018 .` succeeds (Podman); `podman run --rm --cgroups=disabled --entrypoint sh localhost/docedit-tck:u-syn-001-018 -c 'ls /kit/spec/cdm/cdm-1.prosemirror.json /kit/packages/authority/fixtures/engine'` lists the generated schema artifact, `pm-steps-1.json` and `engine/golden/{apply,rebase,map}.json`.

**Evidence:** `packages/authority/fixtures/engine/pm-steps-1.json` names prosemirror-transform 1.12.5, prosemirror-model 1.25.12 (applying a step runs its replace algorithm), the allowed step types, and `spec/cdm/cdm-1.prosemirror.json` with its SHA-256. `packages/authority/scripts/engine-fixtures.ts`, run by `pnpm --filter @docedit/authority generate` (`scripts/generate.ts`), writes from a seeded generator `fixtures/engine/golden/apply.json` (30 cases, 6 of them steps that must fail), `map.json` (16 step lists, 12 positions each, both associations, with the deletion flags) and `rebase.json` (44 cases, 16 with dropped steps, in the authority's reject mode and the client's drop mode); documents are given and compared in the CDM canonical form with their SHA-256. `packages/authority/test/engine.test.ts` checks the pin against the installed releases and `pnpm-lock.yaml` (one version each), the schema hash against `spec/cdm/cdm-1.manifest.json`, that the room stamps `pm-steps/1`, that all seven step types occur, replays every fixture, and that a fresh generation writes the same bytes. A different installed release fails that test, and the generator refuses to write; an output that changes under the same engine and schema is refused too. CI runs `pnpm test`; it has not run yet.

**Notes:** the generated ProseMirror schema is a normative artifact of the CDM epic; this story only pins and cites it. The conformance kit exists in part (`packages/tck`, which reads the engine file and the fixtures through `@docedit/authority`). 2026-11-13: its image (`packages/tck/Containerfile`) copies `packages/authority/fixtures` but not `spec/`, so the generated schema artifact that the engine file names (`spec/cdm/cdm-1.prosemirror.json`) is not in the kit; the image has not been built (Podman, not run in this lane). Criterion 5 is met (lane U-SYN-001-018, 2026-11-13): `packages/tck/Containerfile` and `Containerfile.ignore` now copy `spec/` (the built image had none, so the kit could not read `spec/permissions` or `spec/rules`), and the image builds under Podman (see Evidence). Pinning prosemirror-model as well as prosemirror-transform is an addition to 04 §4, which names only the latter. While CDM 1 is a draft, a change of the generated schema regenerates the fixtures under the same engine identifier; only a change of library release requires a new one.

## Commits

### SYN-003 Validate step commits: shape, limits and the step allow-list

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 04 §3.1, §4, §5 step 1; 05 §5.3, §5.1 (`limits`) · **Requirements:** R7, R10 · **Depends on:** SYN-001, SYN-002

As a maintainer, I want every submitted commit checked for shape, size and step type before any expensive work, so that malformed or oversized commits cost almost nothing and cannot reach the document.

**Acceptance criteria**

- [x] Given a commit with more than `maxStepsPerCommit` steps (target default 500), when it is submitted, then it is rejected with `too_large` and nothing is applied; a commit with zero steps is rejected and never stored as a control commit.
- [x] Given a commit whose serialised form exceeds `maxCommitBytes` (target default 1 MiB), when it is submitted, then it is rejected with `too_large` and nothing is applied.
- [x] Given a step whose `stepType` is anything other than `replace`, `replaceAround`, `addMark`, `removeMark`, `addNodeMark`, `removeNodeMark` or `attr`, including `docAttr`, when the commit is submitted, then the whole commit is rejected and nothing is applied.
- [x] Given step JSON that the pinned prosemirror-transform release cannot parse against the generated schema, when it is submitted, then the commit is rejected without throwing.
- [x] Given `origin` values `input`, `paste`, `format`, `undo`, `redo`, `suggestion.accept`, `suggestion.reject`, `fill` and `assistant`, when two otherwise identical commits from the same user differ only in `origin`, then both are accepted or both rejected with the same code, and the origin is recorded unchanged as the client's claim.
- [x] Given the limits announced in `welcome`, when the room enforces them, then it uses exactly those values for `maxCommitBytes` and `maxStepsPerCommit`.

**Evidence:** `packages/authority/test/room.test.ts` ("refuses disallowed step types, malformed steps and oversized commits") and `room-scenarios.test.ts`, "step commits": a commit with no steps is refused, nothing is written and no control commit appears; one `docAttr` among allowed steps refuses the whole commit; the step and byte limits apply exactly at the boundary; each of the nine client origins is accepted alike, stored unchanged, and refused alike with `permission_denied`. `fuzz.test.ts`: hostile step JSON never throws. Criterion 6 (lane U-SYN-001-018, 2026-11-13): `services/document-service/test/data-plane/syn-003-welcome-limits.test.ts` (MemoryStore, real WebSocket clients, Node.js): with `maxStepsPerCommit` 4 and `maxCommitBytes` 2000 configured, the `welcome` announces those values, one step over the announced count is refused `too_large` with `drop`, exactly that count is acknowledged, a commit over the announced bytes is refused `too_large`, and a small one is acknowledged. The room host builds the room from the same settings object as the session's `welcome`.

**Notes:** the spec names no code for a zero-step commit, a disallowed step type or unparseable steps; step 5 gives `invalid_op` for an apply failure and that is the assumed code (Open questions). What the room does with a client-supplied reserved origin (`restore`, `import`, `migration`, `repair`, `sign`, `rules`, `prefill`, `control`) is also unspecified; the room refuses it with `invalid_op`. Not met: (6) `welcome` is PRO's; the room enforces exactly the `Limits` it is given, so the gateway must announce the same object. 2026-11-13: the room's limits come from its constructor (`this.limits` in `packages/authority/src/room/room.ts`); no code in `packages/authority` builds a `welcome`, and `packages/backend-dep/src/backend.ts` (around line 148) only maps the welcome's two limits for the client. 2026-11-13 (lane U-SYN-001-018): criterion 6 is ticked by the test named in its Evidence, which links the room's limits to the announced `welcome`.

### SYN-004 Record permission and workflow changes as control commits

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 04 §3.2; 07 §3, §9; 08 §2; review S-02 · **Requirements:** R3, R4 · **Depends on:** SYN-006, PRM-019, PRM-020

As an owner, I want a change of grants, region state or workflow to sit in the same ordered log as the content, so that "this field was filled before that region was approved" can be proved from one log.

**Acceptance criteria**

- [ ] Given a new grants revision, a region state, a lease break, a workflow transition or a participant's completion, when the room applies it, then it stores a commit of kind `control` with no steps and the next `seq`.
- [x] Given a stored control commit, when it is broadcast, then every subscriber receives it in `seq` order as a `sync.commit` with `kind` `control`, and each client advances its confirmed `seq` without changing its document.
- [x] Given a grants change and a content commit processed close together, when the log is read, then the control commit's `seq` places it before or after the content commit exactly as the room applied them.
- [x] Given a control commit, when it is stored, then its metadata and hash are recorded like any other commit (HIS-001, HIS-002).
- [x] Given a client, when it sends a `sync.submit`, then it can only produce a `steps` commit; no client message creates a control commit.

**Evidence:** `packages/authority/test/room-scenarios.test.ts`, "control commits": a grants change after a waiting content commit gets the next `seq`, and one before a content commit precedes it; a stored control commit reaches every subscriber as a `sync.commit` of kind `control` with no steps; the origins `control`, `restore`, `import`, `migration`, `repair`, `sign` and `rules`, and an empty commit, are refused, so only `steps` commits come from clients. `room.test.ts`: the control commit for a revision whose notification was lost. Control commits get the same metadata and hash as step commits, now with a NULL session for the server (`services/document-service/test/data-plane/postgres.pg.test.ts` "records every field of a commit" and "chains every commit by hash, control commits too"). Criterion 2 (lane U-SYN-001-018, 2026-11-13): `packages/authority/test/room-scenarios.test.ts`, "broadcasts a stored control commit to every subscriber, with no steps" (three subscribers each receive one `sync.commit` of kind `control`, seq 1, no steps; Node.js); `packages/engine/test/sync-state.test.ts`, "a control commit advances the seq and changes no content".

**Evidence (PostgreSQL, lane V-SYN-001-018, 2026-11-13, PostgreSQL in Podman (the shared test container), Node.js with `pnpm vitest run --project node <file>`):** `services/document-service/test/data-plane/prm-051-grant-control.pg.test.ts` ("records the control commit at the same revision in the chain") and `services/document-service/test/data-plane/postgres.pg.test.ts` (6 tests, including "chains every commit by hash, control commits too") pass against the real database. This covers the stored control commit's metadata and hash (criterion 4) and a grant change's control commit in PostgreSQL (criterion 1, for grants).

**Notes:** the control payloads themselves (grants, states, leases, workflow) belong to PRM and FRW. 2026-11-13 (lane V-SYN-001-018): criterion 1 stays unticked. The workflow's lock reaches the room as a permission change, which makes a control commit (`permissionsChanged`, `room.ts`); a workflow transition that leaves the lock as it is, and a participant's completion, have no control commit that a test shows, so the workflow half is not proven. The side effects that must share the commit's transaction (06 §2.3, step 4) are BE's. Not met: (1) the room stores a control commit for every new grants revision, which covers grants, region states and leases (`PermissionState`), but workflow transitions and participants' completion have no source until FRW. (2) the room's half is shown; advancing the client's confirmed `seq` is the engine's (SYN-019). 2026-11-13 (lane U-SYN-001-018): the client half of criterion 2 is shown by `packages/engine/test/sync-state.test.ts`, "a control commit advances the seq and changes no content" (passes under Node.js). The room half (a stored control commit sent to every subscriber as `sync.commit` with `kind` `control`) is tested by `room-scenarios.test.ts`, 'broadcasts a stored control commit to every subscriber, with no steps' (lane U-SYN-001-018, 2026-11-13, Node.js), so criterion 2 is ticked; the client half is `packages/engine/test/sync-state.test.ts`, 'a control commit advances the seq and changes no content' (passes, Node.js, same date). (4) metadata and the hash chain are HIS-001 and HIS-002. Lane w4 (2026-11-15): criterion 1 stays unticked, blocked on FRW-035 and FRW-036. Looked for a source of the two missing cases and found none: the room records a control commit only when it is given a `PermissionState` with a new revision (`permissionsChanged` and `ensureControlCommit`, `packages/authority/src/room/room.ts`), and the permission data holds of the workflow only `workflowActive` and the document state (`PermissionChange`, `services/document-service/src/storage/types.ts`). No route or service applies a workflow transition or stores a participant's completion: `packages/authority/src/workflow/` has the pure functions (`sendWorkflow`, `openWorkflow`, `completeParticipant`), and `packages/authority/test/frw-031.activation-room.test.ts` says that storing a completion and pushing `wf.changed` are FRW-035 and FRW-036; `services/document-service/src/workflow/sealed-pdf-finalise.ts` says the workflow's control commit is the workflow service's and is not built (ADR 0341). Grants, region states and lease breaks are shown (Evidence; `services/document-service/src/data-plane/pro-053-region-state-control-commit.test.ts`; `services/document-service/test/data-plane/prm-045-lease-break.pg.test.ts`). Whether a transition that leaves the lock as it is, and a completion, reach the room as a new grants revision or by another entry is not stated in 04 §3.2 or 12 (Open questions); no scaffolding was built for it here.

### SYN-005 Store snapshot commits and send `sync.reset`

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 04 §3.2, §5 step 3; 05 §5.3; 03 §11.3; review MIG-1 · **Requirements:** R4, R7 · **Depends on:** SYN-006, BE-020, HIS-005

As an owner, I want imports, whole-document restores, migrations and repairs to be one commit that replaces the document, so that changes too large for a list of steps still have a place in the ordered log.

**Acceptance criteria**

- [x] Given an import, a whole-document restore, a schema migration or a repair, when the room applies it, then it stores a commit of kind `snapshot` that references a checkpoint instead of listing steps, and checkpoints are written around it.
- [x] Given a stored snapshot commit, when it is broadcast, then every subscriber receives `sync.reset` with `seq` and `reason` (`import`, `restore`, `migration` or `repair`), not a `sync.commit` with steps.
- [x] Given a step commit whose `base` is older than a snapshot commit, when it is submitted, then it is rejected with action `reload` and is not rebased.
- [x] Given a snapshot commit, when it is processed, then it passes the same invariant and permission checks as any commit, including the refusal to change an approved region (07 §11).
- [x] Given a pinned read of the content at the snapshot's `seq`, when it is served, then it comes from the checkpoint written for the snapshot.

**Evidence:** `packages/authority/src/room/room.ts` (`Room.snapshot`; `SnapshotCommit` and `WriteRequest.snapshot` in `room/types.ts`). `test/room-commits.test.ts`, 'snapshot commits (SYN-005)': a commit of kind `snapshot` that references the caller's checkpoint and lists no steps is written alone, and the room asks for a checkpoint of the durable state just before it (`Effects.checkpoints`); every subscriber receives `sync.reset` with `seq`, `reason` (all four) and the content, never `sync.commit`; a commit whose base is older than a stored or waiting snapshot is refused without rebasing with `stale_base` and action `rebase`, as 04 §3.2 says since the second review (SR-K1; this criterion's `reload` predates that edit); invariants and the outcome check apply, so an approved region cannot change for `system` or an owner; a restarted room replays the snapshot from its checkpoint. `test/room-content.test.ts`: the pinned read at the snapshot's seq comes from its checkpoint, with no replay. `test/convergence.snapshot.property.test.ts` (150 schedules with the faults of S3 on 2026-11-06): 181 snapshot commits stored, 584 resets, retries of failed writes applied once. Behind the projection gateway a reader receives the projection of the new content (`test/projection.steps.test.ts`; S12 suite).

**Evidence (PostgreSQL, lane V-SYN-001-018, 2026-11-13, PostgreSQL in Podman, Node.js):** `services/document-service/test/data-plane/his-019-reset-chain.pg.test.ts` passes against the real database: a whole-document snapshot reaches every open client as `sync.reset` at a new seq, and the hash chain still verifies after it (criterion 2). The PostgreSQL log stores a snapshot commit with its checkpoint reference and its content in one transaction (`services/document-service/src/storage/log-store.ts`, table `doc_snapshots`, migration 0030).

**Notes:** the rejection code for a base before a snapshot is stated differently in 04 §3.2 (action `reload`) and in §5 step 3 (`stale_base`, whose table action is `rebase`); see Open questions. `restore` as a reason is written by HIS-019. 2026-11-06: built in the room; the PostgreSQL store does not yet store snapshot commits (`WriteRequest.snapshot`) or write the checkpoint the room asks for (BE-020), and the mock backend still models a snapshot as a new room. Second review (2026-11-06, SPK-027), SR-K1: settled in 04 §3.2 as edited: `stale_base` with action `rebase`. By the ordering rule the client has already handled `sync.reset` and re-applied its work (SYN-023) when the rejection arrives. S6's decision D09 (`reload`) does not stand ([review](../review/2026-11-06-second-review.md)).

## Authority algorithm

### SYN-006 Process submissions one at a time against durable and tentative state

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 04 §1, §2 (G1, G2, G3, G5), §5 introduction and last paragraphs; 06 §2.2 · **Requirements:** R7, R9 · **Depends on:** SYN-001, BE-017, BE-024

As an author, I want exactly one authority to order the edits of an open document, so that everyone sees the same document in the same order.

**Acceptance criteria**

- [x] Given two submissions arriving on different channels of one document, when the room processes them, then it handles them one at a time in arrival order, and only the room that owns the document accepts submissions.
- [x] Given commits waiting to be stored, when a new submission is validated, then validation runs against the tentative state (document plus waiting commits), while the durable state (document, indexes, attribution map, comment ranges, chain head) is exactly as of the last stored commit.
- [x] Given accepted commits, when they are ordered, then each gets the next tentative `seq` after the durable head, starting at 1 for a new log, with no gaps.
- [x] Given a checkpoint is to be written, when the room serialises it, then it takes the durable state only, never the tentative one (BE-020).
- [x] Given two clients that have applied the log up to the same `seq` of the same incarnation and have no unconfirmed steps, when their documents are compared in the property suite, then they are identical (G3).
- [x] Given a restart of the room after a crash, when it reopens the document, then the tentative state is gone and the room continues from the durable state.

**Evidence:** `packages/authority/test/checkpoints.test.ts`, "writes the snapshot checkpoint from the stored commits only": a snapshot requested while two commits wait for storage gets a checkpoint, taken when the snapshot is written, that equals the durable document at seq 2 and differs from the snapshot's tentative content. `packages/authority/test/room-scenarios.test.ts`, "one at a time": two channels' commits get seq 1 and 2 in arrival order while the durable document stays at seq 0 until the write. `room.test.ts`: a commit accepted into the tentative state behind another, both discarded on a failed write; a fenced room stops and closes every channel. `convergence.property.test.ts` (1,000 schedules on 2026-11-06, `S3_RUNS=1000`): G3 for every client after quiescing, a gap-free log, and 388 room crashes with failover, each new room built from storage alone.

**Notes:** ProseMirror documents are persistent data structures, so holding both states costs little (04 §5). Eviction of idle rooms is BE's (06 §2.2). The durable state holds the document, the log, the step maps, the retired region identifiers and the suggestion owners; comment ranges and the hash chain do not exist yet. (4) is met at the room (`test/checkpoints.test.ts`): the checkpoint it requests holds the durable state only. Writing checkpoints to storage is BE-020.

### SYN-007 Authorise a submission and allow one commit in flight per channel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 04 §5 step 1, §8 · **Requirements:** R3, R7 · **Depends on:** SYN-006, PRM-004

As an author, I want a change refused up front when my connection cannot change anything, so that a rejection is immediate and cheap.

**Acceptance criteria**

- [x] Given a connection whose channel holds none of `suggest`, `edit` or `fill` in any scope, when it submits, then the commit is rejected with `permission_denied` and action `drop`.
- [x] Given a document whose state is `locked` or `archived`, or a workflow that does not permit the change, when a commit is submitted, then it is rejected with `read_only` and action `drop`.
- [x] Given a channel with a commit in flight, when a second `sync.submit` arrives before the first is answered, then the second is rejected with `busy` and action `retry`, and the first is unaffected.
- [x] Given any rejection from the room, when it is sent, then it carries the document's current `head`.
- [x] Given a submission, when step 1 runs, then the size limits (SYN-003) and admission control (SYN-037) are applied before any deduplication, rebase or apply work.

**Evidence:** `packages/authority/test/room-scenarios.test.ts`, "authorise, and one commit in flight": a viewer and a commenter get `permission_denied` with `drop`; an archived document gives `read_only` with `drop`; a second submission gets `busy` with `retry` while the first is acknowledged later; five different rejections all carry the current head. `room.test.ts`: a locked document gives `read_only`. 2026-11-13 (criterion 5): `packages/authority/test/submission-order.test.ts`: a resubmission of a stored commit with too many steps is refused `too_large`, and one over the admission budget is refused `rate_limited`, both before the duplicate check; a retry within the limits is still acknowledged as a duplicate.

**Evidence (criterion 2, partly, lane V-SYN-001-018, 2026-11-13):** `packages/authority/test/syn-007-workflow-lock.test.ts` (Node.js): the lock that a workflow state implies (`lockFor`, `packages/authority/src/workflow/lock.ts`) applied to the room's permission state gives `read_only` with `drop` for a viewer while the workflow is `sent`, `in_progress`, `declined` or `voided`, and for an owner once it is `declined` or `voided`; a draft workflow leaves the owner's commit accepted. Lane w4 (2026-11-15), the rest of criterion 2: the same file, "a running workflow that does not permit the change gives read_only": while the workflow is `sent` or `in_progress` an owner's text change and an editor's direct field value are refused with `read_only`, `drop`, the head and the scopes, and nothing is stored; a participant's text change and an editor's change in a region they hold no grant on stay `permission_denied`; the active participant's fill is accepted. `packages/authority/src/room/room.ts` (step 7): a client commit refused with `permission_denied` on a document that is not active is checked once more as if the document were active with no workflow, and is answered `read_only` when that check passes (ADR 0363, proposed). `frw-029.workflow-lock.test.ts` now pins `read_only` for the owner and the editor.

**Notes:** Cross-check: document states (locked, archived) arrive with PRM-005 in phase 1b. Criterion 2 met on 2026-11-15 (lane w4): the reading left open below is settled as proposed in ADR 0363, which applies the text of 04 §5 step 1; the owner has not reviewed it. Earlier note: (2) was still open after lane V-SYN-001-018 (2026-11-13). The workflow lock exists now (FRW-029), so the earlier note "no workflow exists yet" is out of date. The owner in `sent` or `in_progress` holds `fill`, so the room passes the commit to the outcome check, which refuses it with `permission_denied`, not `read_only`. P6 (07 §9) says that a state which limits the connection gives `read_only` first, and criterion 2 says the same; the two readings differ for a connection that holds fill. This is an open question for PRM and FRW and is not decided here. Criterion 5 is now met: step 1 of `Room.submit` (`src/room/room.ts`, "Authorise and limit") checks the byte and step limits and admission control before step 2 (deduplication). The 2026-11-06 note that admission control did not exist is superseded: `room/admission.ts` exists (SYN-037 is partly done).

### SYN-008 Deduplicate resubmitted commits

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 04 §2 (G4), §5 step 2; 07 §16; review SYNC-1 · **Requirements:** R7 · **Depends on:** SYN-006, SYN-003

As an author, I want a commit that I resubmit after a dropped connection to apply once and only once, so that nothing I typed is duplicated or lost.

**Acceptance criteria**

- [x] Given a commit `id` that is waiting to be stored, when the same user resubmits it, then no second copy is applied, the request attaches to the pending acknowledgement, and both requests receive an acknowledgement with the same `seq`.
- [x] Given a commit `id` that is already stored and was submitted by the same user, when it is resubmitted, then the reply is an acknowledgement rebuilt from the stored commit, always carrying the stored steps.
- [x] Given a commit `id` that belongs to another user, whether waiting or stored, when it is submitted, then it is rejected with `invalid_op` and the existing commit is unchanged.
- [x] Given the lookup, when step 2 runs, then it checks the commits waiting to be stored first and the log second.
- [x] Given one user who sends the same `id` twice in quick succession, when the room processes both, then the room neither crashes nor stores two copies.
- [x] Given a commit resubmitted from the recovery journal after a crash, when it reaches the room, then it is applied exactly once, whether or not the first copy was stored.

**Evidence:** `packages/authority/test/room.test.ts` ("deduplicates a resubmission while the first copy waits for storage, and after it is stored", "refuses another user's commit identifier") and `room-scenarios.test.ts`, "deduplication": a resubmission on a second channel of the same user attaches, and both channels are acknowledged with seq 1, the rebuilt acknowledgement carrying the steps; another user's waiting identifier is refused and the stored commit is the first user's; the same identifier sent twice in quick succession is stored once. The waiting commits are searched before the log (`room.ts`, step 2). `convergence.property.test.ts`: G4 over 1,000 schedules with dropped connections, unknown write outcomes and room crashes, after which clients resubmit their in-flight commit.

**Notes:** review SYNC-1 found that waiting commits were missed and a duplicate identifier could crash a room. A conflict on the commit identifier during the write is a duplicate, not another writer (SYN-016). The harness client's in-flight commit stands in for the recovery journal, which is FE's.

### SYN-009 Reject commits with an impossible or too distant base

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 04 §5 step 3, §3.2, §16; 05 §5.1 (`maxRebaseSteps`) · **Requirements:** R7 · **Depends on:** SYN-006

As an author, I want a commit based on a version the authority cannot reconcile to be refused with a clear instruction, so that my client knows whether to wait, resubmit or reload.

**Acceptance criteria**

- [x] Given a commit whose `base` is greater than the tentative head, when it is submitted, then it is rejected with `invalid_op` and action `reload`.
- [x] Given a commit whose `base` is so old that more than `maxRebaseSteps` steps (target default 5,000) have been accepted since, when it is submitted, then it is rejected with `stale_base`.
- [x] Given a snapshot commit that lies after the commit's `base`, when it is submitted, then it is rejected and not rebased (the code and action are in Open questions).
- [x] Given a commit whose `base` equals the tentative head, when it is submitted, then the rebase step is skipped and processing continues with apply.
- [x] Given any of these rejections, when it is sent, then it carries the current `head` and no `seq` is consumed.

**Evidence:** `packages/authority/test/room.test.ts` ("refuses a base ahead of the head with reload, and a base too far behind with stale_base", with the head; a commit at the head is acknowledged with `rebased` false) and `room-scenarios.test.ts`, "consumes no seq for a rejected base". 2026-11-13 (criterion 3): `packages/authority/test/room-commits.test.ts`, "refuses a step commit whose base is older than a snapshot with stale_base and rebase, without rebasing it" (the snapshot is also one still waiting to be stored), and `test/projection.steps.test.ts`, "refuses a reader commit whose base is older than a snapshot with stale_base and rebase".

**Notes:** `maxRebaseSteps` is described as a guess in 04 §16; SYN-038 calibrates it. Criterion 3 was not met while snapshot commits did not exist; they are stored now (SYN-005), so it is ticked on 2026-11-13.

### SYN-010 Rebase a commit over everything accepted since its base

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 04 §5 step 4, §6; ADR 0001; review SYNC, CONV-1 · **Requirements:** R7 · **Depends on:** SYN-001, SYN-002, SYN-009

As an author, I want my commit mapped over concurrent commits from other people instead of refused, so that editing at the same time works.

**Acceptance criteria**

- [x] Given a commit with `base` less than the tentative head, when it is rebased, then its steps are mapped over every step accepted after `base` with the procedure of 04 §6 (invert the commit's own maps, append the accepted maps, map each step with the mirror), and the output equals the golden fixtures of SYN-002.
- [x] Given a step that maps to nothing or fails to apply after mapping, when the commit is rebased, then the whole commit is rejected with `rebase_failed`, with no partial application (the client procedure drops such steps; the authority does not).
- [x] Given a client that sends steps inconsistent with its claimed base, when the commit is processed, then only the mapped steps are applied and they go through apply, invariants and the outcome check, so the client gains nothing.
- [x] Given random inputs, when the authority's rebase is compared with `rebaseSteps` of prosemirror-collab in a differential test, then the mapped steps are identical except where the authority rejects.
- [x] Given the position maps of recent steps, when the room needs them, then they are derived from the stored steps and kept at least `maxRebaseSteps` back, without loading any older document version, and they are rebuilt from the log tail after a restart.

**Evidence:** `packages/authority/src/rebase.ts` (`rebaseOver`, reject and drop modes). `test/engine.test.ts` replays `fixtures/engine/golden/rebase.json` (44 cases, 16 with dropped steps). `test/rebase.differential.test.ts` against prosemirror-collab's `receiveTransaction` (399 random pairs compared on 2026-11-06, 11 with dropped steps; reject mode gives the same steps or `rebase_failed`). `test/room-scenarios.test.ts`, "rebase": a step whose range was deleted gives `rebase_failed` with action `rebase` and nothing of the commit is applied; steps aimed at the current document under an old base land, after mapping, in the restricted region and are refused by the outcome check. The room keeps the maps of every stored commit, derived from its steps, and the constructor rebuilds them from the log (388 failovers in the 1,000-schedule S3 run).

**Notes:** a reviewer checked the procedure index by index against prosemirror-collab (review section 2). The differential test keeps that check alive. Until checkpoints exist (BE-020) a new room replays the whole log, and it keeps every map rather than only `maxRebaseSteps` of them; trimming is BE's.

### SYN-011 Apply the steps and check the document invariants

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 04 §5 steps 5 and 6; 03 §8 (I1 to I12) · **Requirements:** R7, R10 · **Depends on:** SYN-010, CDM-013

As an author, I want a commit that would leave the document invalid to be refused whole, so that the document is always valid whatever any client sends.

**Acceptance criteria**

- [x] Given mapped steps, when applying them to the tentative document fails, then the commit is rejected with `invalid_op` and the tentative and durable states are unchanged.
- [x] Given a result that violates any of I1 to I12, when the invariants are checked, then the commit is rejected with `invalid_op`, with one test per invariant.
- [x] Given commits built from each of the seven allowed step types, including `attr`, `addMark` and `addNodeMark`, whose position maps are empty, when each produces a violation, then each is caught by the invariant check.
- [x] Given the same document, when `checkInvariants` and the CDM's `model.validate()` are run on a shared corpus, then they report the same violations.
- [x] Given a commit that is rejected here, when the room continues, then the next submission is validated against the same state as before.

**Evidence:** `packages/authority/test/room-scenarios.test.ts`, "apply and invariants": a commit whose second step cannot apply is `invalid_op`, the document is unchanged and the next commit on the same base is acknowledged at seq 1; one commit per invariant I1 to I12 (and I3 for a retired identifier) is refused with `invalid_op` by the invariant check, whose reason names the invariant; results of all seven step types are caught, a removal at the end of a commit included. `test/corpus.test.ts`: on the corpus documents `pages-1`, `form-fields` and `pages-20` (`@docedit/corpus`) and on commits that break them, `checkInvariants` and `model.validate()` agree, the first violation reported identically. `invariants.test.ts`.

**Notes:** the invariants for fields (I13 to I15) are checked by SYN-012. I9, I12 and the `latex` and column limits of I7 are attribute grammars, so the validator reports them as I11; the commit is refused either way.

### SYN-012 Check the field invariants I13 to I15

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | must | Maintainer |

**Spec:** 04 §5 step 6; 12 §3.6 (I13 to I15) · **Requirements:** R13 · **Depends on:** SYN-011, FRW-005

As an owner, I want the authority to refuse a commit that breaks the rules about fields, so that field keys, assignees and rule references stay consistent for everyone.

**Acceptance criteria**

- [x] Given a commit that duplicates a field key, assigns a field to a role that does not exist, or deletes a `role_def` that is still referenced, when it is checked, then it is rejected with `invalid_op` (I13).
- [x] Given a commit that leaves a rule or a `formValue` field pointing at a missing field key, or creates a cycle in the graph of `set` effects and formulas, when it is checked, then it is rejected with `invalid_op` (I14).
- [x] Given a commit that takes the document above 2,000 fields or 500 rules, gives a value more than 4 KiB, or gives a `value` of the wrong type for its kind, when it is checked, then it is rejected with `invalid_op` (I15).
- [x] Given a fill commit with a wrongly typed value from a user who holds only `fill`, when it is processed, then the code is `field_invalid` as P7 requires, not `invalid_op`.

**Evidence:** `packages/authority/test/room-scenarios.test.ts`, "I13: rejects a duplicate field key, an assignee that is no role, and deleting a role still used" (each `invalid_op`); `room.test.ts`, "refuses a wrongly typed fill with field_invalid (P7)"; the I13 and I15 checks themselves are in `packages/model/src/validate/validate.ts` (`validate.test.ts`, "I13 and I15"). Criterion 2, the rule half (2026-11-06): `RULE_INVARIANTS` (`packages/authority/src/room/rules.ts`) runs `@docedit/rules` on every commit through the model's registration point (`checkInvariants`, `src/invariants.ts`): `test/room-rules.test.ts` refuses a rule that reads a key that does not exist and a cycle of two formulas with `invalid_op`, the reason naming I14 and the keys on the cycle; the `formValue` half and I15 are the model's (`validate.ts`).

**Evidence (criterion 3, lane V-SYN-001-018, 2026-11-13):** `packages/authority/test/syn-012-p7-code.test.ts` (Node.js, `pnpm vitest run --project node`): an editor's value of 4,097 characters and an editor's number in a text field are refused whole with `invalid_op` and `drop`, the reason naming I15; a filler's wrongly typed value gives `field_invalid` (criterion 4). The room decides the code at step 6 (`Room.submit`, `room.ts`, `fillOnly`): `field_invalid` only when the connection holds `fill` and no `edit`, as P7 says, and `invalid_op` otherwise. `packages/authority/test/room.test.ts`, `permissions.room.test.ts`, `syn-012-i15-limits.test.ts` still pass.

**Notes:** the interaction between I15 and P7 (which code wins for a wrong type) is for FRW to confirm; the story follows 12 §4.2. 2026-11-13 (lane V-SYN-001-018): the reading applied is the text of 12 §4.2 P7 (`field_invalid` for a user with `fill` and not `edit`, `permission_denied` for others) with I15 giving `invalid_op` for everyone else, as criterion 3 states. FRW should confirm it; the invariant check in `packages/authority/src/invariants.ts` still returns `field_invalid` for any value-only violation, and the room narrows it. 2026-11-13 (lane U-SYN-001-018): `packages/authority/test/syn-012-i15-limits.test.ts` (Node.js, through the room) shows that a commit taking the document to 2,001 fields is refused `invalid_op` with reason I15, that 1,999 new fields (2,000 in all) are acknowledged, that a 4,097-character value is refused whole with `field_invalid` (accepted as the open P7 interaction, `invalid_op` or `field_invalid`), and that a 4,096-character value is acknowledged. Criterion 3 stays unticked: the wrongly typed value's code is open. 2026-11-13 (lane U-SYN-001-018, round 4): the 500-rule limit through the room is now tested in `packages/authority/test/syn-012-rule-limit.test.ts` (Node.js; a 501st `rule_def` is refused `invalid_op` with reason I15, a 500th is acknowledged). (3) is met (lane V-SYN-001-018, 2026-11-13; see the Evidence and the Notes above): the room now answers `invalid_op` for an editor's wrongly typed value, as this criterion says, and `field_invalid` only for a fill-only user.

### SYN-013 Call the outcome check and write only under the grants revision it used

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 04 §2 (G7), §5 steps 7 and 9; 07 §5, §9; 06 §2.3; review PERM-1 · **Requirements:** R3, R10 · **Depends on:** SYN-011, PRM-009, BE-017, BE-024

As an owner, I want a revoked person to be unable to store a change even if the room never heard about the revocation, so that a lost notification cannot leave a hole in the permissions.

**Acceptance criteria**

- [x] Given a rebased commit that passed apply and invariants, when step 7 runs, then the room calls the outcome check on the document before and after the commit with the permissions in force at that moment, and notes the access revision it used.
- [x] Given a violation, when it is found, then the commit is rejected with `permission_denied`, action `drop`, and the list of offending scopes.
- [x] Given a batch to store, when the room writes it, then the write is conditional on the room's ownership epoch and on the grants revision the batch was checked against still being current, and the log's primary key is (document, `seq`).
- [x] Given a grants change committed to the database between the check and the write, when the room writes, then the commit is not stored and is rejected with `unavailable`; when the client resubmits it, then it is checked against the new permissions.
- [x] Given a grants change whose notification to the room is dropped, when a commit checked against the old revision is written, then the write still refuses it and the room reloads grants (property test with the notification dropped).
- [x] Given a commit made under old permissions and processed under new ones, when it reaches step 7, then it is rejected with `permission_denied`.

**Evidence (criterion 3, lane U-SYN-001-018, PostgreSQL in Podman, 2026-11-13):** `services/document-service/test/postgres/fencing.pg.test.ts` ("two nodes that both believe they own a document append the same seq at once: one is stored, the other stops"; "the primary key refuses a second commit at a stored seq even when the head check is passed") and `revision-race.pg.test.ts` ("a write that holds the revision row makes a grant change wait until it has committed"; "once a grant change has returned, no write checked against the old revision is stored (interleaved, 20 rounds)"). Run with `pnpm vitest run` on those two files: 5 tests passed against the shared `docedit-test-postgres` (skips would show in the summary; none did).

**Evidence:** `packages/authority/test/room-scenarios.test.ts`, "the outcome check and the grants revision": a commit is stamped with the scopes the check found and revision 7, the revision it was checked under; a commit touching a writable and a non-writable region is refused with `permission_denied`, `drop`, the head and only the offending scope; a rebased commit is checked against the revoked grant and against a region another user created meanwhile. `room.test.ts`, "refuses a write made under replaced permissions, reloads them and records a control commit (G7)". `convergence.property.test.ts`: 986 grant changes with the notification lost in 1,000 schedules, and every stored commit checked by the oracle under the revision it records.

**Notes:** the check itself is PRM's; this story proves the call site and the condition. The reason for `unavailable` instead of `permission_denied` when the revision moved is in 04 §5 ("When a write fails"). Criterion 3 is met (lane U-SYN-001-018, 2026-11-13) by the PostgreSQL tests named in its Evidence: the write carries the epoch, the revision and the first `seq`, and the primary key (document, `seq`) refuses a second writer.

### SYN-014 Stamp each commit with server-side attribution

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 04 §2 (G6), §3.1, §5 step 8; 08 §2; 10 §3.2 · **Requirements:** R4, R10 · **Depends on:** SYN-013

As an owner, I want the user, session and time of every change to come from the authenticated connection and the server clock, so that attribution is as strong as authentication and no client can forge it.

**Acceptance criteria**

- [x] Given an accepted commit, when it is ordered, then it is stamped with the user, the session, the server time, the scopes touched, the access revision, the schema version and the engine version.
- [x] Given a client that puts a user, session, agent or time into its commit or into its steps, when the commit is processed, then those values are ignored and the stamped values come from the connection and the server clock.
- [x] Given a commit from a delegated assistant identity, when it is stamped, then the agent comes from the authenticated identity; a commit with `origin: "assistant"` from a connection with no agent identity carries no agent.
- [x] Given two commits, when they are stored, then their `seq` values are consecutive within the incarnation.

**Evidence:** `packages/authority/test/room-scenarios.test.ts`: "stamps the scopes the check found and the grants revision it used" (scopes, revision, `cdm` 1, engine `pm-steps/1`); "attribution" (a commit claiming another user, session, agent and time is stored with the connection's user and session and the room's clock, and no agent; a connection with an agent identity stamps it, an `assistant` origin without one stamps none, and the two commits have consecutive `seq`). `convergence.property.test.ts`: G6 (every stored commit's user is the client that created it) and a gap-free log over 1,000 schedules. `Connection.agent` and `StoredCommit.agent` were added for this (`packages/authority/src/permissions/model.ts`, `room/types.ts`).

**Notes:** what is stored and chained is HIS-001 and HIS-002. Steps carry no identity in `pm-steps/1`; suggestion marks name a user, which P4 checks against the connection (07 §5.2). Where the agent identity comes from in a token is PRO's.

### SYN-015 Acknowledge and broadcast in sequence order, only after storage

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | M | must | Maintainer |

**Spec:** 04 §2 (G2, G5), §5 step 10, §7; 05 §5.3; 00 §9 · **Requirements:** R7 · **Depends on:** SYN-014

As an author, I want my change confirmed only once it is safely stored, and other people's changes to reach me in order without gaps, so that nothing I see can be lost or reordered.

**Acceptance criteria**

- [x] Given a commit, when the write succeeds, then the room advances the durable state, sends `sync.ack` to the author and `sync.commit` to every other subscriber, and does neither before the write has succeeded.
- [x] Given an acknowledgement, when it is built, then it carries `id`, `seq`, `serverTime` and `rebased`, and when `rebased` is true it also carries the mapped steps.
- [x] Given any channel, when messages are sent, then they are sent in `seq` order: an acknowledgement or a rejection is never sent before all commits with a lower `seq` have been sent on that channel.
- [x] Given a stream of commits on an open channel, when a client checks it, then every commit after its resume point arrives in order, so that the client can detect a gap (G5).
- [ ] Given the reference deployment of stage 1 in one region, when acknowledgement latency is measured, then it is recorded against the target of 50 ms at the median and 300 ms at the 99th percentile.

**Evidence:** `packages/authority/test/room.test.ts`: nothing is sent before the write succeeds, then `sync.ack` to the author and `sync.commit` to the others; a rebased acknowledgement carries the mapped steps; the acknowledgement is `{ id, seq, time, rebased, steps? }` in the room's in-process form, `time` being DEP's `serverTime`. `test/harness/sim.ts` now watches every message the room sends on every channel: commits strictly one after another from the channel's starting point, no acknowledgement ahead of the commits before it, no rejection whose head was not yet delivered, and `sync.caughtUp` at the last delivered commit; `convergence.property.test.ts` checked 23,415 such messages over 1,000 schedules on 2026-11-06 without a violation.

**Notes:** the latency target is 00 §9; storage latency dominates it (04 §12), so it is measured end to end, not for the authority alone (SYN-040). Not met: (5) needs the stage-1 reference deployment (BE). Lane w4 (2026-11-15), no tick: the instrument exists (`dep_ack_latency_ms`, observed in `services/document-service/src/data-plane/room-host.ts` from the receipt of `sync.submit` to the acknowledgement; BE-086), but the deployment the criterion names does not. The only stack in the repository is the demo stack of `apps/reference-host/compose.json`, which says of itself that it is not a production deployment: one PostgreSQL with no synchronous standby (06 §6, stage 1 in hosted mode), on a development machine, in no region. A figure from it would not be the measurement asked for, so none was taken or recorded. The criterion waits for a stage-1 deployment in one region (the same blocker as SYN-040 criterion 3).

### SYN-016 Recover when a write fails or its outcome is unknown

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Operator |

**Spec:** 04 §5 ("When a write fails"), §9; 06 §2.3, §8; review TENT-1 · **Requirements:** R7, R9 · **Depends on:** SYN-015, BE-017, BE-024

As an operator, I want the room to fall back to what is really stored when a write fails, so that no client is left ahead of the server and no commit is half-applied.

**Acceptance criteria**

- [x] Given a write that fails with a known outcome, when the room recovers, then it discards the tentative state, continues from the durable state, and rejects the commits that were not stored with `unavailable` and action `retry`.
- [x] Given a write whose outcome is unknown (the database connection broke during the transaction), when the room recovers, then it re-reads the log tail before deciding, acknowledges commits that turn out to be stored and rejects the rest with `unavailable`.
- [x] Given a write refused because the grants revision moved, when the room recovers, then it rejects the commits with `unavailable` and clients resubmit; the resubmitted commits are checked against the new permissions.
- [x] Given a write refused because the ownership epoch or the primary key shows another writer, when the room recovers, then it stops serving the document and closes its channels with `ch.closed` and code `unavailable`.
- [x] Given a conflict on the commit identifier alone, when the room recovers, then it treats the commit as a duplicate (SYN-008) and does not stop serving.
- [x] Given any of these failures injected in the property suite, when the run ends, then no client holds a commit that the log does not have.

**Evidence:** `packages/authority/test/room-commits.test.ts`, "storage outcomes (SYN-016)": a commit whose identifier storage already holds is acknowledged as a duplicate, the room keeps serving, and another user's commit with that identifier is refused with `invalid_op`; the harness storage (`test/harness/storage.ts`) reports the `duplicate` outcome of `WriteResult`. `packages/authority/test/room.test.ts`: a failed write rejects every unstored commit with `unavailable` and `retry` and returns to the durable state; an unknown outcome re-reads the tail, acknowledging what was stored and rejecting the rest; a moved revision rejects, reloads permissions, and the resubmission is refused under them; a fenced write stops the room and closes every channel with `ch.closed` and `unavailable`. `convergence.property.test.ts`: 1,266 injected write faults (failed; outcome unknown, stored or lost) and the writes refused on a moved revision, over 1,000 schedules, after which every acknowledgement names a stored commit (G2) and every client holds the log.

**Evidence (PostgreSQL, lane V-SYN-001-018, 2026-11-13, PostgreSQL in Podman, Node.js):** `services/document-service/test/data-plane/postgres.pg.test.ts`, "answers a resubmitted stored commit as a duplicate after a new room opened (BE-025)", passes against the real database: the `duplicate` outcome of the PostgreSQL write is what lets a resubmission be acknowledged once (criterion 5 on PostgreSQL). The failure injection of criteria 1 to 4 on PostgreSQL is not run here.

**Notes:** the transaction itself is BE's (06 §2.3). The suite that injects the failures is SYN-047 and BE-080. (5) is met at the room and in the storage contract: `WriteResult` in `packages/authority/src/room/types.ts` has the `duplicate` outcome. The PostgreSQL write that reports it is BE-017, and its run under the suite is SYN-047.

## Client: confirmed document and local edits

### SYN-017 Keep a confirmed document and rebuild from it

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | L | must | Author |

**Spec:** 04 §7; ADR 0001 (after the review); review CONV-1 · **Requirements:** R7 · **Depends on:** SYN-001, SYN-002

As an author, I want my editor to correct itself from a known-good copy of the document whenever my change is acknowledged or refused, so that I never end up with a document that differs from everyone else's.

**Acceptance criteria**

- [x] Given a running client, when it is idle or editing, then it holds a confirmed document at its confirmed `seq` with no unconfirmed steps, separate from the visible state.
- [x] Given a `sync.ack` with `rebased` false, when it arrives, then the client applies its own steps to the confirmed document, advances its confirmed `seq`, and rebuilds the visible state as the confirmed document plus its remaining local steps rebased over the change.
- [x] Given a `sync.ack` with `rebased` true, when it arrives, then the client applies the authority's mapped steps, not its own.
- [x] Given acknowledged steps and the client's own rebased steps, when their canonical JSON is equal, then the rebuild is a no-op and the visible document and the selection do not change.
- [x] Given a rejection or an acknowledgement that rebuilds the visible state, when the rebuild finishes, then undo history entries that belong to discarded steps are dropped and the selection is mapped through the change.
- [x] Given a mark step that overlaps another user's mark step and is then rejected, when the client corrects itself, then it rebuilds from the confirmed document and the result equals the authority's document; stored inverse steps are never applied.

**Evidence:** `packages/engine/src/sync/state.ts` (a port of the reference client); `packages/engine/test/sync-state.test.ts` (confirmed document block); undo entries of discarded work dropped and later work kept: `test/sync.mock.test.ts` ('permission_denied: the work is set aside, its undo entry dropped…'); overlapping marks end equal to the authority: 'rebuilds from the confirmed document…' and `test/sync.property.test.ts`.

**Notes:** CONV-1 found that removing steps with stored inverses is not exact for mark steps. The suite SYN-047 includes overlapping marks. Nothing is ticked here: the client belongs to the engine. `packages/authority/test/harness/client.ts` is a reference that keeps a confirmed document, applies the authority's steps when `rebased` is true, compares step lists by canonical JSON (`stepsEqual`) and rebuilds without stored inverses; the shared parts are `rebaseOver` in drop mode, pinned by the SYN-002 fixtures. The engine package adopts the algorithm. Second review (2026-11-06, SPK-027), SR-M1: under ADR 0019 a commit that touches hidden content reaches projected readers as one diff step from the first to the last change, which drops their concurrent edits in between and makes the no-op of the fourth criterion rare; the review proposes one diff step per changed range, and acknowledgements that carry the author's own steps mapped into their projection ([review](../review/2026-11-06-second-review.md)).

### SYN-018 Send local edits as one in-flight commit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Author |

**Spec:** 04 §3.1, §8 ("Local edit"), §16; 05 §5.1 (`limits`) · **Requirements:** R7 · **Depends on:** SYN-017, SYN-003

As an author, I want what I type to appear at once and to be sent promptly, so that editing feels immediate and my changes reach others quickly.

**Acceptance criteria**

- [x] Given a client with nothing in flight, when the user edits, then the steps are applied locally at once and a commit with the queued steps is sent immediately, with `base` equal to the confirmed `seq` and a fresh UUID as `id`.
- [x] Given a commit in flight, when the user edits further, then the steps join the queue, at most one commit is in flight, and the next commit is sent when the acknowledgement arrives.
- [x] Given continuous typing, when the client batches, then it waits at most 100 ms (target) before sending, and the 100 ms rule is a configuration value, not a constant.
- [x] Given a queue larger than `maxStepsPerCommit` or `maxCommitBytes` announced in `welcome`, when the client sends, then it splits the queue into successive commits that each respect the limits.
- [x] Given a commit that is resubmitted, when it is sent again, then it keeps its original `id` and, if its `base` is now old, its original steps.

**Evidence:** `packages/engine/src/sync/state.ts` (`takeCommit`, `resendCommit`), `src/sync/session.ts` (`batchMs`, default 100); `packages/engine/test/sync-state.test.ts` (SYN-018 block), `test/session.test.ts` ('sends at once when idle, one commit in flight, then batches…', 'retries the same commit with the same id…').

**Notes:** the sentence "send at once when idle and otherwise batch for at most 100 ms" does not say whether batching applies while a commit is in flight; this story reads it as a bound on idle-to-send delay. Commit granularity is an open issue (SYN-038). Behaviour while an input-method composition is in progress and remote commits arrive is decided by spike S1 SPK-014. Nothing is ticked here: the client belongs to the engine; the harness client of `packages/authority/test/harness/client.ts` (one commit in flight, a queue, resubmission with the same `id`) is a reference the engine package adopts.

### SYN-019 Apply remote commits and detect gaps

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Author |

**Spec:** 04 §8 ("`sync.commit` received"), §2 (G5), §8 closing paragraph · **Requirements:** R7 · **Depends on:** SYN-017, SYN-018

As an author, I want other people's changes to merge into my document without disturbing what I am typing, and to be told when something I typed could not be kept.

**Acceptance criteria**

- [x] Given a received commit, when its `seq` is not the confirmed `seq` plus one, then the client treats it as a gap, closes the channel and reopens it with a resume (SYN-028).
- [x] Given a received commit with the expected `seq`, when it arrives, then the client applies its steps to the confirmed document and rebases the in-flight and queued steps over them.
- [x] Given a local step that can no longer apply because another user removed the content it applied to, when the client rebases, then the step is dropped, the rest of the local work stays, and the user is told that typed text was dropped UX-016, UX-017.
- [x] Given a received commit that carries the in-flight commit's `id`, when it arrives, then the client treats it as the acknowledgement.
- [x] Given a received control commit, when it arrives, then the client advances its confirmed `seq` and changes no content.
- [x] Given a message that coalesces several commits (SYN-041), when it arrives, then the client applies them in ascending `seq` and checks each for a gap.

**Evidence:** `packages/engine/src/sync/state.ts` (`receiveCommits`); `packages/engine/test/sync-state.test.ts` (SYN-019 block); `test/session.test.ts` ('a commit that is not the next seq closes the channel and resumes…'); the dropped text reaches the `recovered` view (`test/sync.mock.test.ts`).

**Notes:** until SYN-028 is in place, reopening a channel without a resume makes the server answer `catchUp: "reload"` (05 §5.2), which is the 1a fallback. Nothing is ticked here: the client belongs to the engine. The harness client detects gaps, treats its own commit in the stream as the acknowledgement and rebases local steps with `rebaseOver` in drop mode, whose output the SYN-002 rebase fixtures pin; the engine package adopts the algorithm. The 04 "SHOULD tell the user" is satisfied by the notice; its presentation is UX's.

### SYN-020 Act on a rejection by its code and action

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Author |

**Spec:** 04 §8 (table), §7; 05 §5.3, §5.8; PRODUCT principle 2 · **Requirements:** R3, R7 · **Depends on:** SYN-017

As an author, I want a refused change to be handled the right way for its reason and explained to me, so that nothing is silently lost.

**Acceptance criteria**

- [x] Given `stale_base` or `rebase_failed` with action `rebase`, when the rejection arrives, then the client waits until its confirmed `seq` reaches the `head` in the rejection, then resubmits the rebased steps as a new commit with a new `id`.
- [x] Given `permission_denied` with action `drop`, when it arrives, then the client discards the rejected steps and rebuilds from the confirmed document plus later local steps that still apply, keeps the discarded content as recovered edits, and refreshes permissions.
- [x] Given `invalid_op` with action `drop`, when it arrives, then the client discards the steps; with action `reload`, it discards local state and reloads the document.
- [x] Given `too_large` with action `drop`, when it arrives, then the client splits the change and resubmits it, or reports it.
- [x] Given `busy`, `rate_limited` or `unavailable` with action `retry`, when it arrives, then the client resubmits the same commit with the same `id` after the indicated `retryAfterMs`.
- [x] Given `read_only` with action `drop`, when it arrives, then the editor switches to read-only.
- [x] Given any rejection, when it arrives, then the client reads the `head` it carries and keeps it for the wait in the first criterion.

**Evidence:** `packages/engine/src/sync/state.ts` (`receiveReject`), `src/sync/session.ts` (delays); `packages/engine/test/sync-state.test.ts` (SYN-020 block); against the real `Room`: `test/sync.mock.test.ts` (permission_denied, read_only, stale_base after a snapshot) and `test/sync.property.test.ts` (unavailable, read_only, stale_base, permission_denied and rebase_failed in one run). Criterion 2 (lane w4, 2026-11-15): the refresh is pushed by the room, not asked for by the client (ADR 0364, proposed). `packages/authority/src/room/room.ts` sends `perm.changed` with the access a refused commit was judged under, ahead of the `permission_denied` rejection, when the channel was last sent another access, and no longer overwrites the channel's recorded access at submission; `packages/protocol/src/bridge/room-bridge.ts` sends it at once. `packages/authority/test/syn-020-refresh-access.test.ts` (5 tests: the order `perm.changed`, `sync.reject`; the access equals `computeAccess` for the user at that instant; not sent twice; an accepted commit does not hide the change from the expiry run; nothing extra when `perm.changed` had already arrived). End to end against the real `Room`: `packages/engine/test/sync.mock.test.ts`, "permission_denied after a grant ran out: the access the room sends is applied": the rejected text is in recovered edits, the core's access has no `edit` in the region and a higher `rev`, and the guard refuses the next attempt.

**Notes:** the explanation shown for `permission_denied` (which region, who changed it) is PRM's (07 §9) and the presentation is UX's. Nothing is ticked here: the client belongs to the engine; the harness client acts on `retry`, `rebase` (waiting for the head), `drop` and `reload` as a reference the engine package adopts. The treatment of `stale_base` with a snapshot is in Open questions. Criterion 2 met on 2026-11-15 (Evidence; ADR 0364 is proposed and not reviewed by the owner): the client applies the `perm.changed` the room now sends with the rejection; `core.ts` still ignores the `permissions-stale` event, which is left for a host that explains the denial (07 §9). Earlier audit (2026-11-13): the `permission_denied` criterion was unticked because "refreshes permissions" is not done: the engine only emits a `refresh-permissions` action and a `permissions-stale` event, which `core.ts` ignores (it only republishes), and nothing fetches the access object (ADR 0260 item 4, ADR 0349); the test asserts the action name only, and the rest of the criterion (discard, rebuild, recovered edits) is met and tested. Second review (2026-11-06, SPK-027): SR-K1 settles it (`rebase`, 04 §3.2 as edited). SR-M30 proposes that every rejection with action `drop` or `reload` keeps the discarded content as recovered edits, not only `permission_denied`, which would change the `read_only` criterion. SR-N25: `quota_exceeded`, `forbidden` and `internal` can reach `sync.reject` with no client action in 04 §8 ([review](../review/2026-11-06-second-review.md)).

### SYN-021 Handle rejected fills

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | S | must | Participant |

**Spec:** 04 §8 (table); 12 §4.2 (P7, P9), §10 · **Requirements:** R13 · **Depends on:** SYN-020, FRW-008, FRW-010

As a participant, I want to see the current value or the validation message when my entry is refused, so that I know what to correct.

**Acceptance criteria**

- [x] Given a fill rejected with `conflict` because another commit changed the same field after the commit's `base`, when the rejection arrives, then the client discards my fill and shows the other value; values are not merged.
- [x] Given a fill rejected with `field_invalid`, when the rejection arrives, then the client discards the fill and shows the validation message.
- [x] Given either rejection, when it arrives, then the action is `drop` and my other pending local steps are kept where they still apply.

**Evidence:** `packages/engine/src/sync/state.ts` (`receiveReject`, `dropInflight`: the fill is set aside with its code as reason and the queue is rebased over the confirmed document); `packages/engine/test/sync-state.test.ts` (describe 'rejected fills (SYN-021)': 'a conflict discards the fill and shows the other value; the values are not merged', 'a field_invalid discards the fill and reports the validation message', and the `it.each` over `conflict` and `field_invalid` for the kept queue).

**Notes:** the engine emits the rejection's message in a `report` action and keeps the other value in the confirmed document; how the value and the message are shown is the element's (FE) and UX's. The codes come from `packages/protocol` (`errors.ts`). FRW-008 and FRW-010 (the fill commands and their validation) are not built, so the rejections are driven by hand in the state tests and not by a real fill. Proposed defaults (not decided here): none.

### SYN-022 Rebase the undo history over remote commits

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 04 §8 ("Undo and redo"), §3.1 · **Requirements:** R1, R7 · **Depends on:** SYN-018, SYN-020, FE-049

As an author, I want my undo entries kept valid as other people's commits arrive, so that undo takes back exactly my own change, however much has been edited around it.

**Acceptance criteria**

- [x] Given my change followed by remote commits, when the client rebases my undo entry over their steps, then inverting the entry removes only my change, rebased over everything since, and the other users' changes stay.
- [x] Given a remote commit removed the content my undo entry would touch, when the entry is rebased, then the affected step is dropped without corrupting the document.
- [x] Given I undid a change and remote commits arrive before I redo it, when the redo entry is rebased over them, then redo restores my change at its mapped position.
- [x] Given an undo that would change a scope where I no longer have permission, when the authority rejects it with `permission_denied`, then the client handles the rejection as in SYN-020 and my undo history stays consistent.

**Evidence:** `packages/engine/test/undo-rebase.test.ts` (describe 'undo history rebased over remote commits (SYN-022)'): undo over three remote commits removes only my change; a remote deletion of the undone text leaves the document equal to the room's; redo after remote commits lands at the mapped position; an undo refused with `permission_denied` (held write, grant removed first) leaves the paragraph with the change and an empty undo history. The rebuild pairing is `src/sync/state.ts` (`rebaseLocal`, `confirm`); the history is prosemirror-history.

**Notes:** The commands, the editing behaviour, the origins `undo` and `redo` on the commit and the history plugin are FE-049's; this story covers only the client algorithm that rebases the undo history over remote commits (04 §8).

### SYN-023 Reload on a snapshot reset

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Author |

**Spec:** 04 §8 ("`sync.reset` received"), §3.2 · **Requirements:** R4, R7 · **Depends on:** SYN-019, SYN-005

As an author, I want my editor to switch to the restored or imported document and to keep whatever of my typing still fits, so that a whole-document change does not cost me work.

**Acceptance criteria**

- [x] Given a `sync.reset` with a `seq`, when it arrives, then the client fetches the content at that `seq`, replaces its confirmed document with it and sets its confirmed `seq`.
- [x] Given local steps in flight or queued, when the confirmed document is replaced, then the client tries to re-apply them, and those that fail go to recovered edits.
- [x] Given an in-flight commit whose `base` is older than the snapshot, when the authority rejects it with action `reload`, then the client does not resubmit it unchanged.
- [x] Given the reset is handled, when the next commit arrives, then the client expects the reset's `seq` plus one.

**Evidence:** `packages/engine/src/sync/state.ts` (`reset`, `receiveCommits`, the `rebase` case of `receiveReject`); `packages/engine/src/sync/session.ts` (a reset without content loads it at `seq`); `packages/engine/test/sync-state.test.ts` (describe 'reset on a snapshot (SYN-023)': the confirmed document and seq are replaced; re-applied steps keep their order and a step that cannot apply is set aside as `reset`; no unchanged resend after `stale_base`; the next commit must be the reset seq plus one); `packages/engine/test/sync.mock.test.ts` ('a snapshot commit: reset reloads the content; an old base gets stale_base and is resubmitted') for the fetch through the room.

**Notes:** Second review (2026-11-06, SPK-027), SR-K1: the rejection of an in-flight commit whose base is older than the snapshot is now `stale_base` with action `rebase` (04 §3.2 as edited), so "action `reload`" in the third criterion changes: the client resubmits its re-applied steps as a new commit with a new `id`. SR-M9: under ADR 0019 an access change is a close and a forced reload, which should also purge undo history, caches and journal entries holding content that is now hidden ([review](../review/2026-11-06-second-review.md)).

> SYN-024 (Flush unconfirmed work on demand) was merged into FE-012 during the cross-check of 2026-11-06.

> SYN-025 (Keep unconfirmed work in the recovery journal and resubmit it) was merged into FE-008 during the cross-check of 2026-11-06.

## Reconnect and resume

### SYN-026 Decide how a resuming channel catches up

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Maintainer |

**Spec:** 04 §9 steps 2 to 4; 05 §5.1 (`catchUpCommits`, `catchUpBytes`), §5.2; 07 §8; review ROUTE-1 · **Requirements:** R7, R9 · **Depends on:** SYN-015, SYN-029, HIS-024

As an author, I want a reconnect to bring me up to date in the cheapest safe way, so that a short outage costs nothing and a long one never leaves me with a wrong document.

**Acceptance criteria**

- [x] Given a `ch.open` with `resume` (`seq`, `incarnation`, `inflight`), when the server answers, then `ch.opened` carries `head`, `incarnation`, `catchUp` (`stream`, `page` or `reload`) and `inflight` (`accepted` with its `seq`, or `unknown`).
- [x] Given a `ch.open` without `resume`, or a different incarnation, or a client `seq` greater than the head, when the server answers, then `catchUp` is `reload`.
- [x] Given a gap within the catch-up limits (target default 5,000 commits or 5 MiB) and within what the user may see, when the server answers, then `catchUp` is `stream`: it sends the commits from `resume.seq` plus one to `head`, then `sync.caughtUp`, then live commits.
- [x] Given a gap beyond the limits, when the server answers, then `catchUp` is `page` and the client reads `GET /documents/{id}/commits`, or the server answers `reload`.
- [x] Given a `resume.seq` below the visibility gate for the user, when the server answers, then `catchUp` is `reload` and no old commits are sent.
- [x] Given an `inflight` identifier that is stored, when the server answers, then `inflight` is `accepted` with the stored `seq`; given one that is not stored, then `unknown`.

**Evidence:** Decided in ADR 0034 (proposed) and built in `Room.open` (`packages/authority/src/room/room.ts`): `test/room-resume.test.ts`, 'how a resuming channel catches up': `ch.opened` carries `head`, `incarnation`, `catchUp` and `inflight`; no resume, another incarnation or a seq beyond the head reloads; within `catchUpCommits` and `catchUpBytes` (`Limits`, defaults 5,000 and 5 MiB) the commits stream, then `sync.caughtUp`; beyond them `page` when the host serves the commits resource (`RoomInit.commitsResource`), else `reload`, and a paging client goes live from the head; a resume below the visibility gate or across a snapshot reloads with no old commit sent; `inflight` is `accepted` with its seq only for the caller's own stored commit, `unknown` otherwise (a waiting commit included, ADR 0034), on a reload too.

**Notes:** a commit that is waiting to be stored when the channel opens has no named state in 05 §5.2. Answering `unknown` is safe because deduplication (SYN-008) attaches a resubmission to the pending acknowledgement. Decided in ADR 0034 (proposed) with the rest of this story: `page` only when the host serves the commits resource, nothing streamed and no `sync.caughtUp` on `page`, and `reload` behind the projection gateway, which cannot page yet.

### SYN-027 Subscribe and stream without a missed or repeated commit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 04 §9 step 4; 05 §5.2 ("Joining"); review ROUTE-1 · **Requirements:** R7 · **Depends on:** SYN-026

As an author, I want the missing commits and the live commits to join up exactly, so that a reconnect never skips or repeats a change.

**Acceptance criteria**

- [x] Given a channel opened with `catchUp: "stream"`, when commits are stored while the missing commits are being sent, then every commit from `resume.seq` plus one onward is delivered exactly once and in order, with no gap and no duplicate.
- [x] Given `head` in `ch.opened`, when the channel is attached, then it is the durable head at that moment and the first live commit the client receives is `head` plus one.
- [x] Given the ordering rule of SYN-015, when catch-up and live messages interleave, then an acknowledgement or a rejection is still never sent before lower commits on that channel.
- [x] Given a stress test with commits arriving during a stream of 5,000 commits (target), when the client compares what it received with the log, then the two are equal.

**Evidence:** Criteria 1 and 3, on the room (lane authority-3): `packages/authority/test/catch-up.stream.test.ts`, "delivers each commit once and in order when commits are stored during the stream" (commits 2 to 5 reach the resumed channel once each, in order, with `sync.caughtUp` between commits 3 and 4) and "never sends an acknowledgement before a lower commit on the same channel" (the broadcast of commit 2 precedes the acknowledgement of commit 3). Criterion 4: `packages/authority/test/catch-up.stress.test.ts`, "the client receives exactly the log, each commit once and in order, with commits stored mid-stream" (5,000 commits streamed from seq 0, three more commits stored between chunks of 500 messages; the received commits equal the log by identifier, steps and order, and applied in order they give the room's document). Criterion 4: `packages/authority/test/catch-up.stress.test.ts`, "the client receives exactly the log, each commit once and in order, with commits stored mid-stream" (5,000 commits streamed from seq 0; three more commits stored between chunks of 500 messages; the received commits equal the log by identifier, steps and order, and applied in order they give the room's document). Criterion 2: `services/document-service/test/data-plane/sync.test.ts` "streams from resume.seq + 1 to head, then sync.caughtUp, then live commits from head + 1" (`ch.opened` with head 3, `sync.caughtUp` at 3, then the first live commit is 4). Criterion 1 is partly shown by `test/data-plane/session-1b.test.ts` "bounded send queues (BE-027)" (a resume gets every commit once), but there the commits were stored before the resume, not during the stream.

**Notes:** Criteria 1 and 3 are met at the room (lane authority-3). The room is synchronous, so its stream is one set of effects; the test holds the effects not yet delivered while commits are stored. The socket queue between the room and the client is BE's, and the data-plane test (`sync.test.ts`) does not yet cover it. The sim in `test/data-plane/sim/dep-sim.ts` checks the order of catch-up and live messages, but `test/data-plane/convergence.test.ts` currently fails on a coverage assertion (`invalid_op` never seen), so it is not cited as evidence. Criterion 4 (2026-11-13, lane SYN-015-028): `packages/authority/test/catch-up.stress.test.ts` streams 5,000 commits to a reader that resumes at seq 0, and stores 3 commits, one after each chunk of 500 messages, while the stream is sent; what the reader keeps equals the log the room wrote (each seq once, in order, every commit equal), with `sync.caughtUp` (head 5,000) between commits 5,000 and 5,001. The chunking models the host's queue, not the wire. No timing is asserted.
### SYN-028 Reconnect and resubmit in-flight work

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | L | must | Author |

**Spec:** 04 §8 ("No answer"), §9; 05 §4 (reconnection); review DR-1, ROUTE-1 · **Requirements:** R7, R15 · **Depends on:** SYN-019, FE-008, SYN-026, SYN-027

As an author, I want my editor to reconnect on its own and carry on from where it was, so that a network drop or a restart of the server costs me nothing I typed.

**Acceptance criteria**

- [x] Given a gap in received `seq`, a submitted commit not answered within `ackTimeoutMs` (target default 15,000), or a lost connection, when the client notices, then it closes and reopens the channel with `resume: { seq, incarnation, inflight }` where `inflight` is the `id` of the in-flight commit, if any.
- [x] Given `catchUp: "reload"`, when the channel opens, then the client fetches the content at `head`, replaces its confirmed document, and moves unconfirmed work that no longer applies to recovered edits.
- [x] Given `catchUp: "stream"`, when commits and `sync.caughtUp` arrive, then the client applies them as in SYN-019 and goes live after `sync.caughtUp`.
- [ ] Given `catchUp: "page"`, when the channel opens, then the client reads the missing commits from `GET /documents/{id}/commits`, then expects `head` plus one.
- [x] Given `inflight` is `unknown`, when `sync.caughtUp` arrives, then the client resubmits the commit with the same `id` and only then; given `accepted`, the client finds the commit in the catch-up stream and does not resubmit it.
- [x] Given a room host that crashes and restarts during an edit, when the client reconnects, then no acknowledged commit is missing, the client is not ahead of the server, and the in-flight commit is applied once.

**Evidence:** criterion 1: `packages/engine/src/sync/session.ts` (`resume` with `inflight`, the ack timeout, a close with `unavailable`); `packages/engine/test/session.test.ts` ('a commit that is not the next seq closes the channel and resumes from the confirmed seq'; 'a commit not answered within ackTimeoutMs resumes with the in-flight commit named'; 'a resume echoes the view token…' for the close with `unavailable`). Criteria 2, 3 and 5: `packages/engine/test/sync-resume.test.ts` ('a catch-up reload replaces the confirmed document and sets the unconfirmed text aside'; 'accepted: the stream carries the commit under its id, so it is not resubmitted'; 'unknown: resent with the same id only after the stream has caught up'; 'commits are applied in order, and nothing is sent before the live state arrives'). Criterion 6 (lane U-SYN-019-036, PostgreSQL 17 in Podman, `services/document-service/test/data-plane/syn-028.restart.pg.test.ts`, run with `pnpm vitest run` on that file): the host is killed with a commit held in the persist step, once before the store is reached and once after; a new host opens the same PostgreSQL stores; every acknowledged commit is in the log, the resumed head is the stored count and never below the confirmed seq, and the in-flight commit is stored once at seq 3 (rows checked in `doc_commits`).

**Notes:** the backoff schedule (0.5 s doubling to 30 s with full jitter) and `goaway` are PRO's (05 §4). The save-state wording while reconnecting is UX's. Engine status (2026-11-13): criteria 2, 3 and 5 are ticked by `test/sync-resume.test.ts`. Criterion 3 goes live on the channel's `live` state (`sync.caughtUp`); the session also goes live once the confirmed seq reaches the head (`test/session.test.ts`). Criterion 4 stays unticked: the session never reads `GET /documents/{id}/commits` (no port member does that), and a `page` catch-up reloads the content instead (ADR 0038). Criterion 6 is ticked (lane U-SYN-019-036) on PostgreSQL through the data plane; the in-memory version is `crash-recovery.test.ts`. The first run of the new file showed no product defect.

### SYN-029 Identify the log by an incarnation

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 04 §1, §9 step 3; 00 §9 (durability); 06 §8, §9; review DR-1 · **Requirements:** R7, R9 · **Depends on:** SYN-006, BE-081

As an operator, I want a log that has been rewound by a database recovery to get a new identity, so that clients holding commits the log no longer has are forced to reload instead of diverging silently.

**Acceptance criteria**

- [x] Given a document, when its log is created, then it has an incarnation identifier that appears in `ch.opened` and in content reads, and a `seq` is only ever interpreted together with its incarnation.
- [x] Given normal operation including room restarts, failovers and resumes, when the property suite runs, then the incarnation never changes.
- [x] Given a log that is rewound in a test and given a new incarnation by the operator procedure, when a client resumes with the old incarnation, then the answer is `catchUp: "reload"` and the client's unconfirmed work moves to recovered edits.
- [x] Given a client whose `seq` is greater than the head under the same incarnation, when it resumes, then the answer is `catchUp: "reload"`.
- [x] Given pinned content reads, when they are cached, then the `ETag` combines incarnation and `seq`.

**Evidence:** `test/room-resume.test.ts`, 'the log incarnation (SYN-029)': every `ch.opened` and inline content read names the incarnation; a log rewound by the operator procedure (`MemoryStorage.rewind` in the harness) and given a new incarnation makes a client that resumes with the old one reload, and its unconfirmed typing goes to recovered edits; a seq beyond the head under the same incarnation reloads. `test/harness/sim.ts` checks every `ch.opened` and every client's incarnation against the log's: none changed over `S3_RUNS=1000` with 345 failovers and 65 fenced writes. `packages/authority/src/room/content.ts`: `contentEtag(incarnation, seq)` and `ContentCache` keyed by both (`test/room-content.test.ts`); the HTTP response that carries the tag is the service's.

**Notes:** the operator procedure and recovery objectives are BE's (06 §8, §9).

## Server-authored commits

### SYN-030 Author commits on a user's behalf through the same steps

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 04 §10, §3.1, §5 (closing paragraph); 05 §5.3; 06 §3; review SRV-1 · **Requirements:** R4, R13 · **Depends on:** SYN-013, SYN-014, SYN-004, BE-017, BE-024, BE-039

As an owner, I want changes the service makes for me (a restore, a prefill, an import) to go through the same checks and the same log as my own edits, so that the service is never a way round the permissions.

**Acceptance criteria**

- [x] Given a restore, an import, a migration, a repair, a signature or date-signed or formula value, or a prefill, when the service authors the commit, then it goes through the same steps of 04 §5 as a client commit, with the requesting user (or `system`) as author and a reserved origin (`restore`, `import`, `migration`, `repair`, `sign`, `rules`, `prefill` or `control`).
- [x] Given a server-authored commit, when it reaches step 7, then it is checked against permissions like any other and is never exempt.
- [ ] Given the control plane has already authorised an operation, when it writes the request to the outbox, then the request carries a deterministic commit `id` and the preconditions it relied on, and the room re-checks those preconditions when it applies the commit.
- [x] Given a retry after a crash between the control plane and the room, when the request is delivered twice, then the commit is applied once and none is lost.
- [x] Given a server-authored commit broadcast to subscribers, when it is sent, then its `session` is null and its `author` names the requesting user or `system`.

**Evidence:** `Room.author` (steps: region restores, `sign`, `rules`, `prefill`) and `Room.snapshot` (import, restore, migration, repair), sharing steps 2 to 9 with client commits (`room.ts`, `process`). `test/room-commits.test.ts`, 'server-authored commits (SYN-030)': the author is the requesting user or `system` with a reserved origin (`control` stays the room's own); they are refused like any commit (P6, a restricted region, an approved region for `system`); a retry with the same deterministic id, delivered while the first waits and after it is stored, is applied once, for snapshots too; the stored commit's session is `system` (`SERVER_SESSION`), which DEP renders as a null session, with no agent. `convergence.snapshot.property.test.ts`: 153 restores retried after failed writes, each stored once.

**Notes:** the outbox table and delivery are BE's. The commit identifier is "derived for server-authored commits" (08 §2); the derivation is the control plane's. Not met: (3) the room requires a UUID version 7 id and re-checks the preconditions a request carries (`Preconditions`: grants revision, head, document state, workflow, region states; `room-commits.test.ts`), refusing a failed one with `conflict` and `drop` (ADR 0034: the spec names no code); writing the request to the outbox is the control plane's (BE). Lane U-SYN-019-036 (PostgreSQL in Podman): `services/document-service/test/data-plane/syn-030.outbox.pg.test.ts` delivers outbox items with a head precondition into a room over the PostgreSQL log: applied with the id, origin and `system` author; refused with `conflict` once the head has moved, with nothing stored; a redelivery of the same deterministic id stored once. 2026-11-13 (lane U-SYN-001-018): the control plane now writes the preconditions it relied on (`revision`, `head`, `documentState`, `workflowActive`) with an accepted prefill (`services/document-service/src/control-plane/field-routes.ts`), checked by `src/control-plane/syn-030-prefill-preconditions.test.ts` (memory storage); the room's re-check is covered on PostgreSQL by `test/data-plane/syn-030.outbox.pg.test.ts`. Criterion 3 stays unticked: the prefill's commit identifier is still `uuid7` of the request time, not a deterministic identifier, and the derivation is an open question (`docs/adr/0354-lane-U-SYN-001-018.md`).

### SYN-031 Run a transient authority for a document that is not open

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | should | Maintainer |

**Spec:** 04 §10; 06 §2.2 (last paragraph) · **Requirements:** R9, R13 · **Depends on:** SYN-030

As an operator, I want a prefill or an import on a closed document to run without opening a full room, so that bulk operations do not hold memory and timers for documents nobody is editing.

**Acceptance criteria**

- [x] Given a server-authored operation on a document that is not open, when it runs, then a transient authority loads the latest checkpoint and the log tail, applies the commit through the same algorithm as a room, stores it and exits.
- [x] Given the transient authority, when it finishes, then it leaves no subscribers, no timers and no held memory for the document.
- [x] Given the same commit applied once by a room and once by a transient authority on identical documents, when the results are compared, then the stored steps, scopes and hash are identical.
- [x] Given a retry with the same deterministic `id`, when the transient authority runs again, then the commit is applied once.

**Evidence:** `packages/authority/test/transient.resources.test.ts` (SYN-031 criterion 2, lane authority-3): "closes every channel, schedules no timers and holds no pending write" (after a run, the room has no channels, no pending writes and no timers from fake-timer counting) and "lets the garbage collector release the room after the run" (a `WeakRef` to the room is cleared after forced collections, `gc` exposed through `vm.runInNewContext`). `packages/authority/test/transient.test.ts`, "a transient authority applies a commit as a room does (SYN-031 criteria 3 and 4)": a room started from a checkpoint at seq 2 with an empty tail stores the same commit as a room with the whole history (same `seq`, steps, scopes and commit record), and the documents have equal SHA-256 canonical hashes; a retry with the same identifier is refused without a write, both when the stored tail holds the commit and when a run from the checkpoint applies it once and then sees the retry. Criterion 1 (host, round 4): `services/document-service/src/data-plane/transient.test.ts`, "applies a server-authored commit to a document with no open room, stores it, and leaves nothing held" and "loads the log tail when the document already has commits": `RoomHost.apply` on a closed document loads the checkpoint and the tail, stores the commit at seq 1 and then 2, and leaves no room registered and no transient in progress.

**Notes:** Criterion (1) is met at the host (see the Evidence above; BE-023 and BE-020). The authority's test starts a `Room` with `initial` and `initialSeq`, which is the same algorithm. (2) is tested on the room (lane authority-3): no channel, pending write or timer remains, and the room is collected. The room is the only per-document state in this package; the host's registry is BE's. The spec does not say how a transient authority and a room that opens at the same moment avoid two writers; the epoch and primary-key fence would stop the second, but the behaviour is not written down (Open questions).

## Comment ranges

### SYN-032 Map comment ranges through every commit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** ADR 0015; 04 §5 (durable state), 05 §10 (`mapRanges`); 07 §6 · **Requirements:** R8 · **Depends on:** SYN-001, SYN-006

As a commenter, I want a comment to stay attached to the passage it was made on while others edit around it, so that a thread still points at what it is about.

**Acceptance criteria**

- [x] Given a thread that targets a text range, when a commit is accepted, then the room maps the range through each step's position map and the durable state's ranges advance with the commit.
- [x] Given the commented text is deleted, when the range is mapped, then it collapses, stays collapsed even if the deletion is undone, and the thread is reported as detached.
- [x] Given a thread that targets a block (figure, table, equation) by identifier, when other content moves, then the thread keeps its target by identifier.
- [x] Given a list of ranges and a list of commits, when `mapRanges` is called, then it returns the mapped ranges and it also serves presence positions, with no document needed.
- [x] Given mapping happens, when a commit is stored, then no step, commit or `seq` is created for the comment: commenting never changes the document.
- [ ] Given the mapped ranges, when a checkpoint is written, then they are saved with it (BE-020).

**Evidence:** `packages/authority/test/threads.test.ts`, "mapping comment ranges through every commit (SYN-032)": "advances ranges with the durable state, and keeps a block target by its identifier"; "collapses a range whose text is deleted, reports it detached, and keeps it so after an undo"; "maps ranges and presence positions through stored commits with no document (mapRanges)"; and, for criterion 5, the first test of "mapping a requested range from its base to the head (SYN-033; PRM-037)" (the head, pending count and document JSON are unchanged after a thread is created); "commenting never changes the document (PRM-038)" shows that a comment-only connection's commit is refused. Criterion 6 is only partly met: "saves the anchors with the checkpoint before a snapshot" shows that the checkpoint effect carries the anchors (`fx.checkpoints[0].threads`), but the durable write is BE-020's and is not tested in this package. Implementation: `packages/authority/src/ranges.ts`, `packages/authority/src/room/threads.ts`.

**Notes:** ADR 0015 consequences: a collapsed range does not recover, and ranges at old versions come from the nearest checkpoint. The behaviour of text typed exactly at a range's edge, and the effect of removing a targeted block, are not specified (Open questions). Criterion 6 stays open in this package until BE-020 persists the checkpoint. Lane U-SYN-019-036 (2026-11-13) found the host side open too: `Checkpointer.save` (`services/document-service/src/data-plane/checkpoints.ts`) writes only the `.cdm.json.zst` object, and nothing writes the `.side.json.zst` object (06 §2.2 step 3, §8 layout) that `objectKeys.checkpointSide` names; the room's `threads` in `fx.checkpoints` are dropped, and no room is opened with the anchors. A checkpoint at `seq` below the head would need the anchors at that `seq`, which the room does not keep, so the choice of which anchors a side object holds is open: see `docs/adr/0355-lane-U-SYN-019-036.md` (proposed). Not built in this lane.

### SYN-033 Map a requested range from its base to the head when a thread is created

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 2 | M | must | Maintainer |

**Spec:** ADR 0015; 07 §6; 05 §6.2 (`/threads`); review S-03 · **Requirements:** R8 · **Depends on:** SYN-032, PRM-004, PRM-005

As a commenter, I want a comment I start on a slightly old view to land on the right text, so that a busy document does not misplace my comment.

**Acceptance criteria**

- [x] Given a thread request with `range: { from, to, baseSeq }` and a `baseSeq` within the rebase window, when the room handles it, then it maps the range from `baseSeq` to the head and stores the mapped range with the `seq` it refers to.
- [x] Given a `baseSeq` older than the rebase window, when the request is handled, then it is refused (the code is in Open questions).
- [x] Given the mapped range, when the room checks permissions, then it checks `comment` in every scope the mapped range covers, using the permissions at that moment, and refuses the request otherwise.
- [x] Given a request with `block: id`, when the room handles it, then the block must exist at the head and the thread targets it by identifier.
- [x] Given a thread is created, when the request completes, then the document, its head and its log are unchanged.

**Evidence:** `packages/authority/test/threads.test.ts`, "mapping a requested range from its base to the head (SYN-033; PRM-037)": "maps the range from baseSeq to the head, checks comment there, and changes nothing in the document" (stored `seq` is the head; head, pending count and document JSON unchanged); "refuses a range that covers a scope where the caller lacks comment, at the head and now" (checked at the head after a later unwrap); "refuses a baseSeq older than the rebase window, and a viewer altogether" (`stale_base`); "needs only comment in the scope of a targeted block, and the block must exist at the head" (`not_found` for a missing block). Implementation: `packages/authority/src/room/room.ts` (`createThread`).

**Notes:** Criterion 2: the spec leaves the code open; `stale_base` is used here as the assumed code, the same code a stale commit gets (SYN-020). It is listed in Open questions and needs the owner's decision. Record: ADR 0102 batch, `docs/adr/0102-authority-backlog-batch.md`.

> SYN-034 (Keep comment ranges current on the client) was merged into FE-048 during the cross-check of 2026-11-06.

## Presence

### SYN-035 Relay presence with server identity, limits and no storage

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1a | M | must | Participant |

**Spec:** 04 §11; 05 §5.4; review PRES-1 · **Requirements:** R7 · **Depends on:** SYN-006, PRO-023, PRO-027, PRO-028, PRO-029

As a participant, I want to see who else is in the document and whether they are active, so that I know I am not alone.

**Acceptance criteria**

- [x] Given a `presence.update`, when the server relays it, then the identity (user, session, name) comes from the connection and any identity the client claims is ignored.
- [x] Given a client that sends more than 10 updates per second (`presenceHz`, target), when the server receives them, then it drops or coalesces the excess without closing the connection.
- [x] Given an update larger than 1 KiB (`presenceBytes`) or one that does not match the schema (`selection: { anchor, head }`, `scope`, `status` of `active` or `idle`), when the server receives it, then it is refused and not relayed.
- [x] Given presence in operation, when the room restarts, then no presence was stored in the log, the database or a checkpoint, and peers reappear only as clients publish again.
- [x] Given a client that joins or leaves, when the server sends `presence.state`, then `peers` lists the joined sessions and `left` lists the departed ones.

**Evidence:** The relay is in the data plane (`services/document-service/src/data-plane/presence.ts`), tested with real WebSocket clients in `test/data-plane/presence.test.ts`: identity from the session; coalescing above presenceHz without closing; refusal above presenceBytes or outside the schema; nothing stored, and a new room shows nobody; joins receive the peers and departures are listed in `left`.

**Notes:** the header avatars and caret flags are UX's (13 §5). The roadmap places a header with presence in phase 1a and "presence" under Sync in 1b; this story is the relay and its limits, SYN-036 the position mapping. Not started: the room has no presence relay yet, and the messages `presence.update` and `presence.state` (PRO-027 to PRO-029) and the connection's display name are not defined in code. `mapRanges` (`packages/authority/src/ranges.ts`) is the mapping SYN-036 will use. Built on 2026-11-06 in the data plane; the earlier note that the relay was not started is out of date.

### SYN-036 Publish presence positions and map them for receivers

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | must | Participant |

**Spec:** 04 §11; review PRES-1 · **Requirements:** R7 · **Depends on:** SYN-035, SYN-019, SYN-001

As a participant, I want other people's carets and selections to sit where they really are, so that I can see what they are working on.

**Acceptance criteria**

- [x] Given a sender with unconfirmed steps, when it publishes its selection, then the positions refer to its confirmed document (the visible selection mapped back through the unconfirmed steps) and the update carries the confirmed `seq`.
- [x] Given a receiver at or past the update's `seq`, when the update arrives, then the receiver maps the positions through the steps it has applied since.
- [x] Given a receiver behind the update's `seq`, when the update arrives, then the receiver holds it until it reaches that `seq`.
- [x] Given an update older than the receiver's retained mapping history, when it arrives, then the receiver drops it.
- [x] Given a sender who types text that is not yet confirmed, when a receiver draws its caret, then the caret is never inside text the receiver does not have.

**Evidence:** `packages/engine/src/presence.ts` (`toConfirmed`, `PresenceClient.selectionChanged`; the receiver side `#offer`, `#place`, `confirmed`, `positionsOf`); `packages/engine/test/presence-positions.test.ts` (describe 'presence positions of the sender (SYN-036 criterion 1)': positions inside and after the in-flight text map to the confirmed insertion point; positions through the queued step map too; the published update carries the confirmed positions and the confirmed `seq`); `packages/engine/test/presence-mapping.test.ts` (criterion 2: a caret mapped through three confirmed characters, and a property run over 100 insert sequences; criterion 3: an update from seq 5 held at 3 and placed at 5; criterion 4: an update older than a two-commit history dropped, and an update at a reset seq dropped). Confirmed changes reach presence from `packages/engine/src/core.ts` (`#presenceConfirmed`) through `Transition.confirmed` in `src/sync/state.ts`. Criterion 5, engine half only (lane U-SYN-019-036; unticked at review because nothing draws the caret yet): `packages/engine/test/presence-unconfirmed.test.ts` (Node.js, `pnpm vitest run` on that file): a caret inside the sender's in-flight text, and behind its queued step, is placed by the receiver at the confirmed insertion point, and the receiver's confirmed document equals the sender's (a property run over 100 caret offsets). Criterion 5, the drawing (lane w4, 2026-11-15): `PresenceClient.refresh` reports each visible peer with its positions in the reader's visible document (`PresenceHost.setSelections`; `DocumentCore.peerSelections`), and the web view measures them (`EditorCore.carets` in `packages/engine/src/view/web.ts`, `#drawCarets`: rectangles relative to the element the body view is mounted in, measured again after every view update, peer update and window resize; a position outside the view's document is not measured). `packages/element/src/editor.ts` hands `carets` to the shell, whose layer draws it (UX-027, `Carets.svelte`). `packages/engine/src/view/syn-036-peer-caret.universal.test.ts` (`pnpm exec vitest run --project browser` on that file; passed in Chromium, Firefox and WebKit on 2026-11-15): two real cores on backend-mock's room and presence relay; the sender's commit is never answered and its caret is inside the unconfirmed text; the receiver's page and document do not hold that text, the caret is at the confirmed insertion point, its rectangle is the view's own for that position, and it follows text the receiver types before it.

**Notes:** how long a receiver retains mapping history is not stated; the engine keeps 256 confirmed commits (`DEFAULT_MAPPING_HISTORY`, a proposed default in ADR 0108). A reset or reload clears the peers' positions (ADR 0108). Criterion 5 (the receiver draws the caret) stays unticked (checked 2026-11-13, lane V-SYN-019-036). The shell's layer exists (UX-027: `packages/ui/src/shell/carets.ts`, `drawnPeers`, which draws whatever `PeerCaret` the core reports), but nothing produces a `PeerCaret` from the placed positions: `packages/engine/src` has no `carets` view and the element does not map positions to rectangles. The receiver's list of peers keeps only names and status, not positions; the shell does not yet receive the mapped caret. Lane w4 (2026-11-15): criterion 5 is ticked; the core now has the `carets` view and the element passes it to the shell (see Evidence). The test checks the rectangles the core hands the shell, in three browser engines; it does not mount the shell's layer, which UX-027 tests on its own. A selection's rectangles come from a DOM range over the two positions; scrolling inside the mount target does not move them, but a layout change with no transaction and no resize (a late font load, for example) is not measured again until the next update.

## Admission control and performance

### SYN-037 Reject expensive commits before doing the work

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Operator |

**Spec:** 04 §12; 06 §8, §12; 10 §3.3; review CPU-1 · **Requirements:** R9, R10 · **Depends on:** SYN-010, SYN-011, SYN-013, BE-011

As an operator, I want one connection's costly commits to be refused before they stall a process that hosts many rooms, so that a hostile or buggy client cannot slow everyone else.

**Acceptance criteria**

- [x] Given a submission, when the room starts step 1, then it estimates the cost from the number of steps, the rebase distance in steps and the serialised size, before doing any other work.
- [x] Given a connection whose CPU budget is spent, when it submits, then the commit is rejected with `rate_limited`, action `retry` and a `retryAfterMs`.
- [x] Given budgets per connection and per tenant, when they are configured, then both are enforced, and both cover steps 2 to 7 (deduplication, base, rebase, apply, invariants, permissions), not only step application.
- [x] Given a commit that is cheap to apply but has a very long rebase distance, when it is processed, then its estimated and charged cost reflects the distance.
- [ ] Given one connection that floods the room with expensive commits, when other connections edit, then their acknowledgement latency stays within the target of SYN-015.
- [x] Given a client that receives `rate_limited`, when it backs off, then it resubmits the same commit with the same `id` (SYN-020).

**Evidence:** `packages/authority/src/room/admission.ts` (`Admission`, `TokenBucket`, `defaultCost`) and step 1 of `Room.submit`: `test/room-commits.test.ts`, 'admission control (SYN-037)': the estimate is made from the steps, the rebase distance (kept as cumulative step counts) and the size before any other work; a spent connection budget gives `rate_limited`, `retry` and `retryAfterMs`, and the same commit passes after the wait; budgets per connection (session) and a tenant budget shared by rooms are both enforced, charged whatever steps 2 to 7 decide; a cheap commit 30 steps behind is charged for the distance. Budgets and the cost formula are uncalibrated (SYN-038); a rule evaluation that exceeds its budget is also `rate_limited` (`test/room-rules.test.ts`; ADR 0034). Criterion 6 (round 1, lane SYN-029-042): `packages/engine/test/sync-state.test.ts`, 'busy, rate_limited, unavailable: retry the same commit after the indicated delay' (a `rate_limited` with `retryAfterMs` 250 gives the `resend` effect with `afterMs` 250, and `resendCommit` returns the same id `c1`); `packages/engine/src/sync/session.ts` holds the resend until `#resendAt`, which is the delay or the backoff, whichever is longer; `packages/engine/test/session.test.ts`, 'retries the same commit with the same id after a retry rejection' (the same id is sent again, with an identical body, after the timer).

**Notes:** the budgets and the cost formula are not given in the spec; SYN-038 calibrates them. 06 §12 says exceeding a tenant quota returns `quota_exceeded`; which code applies when the tenant's CPU budget is spent is in Open questions. Cross-check: per-tenant quotas (BE-091) join the per-connection budgets in phase 2. Second review (2026-11-06, SPK-027): SR-K2 is settled in 06 §12 as edited: the tenant's budget also gives `rate_limited` with action `retry`. SR-M7: under ADR 0019 a commit also costs projection work for every visibility class (S12: 1 to 1.3 ms per class per commit at 1,000 pages, median, on the development machine), which the budget should count ([review](../review/2026-11-06-second-review.md)). 2026-11-06: the estimate multiplies by `AdmissionConfig.fanOut`, which the host sets from the gateway's `classCount`. Not met: (5) needs the reference deployment (SYN-015 criterion 5). (6) is the client's (SYN-020): the harness client resubmits with the same id on `retry`, and the engine adopts it. Round 3 (lane V-SYN-037-053), criterion 5 in its isolation part: `packages/authority/test/admission-isolation.V-SYN-037-053.test.ts` (Node.js, vitest, 2026-11-13) runs a connection that floods one room with 4 KB commits and another session in the same room; the flood is refused with `rate_limited` and `retry` and changes nothing, and the other session is acknowledged on each of ten rounds with no reject. The latency target of SYN-015 criterion 5 is measured on the reference deployment (BE), so criterion 5 stays unticked. Lane w4 (2026-11-17): criterion 5 stays unticked. The target it names is the one of SYN-015 criterion 5, which is measured end to end on the stage-1 deployment in one region; that deployment does not exist (see the Notes of SYN-015), and owner decision 22 of 2026-11-15 confirms the reference machine, not a deployment. A figure from the demo stack would not be the measurement asked for, so none was taken. The isolation part is covered by the test named above. SYN-038 (2026-11-17) found that the estimate of this story does not predict the time a commit takes, because the size of the document is not one of its inputs (docs/spikes/2026-11-17-syn-038-sync-defaults.md); the budgets stay uncalibrated until the estimate is changed.

### SYN-038 Calibrate the sync defaults that the spec calls guesses

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 1b | M | should | Maintainer |

**Spec:** 04 §16, §12; 06 §16; review CPU-1, section 6 item 5 · **Requirements:** R7, R9 · **Depends on:** SYN-047, SYN-037

As a maintainer, I want measured values behind the defaults that the spec calls starting points or guesses, so that limits and budgets are chosen from evidence.

**Acceptance criteria**

- [x] Given recorded or simulated editing traces, when the batching window is varied around 100 ms, then the spike reports commits per minute, bytes of log, acknowledgement latency and the resolution available to attribution, and recommends a value.
- [ ] Given slow and fast clients, when `maxRebaseSteps` is varied around 5,000, then the spike reports memory for position maps, rebase CPU and the rate of `stale_base`, and recommends a default.
- [x] Given the benchmark of SYN-040, when CPU per commit is compared with the cost estimate of SYN-037, then the spike reports the error of the estimate and recommends per-connection and per-tenant budgets.
- [x] Given the catch-up limits (target 5,000 commits or 5 MiB), when reconnects of different lengths are simulated, then the spike reports the cost of streaming against reloading and confirms or changes the limits.
- [x] Given links of 100, 300 and 1,000 ms round trip, when one in-flight commit is used, then the spike reports throughput and latency, as evidence for the question whether pipelining is worth its complexity.
- [x] Given documents of 1, 10 and 100 pages, when a rolling hash of the document per commit is computed, then the spike reports its cost, as evidence for the open question in 04 §16.
- [x] Given the measurements, when the spike ends, then a written recommendation names each default and lists what remains unmeasured.

**Evidence (lane w4, 2026-11-17):** report [docs/spikes/2026-11-17-syn-038-sync-defaults.md](../spikes/2026-11-17-syn-038-sync-defaults.md); script `packages/authority/scripts/syn-038-calibrate.ts` (`node --expose-gc packages/authority/scripts/syn-038-calibrate.ts all`), run on the reference machine of ADR 0037 (i9-10900KF, Windows 11, Node.js 22.18.0) on a machine shared with four other agents. Criterion 1: simulated synthetic trace (2,175 keystrokes in 10 minutes), windows 0 to 1,000 ms; recommends 200 ms. Criterion 3: the estimate of SYN-037 against measured time of steps 2 to 7 on `pages-1`, `pages-20` and `pages-100`; milliseconds per unit differ by a factor of about a million, because the document size is not an input; budgets proposed. Criterion 4: stream against reload; keeps 5 MiB and proposes streaming only while the bytes to send are below the bytes of the content. Criterion 5: one in flight against pipelined at 100, 300 and 1,000 ms; recommends one in flight. Criterion 6: full hash 1.8, 7.3, 11.8 and 35.5 ms at 1, 10, 20 and 100 pages; a hash per block 0.12 to 0.27 ms. Criterion 7: the table of recommendations and the list of what is unmeasured are in the report.

**Notes:** Lane U-SYN-037-053 (round 2) did not start this spike; see `docs/adr/0356-lane-U-SYN-037-053.md`. The spike changes no behaviour; it leads to edits of 04 and of the defaults in `welcome`. The pipelining and rolling-hash questions are decided elsewhere; this spike supplies data only. Lane w4 (2026-11-17): criterion 2 stays unticked. The report gives rebase CPU (0.4 ms for one step and 7 ms for 50 steps at 5,000 steps behind) and the memory of the position maps (about 120 bytes per step), and recommends keeping 5,000, but it does not report a rate of `stale_base`: that needs the distribution of client lag, which nothing here records, and the model table is arithmetic on an assumed typing rate. Criterion 3 compares the estimate with this script's own measurement, not with the benchmark of SYN-040, which is not finished (SYN-040 criterion 1). The 10-page document is the first half of `pages-20`, because the corpus has none. The recommended values are proposals for the owner (nothing was changed in the defaults); the budgets are not safe to enable for 100-page documents until the check of the invariants is incremental, which is outside this spike.

### SYN-039 Keep heavy work off the room's event loop

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 04 §12; 06 §1, §2.2, §8 · **Requirements:** R9 · **Depends on:** SYN-001, BE-019, BE-020

As an operator, I want checkpoint serialisation, log replay, comparisons and conversions to run in worker threads, so that one large job does not delay the acknowledgements of other documents.

**Acceptance criteria**

- [ ] Given a checkpoint write, a log replay for a content read, a comparison and a conversion, when each runs, then it runs in a worker thread and never on the room's event loop.
- [ ] Given a document at the canonical size limit of 16 MiB (I7), when a checkpoint is serialised, then the acknowledgement latency of other documents on the same process stays within the target of SYN-015.
- [x] Given a worker, when it is started, then it receives all inputs as plain data and needs none of the room's state.
- [x] Given steps 2 to 7 of the authority algorithm, when a commit is processed, then they stay on the room's loop because they cannot be pre-empted, and SYN-037 bounds them.

**Evidence:** `packages/authority/test/room-synchrony.test.ts` (criterion 4): no method of `Room` is async, a commit is validated, applied and acknowledged in the calls that submit it and complete its write, and the SYN-037 step bound refuses a commit of too many steps in the same synchronous call. Criterion 3: `packages/authority/test/worker-boundary.test.ts` (SYN-001 criterion 5) runs the authority's pure functions in a worker on structured-cloned data; the room itself is not run in a worker here, and the production pool is BE's.

**Evidence (criterion 1, partly, lane V-SYN-037-053):** `services/document-service/test/data-plane/syn-039.v-syn-037-053.workers.pg.test.ts` (PostgreSQL 17 in the shared container `docedit-test-postgres`, one worker thread, run with `pnpm vitest run --project node <file>`): the checkpoint write goes to the pool (`checkpoint` task) and not inline; a content read replays the log after a checkpoint (`materialise`) and not inline, once the room is stopped so the read is not answered from memory; a conversion (`RoomHost.encode`, the `encode` task) goes to the pool. Passed on 2026-11-13.

**Notes:** the thread pool, its size and its saturation behaviour are BE's. Criterion 1 stays unticked: the "comparison" has no worker path in the room. The only comparison the room makes is the divergence hash, which the checkpoint task computes (covered by the test above); `recovery.ts` `rebuild`/`verifyCheckpoint` is a command-line tool that uses a pool of size 0 (inline), outside the room. Owner or spec decision needed: whether that tool's work counts. Criterion 2 needs the reference machine (SYN-015 criterion 5).

### SYN-040 Benchmark the cost of a typical commit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | should | Maintainer |

**Spec:** 04 §12; 00 §9; 13 §9 · **Requirements:** R7, R9 · **Depends on:** SYN-015, FND-007, FND-009

As a maintainer, I want the cost of validating and applying a commit measured on every change, so that a regression in the authority is caught before release.

**Acceptance criteria**

- [ ] Given a typical commit (one `replace` step of one character) and a worst-case commit (500 steps), when the benchmark runs on documents of 1, 20 and 100 pages, then it reports median and 99th percentile CPU time per commit for steps 2 to 7 separately.
- [ ] Given the benchmark, when results are compared with the target "well under a millisecond of CPU" for a typical commit, then the budget is recorded in the harness and the CI gate fails when it is exceeded.
- [ ] Given the stage 1 reference deployment, when acknowledgement latency is measured end to end, then median and 99th percentile are reported against 50 ms and 300 ms (targets).
- [ ] Given the benchmark, when it runs on a pull request, then results are stored per commit so that trends are visible.

**Evidence (criterion 1 partly, lane V-SYN-037-053, 2026-11-13, not ticked):** `packages/authority/scripts/commit-cost.ts`, run as `node packages/authority/scripts/commit-cost.ts 200 20 1` on the development machine (Intel i9-10900KF, Node.js 24.22.2, Windows 11). Times are wall-clock per commit on the authority path: `parseSteps`, `applySteps`, `checkInvariants`. Output: `C:/Users/ckvba/AppData/Local/Temp/claude/e697c48aae3901a6/ed343178-003a-4ff4-9d10-b59b756ef636/scratchpad/commit-cost-V-SYN-037-053.md`.

**Notes:** Criterion 1 is not met. The benchmark reports six of the seven types; `replaceAround` has no eligible place in pages-1, pages-20 or pages-100 (no body-level region; wrapping a paragraph in a region fails the schema). Several rows measure refused commits, so their cost is the refusal path: `addNodeMark` and `removeNodeMark` typical commits and the 500-step `attr` commit are refused with `invalid_op` (the suggestion mark's attributes and the style values are the likely cause; not diagnosed). Typical `replace` median is about 10 ms on pages-1, about 77 ms on pages-20 and about 220 ms on pages-100, far above the "well under a millisecond" target; the cost is dominated by whole-document checks, not measured per check. Criteria 2 to 4 (CI gate, reference-machine latency, per-PR storage) stay open: they need root CI configuration, the reference machine (FND-007) and CI storage.

### SYN-041 Coalesce broadcasts for rooms with many subscribers

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | M | could | Operator |

**Spec:** 04 §12, §5 step 10 · **Requirements:** R9 · **Depends on:** SYN-015

As an operator, I want a room with a large audience to send fewer, larger messages, so that fan-out cost stays bounded.

**Acceptance criteria**

- [ ] Given a room with many subscribers, when commits arrive faster than the window, then the room coalesces them into one `sync.commit` message per 30 to 50 ms (target).
- [x] Given coalesced messages, when they are sent, then commits within a message are in ascending `seq` and the ordering rule of SYN-015 still holds for acknowledgements and rejections.
- [x] Given a client, when it receives a coalesced message, then it applies the commits in order and detects gaps as in SYN-019.
- [x] Given a room with few subscribers, when commits arrive, then they are sent without added delay.

**Evidence (criterion 1 window over PostgreSQL, lane U-SYN-037-053, 2026-11-13):** `services/document-service/test/data-plane/syn-041-coalescing.pg.test.ts` (2 tests, Node, real WebSocket clients over the PostgreSQL logs, ownership, grants and documents stores of `pgStores`, in a tenant of its own; passed in the shared PostgreSQL container, Podman): a held commit is sent before a later commit's acknowledgement, and three commits within a 400 ms window reach the viewer as one `sync.commit`. Criterion 1 stays unticked: the threshold for "many" is not in the spec and is not chosen here (ADR 0356).

**Evidence (criterion 2, fixer of U3 group 1, round 2, 2026-11-13):** the document service's data plane puts the room's output (the real `RoomBridge.translate`) through the window: `BroadcastWindow` (`services/document-service/src/data-plane/syn-041-coalescing.ts`) owns the timer around `CommitCoalescer`, now exported from `packages/protocol/src/bridge/index.ts`; `HostedRoom.#apply` passes every translated message through it, and a rejection the host sends itself, a server-side channel close, a drain and a stop end the held message first (`services/document-service/src/data-plane/room-host.ts`). It is on only when the operator sets `coalescing` (`windowMs`, `minSubscribers`) in the data plane's settings. `services/document-service/test/data-plane/syn-041-coalescing.test.ts` (5 tests, Node, real WebSocket clients over MemoryStore, passed 2026-11-13): a commit held on carol's channel reaches her before the `permission_denied` rejection of her commit to the legal region; with three channels and a window of 2000 ms, seq 1 is held on carol's channel, carol's own commit is then acknowledged with seq 2, and her channel receives `sync.commit [1]` before `sync.ack 2`, while the viewer gets one message `[1, 2]`; three commits within a 400 ms window reach the viewer as one message `[1, 2, 3]`; below the threshold each commit goes at once; a stop of the service sends the held commit before the connection closes.

**Evidence (criterion 3 ticked; lane U-SYN-037-053, 2026-11-13):** `packages/protocol/src/bridge/coalesce.ts` (`CommitCoalescer`, a pure window; the host supplies the clock) and `packages/protocol/src/bridge/coalesce.test.ts` (10 tests, Node): a held message is ended before any acknowledgement, rejection or close on its channel, a commit that would break ascending `seq` starts a new message, and a commit with coalescing off is sent at once. Client side (criterion 3): `packages/engine/test/sync-state.test.ts` (SYN-019 block) and `packages/protocol/src/client/channel.universal.test.ts` ('streams after a resume', a message of two commits applied in order; 'drops duplicates and resumes on a gap'), run in Node on 2026-11-13 (56 tests passed in two files). The room itself does not yet hold messages on a window: criterion 1 is not met (see Notes).

**Evidence:** `packages/authority/test/room-broadcast-timing.test.ts` (criterion 4): a stored commit reaches the other two subscribers in the call that completes its write, synchronously, and two commits in turn give one `sync.commit` each, in ascending `seq`. Not met: criteria 1 to 3. The room has no coalescing window, and the message form of a batch is a protocol decision that is not taken here.

**Notes:** Reviewer of round 2: criterion 2 is unticked. `CommitCoalescer` is a pure class that no room, bridge or service calls, and its tests feed hand-made messages cast with `as never`; no coalesced message is ever sent, so the ordering against acknowledgements and rejections is shown for the unit only, not for what the room sends. Tick it when the room's output goes through the coalescer and a test with the real `RoomBridge` and an acknowledgement in the same batch shows the order. Fixer of round 2: done, ticked (evidence above). Criterion 1 stays open: coalescing is off unless `coalescing` is set, and neither the threshold for "many" nor a default window is chosen (open question; ADR 0356); the window's 30 to 50 ms is a target, and no fan-out cost was measured. phase inferred: stage 2 scale work (11 §7). What counts as "many" is not defined (Open questions). Round 1 (lane SYN-029-042): not built; the questions of the window, the wire form of a batch and the flush before an acknowledgement are in `docs/adr/0270-lane-SYN-029-042.md` (questions 1 to 3). Lane U-SYN-037-053 (round 2): the wire form is decided by the protocol (one `sync.commit` with a `commits` array, `packages/protocol/src/bridge/room-bridge.ts`), so no new message is needed. The window is held by `CommitCoalescer`; the spec default for the window is the 30 to 50 ms target, and 40 ms is used in its tests. Not met, criterion 1: the room does not yet hold its broadcasts through the coalescer, because wiring needs the host's timer and the subscriber count, and what "many" means is an open question that no threshold answers. That wiring and the threshold are the document service's and the owner's to set (see `docs/adr/0356-lane-U-SYN-037-053.md`).

### SYN-042 Attach viewers to follower nodes that never submit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | could | Operator |

**Spec:** 04 §12; 06 §2.4, §6, §16 · **Requirements:** R9 · **Depends on:** SYN-015, BE-028

As an operator, I want viewers of a very popular document to connect to follower nodes, so that one room does not carry the whole audience.

**Acceptance criteria**

- [ ] Given a follower node, when it subscribes to a room's ordered stream, then it fans out the same commits in the same order to its viewers.
- [ ] Given a viewer on a follower, when it submits a commit, then the commit is refused and never reaches the room.
- [ ] Given a viewer on a follower that falls behind or reconnects, when it resumes, then the catch-up rules of SYN-026 apply.
- [ ] Given a follower that loses its subscription, when it recovers, then its viewers see no gap or duplicate.

**Evidence (built, not ticked):** `packages/authority/src/room/follower.ts` (`Follower`: `upstream`, `open`, `permissions`, `submit`, `resume`), exported from `packages/authority/src/index.ts` with `FollowerInit`, `FollowerViewer` and `FOLLOWER_REFUSAL`; `packages/authority/test/follower.test.ts` (imports the package entry): 'gives each viewer the room commits, once and in ascending seq' (criterion 1), 'answers read_only and never hands the commit to the room' (criterion 2), 'neither skips nor repeats a commit: the viewer sees 1 to 5 once each' (criterion 4), and the 'each viewer is served under its own access' tests.

**Fix (round 2, 2026-11-13):** the follower is exported. Each viewer opens with its own access (`open(channel, { access, minVisibleSeq }, resume)`), which `ch.opened` carries; the upstream channel's access is never sent to a viewer and its `perm.changed` is not forwarded. A newer upstream revision holds every viewer back until the host passes the viewer's own recomputed access to `permissions`, which sends `perm.changed` and the held commits, or closes the viewer with `access_changed`. The follower serves readers of the whole document only (ADR 0147 section 7): a viewer with `manage`, or, while the content it has seen holds no confidential region and no sensitive field value, a viewer with `view` in every scope; the upstream channel must read the whole document too. A commit or reset that may bring in hidden content closes every other viewer before it is fanned out. A resume below the viewer's history gate is not served, and without a gate only a viewer at the head resumes. Criteria 1, 2 and 4 stay unticked: no host (BE-028) wires a follower to a room yet, so no test goes through that path.

**Review (round 2, 2026-11-13):** criteria 1, 2 and 4 were unticked by the reviewer. `Follower` is not exported from `packages/authority/src/index.ts` (the package's only entry) and nothing but `follower.test.ts` imports it, so no follower node exists to behave as the criteria describe. It also sends every viewer the upstream channel's `access` in `ch.opened` and drops the upstream `perm.changed`, so a viewer would see another user's rights and never learn of a revocation. Tick again once it is exported, wired by a host (BE-028) and the viewer's own access is served.

**Notes:** conditional on the demand-driven stage 3 (11 §7, "not scheduled") and on the open question in 06 §16 whether followers are needed before stage 3. Criterion 3 is not ticked: the follower streams a resume from the commits it holds and closes a viewer it cannot serve (`follower.test.ts`, 'streams the commits after its seq' and 'closes a viewer it cannot serve'), but it does not serve the commits resource (`page`), does not apply the per-user visibility gate of HIS-023 (it serves readers of the whole document only), and cannot answer a `reload` with content of its own. Decisions, by the spec default and proposed in `docs/adr/0147-authority-3-backlog-batch.md`: a submission on a follower is refused with `read_only`, action `drop`, and never reaches the room; the follower holds `catchUpCommits` (`DEFAULT_LIMITS`, 5,000) commits.

## Divergence check

### SYN-043 Detect a diverged client with `sync.check`

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | 1b | M | should | Author |

**Spec:** 04 §13; 05 §5.3; 03 §2; 11 risk 4 · **Requirements:** R7 · **Depends on:** SYN-017, BE-020, CDM-010

As an author, I want my editor to notice if it ever differs from the server's copy and to reload, so that an engine bug cannot leave me working on a wrong document.

**Acceptance criteria**

- [x] Given the room writes a checkpoint, when it chooses to send `sync.check`, then the message carries the `seq` and the SHA-256 of the canonical form of the durable document at that `seq`.
- [x] Given a client whose confirmed document is at the message's `seq`, when it receives `sync.check`, then it computes the hash of its own confirmed document and takes no action on a match.
- [x] Given a mismatch, when the client detects it, then it reloads the document and reports the event.
- [x] Given a client whose confirmed `seq` differs from the message's, when it receives `sync.check`, then it ignores it.
- [x] Given a test hook that makes one client apply a step differently, when the check runs, then that client reloads and the event is reported.
- [x] Given the tests of authority and permissions, when they run, then none relies on `sync.check`: it is not a security control.

**Evidence (criterion 6):** `packages/authority/test/syn-043-check-not-security.test.ts` (2 tests, static): it reads the sources of the authority tests and of the document-service's data-plane and permission tests, and fails when one names `room/check`, `syncCheck`, `documentCanonicalHash` or `sync.check`. The exemptions are the check's own unit test `room-check.test.ts` and the static test itself. A proxy: it cannot see a reliance through a helper that does not name the check. Passed on 2026-11-13 (scoped run).

**Evidence (criteria 2 to 4):** `packages/engine/src/sync/session.ts` (`#check`) and `packages/engine/test/session.test.ts`: 'a divergence check that matches takes no action and reports nothing' (no reload, no problem), 'a divergence check at another seq is ignored' (same), 'a divergence reloads the document and reports it with the code divergence' (one reload, `problem` code `divergence`, not fatal). Session tests pass on 2026-11-13 (scoped run).

**Evidence (criterion 5, round 4, lane SYN-043-053):** `packages/engine/test/syn-043-apply-hook.test.ts` (2 tests): a spy on `ReplaceStep.apply` is the test hook, applying every replace as a no-op on this client only; the server's hash of the document with the inserted text makes the check reload (one load, `problem` code `divergence`, not fatal). The control test runs the same check without the hook and takes no action. Passed on 2026-11-13 (scoped run).

**Evidence (criterion 1, lane V-SYN-037-053):** `services/document-service/test/data-plane/syn-043.v-syn-037-053.check.pg.test.ts` (2 tests, PostgreSQL 17 in the shared container `docedit-test-postgres`, run with `pnpm vitest run --project node <file>`): with checkpoints every two commits, the room's host sends `sync.check` with `seq` 2 after the checkpoint is saved, and the hash is the SHA-256 of the canonical JSON of the stored envelope; with `syncCheck` off, no `sync.check` is sent. Passed on 2026-11-13.
**Notes:** Built by lane authority-3, nothing ticked: `packages/authority/src/room/check.ts` (`syncCheck`, `documentCanonicalHash`) and the `sync.check` variant of `ToClient` in `src/room/types.ts`, tested by `test/room-check.test.ts` (the message carries the durable `seq` and the hash of the durable document, not a tentative one). Lane V-SYN-037-053: (1) is met at the document service, where the room's host chooses to send it after each checkpoint (`syncCheck` setting, on by default; the spec's MAY is decided as yes, see `docs/adr/0356-lane-V-SYN-037-053.md`). SHA-256 is WebCrypto's and asynchronous, so the host computes the hash from the durable envelope, not `syncCheck` in `check.ts` (which hashes the bare document node and has no caller outside its tests; the two conventions differ, recorded in that ADR); (2) to (4) are the client's and are met by the engine session tests (Evidence above). (5) is met by a test-only hook in the test file (Evidence, criterion 5); the engine itself provides no hook, and the session tests reach the same reload with a wrong hash. (6) is met by a static test, a proxy (Evidence, criterion 6). Decision by the spec default: "canonical form" is the CDM canonical node serialised by RFC 8785 and hashed with SHA-256, as the engine fixtures hash a document (recorded in `docs/adr/0147-authority-3-backlog-batch.md`). The protocol package has a `sync.check` message (`packages/protocol/src/definition/messages.ts`). The reporting channel is not specified (Open questions). Hashing a document of up to 16 MiB in the browser takes main-thread time; the cost is part of the typing-latency budget.

## Relay mode and other engines

### SYN-044 Offer a relay mode for backends that cannot run the document model

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | M | could | Integrating developer |

**Spec:** 04 §14; 05 §9, §11; review RELAY-1 · **Requirements:** R6 · **Depends on:** SYN-006, PRO-101, PRO-124

As an integrating developer, I want a documented relay mode with its limits stated, so that I can build a backend that stores and relays without the document model, for trusted clients only.

**Acceptance criteria**

- [x] Given relay mode, when a commit arrives, then the server skips steps 4 to 7 (rebase, apply, invariants, permissions), rejects any commit whose `base` is not the head with `stale_base`, and stores and relays the rest with server attribution and storage before acknowledgement.
- [x] Given a relay, when it announces its capabilities, then it announces `mode: "relay"` and none of `regions`, `suggest-enforced` or `fields`.
- [x] Given a relay without an authority service, when a caller asks for content, catch-up beyond the log window, restore, comparison or export, then the feature is not available; with an authority service (05 §10) it is.
- [x] Given the documentation, when it is read, then it states that relay mode is for trusted clients only and that a relay cannot enforce region permissions, suggestion-only or fill-only roles, or invariants.
- [ ] Given the `core-relay` profile of the conformance kit, when a relay is tested, then it passes the profile and is not tested for the permission profiles.

**Evidence:** `packages/authority/src/room/relay.ts` (`Relay`, `relayCapabilities`, `relayFeatureAvailable`, `RELAY_EXCLUDED_FEATURES`). `packages/authority/test/relay.test.ts` (18 tests): a step no authority would accept is stored and relayed; a base that is not the head is `stale_base` with action `rebase`; attribution comes from the connection; a failed or throwing store is `unavailable` and nothing is acknowledged; a repeated id is acknowledged, never stored twice; 300 random schedules give gap-free sequences; arbitrary JSON never throws; the announcement has `mode: "relay"` and none of the three features; the five features that need the authority service are unavailable to a relay without one. Round 3 fix: the relay is exported from the package entry (`packages/authority/src/index.ts`: `Relay`, `RELAY_MODE`, `RELAY_EXCLUDED_FEATURES`, `relayCapabilities`, `relayFeatureAvailable` and their types), and `relay.test.ts` imports it from there, as a DEP transport would.

**Evidence (criterion 4, round 4, lane SYN-043-053):** the statement is in the spec's relay section, `docs/spec/04-sync-engine.md` §14 ("Relay mode is for trusted clients only. A relay cannot enforce region permissions, suggestion-only or fill-only roles, or invariants."), and in the module header of `packages/authority/src/room/relay.ts`, which names the same three limits and the features `relayFeatureAvailable` withholds. No separate integrator guide exists; this is the documentation the repository has. Read on 2026-11-13.
**Notes:** phase inferred: the roadmap does not place relay mode; it is a backend-tier option for third parties (11 §7, "Ecosystem"). Criteria 1 to 3 are met by the relay's own algorithm, its announcement and its availability rule, which need no room: a relay has no document model to attach to, so `Relay.submit` is the whole server path in relay mode. A live relay still needs a DEP transport that calls `Relay.submit` and delivers its messages; that is BE's, not this package's (ADR 0147 section 10). Criterion 1 is met only for the relay's own checks: a relay stores steps it cannot test, so `scopes`, `retired`, `claimed` and `revision` are empty or zero and `cdm` is 0 in a relay's commits. Not met: (4) the documentation for integrators does not exist; the spec (04 §14, 05 §3) states the limits, and a user-facing page belongs under `docs/`, outside this lane. (5) the `core-relay` profile of the conformance kit (PRO-111) does not exist. The stale-base rule is the spec's default (04 §14, "rejects any commit whose `base` is not the head"); a relay has no snapshot commits, so a base before a snapshot is not distinguished (the open question on `stale_base` codes in SYN-005).

### SYN-045 Tolerate a confirmed step that fails to apply

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 4 | S | could | Maintainer |

**Spec:** 04 §14 · **Requirements:** R6, R7 · **Depends on:** SYN-019, SYN-044

As an integrating developer, I want every client to treat an unappliable confirmed step as a no-op, so that one bad step stored by a relay cannot brick the document.

**Acceptance criteria**

- [x] Given a relay channel, when a received confirmed step fails to apply to the confirmed document, then the client treats it as a no-op, advances its `seq` and continues.
- [ ] Given several clients, including the mock and local backends, when the same unappliable step is delivered to all, then they all skip it and converge to the same document.
- [x] Given a skipped step, when the client continues, then it still rebases its own in-flight and queued steps over the commit.
- [x] Given a skipped step, when it happens, then the client records the event for diagnosis.

**Evidence:** `packages/engine/src/sync/state.ts` (`applyConfirmed`, `failedReport`, `receiveCommits`): a confirmed step that throws or does not apply is counted and skipped, the commit's `seq` is kept, and a `report` action with code `step_failed` is raised. `packages/engine/test/sync-skip.test.ts` (5 tests): the seq advances and the confirmed document is kept; the next commit applies; the steps that do apply are kept and the count is reported; two clients that receive the same commit reach the same state (state level only); the in-flight `c1` and the queued step survive the skipped commit. `packages/engine/test/session.test.ts`, 'a confirmed step that does not apply is skipped and reported as step_failed': the event reaches `problem` through the session. Passed on 2026-11-13 (scoped run).

**Notes:** 04 §14 says "every client MUST" without limiting the rule to relay channels. Round 1 (lane SYN-043-053) applies it to every channel, the spec default; the engine has no channel kind to limit it by. The question whether it should be limited is in Open questions and recorded in `docs/adr/0271-lane-SYN-043-053.md`. Criterion 2 is not met: no test runs the mock backend (`packages/backend-mock`) or a local backend with the same unappliable step; the two states of the test are the same code, not two backends. A DEP-level test of the same step needs the conformance harness (PRO-111).

### SYN-046 Define the engine extension point

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | should | Maintainer |

**Spec:** 04 §15; ADR 0001; 05 §5.1, §5.2 · **Requirements:** R6 · **Depends on:** SYN-006, SYN-017

As a maintainer, I want the engine hidden behind an interface that any engine must satisfy, so that another engine can be added without a new protocol.

**Acceptance criteria**

- [x] Given the server and the client, when an engine is registered, then it must provide a resume token, server attribution of every change, a way for the server to refuse a change, and either JSON or opaque binary payloads; the type definitions make each of the four required.
- [ ] Given `pm-steps/1`, when it is registered, then it uses only this interface, and no ProseMirror type appears in the gateway or in the protocol layer.
- [x] Given a test engine that lacks a way to refuse a change, when the engine-contract test runs, then it fails.
- [x] Given a channel, when it opens, then the engine is the one negotiated for that channel through `hello.engines` and `ch.open.engine`, and an unsupported one yields `unsupported_engine`.

**Evidence:** `packages/authority/src/room/engine.ts` (`EngineDefinition`, `PM_STEPS_1`, `engineContractFailures`, `EngineRegistry`). `test/engine-contract.test.ts`: the four obligations are required members (a definition without `refuse` is a type error, checked with `@ts-expect-error`), and the contract test fails for an engine that lacks `refuse`, a resume member or attribution, or names another payload kind; `pm-steps/1` passes it. Criterion 4 (round 2, lane SYN-043-053; unticked by the reviewer of round 2 because nothing but its own test calls the helper): `packages/authority/src/room/channel-engine.ts` (`openNegotiatedChannel`) opens a channel only when `EngineRegistry.forChannel` accepts the engine against the negotiated list, and only when the engine is the one the room serves (`ENGINE`, `pm-steps/1`); otherwise it returns `unsupported_engine` and `Room.open` is not called. `test/channel-engine.test.ts` (5 tests) checks each case with a spy on `Room.open`. Passed on 2026-11-13 (scoped run with `test/engine-contract.test.ts`). Criterion 4 (fixer, round 2): the decision is `negotiatedEngine` in `channel-engine.ts`, which `openNegotiatedChannel` calls and which `@docedit/authority` exports. The service's data plane uses it: `services/document-service/src/data-plane/engines.ts` (`engineRegistry`, `SessionEngines`) builds the registry from the configured engines the authority defines, `session.ts` `#hello` keeps the engines negotiated from `hello.engines` for the session, and `#openChannel` answers `unsupported_engine` from `SessionEngines.forChannel` before it acquires a room (the server-wide `s.engines.includes` check is gone). `services/document-service/test/data-plane/engine-negotiation.test.ts` (4 tests, real WebSocket clients over MemoryStore): a negotiated engine opens; `pm-steps/1`, which the server serves but the session did not offer in `hello`, is refused with `unsupported_engine` and `host.rooms` stays empty; an engine the client offered but the server does not serve is refused the same way; the negotiation is per session. Passed on 2026-11-13 (scoped run with `test/data-plane/sync.test.ts` and the two authority tests).

**Notes:** Round 4 (lane SYN-043-053), criterion 2 not met: `packages/authority/src/projection/gateway.ts` imports prosemirror types and transform classes, and `services/document-service/src/data-plane/room-host.ts` imports prosemirror as well, so no ProseMirror type is yet kept out of the gateway. `packages/protocol/src` has no prosemirror import, only doc strings. Moving the gateway off prosemirror is a change outside this lane's round. Reviewer of round 2: criterion 4 is unticked. `openNegotiatedChannel` is imported only by `test/channel-engine.test.ts`. The service's data plane exists (`services/document-service/src/data-plane/session.ts`, `#openChannel`) and answers `unsupported_engine` from a server-wide list (`s.engines.includes(d.engine)`); it does not record `hello.engines` for the session and does not use the helper or `EngineRegistry`. Tick it when the data plane (or `Room.open`) opens a channel through the helper and a test through that path shows an engine outside the negotiated list refused. Criterion 2 is not met: `src/projection/gateway.ts` imports `prosemirror-model` and `prosemirror-transform`, so the gateway is not free of ProseMirror types (`engine-contract.test.ts` checks only `room/engine.ts` and the protocol package). Criterion 4 (round 2): the helper `openNegotiatedChannel` (see Evidence) exists and is tested alone; `Room.open` still takes no engine argument. The data plane does not call the helper (the developer's note that the gateway does not exist is out of date). A CRDT engine would satisfy the contract only at the granularity of one synchronised document; moving to one CRDT document per region is a rewrite of the log, history, restore, comparison, attribution and the suggestion and fill rules, not a fallback (04 §15, ADR 0001). No story is written for it. Offline-first editing, which would force that rewrite, is assumption A1 SPK-001. Not met: (2) the contract and the registry, and `packages/protocol`, name no ProseMirror type (`engine-contract.test.ts`), but the mock backend's channel layer builds rooms from ProseMirror nodes and the service's gateway (BE-001) does not exist. (4) is ticked again after the fixer of round 2 routed the data plane through the authority's decision (see Evidence). The data plane checks the engine before it acquires the room, so it calls `negotiatedEngine` rather than `openNegotiatedChannel`, which needs a room in hand; both run the same decision. The edit to `services/document-service/src/data-plane/session.ts` is in the BE lane's file (three small edits) and should be confirmed by the BE owner. 05 §5.1 gives `welcome` no engine list, so a `hello` without a common engine is not refused at once; each `ch.open` is refused instead. Lane w4 (2026-11-15), criterion 2 checked again and left unticked; nothing was built. Two things stand in its way, and both need a decision rather than code from this lane. (a) `pm-steps/1` does not yet use only the interface: the service's gateway (`services/document-service/src/data-plane/session.ts`) asks the registry only whether a channel's engine is negotiated, then hands `ch.open.resume` and each `commit` payload to the room as they came (`room.open`, `room.submit`), so `readResume`, `readChange`, `attribute` and `refuse` of `EngineDefinition` are called by tests only. To meet the criterion the interface needs a way to bind an engine to a room (open a channel, submit a change), and the session must reach the room through it; that changes who refuses a malformed commit and is the BE lane's file. (b) What the criterion means by the gateway is open. `session.ts`, `wire.ts` and `engines.ts` import no `prosemirror-*` module, but `room-host.ts` imports the ProseMirror schema (`@docedit/model/prosemirror`), and `packages/authority/src/projection/gateway.ts` rewrites steps for each visibility class (ADR 0019), so it cannot be free of ProseMirror types: it is either part of the `pm-steps/1` engine, behind the interface, or the criterion cannot be met as written. Proposed, not decided: treat the projection gateway and the room host as the engine's own code, extend `EngineDefinition` with the room binding, and check by test that the session layer and `packages/protocol` name no ProseMirror type.

## Verification

### SYN-047 Run the convergence property suite against the real service

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | L | must | Maintainer |

**Spec:** 04 §2 (G1 to G7); 11 §2 (S3), §3 (exit criteria); review section 2 · **Requirements:** R7 · **Depends on:** SYN-015, SYN-016, SYN-017, SYN-018, SYN-019, PRM-017

As a maintainer, I want property tests that hammer the real room and a real database with concurrent clients and faults, so that the guarantees of the sync engine are checked on every change.

**Acceptance criteria**

- [x] Given a number of simulated clients that generate random concurrent edits with all seven step types, when the run reaches quiet, then every client's confirmed document equals the server's document at the same `seq` (G1, G3).
- [x] Given random disconnects and resubmission of in-flight commits with their original `id`, when the run ends, then no commit was applied twice (G4) and no acknowledged commit is missing (G2).
- [x] Given injected write failures (known failure, unknown outcome, a grants revision that moved, an epoch conflict), when the run ends, then clients converge and none is ahead of the log.
- [x] Given overlapping mark steps and rejections, when clients rebuild from their confirmed documents, then they equal the authority's document (CONV-1).
- [x] Given grant changes racing with commits, when the run ends, then no commit was stored under a grants revision older than the one in force when it was stored (G7), using the permission oracle of PRM-017.
- [x] Given each guarantee G1 to G7, when the suite is listed, then each is named by at least one test and every failure prints a seed that replays it.
- [ ] Given the 1a exit criteria, when the suite runs in CI, then a short run gates every merge and a long run executes nightly.

**Evidence:** `services/document-service/test/postgres/convergence.pg.test.ts` runs `packages/authority/test/convergence.property.test.ts` unchanged against PostgreSQL. Through `vi.mock` it replaces the harness's in-memory storage with `test/sim/pg-sim-storage.ts`, which sends every write, read, grant change and ownership claim to the PostgreSQL stores of `services/document-service/src/storage/` through a synchronous bridge to a worker thread (`test/sim/sync-bridge.ts`, `test/sim/bridge-worker.ts`). The simulation's faults act on the real transaction (`src/storage/faults.ts`): rolled back before the inserts or before COMMIT, committed with the answer dropped, or rolled back and reported unknown; every unknown outcome is settled by reading the log back. Measured on 2026-11-06 on the development machine (Windows 11, PostgreSQL 17.11 on tmpfs in the Podman WSL machine): `SYN047_RUNS=3000` passed in 297.7 s, against 33 s for the in-memory run in the spike note. It stored 7,872 step commits (17,208 steps) and made 8,908 rejections, 1,006 failovers and 8,707 grant changes (3,007 notifications lost), through 16,836 conditional appends (11,240 stored, 2,786 `revision_moved`, 1,832 unknown, 978 failed). The default run, 300 schedules like the in-memory suite, takes 25 to 29 s. With the same fast-check seed (`SYN047_SEED`, which also replays a failing run) the suite's totals are identical in memory and against PostgreSQL: seed 20261106 over 300 schedules gave 744 step commits, 1,611 steps, 853 rejections, 357 faults, 126 failovers and 6,668 ordered messages in both, with the same rejections by code. `test/postgres/revision-race.pg.test.ts` also checks G7 in PostgreSQL's own commit order. Each failure prints fast-check's seed and path. Through the data plane: `services/document-service/test/data-plane/convergence.test.ts` (MemoryStore) and `convergence.pg.test.ts` (PostgreSQL) run the S3 schedules with every client speaking DEP over a real WebSocket to `createDataPlane` (driver `test/data-plane/sim/dep-sim.ts`). Faults: failed writes, unknown outcomes stored or lost, revisions moved by lost notifications, and epoch conflicts from a split brain, where a new node claims the document while the old one keeps its clients until its next write is fenced. Measured on 2026-11-06 on the development machine (Windows 11, PostgreSQL 17.11 in the Podman WSL machine), `SYN047_DEP_RUNS=300`: in memory 300 schedules in 41.1 s, 578 step commits (1,125 steps), 572 control commits, 610 rejections, 362 faults, 1,487 writes, 104 failovers of which 28 split brains, 847 grant changes of which 290 notifications lost, 4,879 ordered messages; against PostgreSQL 300 schedules in 76.7 s, 549 step commits (1,053 steps), 569 control commits, 588 rejections, 372 faults, 1,456 writes, 120 failovers of which 47 split brains, 828 grant changes of which 287 lost, 4,813 ordered messages; no failure in either. A second run of 300 schedules each, with fenced writes counted: in memory 31.4 s, 632 step commits (1,234 steps), 1,528 writes of which 19 were fenced by the epoch check, 97 failovers (33 split brains); against PostgreSQL 75.5 s, 566 step commits (1,102 steps), 1,487 writes of which 18 were fenced, 122 failovers (37 split brains); every client converged after each epoch conflict. The default runs are 60 schedules in memory and 30 against PostgreSQL.

**Evidence (criterion 1, lane U-SYN-037-053, 2026-11-13):** `services/document-service/test/postgres/convergence.pg.test.ts` (both tests passed, PostgreSQL 17 in the shared container `docedit-test-postgres`, default 300 schedules, 80 s, run with `pnpm exec vitest run --project node <file>`). The unchanged suite's 'G1 to G7' test asserts the convergence of every client with the server at each `seq` and, in the same run, that each of the seven step types is submitted and stored at least once (`convergence.property.test.ts` lines 111 to 113). The 2026-11-06 Note that `removeMark`, `addNodeMark` and `removeNodeMark` never appeared is out of date: the harness client produces them (`packages/authority/test/harness/client.ts`, lines 591 to 635).

**Evidence (criterion 6):** `packages/authority/test/convergence.property.test.ts`: the test 'G1 to G7: total order, durability before visibility, convergence, idempotent submission, gap-free delivery, server attribution and no stale authorisation' names all seven guarantees in its title; 'reports a failing schedule with its seed and a shrunk sequence that replays (PRM-017)' checks that a failure report carries the seed. Passed on 2026-11-13 (scoped run with `convergence.snapshot.property.test.ts`).

**Notes:** the spike S3 prototype SPK-016 proves the approach; this is the production suite and must run against the real service (11 §3). In 1a, reconnect means reopening the channel and resubmitting the in-flight commit; resume arrives in 1b. Still open, as of the PostgreSQL runs of 2026-11-06. Criterion 1: in two runs of 100 schedules the stored steps were `replace`, `attr` and `addMark`, plus one `replaceAround`; `removeMark`, `addNodeMark` and `removeNodeMark` never appeared; the harness's clients would have to produce them. Criterion 3: the run injects known failures, unknown outcomes and moved revisions but no epoch conflict, because the harness's failover lands or drops the crashed room's write before the new owner claims. `services/document-service/test/postgres/fencing.pg.test.ts` covers epoch conflicts with real rooms, outside the property run. Both need harness changes in `packages/authority`. Criterion 6 is met since the test titled 'G1 to G7' was added (see its Evidence). Criterion 7: no CI workflow yet; the short run is the default and the long run is `SYN047_RUNS=3000`, both through `pwsh -NoProfile -File infra/test-env.ps1 run pnpm test`. A short run cannot gate merges reliably until the suite's non-vacuity thresholds get more margin: two PostgreSQL runs stored 496 steps in 100 schedules and 1,488 in 300, under the "more than five steps per schedule" threshold. Those totals depend on the schedules alone, not on the storage, so the in-memory suite misses the threshold for the same schedules. The run goes through the real room and the real storage, not yet through the service process of BE-001. Update of 2026-11-06 (packet A1): the suite now also runs through the service process, the data plane over DEP, and criterion 3 is met there, epoch conflicts included. Criteria 1, 6 and 7 stay open for the reasons above; the step totals of the data-plane runs (3.6 to 3.8 steps per schedule) are below the in-memory suite's threshold of five, so that threshold is not asserted there. Lane w4 (2026-11-15): criterion 7 stays unticked, blocked on hosted CI. The jobs exist as files: in `.github/workflows/ci.yml` the job `integration` runs `pnpm test` against PostgreSQL in Podman on every push and pull request (the short run, with the suite's default number of schedules), and the job `convergence-nightly` runs it with `SYN047_RUNS=3000` on the schedule. The criterion asks for the suite to run in CI, to gate every merge and to execute nightly. No run of either job could be seen from this machine (the `gh` command is not installed, and the lane does not push), no branch protection rule that makes the job a required check could be checked, and a scheduled run needs the workflow on the default branch of the remote. The "CI workflow does not exist" part of the earlier note is out of date; the rest stands. Whoever has access to the hosted repository can tick this from a merge that the `integration` job gated and one nightly run of `convergence-nightly`, naming both runs.

> SYN-048 (Soak the sync engine under fault injection) was merged into BE-080 during the cross-check of 2026-11-06.

### SYN-049 Fuzz the authority

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** 04 §12; 05 §11; 06 §8; 10 §3.3, §5; review CPU-1 · **Requirements:** R10 · **Depends on:** SYN-010, SYN-011, SYN-037

As an operator, I want the authority fuzzed with hostile steps and commits, so that no input can crash or stall a process that hosts many rooms.

**Acceptance criteria**

- [x] Given random and mutated step JSON of every allowed type and of disallowed types, when it is fed to validation, rebase, apply and the invariant check, then no input crashes the process, raises an unhandled exception or runs beyond the time limit, and every refusal carries a code from the registry.
- [x] Given adversarial documents and slices (deep nesting up to the limit of 12, very large slices, long attribute strings up to the grammar limits), when the authority processes them, then structural limits hold and no input stalls the loop.
- [ ] Given the fuzz corpus, when CI runs, then a short run gates every merge and a long run executes nightly; every crash found becomes a minimised regression test.
- [x] Given the CPU measured per fuzz input, when it is compared with the estimate of SYN-037, then outliers are reported so the estimate can be corrected.
- [ ] Given the fuzzers for step validation, when the conformance kit is built, then they are included in it PRO-111.

**Evidence:** `packages/authority/test/fuzz.test.ts` (default 10 s; `FUZZ_MS` sets the long run): hostile envelopes and step JSON, and valid steps of all seven types with random mutations, through the room and directly through `parseSteps`, `rebaseOver` in both modes, `applySteps` and `checkInvariants`; nothing throws, no input runs beyond `FUZZ_INPUT_MS` (2 s, a stall bound, not a target), every refusal carries a `sync` code of `spec/dep/dep-1.registry.json`, and accepted documents validate. On 2026-11-06: 31,400 submissions in 10 s, 1,497 accepted, slowest 16.2 ms. Adversarial structures: CDM 1 lets no table into a cell, so the deepest legal path stays below I7's 12 and nested tables 2 to 40 deep are refused at once; a 900 KB slice is processed within the bound and 1.1 MB is `too_large`; a region title of 255 characters passes, 256 is refused; a 200 KB link is handled. Each run prints the inputs with the most milliseconds per unit of the SYN-037 estimate (median 5 µs per unit on 2026-11-06).

**Notes:** Not met: (3) the short run is the default of `pnpm test` and `FUZZ_MS` sets the long run, but no CI workflow exists yet (root configuration); a crash becomes a minimised entry of `REGRESSIONS` in `fuzz.test.ts`, replayed first (two from spikes S3 and S12 are there). (5) the conformance kit (PRO-111) does not exist.

## Read restrictions (ADR 0019)

Added on 2026-11-06 from spike S12 (SPK-029; `docs/spikes/2026-11-06-s12-read-restrictions.md`), after the owner decided that version 1 can hide regions and field values from some readers (SPK-005). Every other story that serves content, steps, positions, history, search, exports, comments, presence or field values applies the requester's projection: README §2.2 rule 8.

### SYN-050 Project the document per visibility class

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | L | must | Maintainer |

**Spec:** ADR 0019 (decision items 1 and 2); 04 §5, §9, §12 · **Requirements:** R3, R7 · **Depends on:** CDM-053, PRM-067, SPK-029

As a maintainer, I want the authority to keep a projection of the document for each visibility class, so that every reader is served only what they may read.

**Acceptance criteria**

- [x] Given a full document and a hidden set, when it is projected, then hidden regions become placeholders, hidden values become the redaction marker, and the full document is unchanged.
- [x] Given positions, when they are mapped between the full document and a projection in either direction, then positions outside hidden content round-trip and positions inside it map to none.
- [x] Given a commit, when the projection after it is computed, then only the nodes on the path to the change are rebuilt, and the result equals a projection built from scratch (property test).
- [x] Given the shared corpus (FND-006), when projections are computed per commit, then their cost per class is reported on the reference machine (FND-007) against the authority's budget (04 §12).

**Evidence:** `packages/authority/src/projection/projection.ts`, now built on the model's projection schema and redaction marker (CDM-053). `test/projection.test.ts`: redaction leaves the full document untouched, positions map both ways and inside a hidden region to none, and the incremental projection equals one built from scratch (500 runs). `test/projection.steps.test.ts`, 'projections (SYN-050)': after a commit only the changed body child is a new object, whether projected afresh or reached by the class's mapped steps; the hidden spans are kept by mapping, never by scanning the body. Criterion 4 (lane w4, 2026-11-15): `packages/authority/scripts/projection-cost.ts` now ends with the worst class against the budget of 04 §12. Measured on the reference machine of ADR 0037 (FND-007: Alienware Aurora R11, Intel Core i9-10900KF, 128 GiB, Windows 11 Pro 10.0.26300, power plan High performance, Node.js 22.18.0) with `node packages/authority/scripts/projection-cost.ts 300 1`, corpus `docedit-corpus 2 (dd2dac5a)`, 300 one-character commits per document, two classes per document (half of the regions and values hidden; all hidden). Times are wall-clock from `performance.now()` on one thread, as median / 95th percentile, for one class's outgoing work per commit (`projectCommit`): form-fields 0.021 / 0.081 ms; pages-20 0.022 / 0.063 ms; pages-100 0.042 / 0.127 ms; pages-300 0.056 / 0.120 ms (22 regions hidden) and 0.116 / 0.265 ms (43 hidden); pages-1000 0.295 / 0.619 ms (72 hidden) and 0.398 / 0.820 ms (143 hidden). Mapping a reader's step back to full positions: at most 0.123 / 0.268 ms. A cold projection: 2 to 3 ms (form-fields) up to about 290 ms (pages-1000) per class. Against 04 §12 (a typical commit well under a millisecond of CPU): every class's median and 95th percentile is under 1 ms; the highest is pages-1000 with all 143 regions hidden.

**Notes:** The spike's code in `packages/authority/src/projection/` is the starting point. Not met: (4) needs the reference machine (FND-007). On the development machine, `node packages/authority/scripts/projection-cost.ts 300 1` (2026-11-06) measured a class's outgoing work at 1,000 pages at 0.10 to 0.14 ms per commit (median) with mapped steps, against 2.3 to 2.9 ms for the spike's projection and diff in the same run, and a cold projection of about 130 ms per class. Lane w4 (2026-11-15): criterion 4 is ticked; the development machine is the reference machine ADR 0037 names, so the run in Evidence is on it. Limits of that measurement: it is one run, taken while four other lanes were running tests on the same machine, so the figures are an upper bound for an idle machine (single commits took up to 26 ms, which is scheduling or garbage collection, not the algorithm); it times wall-clock, not CPU time; the browser throttling profile of ADR 0037 does not apply to a Node.js script. 04 §12 gives no number below "well under a millisecond"; the script checks 1 ms as the ceiling, which is this lane's reading, not a decided budget. At 1,000 pages with every region hidden the 95th percentile (0.82 ms) is under that ceiling but not well under it, and the cost is per class, so a room with several classes pays it once for each. The results are not stored per commit (FND-007 criterion 5 is open).

### SYN-051 Send each commit to each visibility class

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** ADR 0019 (decision item 3, change 4); 04 §2, §7, §8 · **Requirements:** R3, R7 · **Depends on:** SYN-050

As a maintainer, I want every stored commit sent to each reader as steps on their projection, so that readers converge to their projection of the head without receiving hidden content.

**Acceptance criteria**

- [x] Given a commit that does not touch hidden content, when it is sent to a class, then it goes as its own steps mapped to projected positions, keeping each step's type.
- [x] Given a commit that touches hidden content, when it is sent to a class, then it goes as one replacement step between the projections before and after, or as an empty commit when the projection did not change, and sequence numbers stay gap-free (G5).
- [x] Given an acknowledgement to a read-restricted reader, then it carries the class's steps (`rebased: true`).
- [x] Given the faults of S3 and an oracle that scans every message, when random schedules run, then every client converges to the projection of the head for its class, and no hidden text, title or value reaches a reader without access.

**Evidence:** `projectCommit` (`projection.ts`) and `ProjectionGateway` (`gateway.ts`): a step that does not touch hidden content goes as itself at projected positions, a step inside a hidden region sends nothing, a hidden value change sends the redacted change, a step that changes nothing is never forwarded, and from the first step that touches hidden content in another way the class receives one replace step per changed range of the commit's result (second review SR-M1; never one step from the first change to the last, and never a state inside the commit). `test/projection.steps.test.ts`: every step type keeps its type; a change inside a hidden region is an empty commit that advances seq; a reader's typing between two hidden values that one commit sets survives (it would be dropped by one diff step); acknowledgements carry the class's steps with `rebased: true`; 500 random commits give exactly the projection after them. `test/projection.property.test.ts` (`S12_RUNS=1000` on 2026-11-06, faults of S3, snapshot restores, the gateway's `audit()` of every class's steps): 4,711 commits, 38,171 messages scanned, 5,690 secrets sent only to readers entitled to them, none to anyone else; routes 10,386 mapped, 1,175 inside, 932 value, 518 no-op, 451 diff.

### SYN-052 Map and vet a reader's commit

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** ADR 0019 (decision item 4, change 5); 04 §5, §6 · **Requirements:** R3, R13 · **Depends on:** SYN-050

As a maintainer, I want a read-restricted reader's commit rebased in projected space and mapped to full positions before the room checks it, so that it meets exactly the checks a commit on the full document meets.

**Acceptance criteria**

- [x] Given a reader's commit, when it is rebased over the class's steps since its base and mapped to full positions, then it passes or fails steps 5 to 7 of 04 §5 exactly as the equivalent commit on the full document would (differential test).
- [x] Given a step that touches a placeholder, or a slice that carries a placeholder or a redacted value, when it arrives, then it is refused with `permission_denied` before the room sees it.
- [x] Given a change to the value or default of a field whose value the reader cannot read, when it arrives, then it is refused with `permission_denied`.
- [x] Given a malformed or crafted step that maps outside the document, when it arrives, then it is refused with `invalid_op` and nothing throws.

**Evidence:** `toFullSteps` (`projection.ts`) and `ProjectionGateway.submit`: `test/projection.differential.test.ts` (`S12_RUNS=1000` on 2026-11-06: 3,358 commits with the same verdict in both rooms, 1,363 accepted, 1,311 `permission_denied`, 684 `invalid_op`; 1,152 edits touching hidden content refused by the gateway). `test/projection.steps.test.ts`, 'vetting a reader's commit': a slice that carries the placeholder or a redacted field, and a change of a hidden value or default, are `permission_denied`; crafted steps mapped outside the document are `invalid_op` and nothing throws. Incoming mapping now keeps the class's hidden spans by mapping instead of projecting after every step.

**Notes:** On 2026-11-13 the S12 leak oracle (`test/harness/projection-sim.ts`) was reported once to have failed with 'mallory received hidden region content in sync.reject'. It was not reproduced: the review's 12 runs of `projection.property.test.ts` (4 default, 8 with `S12_SEED` varied) and a seed loop of 4,000 schedules over the same simulation, which printed every leaking payload, found none. One channel that fits it was closed: an `invalid_op` reason built on the full document can quote its content (a ProseMirror error such as 'Invalid content for node', or a validator message). `toFullSteps` no longer puts the thrown message in its reason, and the gateway gives a read-restricted reader only the step index of a room's `invalid_op` reason (`withheldReason`, `gateway.ts`; `test/projection.withheld-reason.test.ts`). If the oracle fails again, keep the seed and the payload.

### SYN-053 Close and reload readers whose visibility class changes

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Maintainer |

**Spec:** ADR 0019 (decision item 6, changes 1 to 3) · **Requirements:** R3, R7 · **Depends on:** SYN-051, PRM-067, PRO-130

As a maintainer, I want a reader whose access changes to start again from their new projection, so that no projection of the old view reaches them again.

**Acceptance criteria**

- [x] Given a connected reader whose class changes, when the room learns of the change, then their channel is closed with the access-change reason, and their next open is a reload with the new projection.
- [x] Given a resume whose view token is missing or names another class, when it arrives, then the answer is a reload, never a stream.
- [x] Given unconfirmed work at that reload, then it goes to recovered edits.
- [x] Given a lost notification of a grant change, when a reader opens the document, then the content is projected at the grants revision in storage, not at the room's older one.

**Evidence:** `ProjectionGateway` (`gateway.ts`): a reader whose class changes (grants revision, snapshot, `expire()`, `refresh()`) is closed with `ch.closed` code `unavailable` and reason `access_changed`, a value PRO-130's close code can replace; a resume with a missing or another class's view token reloads; `open(channel, conn, resume, stored)` brings the room up to the grants revision read from storage before projecting. `test/projection.steps.test.ts`, 'readers whose class changes' and 'with the permissions module's visibility': the close reason and the reload with the new projection, the token rule, content projected at the stored revision when the notification was lost, and an expired grant and a refreshed token under `visibility(now)` of `src/permissions/visibility.ts`. `S12_RUNS=1000`: 508 closes on access change and no stale read (was 4 in 1,000 in the spike).

**Evidence (criterion 3):** `packages/engine/test/sync-reload-recovered.test.ts`, 'goes to recovered edits with the reason reload, in-flight first then queued' (the engine's `reload`, `packages/engine/src/sync/state.ts`). Passed on 2026-11-13 (scoped run).

**Notes:** The close reason is the room's `CloseReason` `access_changed` with code `unavailable` until PRO-130 gives DEP a close code of its own. Not met: (3) is the client's: the harness client moves all unconfirmed work to recovered edits on a reload (4,327 edits over `S12_RUNS=1000`), and the engine adopts it (FE-008). Round 1 (lane SYN-043-053) ticks criterion 3 for the engine state machine: `reload` in `packages/engine/src/sync/state.ts` discards the in-flight and queued steps with reason `reload`, tested by `packages/engine/test/sync-reload-recovered.test.ts` ('goes to recovered edits with the reason reload, in-flight first then queued'; the two are one recovered item). The session's `discarded` event reaching the recovered store is not tested here.

## Coverage

| Spec section | Stories |
|---|---|
| 04 §1 Model | SYN-006, SYN-029 |
| 04 §2 Guarantees G1 to G7 | G1 SYN-006, SYN-047; G2 SYN-015, SYN-016, SYN-047; G3 SYN-006, SYN-047; G4 SYN-008, FE-008, FE-009, SYN-047; G5 SYN-015, SYN-019, SYN-027; G6 SYN-014; G7 SYN-013, SYN-047 |
| 04 §3.1 Step commits | SYN-003, SYN-014, SYN-018 |
| 04 §3.2 Control and snapshot commits | SYN-004, SYN-005, SYN-023 |
| 04 §4 Steps | SYN-002, SYN-003 |
| 04 §5 Authority algorithm | SYN-006 to SYN-016, SYN-030 |
| 04 §6 Rebase procedure | SYN-010 |
| 04 §7 Acknowledgement and confirmed document | SYN-015, SYN-017 |
| 04 §8 Client algorithm | SYN-018 to SYN-023, SYN-028, FE-008, FE-009, FE-012 |
| 04 §9 Reconnect and resume | SYN-026 to SYN-029 |
| 04 §10 Server-authored commits | SYN-030, SYN-031 |
| 04 §11 Presence | SYN-035, SYN-036 |
| 04 §12 Admission control and performance | SYN-037 to SYN-042; room eviction: none, owned by BE (06 §2.2) |
| 04 §13 Divergence check | SYN-043 |
| 04 §14 Relay mode | SYN-044, SYN-045 |
| 04 §15 Other engines | SYN-046 |
| 04 §16 Open issues | SYN-038, Open questions |
| ADR 0001 | SYN-001 to SYN-016, SYN-046 |
| ADR 0015 (range mapping) | SYN-032, SYN-033, FE-048 |
| Review section 3.1 | SYN-008 (SYNC-1), SYN-013 (PERM-1), SYN-016 (TENT-1), SYN-017 (CONV-1), SYN-029 (DR-1), SYN-026 (ROUTE-1), SYN-005 (MIG-1), SYN-030 (SRV-1), SYN-037 (CPU-1), SYN-044 (RELAY-1), SYN-036 (PRES-1) |
| Spike S3 | none: owned by SPK (production suite: SYN-047 to SYN-049) |

## Open questions

| Question | Affects |
|---|---|
| **A1, offline-first editing** (one-way door, default no). The whole epic depends on it: a CRDT engine would replace the log, history and the rules. Needs the owner's decision SPK-001. | all; SYN-046 |
| **Code and action for a base before a snapshot commit.** 04 §3.2 says action `reload`; §5 step 3 says `stale_base`, whose table action is `rebase` and whose client behaviour (wait, rebase, resubmit) cannot succeed after a snapshot. | SYN-005, SYN-009, SYN-020, SYN-023 |
| **Codes the spec does not name:** a commit with zero steps, a disallowed step type (including `docAttr`), unparseable steps, and a client-supplied reserved origin (`restore`, `import`, `migration`, `repair`, `sign`, `rules`, `prefill`, `control`). The stories assume `invalid_op`; the reserved-origin behaviour is undecided. | SYN-003, SYN-004 |
| **Input-method composition while remote commits arrive** (spike S1). Not decided by 04. | SYN-018, SYN-019 |
| **Commit granularity and the 100 ms batching rule** are "a starting point"; the sentence does not say whether batching applies while a commit is in flight. | SYN-018, SYN-038 |
| **`maxRebaseSteps` (5,000) and the catch-up limits** are guesses. | SYN-009, SYN-026, SYN-038 |
| **Pipelining more than one in-flight commit.** Not decided; SYN-038 supplies data only. | SYN-018, SYN-038 |
| **A rolling document hash per commit** would give continuous divergence detection and a stable authority-service identity; its cost is unmeasured. | SYN-043, SYN-038 |
| **Tenant CPU budget code:** 04 §12 says `rate_limited`; 06 §12 says exceeding a tenant quota returns `quota_exceeded`. | SYN-037 |
| **Budgets and cost formula for admission control** are not given. | SYN-037, SYN-038 |
| **Transient authority against a room opening at the same moment.** The single-authority rule is stated for open documents only. | SYN-031 |
| **Comment ranges:** the bias of a range at its edges (does text typed at the edge land inside or outside), the effect of removing a block that a thread targets, and the code when `baseSeq` is outside the rebase window. | SYN-032, SYN-033 |
| **How long a receiver retains mapping history for presence.** | SYN-036 |
| **Where a diverged client "reports the event"** after `sync.check`. | SYN-043 |
| **Whether the "treat as a no-op" rule is for relay channels only.** | SYN-045 |
| **What "many subscribers" means for coalescing**, and the code for a submission on a follower. | SYN-041, SYN-042 |
| **State of an in-flight commit that is waiting to be stored when a channel opens:** `ch.opened` names only `accepted` and `unknown`. | SYN-026 |
