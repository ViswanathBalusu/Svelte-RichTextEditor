# FND Foundations

The groundwork every other epic builds on: the repository and its package layout, shared conventions, architecture boundaries, continuous integration, the shared document corpus, the performance harnesses and budget gates, licences, release and documentation. Sources: [00 Overview](../spec/00-overview.md) §9, [01 Architecture](../spec/01-architecture.md) §6 to §8, [13](../spec/13-experience-extensibility.md) §9, and [ADR 0016](../adr/0016-rust-wasm-compute-kernels.md). Machine-readable protocol and model artifacts belong to PRO and CDM; supply-chain security to SEC; observability to BE; the reference host and its compose file to UX.

## Repository and conventions

### FND-001 Monorepo with the package layout of the architecture

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 01 §6, §7 · **Requirements:** R2, R6 · **Depends on:** none

As a maintainer, I want one TypeScript monorepo laid out as the architecture describes, so that the component and the reference service share the model, the authority and the rules from the first commit.

**Acceptance criteria**

- [ ] Given a fresh clone, when a contributor runs the documented setup, then a pnpm workspace with `packages/`, `services/`, `apps/` and `spec/` builds, type-checks and tests with one command.
- [x] TypeScript strict mode is on for every package, from one shared base configuration.
- [x] Packages are published under the working scope `@docedit/*` until SPK-007 renames them, and each is created only when its first story needs it.
- [x] Services target Node.js 22 or later (01 §7).
- [x] Linting and formatting run locally and in CI with the same configuration.

**Evidence:** Criterion 2: every package's tsconfig.json extends tsconfig.base.json (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax, erasableSyntaxOnly) and none overrides them (checked 2026-11-06 over packages/* and services/*). Criterion 3: all 13 packages are named @docedit/*, and each was created by the first story that needed it. Criterion 5: pnpm lint runs eslint . and prettier --check . with eslint.config.js, .prettierrc.json and .prettierignore, and .github/workflows/ci.yml runs the same pnpm lint. Criterion 4: every package under services/ declares `engines.node` `>=22.18.0` (services/export-worker/package.json gained it on 2026-11-15), as does the root package.json; .npmrc sets `engine-strict=true`; .node-version, which CI installs, is 22.18.0; the asset worker's image is built on Node.js 24. scripts/workspace-layout.test.ts ("services target Node.js 22 or later") checks each of these and that the runtime running the tests is 22 or later (run 2026-11-15 on Node.js 22.18.0, Windows 11). Criterion 1, in part: the same file checks the declared half (the four folders, the workspace globs, `pnpm check` chaining lint, type-check, tests and build, a `typecheck` script in every workspace member, the pinned pnpm, and the README's setup section).

**Notes:** phase 0 because spikes S3, S4 and S6 produce code meant to be kept. Criterion 1 stays unticked (2026-11-15): it asks for a run from a fresh clone, and none has been made and recorded. The integrator's `pnpm check` runs in a checkout that is already installed, and the hosted CI job that would run it from a clone (.github/workflows/ci.yml, job `check`) has no recorded run here. To tick it: clone into an empty folder, run `pnpm install --frozen-lockfile` and `pnpm check`, and record the date, machine and result. The 2026-11-15 pass found that packages/painter had no tsconfig.json and no `typecheck` script, so `pnpm typecheck` skipped it; both were added (its source type-checks cleanly; its tests are still not type-checked, as it has no tsconfig.test.json).

### FND-002 Continuous integration across the supported browsers

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 02 §12, §14; 13 §8 · **Requirements:** R11, R12 · **Depends on:** FND-001

As a maintainer, I want every change built and tested in Node.js and in each supported browser, so that regressions are caught before they merge.

**Acceptance criteria**

- [ ] Given a pull request, when CI runs, then lint, type-check, unit tests in Node.js without a browser, and the build all run and must pass before merge.
- [ ] Playwright suites run in Chrome and Edge 137 or later, Firefox 142 or later and Safari 17 or later (02 §12), with the minimum versions pinned in the configuration.
- [ ] axe checks run inside the Playwright suites and fail the build on new violations.
- [ ] Test results, traces and screenshots of failures are kept as build artifacts.
- [ ] The pipeline's duration is reported, so that slow suites are visible.

**Notes:** No criterion is ticked, because the pipeline has never run: this repository has no Git remote (`git remote -v` is empty on 2026-11-15), so there is no hosted CI, no pull request and no branch protection rule. Each criterion asks for a CI run, and a workflow file that has not run is a plan. What exists, and what a first hosted run has to show (lane w5, 2026-11-15):

- (1) `.github/workflows/ci.yml`, job `check`, runs `pnpm lint`, `pnpm typecheck`, `pnpm test` (Node.js, no browser) and `pnpm build` on every pull request. "Must pass before merge" also needs the branch protection rule, which is set on the host, not in the repository.
- (2) Job `browsers` runs the universal tests, and the new job `e2e` runs the Playwright suites of `packages/element` and `packages/ui`, in Chromium, Edge, Firefox and WebKit (WebKit on macOS stands in for Safari; Safari itself is not run). The minimum versions are pinned once, as `BROWSER_MINIMUMS` in `packages/element/scripts/vite-configs.ts` (the build target of every component build; `packages/element/test/browser-support.test.ts`). The new `scripts/ci/browser-version.ts` launches the browser a job is about to test and fails the job when it is older than that minimum. Run locally on Windows 11 on 2026-11-15 with Playwright 1.65.0 it reported Chromium 158, Edge 157, Firefox 159 and WebKit 27.2, all above the minimums. The suites run on Playwright's current engines, never on the minimum versions themselves; whether a run on the exact minimums is wanted is open (the comment in the `browsers` job names a scheduled compatibility run that does not exist).
- (3) The axe checks are inside those suites (9 spec files use `@axe-core/playwright`), and a violation fails its test. Checked locally in the form the job uses: `pnpm exec playwright test -c packages/ui/playwright.config.ts --project=chromium axe`, 14 passed, Chromium, Windows 11, 2026-11-15. "New violations" is read as any violation: there is no baseline of accepted ones.
- (4) Job `e2e` uploads `packages/<suite>/test-results/` on every outcome (the JSON results, and the traces and screenshots Playwright keeps for failed tests); `check` uploads the JUnit file; `browsers` uploads on failure.
- (5) Job `summary` writes the duration of every job to the run's summary, and now waits for `e2e` too.
- `scripts/ci/browser-version.test.ts` checks the version gate and that `ci.yml` keeps these jobs, commands and artifact steps. It reads the workflow file; it does not run it.
- The suites of `apps/reference-host` and `tests/V-FE-113-128` need the demo stack or PostgreSQL and are not in the `e2e` job.

### FND-003 Shared conventions for identifiers, time, lengths, numbers, colours and errors

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 01 §8 · **Requirements:** R6 · **Depends on:** FND-001

As a maintainer, I want one tested implementation of the cross-cutting conventions, so that the component, the service and other implementers agree on every value's form.

**Acceptance criteria**

- [x] Documents, commits, sessions, assets, jobs and threads get UUID version 7 identifiers in canonical text form; node identifiers are 16-character URL-safe random strings.
- [x] Timestamps are RFC 3339 in UTC with millisecond precision, and only server-assigned times are treated as trusted.
- [x] Lengths, including font sizes, are integers in twentieths of a point; a helper converts to points and to TeX `bp` by dividing by 20.
- [x] A validator rejects floating-point numbers where the CDM requires decimal strings, colours not of the form `#RRGGBB`, and language tags that are not BCP 47.
- [x] Errors carry a stable `code`: RFC 9457 problem details over REST and typed messages over the socket; the registry of codes itself is PRO's.
- [x] The same helpers run in the browser and in Node.js and have identical test vectors.

**Evidence:** `packages/model/src/conventions/` (`ids.ts`, `time.ts`, `units.ts`, `validators.ts`, `errors.ts`, `platform.ts`) with `conventions.universal.test.ts` (UUID version 7 text form and order, node identifiers, timestamps, twips to points, `bp` and CSS, decimal strings, `#RRGGBB`, BCP 47, non-integer numbers, problem details, SHA-256) and `ids.test.ts` (a million node identifiers from the platform's CSPRNG, no duplicate). In documents the same rules are I11: `packages/model/src/validate/validate.test.ts`. Server time: the room stamps its own clock and ignores a claimed one (`packages/authority/test/room-scenarios.test.ts`, "stamps user, session and server time from the connection and the clock, ignoring claims"); socket rejections carry a `code` (`packages/authority/src/codes.ts`). The universal tests passed on 2026-11-06 on Windows 11 in Node.js 22.18 and, through Playwright 1.65, in Chromium, Firefox, WebKit and the installed Microsoft Edge (`pnpm test:browsers`; `DOCEDIT_BROWSERS=msedge`).

**Notes:** Playwright's WebKit stands in for Safari until the macOS job of CI runs. The registry of codes is PRO-038.

### FND-004 Architecture boundary checks

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 01 §6; 02 §5.1, §9.1; ADR 0003 · **Requirements:** R2, R6 · **Depends on:** FND-001

As a maintainer, I want the build to fail when code crosses an architectural boundary, so that the editing core stays replaceable and the authority stays portable.

**Acceptance criteria**

- [x] Given `model`, `authority`, `rules` or `layout` imports a Node.js or browser API, when CI runs, then the build fails (01 §6; 02 §9.1).
- [x] Given a ProseMirror type appears in the document API's public types, or `ui` imports a `prosemirror-*` module, then the build fails (02 §5.1; ADR 0003).
- [x] Given a service imports `ui` or `element`, then the build fails.
- [ ] The rules live in one configuration file with a comment citing the spec section behind each.

**Evidence:** `packages/model/test/boundaries.test.ts`. A probe that uses `process`, `document`, `window`, `Buffer`, `TextEncoder` and `node:fs` fails the type check of `model` and of `authority` on exactly those lines, while each package itself type-checks (lib ES2023, no ambient types). dependency-cruiser, run with the rules of `.dependency-cruiser.cjs` on a probe workspace, reports Node.js modules imported by `model`, `authority` and `rules`; `prosemirror-view` and the painter imported by `layout`; `prosemirror-model` imported by `ui`; `ui` and `element` imported by a service; and nothing for a clean file. These are the `pnpm typecheck`, `pnpm deps:check` and `pnpm test` steps of `.github/workflows/ci.yml`; CI itself has not run yet, because the repository has no remote.

**Evidence (lane w5, 2026-11-15, criterion 2):** `packages/engine/test/fnd-004-w5-api-surface.test.ts` (Node.js, `pnpm exec vitest run --project node` on that file, 2 of 2 pass). With the TypeScript type checker it follows every export of the document API (`packages/engine/src/api.ts`) through members, parameters, results, type arguments, unions and base types, across the engine's own files, and finds no type declared in a `prosemirror-*` package. A probe that extends the API with a `Node` member, a result of `Promise<readonly { state: EditorState }[]>` and a type of the engine that holds the ProseMirror state (`Internals`) is reported at each of the three places, so the test fails when such a type is added. `packages/model/test/boundaries.test.ts` (4 of 4 pass) has two new probes for the real case, where `ui` and `element` cannot resolve ProseMirror because they do not depend on it: an unresolved `prosemirror-state` import is reported by `ui-no-prosemirror` and by `hosts-no-prosemirror`. Both tests run in `pnpm test`, a step of `pnpm check` and of the CI workflow; as for the other criteria, hosted CI has not run.

**Notes:** Not met: (2) the document API (02 §5.1) does not exist yet, so nothing checks its public types for ProseMirror types; the `ui` half is shown by the probe. (4) the `no-circular` rule cites no spec section, and the rule against Node.js and browser globals lives in `tsconfig.base.json`, not in the boundary file; both are root configuration (main session). Lane w5 (2026-11-15): (2) is ticked: the document API exists now (FE-026) and its public types are checked with the type checker (see Evidence). The comment in `packages/engine/test/fe-026-document-api-boundary.test.ts` that dependency-cruiser misses an unresolved `prosemirror-*` import is out of date; the new probes show the rules report it. (4) stays unticked. Every rule of `.dependency-cruiser.cjs` now cites its spec section, `no-circular` included (01 §6). But the rules are not in one file: the ban on Node.js and browser globals is the `lib` and `types` settings of `tsconfig.base.json`, and the ban on ProseMirror types in the API is a test, because neither is a rule about imports and dependency-cruiser cannot express them. The header of `.dependency-cruiser.cjs` names both and where they live. Whether one file that holds the import rules and points to the other two checks meets "one configuration file" is for the owner or the reviewer; the wording was not changed.

### FND-005 Canonical JSON, hashing and compression primitives

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 01 §8; 03 §2 · **Requirements:** R4, R6 · **Depends on:** FND-001

As a maintainer, I want one implementation of RFC 8785 serialisation, SHA-256 and Zstandard used everywhere, so that every hash of a document is the same in the browser, the service and other implementations.

**Acceptance criteria**

- [x] Given the RFC 8785 test vectors, when the serialiser runs in Node.js and in each supported browser, then every output matches byte for byte.
- [x] SHA-256 uses the platform's native implementation on both sides.
- [x] Zstandard compresses stored checkpoints and commit payloads (01 §8); HTTP content encoding is left to normal negotiation.
- [x] The CDM's own canonical-form rules (03 §2) build on these primitives and are owned by CDM.

**Evidence:** `packages/model/src/canonical/jcs.universal.test.ts` (the example of RFC 8785 §3.2.3, member order by UTF-16 code units, the binary64 vectors of appendix B, refusal of NaN, infinities, lone surrogates and undefined) and the SHA-256 vectors of `conventions.universal.test.ts` (`crypto.subtle.digest` through `platform.ts`) passed on 2026-11-06 on Windows 11 in Node.js 22.18 and, through Playwright 1.65, in Chromium, Firefox, WebKit and Microsoft Edge. `canonical-form.ts` builds the CDM canonical form on `canonicalize` and `sha256Hex`; `canonical-form.universal.test.ts` pins the hash of the 03 §12 example in every engine.

**Evidence (lane w5, 2026-11-15, criterion 3):** the document service compresses with the Zstandard of `node:zlib` (Node.js 22.18; marked experimental there): commit payloads and checkpoint content in `services/document-service/src/storage/codec.ts`, checkpoints also in `src/data-plane/tasks.ts` (in a worker) and `src/objects/checkpoints.ts`. Run on this machine on 2026-11-15 with `pnpm exec vitest run --project node` against PostgreSQL and the S3-compatible store in Podman: `test/postgres/write-path.pg.test.ts` ("stores the payload as Zstandard-compressed canonical JSON and the metadata in its own row": the `bytea` starts with the frame magic number and decompresses to the canonical payload; 4 of 4 pass) and `test/data-plane/be-020-checkpoint-object.pg.test.ts` (the checkpoint object a running room wrote decompresses to the canonical envelope; 1 of 1 passes). HTTP: `test/control-plane/fnd-005-w5-http-encoding.test.ts` (real service over HTTP, memory storage, 4 of 4 pass) reads `/content` with `Accept-Encoding` of `identity`, `zstd` and `zstd, gzip, br`: each answer is plain JSON with no `Content-Encoding`, so the service forces no encoding and leaves it to what stands in front of it.

**Notes:** Zstandard is service-side only (01 §8: stored checkpoints and commit payloads), so it belongs to the document service (BE) and is deliberately not implemented in the universal packages. Playwright's WebKit stands in for Safari until the macOS job of CI runs. Lane w5 (2026-11-15): criterion 3 is ticked on the service's code and tests (see Evidence); the universal packages still hold no Zstandard, as said above. The service itself does not compress HTTP answers; a proxy or gateway in front of it may, by the usual `Accept-Encoding` negotiation, and none is part of this repository's deployment yet. `node:zlib` marks its Zstandard as experimental in Node.js 22; replacing it would need a dependency, which is not proposed here.

## Test corpus and performance

### FND-006 Shared document corpus

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 00 §9; 09 §14; 13 §9; 11 §2 (S4, S5) · **Requirements:** R1, R5 · **Depends on:** FND-001

As a maintainer, I want one corpus of documents used by every performance, layout and export test, so that results are comparable across spikes and releases.

**Acceptance criteria**

- [x] The corpus holds documents of 1, 20, 100, 300 and 1,000 pages, matching the sizes the budgets name (00 §9; 13 §9).
- [x] Together they cover named styles, multi-level numbering, tables including tables longer than a page, images, footnotes, headers and footers, fields, math, CJK text and very long paragraphs.
- [x] Every document is valid CDM, and the licence of any included text is recorded.
- [x] The corpus is versioned, and each test result records the corpus version it ran against.
- [x] Spikes S4, S5 and S10 and the export tests use it.

**Evidence:** `packages/corpus`. `pnpm --filter @docedit/corpus generate` runs a seeded, deterministic generator (`src/generate/`) that writes `out/`: `pages-1`, `pages-20`, `pages-100`, `pages-300`, `pages-1000` and the one-page `form-fields` (feature `fields`), tiny PNG assets with UUID version 7 identifiers, and `manifest.json` with each document's page target and estimate, canonical `documentHash`, file hash, node, character and word counts, features used and attached assets, the licence and provenance of every text and image source, and the corpus version with its fingerprint. `test/corpus.test.ts`: every document passes `validate()` with its attached assets and no violations; estimated pages within 15 % of each target; each construct of this story and of the corpus brief is covered; two runs give byte-identical output; `out/` equals a fresh generation; the manifest's hashes match the files and assets; the output matches the fingerprint of the current version in `src/generate/version.ts`; every result carries `task.meta.corpus` (`corpusStamp()`). `src/corpus.universal.test.ts`: the documents and images built in Node.js, Chromium, Firefox, WebKit and Edge have the manifest's bytes and hashes. How a test records the version is in `packages/corpus/README.md`. Criterion 5 (lane w5, 2026-11-15): S4 was measured on the shared corpus, version 2 (`node services/export-worker/scripts/measure.ts --corpus packages/corpus/out ...`, which reads the documents, their assets and the stamp from the manifest; the run of 2026-11-06 is in the Evidence of SPK-017). S5 builds its lines from corpus text (`packages/perf/src/lines.ts`, `packages/perf/e2e/s5.spec.ts`) and S10 loads its paragraphs with `loadDocument` (`packages/perf/src/browser/s10-page.ts`, `packages/perf/e2e/s10.spec.ts`); both stamp their results. The LaTeX export tests compile corpus documents in the Podman sandbox: `services/export-worker/src/exp-016-v-exp-001-016.corpus.e2e.test.ts` (compile and veraPDF) and `services/export-worker/src/exp-078-reference.podman.test.ts` (comparison with stored reference PDFs). The DOCX export test is new: `packages/export-docx/test/fnd-006-shared-corpus.test.ts` writes `pages-1`, `form-fields` and `pages-20` with their images, finds every text node of eight characters or more in the written parts, reads each package back through the importer, which validates it, and records the corpus stamp (4 tests, Node.js). Run on 2026-11-15 on the development desktop (Windows 11, Podman machine, image `localhost/docedit-export-worker`): the DOCX test passed 4 of 4; the two LaTeX files passed 6 of 7.

**Notes:** documents are generated or written as CDM JSON; the CDM schema they validate against is CDM's.

- Page counts are estimates (a line model whose parameters are in the manifest's `pageEstimate`) until the S4 compile measures them; measured counts go into `src/generate/measured.ts`. `pages-20` holds every special case once and is estimated at 22 pages.
- The last criterion is ticked on use, not on every export test passing (lane w5, 2026-11-15). The one failure of the run above is `validates pages-20 against every declared flavour` in the EXP-016 file: the sandbox image has no CJK face, so the compile stops on the missing glyphs of the CJK text in `pages-20` (EXP-026). For the same reason the `pages-20` case of `packages/export-latex/src/exp-056-layout-pdf.compile.test.ts` is skipped. That is a gap of the export image, which the corpus exposes; it belongs to EXP.
- What does not use the corpus. `services/export-worker/scripts/generate-corpus.ts` still writes S4's first documents to `fixtures/s4-corpus`, and `measure.ts` reads that directory unless `--corpus packages/corpus/out` is given; whether to remove them is SPK-017's to say. S4 did not measure `pages-300` or `pages-1000`. The export worker and `export-docx` import the corpus by path, because neither package depends on `@docedit/corpus`. The export worker's two corpus tests do not put the corpus stamp into their results.
- Invariant I8 is not checked yet, because no math gate exists; the corpus tests should pass the gate to `validate()` once EXP provides it.
- Decisions taken for the corpus, not for the model: every document defines all 37 built-in styles of ADR 0018 (valid whether 03 §4.1 "present in every document" means present, as CDM-016 expects, or available, as ADR 0018 reads it); other definitions get random identifiers, as 03 §4.1 says; the licence is recorded as `LicenseRef-docedit-project` until SPK-007 chooses the project's licence; `field.cached` is set only on `seq` fields, because other labels come from the shared numbering algorithm (03 §7), which does not exist yet.
- Questions for CDM found while building it: whether `pageNumberStart` on a page setup that several sections share restarts the numbers at each of them (the corpus uses a separate continuing page setup to avoid relying on either reading); which `format` values a `ref` field takes to print a page number instead of a label (09 §3.1 needs both; the corpus leaves `format` unset); and whether a table style's run properties can ever apply, since the paragraph style chain comes after the table style in the cascade (03 §6) and `Normal` sets the font size.

### FND-007 Reference machine and client performance harness

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 0 | M | must | Maintainer |

**Spec:** 00 §9; 13 §9; review CPU-1 · **Requirements:** R1, R12 · **Depends on:** FND-002, FND-006

As a maintainer, I want the client budgets measured the same way on every run, so that a performance claim is a measurement, never a guess.

**Acceptance criteria**

- [x] The reference machine and its CPU throttling profile are named and documented (00 §9).
- [x] Given a 100-page corpus document in the web view, when scripted typing runs, then keystroke-to-paint latency is measured with the Event Timing API and reported as the median and 95th percentile against the targets of 16 ms and 50 ms.
- [x] Time to interactive for a 20-page document is measured against the target of under 2 seconds, and memory for a 100-page document against the target of under 300 MB (13 §9).
- [x] The story writes down the metric used for "usable to 300 pages" in the web view (13 §9) and measures it.
- [ ] Results are stored per commit so that regressions show as trends, and a regression beyond an agreed tolerance fails the scheduled run.

**Evidence:** `packages/perf` (`@docedit/perf`). (1) The reference machine `reference-1` and its CPU throttling profile (rate 1) are defined in [ADR 0037](../adr/0037-reference-machine-and-throttling-profile.md) (proposed) and `src/reference.ts`. The rate was calibrated with `e2e/calibrate.spec.ts` (`pages/calibrate.html`) against published WebXPRT 3 medians for the laptop class, and `baseline/calibration.json` keeps the reference time for other machines. (2 to 4) `e2e/harness.spec.ts` drives `<doc-editor>` from `@docedit/element`, loaded through `@docedit/backend-mock`, with Chromium's CPU throttling through the DevTools protocol. Three runs on 2026-11-06 on the reference machine (`pnpm exec playwright test -c packages/perf/playwright.config.ts --project=reference harness`; results in `test-results/runs/*.json`, stamped with `corpusStamp()`, corpus version 2): keystroke-to-paint on `pages-100` by the Event Timing API was 40 ms at the median and 40 ms at the 95th percentile in each run, against 16 ms and 50 ms, so the median misses its target; time to interactive on `pages-20` was 236, 278 and 389 ms, against 2,000 ms; renderer private memory on `pages-100` was 106.8, 98.7 and 98.0 MB, against 300 MB; for "usable to 300 pages", typing on `pages-300` was 56 to 96 ms at the median and 72 to 112 ms at the 95th percentile, which misses the 00 §9 targets the metric uses. Statistics and comparison: `test/stats-baseline.test.ts`.

**Notes:**

- **Owner decision (2026-11-15, decision 22).** The reference machine and the laptop class (Intel Core i5-1235U laptops) of ADR 0037 are confirmed; the tolerances stay provisional until they are measured again on a dedicated runner (`docs/owner-decisions-2026-11-15.md`). ADR 0037's status now says so. Before this, the machine, the class and the rate were proposals; the rate (1) follows from that class (ADR 0037 §2), and criterion 1 stands as ticked. Criterion 5 stays open for the reasons below.
- **The metric for "usable to 300 pages" (criterion 4).** It is the typing measurement of criterion 2 on `pages-300`, judged against the typing targets of 00 §9. Load time, time to interactive and memory are reported without a target. 13 §9 gives no figure of its own, so a looser one is the owner's to set (ADR 0037 §5).
- **The in-page backend is kept out of the measurement.** The harness hands each commit to the in-memory backend after the frame and waits for it before the next keystroke. It subtracts the backend's document creation from load times. The backend took 62 to 90 ms per commit on `pages-100` (S3: every commit is validated in full).
- **The client alone misses the median target.** With the backend holding every commit (`DOCEDIT_BACKEND=hold`, a trial of 30 keystrokes), typing on `pages-100` was still 40 ms at the median. So it is the client's own work that misses 16 ms, a finding for FE.
- **Where the time goes.** A CPU profile of ten keystrokes put the most time in the canonical form, in validation and in the permission scope diff. The profile does not separate the client's share from the in-page room's.
- **Not met: (5).** Each run writes its result file. `baseline/reference-1.json` holds the baseline with per-metric tolerances measured over three runs (ADR 0037 §6, §7). `scripts/compare-baseline.ts` exits with 1 on a regression beyond them. Storing results per commit and failing the scheduled run need the scheduled CI job, which the main session adds to `.github/`. The tolerances were measured on a shared machine and are provisional until that job has a dedicated runner.
- **Still not met: (5), checked by lane w5 on 2026-11-15.** The scheduled job now exists as a file: `.github/workflows/perf.yml`, job `harness`, runs nightly on a self-hosted runner with the label `docedit-reference`, passes the commit to the harness (`DOCEDIT_COMMIT`, kept in each result's `commit` field), runs `compare-baseline.ts` and uploads the run's results as the artifact `perf-runs-<commit>`. It has never run: the repository has no Git remote, so there is no hosted CI, and no reference runner is registered. Three things remain, and none can be built here. (a) A scheduled run on the reference runner, and one that fails on a regression. (b) A store in which results of successive commits can be read as a trend; build artifacts are kept per commit but expire, and nothing reads them together. Where that store lives (a branch, an object store, the host's artifacts with a longer retention) is not decided; FND-002 has the same dependency on hosted CI. (c) An agreed tolerance: the tolerances in `baseline/reference-1.json` are proposals of ADR 0037 §7, and the owner has not confirmed them: decision 22 of 2026-11-15 keeps them provisional until they are measured again on a dedicated runner, which does not exist here.

### FND-008 Bundle-size budget gate

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Integrating developer |

**Spec:** 02 §2; 13 §9; ADR 0016 · **Requirements:** R2 · **Depends on:** FND-002

As an integrating developer, I want the component's first download kept small, so that embedding it does not slow my application down.

**Acceptance criteria**

- [x] Given a build, when CI measures it, then the chunks needed for the first interactive editor total at most 300 KB compressed (target), and the build fails above an agreed tolerance.
- [x] The report lists every lazy chunk and its size: the PDF viewer and its worker, the math editor, the panes, proofing, the assistant, and any WebAssembly module (ADR 0016).
- [x] Given a WebAssembly module appears in the initial chunk or is inlined as base64, then the build fails.
- [ ] The report is attached to every pull request that changes a chunk's size.

**Evidence:** Criterion 1: packages/element/scripts/build.ts and bundle-report.ts measure the library build (Node.js zlib, gzip level 9, Brotli quality 11) and fail the build above the 300 kB gzip budget; CI runs it in the check job (pnpm build). Measured 2026-11-06 on this machine: first interactive editor 166.1 kB gzip (6 files, host backend) and 218.4 kB gzip with the DEP client (7 files); report in packages/element/dist/lib/bundle-report.json, withinBudget true.

**Evidence (lane w5, 2026-11-15, criteria 2 and 3):** `packages/element/scripts/bundle-report.ts` adds `lazy` (every chunk the first interactive editor does not need, every asset of the build, the viewer frame's files and pdf.js's WebAssembly modules, each with its raw, gzip and Brotli size and its feature), `lazyByFeature` (the same summed for the PDF viewer, the PDF worker, the math editor, the panes, proofing, the assistant, WebAssembly, the DEP client and the rest; a feature with no file is listed with zero files) and `wasmViolations`. `scripts/build.ts` passes the build's assets to the report, prints the violations and exits with 1 when there is one, as it does above the budget. A violation is a `.wasm` module in a chunk of the first interactive set (the larger set, with the DEP client), or base64 that starts with the WebAssembly header at the start of a string literal or of a data URI in any chunk. Tests: `packages/element/test/fnd-008-w5-lazy-report.test.ts` (Node.js, synthetic chunks and a temporary viewer folder; 15 of 15 pass). Real build on this machine, 2026-11-15, `pnpm --filter @docedit/element build`: 28 lazy files; PDF viewer 4 files, 136.4 kB gzip; PDF worker 2 files, 746.6 kB; math editor 2 files, 947.1 kB; panes 10 files, 32.2 kB; proofing and assistant no files; WebAssembly 4 files, 366.6 kB (all pdf.js's, under `viewer/pdfjs/wasm/`); DEP client 1 file, 57.1 kB; other 5 files, 12.7 kB; no WebAssembly violation. The same build measured the first interactive editor at 250.3 kB gzip (14 files, host backend) and 307.5 kB gzip with the DEP client (15 files), so the budget gate of criterion 1 failed the build.

**Notes:** Lane w5 (2026-11-15). The build of `stories/integration` is over the budget with the DEP client (307,453 bytes of gzip against 300,000); the gate is left as it is, and no tolerance has been agreed (criterion 1 names one), so this is the owner's and the FE epic's to settle. Criterion 2: the build has no proofing chunk, no assistant chunk and no WebAssembly module of its own yet; the report says so with zero files, and the rules that would name them (`lazyFeatureOf`: a `proofing/` or `assistant/` folder, a `.wasm` file) are tested on synthetic chunks only. Criterion 3 is tested on synthetic chunks, not on a real build that holds a module, because no package has one. Criterion 4 is not met: no workflow attaches the report to a pull request or compares chunk sizes with the base branch, and that needs hosted CI (`.github/`), which cannot be run here.

### FND-009 Service latency, load and fault-injection harness

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Operator |

**Spec:** 00 §9; 11 §4 (exit criteria); 06 §6, §8 · **Requirements:** R7, R9 · **Depends on:** FND-006

As an operator, I want the service's latency targets and stage 1 capacity measured under realistic load and faults, so that the phase 1b exit criteria and later scaling decisions rest on evidence.

**Acceptance criteria**

- [ ] Commit acknowledgement latency is measured within one region against the targets of 50 ms at the median and 300 ms at the 99th percentile.
- [ ] Cold open of a room is measured against the target of 500 ms at the 95th percentile for a document whose CDM is under 1 MB.
- [ ] A 20-page export is measured against the target of 10 seconds at the 95th percentile with an empty queue.
- [ ] A load generator drives one node towards the stage 1 figures of about 2,000 connections and 500 open documents and reports where it saturates.
- [ ] Fault injection can drop connections, kill the service process and take the database away, as the phase 1b exit criteria require (11 §4).
- [ ] The BE epic reuses the harness for the stage 2 load tests of phase 4.

### FND-010 Integration-test environment

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 01 §7; 11 §3 (exit criteria) · **Requirements:** R6, R9 · **Depends on:** FND-002

As a maintainer, I want integration tests to run against real PostgreSQL, object storage and a compile worker, locally and in CI, so that what passes in CI is what runs in the demo.

**Acceptance criteria**

- [x] Given a contributor's machine or a CI runner, when the integration suite starts, then PostgreSQL 16 or later, an S3-compatible store and one sandboxed export worker without network start from container definitions.
- [x] The definitions are shared with the reference host's compose file (owned by UX), not duplicated.
- [x] The S3 property tests run against the real service in this environment (11 §3).
- [x] The environment starts from a clean state for each run and tears down afterwards.

**Evidence:** `infra/test-env.ps1` (`up`, `down`, `reset`, `status`, `run <command>`) starts the definitions in `infra/containers/compose.json` with Podman: PostgreSQL 17.11 and the Versity S3 Gateway v1.10.0, both pinned by digest, bound to 127.0.0.1 with their data on tmpfs, plus the export worker image built from `services/export-worker/Containerfile`, of which one job must return `main.pdf` with no network. It creates the test bucket and checks a signed PUT, GET and DELETE. Test credentials come from `infra/containers/.env.example`. `run` resets, runs the command and tears everything down whatever the outcome; each test file also gets a database of its own (`services/document-service/test/support/env.ts`). Measured on 2026-11-06 on the development machine: `pwsh -NoProfile -File infra/test-env.ps1 run pnpm exec vitest run --project node services/document-service` took 42.9 s, of which the 57 tests took 25.5 s, and left no container behind; in four observed starts with the export check, the environment came up in 9.1 to 11.2 s. The S3 property suite runs against PostgreSQL in this environment through `services/document-service/test/postgres/convergence.pg.test.ts` (SYN-047): the real room and the real storage, not yet behind the service process of BE-001. Not yet run on a CI runner: no workflow starts the environment (`.github/` is root configuration).

**Evidence (lane w5, 2026-11-15, criterion 2):** `infra/containers/compose.base.json` defines PostgreSQL and the S3 gateway (image pinned by digest, host networking, fixed settings, health-check timing) and the sandbox settings once. `infra/containers/compose.json` and `apps/reference-host/compose.json` take them with Compose's `extends` and keep only what differs: credentials, ports, storage (tmpfs for tests, named volumes for the demo), labels, and the tag and build of the sandbox image. `infra/test-env.ps1` and `apps/reference-host/scripts/stack.ps1` resolve `extends` with `infra/containers/compose-extends.ps1` (mappings merged, `command`, `entrypoint` and a health check's `test` replaced, other lists joined). Tests: `scripts/fnd-010-w5-shared-definitions.test.ts` (Node.js, runs the resolver with `pwsh`; 9 of 9 pass) and `apps/reference-host/test/stack.test.ts` (changed to follow `extends`). Before the change was kept, every service of both files resolved to the same definition as the committed files (compared member by member, notes aside). Run on this machine on 2026-11-15 with Podman, under project names ending `-w5` and other ports: `infra/test-env.ps1 run pnpm exec vitest run --project node services/document-service/test/postgres/schema.pg.test.ts` came up in 10.5 s with the export check (one job without network produced `main.pdf`), 9 of 9 tests passed, 2 containers removed; `apps/reference-host/scripts/stack.ps1 up -NoExport` came up in 12.4 s with set-up, seed, document service and host, the PostgreSQL container ran the image of the shared file, and `down -Volumes` removed everything.

**Notes:** MinIO's server is AGPL-3.0, which the licence policy denies (borrow list §15), so the S3-compatible store is the Versity S3 Gateway (Apache-2.0). Compose cannot pass `--cgroups=disabled`, which the WSL Podman machine needs (its systemd cgroup manager delegates no controllers, so even Podman's default pids limit fails), and published ports there are DNAT rules that WSL's localhost relay does not see. The script therefore starts the compose file's definitions with `podman run` and host networking; the file stays valid for `podman compose` (checked with `config`). Criterion 2 waits for the reference host's compose file (UX), which can `include` this one. The export worker's memory, CPU and process limits are set per job by `services/export-worker/src/sandbox.ts`; the environment's check job runs without them, because cgroup limits on this machine need the cgroupfs route of `DOCEDIT_PODMAN_MACHINE`. Lane w5 (2026-11-15), criterion 2: the two files share by `extends` and a third file, not by `include`, because the environments differ in storage and in variable names, and `include` would start the test definitions as they are. The commands of PostgreSQL stay in each file (Compose replaces a `command`, it does not merge it). `podman compose config` could not be run on the merged files here: this machine has no Compose provider; both scripts were run instead. `DOCEDIT_TEST_PROJECT` is new in `infra/test-env.ps1`: it names a second test environment beside the usual one. The changes in `apps/reference-host` (UX) are the compose file, one line of `stack.ps1` and one test.

## Licences, release and documentation

### FND-011 Licence gate

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | must | Maintainer |

**Spec:** 11 §9 risk 10; 00 §10; ADR 0016 · **Requirements:** R6 · **Depends on:** SPK-007, SPK-024, SPK-026

As a maintainer, I want the build to refuse dependencies with disallowed licences, so that the project stays permissively licensed.

**Acceptance criteria**

- [x] Given a dependency whose licence is not on the allow-list, when CI runs, then the build fails and names the package and licence.
- [x] The allow-list covers npm packages, and Cargo crates if ADR 0016's Rust kernel is adopted.
- [ ] A NOTICE file and third-party notices are generated into the element bundle and into each container image.
- [x] An exception needs a recorded decision with a reason and an expiry.

**Evidence:** `scripts/licence-gate.ts` (run by `pnpm licence:check` and in CI) checks every production dependency against `licences/policy.json`, taken from the borrow list's section 15. It names the package and licence on failure, requires a recorded option for dual licences, and refuses exceptions without a reason, a decision or an unexpired date (`licences/exceptions.json`). The policy logic is tested in `scripts/licence-policy.test.ts`. Cargo crates are not used, because ADR 0016's Rust kernel is not adopted. `scripts/third-party-notices.ts` generates the notices; putting them into the element bundle and the container images is still to do (criterion 3).

**Evidence (lane w5, 2026-11-15, criterion 3 in part; not ticked):** Element: `node scripts/release/release.ts --dry-run --skip-build`, run on this machine on 2026-11-15, packed `docedit-element-0.0.0.tgz`, and `tar -tzf` lists `package/NOTICE` and `package/THIRD-PARTY-NOTICES.md` in it (written from the packages found in the bundle, `scripts/release/release.ts` step 5). Asset worker image: `services/asset-worker/scripts/build-image.ts` writes `NOTICE` and `THIRD-PARTY-NOTICES.md` into the staged build context from the three decoders it copies, and `services/asset-worker/Containerfile` copies both to `/opt/docedit/`; `services/asset-worker/test/fnd-011-w5-image-notices.podman.test.ts` (3 of 3 pass) builds the image with Podman under a tag of its own, copies both files back out of it and compares them with the staged ones.

**Notes:** Lane w5 (2026-11-15). Criterion 3 stays open, because "each container image" is not met: (a) the document service has no Containerfile yet (`scripts/release/distributables.ts` lists its image as missing), so there is no image to put notices into; (b) the export worker's image is built from the fixed context `services/export-worker/image` by four callers (`infra/test-env.ps1`, the demo stack, the compose files, `scripts/release/image.ts`), so generating files into it means a staged context for all of them, which is the export work's to change; it holds TeX Live and fonts and no npm package; (c) the conformance kit's image (`packages/tck/Containerfile`) and the demo image (`apps/reference-host/containers/Containerfile`) carry no generated notices. The element's notices are in the published package (the release tarball), not in `packages/element/dist/lib` after a plain build. The release dry run also reported one failing step that is not part of this story: the pin check finds `docker.io/library/node:24.21.0-slim` without a digest in `infra/webhook-egress-policy.ps1` line 32.

### FND-012 Release pipeline

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | M | must | Integrating developer |

**Spec:** 02 §2; 01 §6; 11 §9 risk 6 · **Requirements:** R2, R6, R15 · **Depends on:** FND-002, FND-011

As an integrating developer, I want versioned, reproducible releases of the packages, the element bundle and the service images, so that I can pin and upgrade deliberately.

**Acceptance criteria**

- [ ] Given a release tag, when the pipeline runs, then the `@docedit/*` packages are published with provenance, and the element ships as an ECMAScript module with its lazy chunks (02 §2).
- [x] Versions follow semantic versioning, and a changelog lists changes per package.
- [ ] Container images for the services are built reproducibly from pinned bases; the signing policy for images is SEC's.
- [x] The release notes state the protocol and CDM versions each release supports, as the versioning rules of PRO require.

**Evidence:** Criteria 2 and 4: scripts/release/version.ts (one version for every @docedit/* package, the tag v<version>, Semantic Versioning 2.0.0 precedence, a new version above the earlier releases of its MAJOR.MINOR line; version.test.ts, with a fast-check property for the order), scripts/release/stories.ts (the changelog from the stories: the criteria met since the previous release's stories-snapshot.json, matched by a hash of their text, under every package the Evidence line names; stories.test.ts) and scripts/release/notes.ts (the protocol, CDM and rules versions from the manifests in spec/, the embedding API and the conformance kit; notes.test.ts), run by scripts/release/release.ts and .github/workflows/release.yml (ADR 0044 §2). Dry run on 2026-11-06 (node scripts/release/release.ts --dry-run, Windows 11, Node.js 22.18): CHANGELOG.md with 278 stories under their packages, and RELEASE-NOTES.md stating DEP 1.0 (subprotocol dep.v1), CDM 1 to 1 and rules/1, all draft.

**Notes:** The pipeline (ADR 0044, proposed): a tag makes a draft GitHub release only; publishing is a manual run on the tag, approved through the `release` environment, which refuses anything that differs from the draft. Criterion 1 stays open: the workflow has not run (no remote), only the element can be published (the other packages export TypeScript sources, which Node.js does not strip under `node_modules`), and npm trusted publishing needs the owner to register each package. The dry run packed the element twice into byte-identical tarballs (`docedit-element-0.0.0.tgz`, the ES module with its lazy chunks and the viewer). Criterion 3 stays open: `scripts/release/image.ts` builds each image twice with `--timestamp` and fails when the identifiers differ. The same builds, run by hand on 2026-11-06 (Podman 6.0.2, WSL machine), gave identical identifiers for the asset worker's sandbox image and different ones for the export worker's: only the layer of its font-cache warm-up step (`luaotfload-tool --update` and the warm-up compile) differs, so the release would refuse that image today. The document service has no Containerfile yet, and `packages/tck/Containerfile` has an unpinned base (SEC-052). Open questions are listed in ADR 0044.

### FND-013 Documentation site

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1b | S | should | Integrating developer |

**Spec:** 00 §1; 13 §11; 05 §11 · **Requirements:** R6, R15 · **Depends on:** FND-012

As an integrating developer, I want the specification, the integration guide and the API reference published together for each release, so that I can find the contract for the version I use.

**Acceptance criteria**

- [ ] The site publishes the specification, the decision records, the stories, generated API documentation for the embedding API and packages, and the protocol artifacts from `spec/`.
- [ ] The integration guide (content owned by UX) is part of the site.
- [ ] Each release has its own version of the site, and the latest is the default.

**Notes (lane w5, 2026-11-17):** Blocked; nothing ticked. Criterion 1 needs a Markdown renderer and a generator of API documentation (typedoc or similar). Neither is in the repository or in the root devDependencies, and this lane may not add one. The choice of a Markdown renderer is still an open question in docs/owner-decisions-2026-11-15.md (third-party libraries). needsDependency: a Markdown renderer and an API documentation generator. Criterion 2: the integration guide exists (apps/reference-host/docs/integration-guide.md), but it cannot be published without the site. Criterion 3: the release pipeline of FND-012 (scripts/release) does not yet build a site per release.

### FND-014 Requirements traceability

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | 1a | S | could | Project owner |

**Spec:** 00 §4 · **Requirements:** R1 to R15 · **Depends on:** none

As the project owner, I want each requirement traced to stories and tests, so that I can see which requirements a release covers.

**Acceptance criteria**

- [x] A matrix maps R1 to R15 to the stories that implement them and the test suites that prove them.
- [x] The release notes list the requirements whose coverage changed.
- [x] A requirement with no story or no test is shown as a gap.

**Evidence:** `docs/stories/tools/traceability.ps1` (`pnpm trace`) writes `docs/stories/TRACEABILITY.md`. It maps R1 to R15 to stories (from their Requirements field) and to test suites (from their Evidence lines), and marks a requirement with no story or no test as a gap. Criterion 2 (lane w5, 2026-11-15): the release pipeline of FND-012 now exists and does this. `scripts/release/stories.ts` (`coverage`, `coverageChanges`) compares the story snapshot kept by the previous release with the current one, and `scripts/release/notes.ts` (`renderReleaseNotes`) writes the section "Requirements whose coverage changed" into `RELEASE-NOTES.md` (`scripts/release/release.ts`, option `--previous-snapshot`). Tests: `scripts/release/stories.test.ts` ("lists the requirements whose coverage changed") and `scripts/release/notes.test.ts` ("list artefacts, images, what is missing, how to verify and the coverage that changed"), run in Node.js.

**Notes:** In the release notes, a requirement's coverage is the set of stories that have at least one met criterion; a change in that set is what is listed. The test suites per requirement are in the matrix only. No release has been published yet, so the section has only been produced in tests.

## Coverage

| Spec section | Stories |
|---|---|
| 00 §1 to §3 | none: informative |
| 00 §4 Requirements | FND-014; implemented across all epics |
| 00 §5 Assumptions | none: owned by SPK (SPK-001 to SPK-004) |
| 00 §6 to §8 | none: informative |
| 00 §9 Quality targets | FND-006, FND-007, FND-009 |
| 00 §10 Open issues | none: owned by SPK (SPK-005 to SPK-007, SPK-024) |
| 01 §1 to §5 | none: informative; the flows are owned by the normative epics |
| 01 §6 Repository and package layout | FND-001, FND-004 |
| 01 §7 Technology choices | FND-001, FND-010 |
| 01 §8 Cross-cutting conventions | FND-003, FND-005 |
| 01 §9 Open issues | see Open questions |
| 13 §9 Budgets | FND-007, FND-008 |
| ADR 0016 | FND-008, FND-011 |

## Open questions

- Whether the gateway and rooms start as one deployable (01 §9): affects FND-010 and the BE stories, not the repository layout.
- Whether the reference service is also published as an embeddable library for Node.js hosts (01 §9): affects FND-012.
- The cloud target for the hosted mode (01 §9): nothing in this epic depends on it.
