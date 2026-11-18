# WASM Rust compiled to WebAssembly for compute kernels

The work that follows from [ADR 0016](../adr/0016-rust-wasm-compute-kernels.md) and the [Rust and WebAssembly assessment](../research/2026-11-06-rust-wasm-assessment.md). In short: nothing on the editing, sync, permission, rules, history, protocol or export path is written in Rust. WebAssembly enters the product only as the page view's text kernel, behind the measurement interface that 02 §9.1 already requires, and only if the evidence asks for it. The layout engine, pagination, the layout tree and the painter remain FE's, in TypeScript; this epic owns what runs behind FE's injected interfaces. The spikes that decide all of this (S2, S5, S7 and S10) are in SPK.

Every story here is conditional. Two conditions are used:

| Label | Holds when |
|---|---|
| **C-WASM** | The page-view gate (SPK-013) says yes to the page view or to the read-only painter, and S5 (SPK-018) chooses measurement from the font files. WebAssembly is then needed at all, whichever shaper wins |
| **C-RUST** | C-WASM holds, and S10 (SPK-023) recommends one Rust module for shaping, segmentation, line breaking and hyphenation rather than HarfBuzz's own WebAssembly build alone |

If C-WASM never holds, this epic stays parked and costs nothing.

## Toolchain and loading

### WASM-001 Rust workspace and build toolchain

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Maintainer |

**Spec:** ADR 0016 (decisions 2 and 5); 01 §6 · **Requirements:** R1 · **Depends on:** SPK-023, FND-001, FND-002

As a maintainer, I want a reproducible Rust build that produces the kernel as an npm package, so that the TypeScript side consumes it like any other dependency.

**Acceptance criteria**

- [x] Given a clone with the pinned Rust toolchain, when one documented command runs, then the kernel crate compiles to `wasm32-unknown-unknown`, passes through wasm-bindgen and wasm-opt, and is packaged with TypeScript typings under the working name `@docedit/layout-kernel`.
- [x] The project's own crates forbid unsafe code.
- [x] Two builds of the same commit produce byte-identical WebAssembly files.
- [ ] CI runs the crate's native tests and the WebAssembly package's tests on every change that touches the kernel.
- [x] The kernel depends on no system library and no browser font stack: fonts arrive only from the manifest (WASM-005).
- [x] The repository layout of 01 §6 is updated with the folder that holds the crates.

**Evidence:** Lane w6, 2026-11-18, on owner decision 27 of [docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md) (build the Rust WebAssembly module; C-RUST and C-WASM hold; ADR 0016 has a note of it). The Rust workspace is `crates/` (`Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml` pinning Rust 1.89.0, `Containerfile` for Podman, `build.sh`) with one crate, `crates/layout-kernel`, which holds three calls (`kernel_version`, `abi_version`, `checksum`, the 32-bit FNV-1a hash) and no other code: the toolchain is this story, the kernel's content comes with WASM-005 to WASM-010. The npm package is `packages/layout-kernel` (`@docedit/layout-kernel`: `src/index.ts` with the types and `createKernel`, `scripts/build.ts`, tests). Criterion 1: `pnpm --filter @docedit/layout-kernel build:wasm` builds the builder image on first use (Rust 1.89.0 on Debian 12 pinned by digest, wasm-bindgen-cli 0.2.130 and binaryen version_133 checked against their published SHA-256), compiles the crate for `wasm32-unknown-unknown`, runs wasm-bindgen (`--target web --typescript`) and `wasm-opt -Oz`, and writes `packages/layout-kernel/dist/` (the ES module, `docedit_layout_kernel_bg.wasm` of 14,473 bytes, the typings and `build.json`); `exports` of the package name `./wasm/*`. It ran on 2026-11-18 under Podman on Windows 11 (a WSL machine) in about 130 s with a warm image. `pnpm --filter @docedit/layout-kernel test:wasm` builds and then runs `src/kernel.test.ts` and `src/layout-doc.test.ts` (Node.js, 7 tests passed): the module starts from the bytes, reports its versions, gives the FNV-1a test vectors, refuses another interface version, imports nothing but its own glue file, ships typings for the three calls, and `build.json` matches the file. Criterion 2: the workspace lint `unsafe_code = "forbid"` (`crates/Cargo.toml`), `#![forbid(unsafe_code)]` in `crates/layout-kernel/src/lib.rs`, and `forbid_unsafe` in `build.sh` (run by `pnpm --filter @docedit/layout-kernel test:native`, which also runs `cargo fmt --check`, `clippy -D warnings` and the 3 native tests, all passed) fails a crate that lacks either; the wasm-bindgen glue is generated and is not the project's crate. Criterion 3: `pnpm --filter @docedit/layout-kernel verify:reproducible` builds twice from scratch (two containers, fresh target directories, paths remapped, no timestamps) and compares: SHA-256 `f1b38402adc1576bf485fc1755f4a7201046ea29d13796d929114a7aa09995f9` both times, and a third build (the `test:wasm` run) gave the same. Criterion 5: `build.sh` fails when `cargo tree` lists a `-sys` crate (the tree is 11 packages: wasm-bindgen and its macro crates), and `kernel.test.ts` checks that the WebAssembly file imports only from `./docedit_layout_kernel_bg.js`, so no `env`, WASI or browser import; the crate has no font code (fonts arrive from the manifest in WASM-005). Criterion 6: `docs/spec/01-architecture.md` §6 lists `crates/` and `packages/layout-kernel`, and `src/layout-doc.test.ts` reads it.

**Notes:** C-RUST, phase 3. Not needed if S10 recommends harfbuzzjs alone, which ships as a package. Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold. S10 (SPK-023, done) recommends harfbuzzjs with line breaking in TypeScript, because the Rust module gave no material gain and cost 2.1 times the download, a second toolchain and 21 crates (ADR 0016, "Result of S10"). C-WASM itself waits on the page-view gate (SPK-013), which the owner has not held. The spike crate `packages/perf/wasm/text-kernel/` is measurement code, not the kernel package of this story, and no production Rust workspace was created. The story reopens if the gate says yes and a later measurement changes S10's answer. Lane w6 (2026-11-18): the reasons above are stale. Owner decision 27 (2026-11-15) says to build the Rust WebAssembly module, which overrides S10, and C-RUST and C-WASM hold; the page view is to be built (decision 26). So the story was built; see Evidence. Five of six criteria are ticked. (4) stays unticked: it asks for a CI run on every change that touches the kernel, which is a workflow under `.github/` (not mine to edit in this run) and a hosted run that cannot happen here; the commands such a job runs are `pnpm --filter @docedit/layout-kernel test:native` and `test:wasm`, and both pass here. What was chosen without an owner decision, to be reviewed: the crates folder is `crates/` at the repository root, with its own Cargo workspace, outside the pnpm workspace; the build runs in a Podman image (not natively) because this Windows host has no Windows SDK for the MSVC linker, so Rust build scripts cannot link here (`DOCEDIT_KERNEL_NATIVE=1` runs `crates/build.sh` on a machine with the pinned tools; not run here); `wasm-opt` and wasm-bindgen come from their release archives with pinned hashes, not from `cargo install`; the output folder is `dist/` so that ESLint, Prettier and Git already ignore it. Not done: the licence allow-list, advisory check and SBOM for crates that ADR 0016 decision 5 asks for (`packages/perf/scripts/cargo-licences.ts` checks the spike crate only), and the CI job. The `podman run` of the build needs `--pids-limit=0` on this host, whose Podman machine has no `pids` cgroup controller (the same cause as the sandbox problem of ADR 0353).

### WASM-002 Load WebAssembly modules on demand inside the element

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Integrating developer |

**Spec:** 02 §2, §7; 13 §9; ADR 0016 · **Requirements:** R2 · **Depends on:** SPK-015, FND-008, PRO-087

As an integrating developer, I want the kernel downloaded and compiled only when a view needs it, so that embedding the editor costs nothing extra for people who never open pages.

**Acceptance criteria**

- [x] Given a session that only uses the web view, then no WebAssembly is fetched or compiled.
- [x] Given the page view or the read-only painter opens, when the module loads, then it is resolved relative to the component's own module URL, compiled with `WebAssembly.instantiateStreaming`, and falls back to `WebAssembly.instantiate` from an ArrayBuffer when the server's media type is not `application/wasm`.
- [x] Given the host serves the component's chunks from its own origin, then the module loads from there by the same mechanism the PDF viewer's worker uses.
- [x] The module is never inlined as base64 and never part of the initial chunk; FND-008 fails the build otherwise.
- [x] The directives a host must allow for the module, as recorded by S2, appear in the integration guide.
- [x] Load time and load failures are reported through the component's diagnostic events.

**Evidence:** Lane w6, 2026-11-18, on owner decisions 26 and 27 of [docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md) (the page view is built; the Rust module is built; C-WASM holds). Loader: `packages/element/src/features/layout-kernel.ts` (lazy chunk; fetch, `WebAssembly.instantiateStreaming` through the generated module when the media type is `application/wasm`, otherwise the bytes to `WebAssembly.instantiate`; failure codes), `features/layout-kernel-source.ts` (the build's files), `src/layout-kernel-request.ts` (the core's only way in, one load per page, reports through `de-diagnostic`), `doc-editor.ts` (`view="print"` asks for the kernel; no other view does) and `startKernel` in `packages/layout-kernel/src/index.ts`. Criterion 1: `e2e/wasm-002-kernel-load.spec.ts` (web view: no `.wasm` request, no compile call, no event), 4 tests in each of Chromium, Edge, Firefox and WebKit, 16 passed on 2026-11-18. Criterion 2: the same spec (print view: one `.wasm` request at `/lib/assets/docedit_layout_kernel_bg-<hash>.wasm`, `instantiateStreaming` once; with the file re-served as `application/octet-stream`: `instantiate` once and `streaming: false`), and `test/wasm-002-kernel-loader.test.ts` (12 tests, Node.js, on the real build of the crate). The URL is `new URL("../assets/…wasm", import.meta.url)` in the chunk, since `libraryConfig` has `base: './'`. Criterion 3: that URL is the mechanism the PDF viewer's page uses (`new URL(VIEWER_PAGE, import.meta.url)` in `doc-editor.ts`); the spec checks the request goes to the origin and folder of the library. Criterion 4: the library build writes the file as an asset of 14,473 bytes and `wasmViolations` is empty; before the fix of `vite-configs.ts` (`?url&no-inline` and cutting the glue's default URL) the same build failed with "WebAssembly must load lazily, as a file of its own (FND-008)" for two chunks, which shows the gate works; the spec reads every script under `/lib/` for base64 of the module header; `critical-path.test.ts` lists the two new modules as off the critical path. Criterion 5: `apps/reference-host/docs/integration-guide.md` (section "Layout kernel (WebAssembly; ADR 0016, WASM-002)") and `packages/element/docs/policies-and-side-effects.md`, from S2 section 6. Criterion 6: `de-diagnostic` (`events.ts`, 05 §8.1, `spec/embedding/` regenerated), `kind: loaded` with `ms` and `streaming`, or `load-failed` with `code` and `directive`; tested in both suites (a 404 gives `fetch_failed`).

**Notes:** C-WASM, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold yet, because the page-view gate (SPK-013) is not held and the owner decides it from customer evidence. S5 did choose measurement from the font files, so the module would be harfbuzzjs's WebAssembly build (ADR 0016, "Result of S10"). The dependencies are largely built (FE-076 6 of 7 ticked, PRO-087 all ticked), so they do not block it. What blocks it is that no page view or read-only painter exists to request a module: every criterion asks for a loader in the element that fetches, compiles and reports on a module, and with nothing to load that loader would be scaffolding built ahead of the gate. S2's directives are recorded in the S2 report (SPK-015) for the integration guide when this story runs. Lane w6 (2026-11-18): the reasons above are stale. Decision 26 says to build the page view and 27 to build the Rust module, so C-WASM holds, and the module to load is the Rust kernel of WASM-001 (not harfbuzzjs). All six criteria are ticked. What was chosen without an owner decision, to be reviewed: the event is `de-diagnostic` (a proposed name and detail, [ADR 0410](../adr/0410-w6-WASM-002-diagnostic-event.md), with a row in 05 §8.1); the page view is not mounted yet (`pageViewAvailable` is false), so asking for `view="print"` loads the kernel while the editor shows the web view; the module is compiled on the page's thread until WASM-004 moves it to a worker (the guide says where the directive moves); the build works without the kernel's `dist/` (the plugin `kernelFiles` in `scripts/vite-configs.ts` substitutes a stub and warns, and the loader reports `compile_failed` at run time), because `dist/` is a Podman build output. `packages/element` now depends on `@docedit/layout-kernel` (a workspace link; `pnpm-lock.yaml` changed). Not run: Safari itself and a host with a real strict policy (WASM-003 does the policy run). The first interactive editor is 376.6 kB gzip against the budget of 320 kB; it was 376.2 kB before this story, so the overrun is not from it.

### WASM-003 Keep editing when the host blocks WebAssembly

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| story | cond | S | must | Author |

**Spec:** ADR 0016 (decision 2); 02 §7; PRODUCT.md (Product principles) · **Requirements:** R1, R2, R10 · **Depends on:** WASM-002, SPK-018

As an author on a site with a strict security policy, I want the editor to keep working when WebAssembly is blocked, so that I can always edit, save and collaborate.

**Acceptance criteria**

- [ ] Given compiling the module is refused, when I ask for the page view, then the editor uses canvas measurement if S5 recorded it as an acceptable fallback, and otherwise stays in the web view.
- [ ] Given the page view is unavailable, then a plain message tells me so and why, and offers the web view and the read view.
- [ ] Given the same failure, then an event tells the host which feature degraded and which directive was missing, so the integrating developer can fix the policy.
- [ ] Given a page whose policy lacks `'wasm-unsafe-eval'`, when the Playwright suite runs, then editing, saving, collaboration and the typeset PDF in the read view all pass.

**Notes:** C-WASM, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold, because the page-view gate (SPK-013) is not held. The owner has not decided it, and `docs/owner-decisions-2026-11-15.md` does not list it. The story also depends on WASM-002, which is blocked for the same reason. No page view or read-only painter exists to fall back from, so the fallback paths and the event would be built against nothing.

### WASM-004 A layout worker that hosts the kernel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Maintainer |

**Spec:** 02 §2.1, §9.1, §9.5, §15; ADR 0016 · **Requirements:** R1, R12 · **Depends on:** WASM-002, FE-076, FE-004, FE-006

As a maintainer, I want the kernel to run in its own worker with a narrow, batched message interface, so that layout work never blocks typing and the host is asked for nothing it cannot give.

**Acceptance criteria**

- [ ] Each editor instance has one worker that owns one kernel instance; no `SharedArrayBuffer` or WebAssembly threads are used, so the host page need not be cross-origin isolated.
- [ ] Requests and results cross the boundary in batches of whole paragraphs or blocks, with typed arrays transferred rather than copied, and the measured cost per batch is recorded.
- [ ] Given a second editor on the same page, the compiled module is reused rather than compiled again.
- [ ] Given the element suspends, the worker stops; given it is destroyed, the worker and its memory are released; given it resumes, the kernel is re-created on first use (02 §2.1).
- [ ] Given the kernel traps, the error is caught and logged, the view falls back as in WASM-003, and no document state is lost, because the document lives in the editing core on the main thread.

**Notes:** C-WASM, phase 3. Answers the open issue of 02 §15 for the page view only. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold yet (the page-view gate, SPK-013, is not held), and the story depends on WASM-002, which is itself blocked, so there is no module for a worker to host. S10 chose harfbuzzjs with line breaking in TypeScript (ADR 0016, "Result of S10"), so the kernel is not Rust. The S10 prototype in `packages/perf/src/kernel/` ran in a layout worker as a measurement only; it is not the editor's worker. Building the worker, batching and lifecycle handling now would be a host with no guest.

## Text kernel

### WASM-005 Font faces from the manifest inside the kernel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Maintainer |

**Spec:** 02 §3 (fonts), §6; 09 §5; ADR 0016 · **Requirements:** R1, R5 · **Depends on:** WASM-004, BE-047, FE-061, FE-063

As a maintainer, I want the kernel to shape with exactly the font files the editor paints with and the LaTeX workers typeset with, so that measurement, painting and the PDF start from the same glyphs.

**Acceptance criteria**

- [ ] Given the font manifest, when a face is needed, then the kernel loads the same file the editor registers with the FontFace API and the workers load, identified by its hash; a file whose SHA-256 does not match the manifest is refused.
- [ ] Faces load on demand by alias, once per worker, and are released when the editor is destroyed.
- [ ] The memory held by faces is reported; a CJK face loads only when a document uses it.
- [ ] Given a later font load, the font epoch advances and the kernel's caches for affected aliases are invalidated (02 §6).
- [ ] A tenant's own fonts load the same way and only for that tenant's documents.

**Notes:** C-WASM, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold yet (the page-view gate, SPK-013, is not held), and the story depends on WASM-004 (the layout worker that hosts the kernel), which is blocked for that reason. There is no kernel instance in the editor to load faces into, so the manifest loader, the hash check, the memory report and the epoch invalidation would have no caller. S5 and S10 did decide that measurement is from the font files with harfbuzzjs (ADR 0016, "Result of S10"), so the story is ready to be built once the gate says yes. Nothing here needs an owner decision beyond that gate.

### WASM-006 Shaping and measurement behind the measurement interface

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Maintainer |

**Spec:** 02 §9.1, §9.3; ADR 0016; review F9 · **Requirements:** R1, R12 · **Depends on:** WASM-005, SPK-018, SPK-023, FE-079, FE-094

As a maintainer, I want the kernel to implement the measurement interface the layout engine already receives, so that switching from canvas to font-file shaping changes no layout code.

**Acceptance criteria**

- [ ] Given the layout engine's test suite, when it runs once with the canvas provider and once with the kernel provider, then it passes both times without changes to the engine.
- [ ] The kernel takes runs of text with a font alias, a size in twentieths of a point, a language and the font features the painter uses, and returns advances in a documented unit with documented rounding that is identical in every runtime.
- [ ] Shaping uses the engine S5 and S10 chose (HarfRust or harfbuzzjs) on the manifest's font files.
- [ ] Results are cached by font alias, size, text, features and font epoch (02 §9.3).
- [ ] Given the half-pixel harness of 02 §9.3, painted line widths match computed widths in every supported browser.
- [ ] Measuring a typical paragraph stays within the kernel's share of the typing budget that S10 set (target).

**Notes:** C-WASM, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold yet (the page-view gate, SPK-013, is not held), and the story depends on WASM-005, which is blocked for that reason. Every criterion needs the kernel to shape manifest font files in the editor: the two-provider run of the layout test suite, the documented advance unit, the cache keyed by font epoch, the half-pixel harness against painted widths in four browsers, and the share of the typing budget. None of these can be met by a mock, and a provider with no font loader and no worker would be scaffolding. The S10 prototype in `packages/perf/src/kernel/` is measurement code and is not the editor's provider; its measurements (SPK-023) stay the evidence for the budget. The engine is harfbuzzjs (ADR 0016, "Result of S10"), so this story does not wait on a Rust build.

### WASM-007 Unicode segmentation in the kernel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Maintainer |

**Spec:** 02 §9.3, §9.6, §11 · **Requirements:** R1, R12 · **Depends on:** WASM-001, FE-080, FE-096

As a maintainer, I want line-break opportunities and grapheme clusters computed by a conformant Unicode implementation inside the kernel, so that lines break correctly and the caret never splits a character.

**Acceptance criteria**

- [ ] Line-break opportunities follow UAX #14 and pass the Unicode line-break test data for the Unicode version the kernel records; this is the bundled implementation 02 §9.3 requires.
- [ ] Grapheme cluster boundaries follow UAX #29 and pass the grapheme-break test data, so caret movement and deletion never split a cluster.
- [ ] The Unicode version and its data are pinned; upgrading is a deliberate change that re-runs the golden tests.
- [ ] The same segmentation is callable from TypeScript tests, so the layout engine and the kernel can be checked against each other.
- [ ] Data for scripts the corpus does not use does not count against the module's size budget (WASM-012).

**Notes:** C-RUST, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold. S10 (SPK-023) recommends harfbuzzjs with segmentation and line breaking in TypeScript, and the Rust module gave no material gain (ADR 0016, "Result of S10"). The story also depends on WASM-001, the Rust workspace, which is blocked for the same reason. Every criterion says "in the kernel", and the kernel crate does not exist. The segmentation that S10 chose stays in TypeScript and belongs to the FE stories (FE-080, FE-096), not here. A UAX #14 library is on the owner's list of new third-party libraries still to be decided (`docs/owner-decisions-2026-11-15.md`, last paragraph), so adding one for this story would decide that silently. The story reopens if a later measurement changes S10's answer. Lane w6 (2026-11-18), blocked again, nothing new ticked: the first reason is stale and two others hold. Stale: decision 27 (2026-11-15) builds the Rust module, so C-RUST holds, and WASM-001 built the kernel crate (`crates/layout-kernel`, `packages/layout-kernel`), so the crate this story needs exists. Still true: (1) the owner's closing paragraph in `docs/owner-decisions-2026-11-15.md` lists "a UAX 14 implementation" among the new third-party libraries still open, and `docs/research/2026-11-06-borrow-list.md` rates the candidate `unicode-linebreak` 0.1.5 "adopt with care" (last release 2023, Unicode 15.0; it is in the local Cargo registry because the spike crate uses it) and `unicode-segmentation` 1.13.3 "adopt" (not in the local registry). Adding either to `crates/layout-kernel/Cargo.toml` decides that silently, and the run rules forbid adding a dependency. Writing the algorithms without a library needs the Unicode property files (`LineBreak.txt`, `GraphemeBreakProperty.txt`, `emoji-data.txt`), which are not on this machine either. (2) Criteria 1 and 2 ask that the implementation pass the Unicode test data (`LineBreakTest.txt`, `GraphemeBreakTest.txt`) for the pinned version. A search of the repository, `node_modules` and the Cargo registry finds neither file (the crate `unicode-linebreak` 0.1.5 ships none), and fetching them from unicode.org is a download that needs the owner's yes; WASM-013 also asks for an explicit review of the Unicode licence of that data. A comparison with `Intl.Segmenter` in Node.js (ICU) would be a cross-check and not the test data, so it does not tick criteria 1 or 2. Criteria 3 to 5 follow from 1 and 2. What the owner needs to say, in one decision: which UAX #14 and UAX #29 implementation the kernel uses (default proposed here: `unicode-linebreak` 0.1.5 and `unicode-segmentation` 1.13.3, both reviewed in the borrow list, with the Unicode version of the line-break crate recorded and the grapheme crate pinned to the same version if it allows), and that the two test files may be downloaded and added under `crates/layout-kernel/tests/data/` with their Unicode licence notice. The story then needs about one crate module per algorithm, a `segment` call in `lib.rs` (offsets in and out, as `Uint32Array`), the two test-data runs in native Rust and in Node.js, and a size check for WASM-012.

### WASM-008 First-fit line breaking in the kernel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Maintainer |

**Spec:** 02 §9.3, §9.7; 09 §7.1; 03 §4.1 (`defaultTabStop`) · **Requirements:** R1 · **Depends on:** WASM-006, WASM-007, FE-076, FE-081

As a maintainer, I want the kernel to break a whole paragraph into lines in one call, using the spec's first-fit rule and the same offsets the typesetter reports, so that the layout engine can adopt the PDF's breaks where they apply.

**Acceptance criteria**

- [ ] Given shaped runs and a line width, the kernel returns line starts and line widths using first-fit breaking at UAX #14 opportunities (02 §9.3).
- [ ] Line starts are offsets in UTF-16 code units of the block's text, with each inline atom counting as one and bookmarks as zero, the rule of `layout.json` (09 §7.1), so the engine can adopt reported breaks (02 §9.7).
- [ ] Justified lines report the word spacing to apply, which stretches only ordinary and no-break spaces and excludes trailing spaces and tabs (02 §9.3).
- [ ] Tabs advance to the paragraph's tab stops or to the document's `defaultTabStop`.
- [ ] Re-breaking an edited paragraph reuses cached shaping for runs that did not change.
- [ ] Golden tests in Node.js lock the line breaks of the shared corpus.

**Notes:** C-RUST, phase 3. Knuth and Plass's algorithm is not in scope: 09 §7 says TeX's paragraph builder is not rebuilt in the browser (assessment §5). Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold. S10 (SPK-023) chose first-fit line breaking in TypeScript, and both prototypes gave identical breaks and widths (ADR 0016, "Result of S10"), so a Rust line breaker has no reason to exist. The story also depends on WASM-006 and WASM-007, which are blocked. Line breaking in TypeScript belongs to the layout engine's own stories (FE-076, FE-081); the S10 prototype in `packages/perf/src/kernel/` is measurement code and its golden results are not the shared-corpus golden tests of the last criterion.

### WASM-009 Hyphenation with TeX patterns

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | should | Author |

**Spec:** 02 §9.3; 03 §4.1 (`settings.hyphenation`, `settings.lang`); 09 §3; ADR 0016 · **Requirements:** R1, R5 · **Depends on:** WASM-008, SPK-026, EXP-015

As an author who turns hyphenation on, I want the page view to hyphenate with the same kind of patterns as the PDF, so that lines on screen and in print diverge as little as possible.

**Acceptance criteria**

- [ ] Given `settings.hyphenation` is false, the default, then no pattern data is loaded and no line is hyphenated (02 §9.3).
- [ ] Given it is true, then words are hyphenated with TeX hyphenation patterns for the text's language, taken from its `lang` mark or `settings.lang`, with each language's patterns loaded on demand.
- [ ] The minimum number of characters before and after a hyphen matches the house class's settings.
- [ ] Every bundled pattern file's licence is recorded in the borrow list; a language whose patterns are not permissively licensed is not bundled.
- [ ] Given a language without patterns, its text is not hyphenated and nothing fails.

**Notes:** C-RUST, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold (S10 chose harfbuzzjs with line breaking in TypeScript, ADR 0016, "Result of S10"), and the story depends on WASM-008, which is blocked. Hyphenation needs a line breaker that calls it, and none exists in the kernel. The borrow list (SPK-026, `docs/research/2026-11-06-borrow-list.md`) already records hyphenation patterns per language with their licences, which is the input the fourth criterion needs when a pattern file is bundled. EXP-015 (the PDF side's hyphenation settings) is the other half; the match with the house class's minimum counts waits on both. Bundling pattern data with no consumer would add size to a module that does not exist.

## Verification and budgets

### WASM-010 The kernel in Node.js for tests

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | S | must | Maintainer |

**Spec:** 02 §9.1, §14 · **Requirements:** R1 · **Depends on:** WASM-006

As a maintainer, I want the same kernel artefact to run in Node.js, so that layout tests need no browser and golden outputs have one reference.

**Acceptance criteria**

- [ ] The same WebAssembly file loads in Node.js 22 or later without a browser and serves the layout engine's unit tests (02 §14).
- [ ] Golden outputs recorded in Node.js (advances, segmentation, line starts) are the reference for the cross-browser suite (WASM-011).
- [ ] In Node.js the kernel loads the manifest's font files by path and hash.

**Notes:** C-WASM, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold (SPK-013 is not held, see WASM-003). The story depends on WASM-006, which is blocked for the same reason, so there is no kernel artefact to run in Node.js. The S10 prototypes under `packages/perf/` are measurement code (see WASM-001), not the kernel this story loads, and their outputs are not the golden reference of WASM-011.

### WASM-011 Identical results in every browser

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Editor |

**Spec:** ADR 0005 (consequences); ADR 0016; 02 §9.3, §14 · **Requirements:** R1, R7, R12 · **Depends on:** WASM-010, FND-002, FND-006

As an editor working with collaborators in other browsers, I want the page view to compute the same lines for all of us, so that we see the same breaks between compiles.

**Acceptance criteria**

- [ ] Given the shared corpus, when the kernel runs in Chrome, Edge, Firefox, Safari and Node.js, then advances, segmentation and line starts equal the golden outputs, and any difference fails CI.
- [ ] Given two collaborators in different browsers editing one document in the page view, then both see the same line breaks before the next compile.
- [ ] The suite runs on every change to the kernel or its dependencies, and on every Unicode or font update.

**Notes:** C-WASM, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold (SPK-013 is not held, see WASM-003). The story depends on WASM-010, which is blocked because there is no kernel to run in Node.js, so there are no golden outputs to compare against. The shared corpus (`packages/corpus`) exists, but a cross-browser run would test prototypes, not a shipped kernel. A page view to compare between two collaborators does not exist either. It reopens if SPK-013 says yes.

### WASM-012 Size, memory and time budgets for the kernel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | S | must | Maintainer |

**Spec:** 13 §9; ADR 0016 · **Requirements:** R1, R2 · **Depends on:** SPK-023, FND-007, FND-008

As a maintainer, I want the kernel held to budgets in CI, so that it never quietly costs more than it saves.

**Acceptance criteria**

- [x] Each module's compressed size has a budget set from S10's results and enforced by FND-008.
- [x] Compile and instantiate time on the reference machine has a budget and is measured by FND-007.
- [ ] Kernel memory, font faces included, for a 100-page document is measured against its share of the 300 MB target (13 §9).
- [ ] Kernel time per keystroke in a 100-page document is measured against the share of the 16 ms budget that S10 set.
- [ ] A regression beyond the agreed tolerance fails the scheduled run.

**Evidence:** Lane w6, 2026-11-18, on owner decision 27 (the Rust module is built; C-RUST and C-WASM hold; [docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)). Criterion 1: `MODULE_BUDGETS` and `moduleBudgetViolations` in `packages/element/scripts/bundle-report.ts` give the layout kernel's WebAssembly file (`docedit_layout_kernel_bg-*.wasm`, listed under "webassembly" in the lazy report) a budget of 420,000 bytes of gzip, from S10's measurement of the whole Rust prototype (419,844 bytes of gzip; S10 report section 3.3), and `scripts/build.ts` fails the build, as it does for the first-interactive budget and for inlined WebAssembly, when a module is over. Tested in `packages/element/test/wasm-012-module-budget.test.ts` (Node.js, 5 passed): synthetic modules over and under, another module not held to it, and the real 14,473-byte file of the crate (the real build of the library passed with it on 2026-11-18: the kernel is 14,473 bytes raw). Criterion 2: `packages/perf/e2e/wasm-012-kernel-start.spec.ts`, added to the `reference` project of the FND-007 harness (`playwright.config.ts`). Run of 2026-11-18 21:00 UTC on the reference machine of ADR 0037 (Intel Core i9-10900KF, Windows 11 Pro; the recorded `onReferenceMachine` is true), Chromium 158.0.8127.18, profile `reference-1` (CPU throttling rate 1), 15 samples each in a fresh browser context: compile of the 14,473-byte module 1.29 ms at the median (0.83 to 1.79 ms; p95 1.79), instantiate 0.26 ms at the median (0.22 to 0.44 ms), against budgets of 9 ms and 1 ms. The machine was fully busy with other lanes during the run (`machineBusy` 1.0 in the result), so the times are an upper bound for an idle machine. The result file is `packages/perf/test-results/wasm-012/2026-11-18T21-00-43Z.json` (not tracked, like the other results). The fetch is not in this figure: it is the network's, and the load itself is timed in the page by `de-diagnostic` (WASM-002).

**Notes:** C-WASM, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold (SPK-013 is not held, see WASM-003). The budgets are for a module the project may never ship. S10's figures are for prototypes (ADR 0016, "Result of S10"), and a budget set from them would fix numbers for an artefact that does not exist. The story depends on FND-007 and FND-008, which are outside this lane. It reopens if SPK-013 says yes. Lane w6 (2026-11-18): the first reason is stale. Decisions 26 and 27 make the page view and the Rust module real, so C-WASM holds, and WASM-001 built the kernel package; FND-007 and FND-008 exist (FND-008 criteria 2 and 3 are ticked). Two of five criteria are ticked. Proposed, for the owner to confirm: the module budget of 420,000 bytes of gzip (S10's prototype figure, rounded up) and the time budgets of 9 ms to compile and 1 ms to instantiate at the median (the top of S10's ranges, rounded up to whole milliseconds). The kernel now is 14,473 bytes and has three calls, so both pass by a wide margin: the budgets are for the finished kernel. Criteria 3 and 4 stay open because there is nothing to measure yet: the kernel holds no font faces (WASM-005), no shaping (WASM-006), no segmentation (WASM-007, blocked) and no line breaking (WASM-008, WASM-009), and a 100-page document cannot be laid out by it; a figure taken from the three-call module would say nothing about memory with fonts or time per keystroke. S10's figures are for a prototype and are not a measurement of this kernel (ADR 0016, "Result of S10"). Criterion 5 stays open for the reason FND-007 criterion 5 does: it asks for a scheduled run that fails on a regression; the workflow `.github/workflows/perf.yml` (not mine to edit) has never run, there is no hosted CI or reference runner, and the tolerance for the new metrics is not agreed. The new spec fails a run over its two absolute budgets, so the scheduled job will fail on it once it runs; no baseline entry or tolerance was added for it.

### WASM-013 Rust supply chain and licences

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | S | must | Maintainer |

**Spec:** ADR 0016 (decision 5); 10 §3.8 · **Requirements:** R10 · **Depends on:** WASM-001, FND-011, SEC-050, SEC-051

As a maintainer, I want Rust dependencies held to the same rules as npm dependencies, so that a second language does not open a second, weaker supply chain.

**Acceptance criteria**

- [x] Cargo dependencies are checked against the licence allow-list of FND-011; the Unicode licence of Unicode data and the licence of each hyphenation pattern file are reviewed explicitly.
- [ ] Advisory checks run on every build and fail on a known vulnerability unless an exception is recorded.
- [x] The element's software bill of materials lists the crates compiled into the module.
- [x] Dependencies are pinned by lockfile, and updates are reviewed changes.

**Evidence:** Lane w6, 2026-11-18, on owner decision 27 (the Rust module is built; C-RUST holds; [docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)). Criterion 1: the licence gate of FND-011 (`scripts/licence-gate.ts`, `scripts/cargo-licences.ts`) already walks every `Cargo.toml` that has a `Cargo.lock` beside it, so it checks the kernel workspace `crates/` (12 packages in the lock; `node scripts/licence-gate.ts` passed on 2026-11-18, cargo 1.89.0); `scripts/kernel-supply-chain.test.ts` runs the same policy over `crates/` in Node.js. The data review is new: `licences/kernel-data.json` holds one review for each crate that carries Unicode data (its licence names a Unicode licence, or it is one of `unicode-*`, `icu*`) or hyphenation patterns (`hypher`, `hyphenation`, `hyphenopoly`), for its exact version and with an expiry; `dataReviewProblems` in `scripts/kernel-supply-chain.ts` makes the gate fail without one, with an expired one, and, for a hyphenation crate, without the licence and the option taken for every pattern file. Today the kernel's one data crate is `unicode-ident` 1.0.27 (code `(MIT OR Apache-2.0)`, tables `Unicode-3.0`, reached through `wasm-bindgen-shared`), reviewed in that file; no hyphenation crate is in the tree yet. With the entry removed on a trial the gate failed and named the crate. Criterion 3: `scripts/release/crates.ts` lists the crates `cargo tree --edges normal,no-proc-macro --target wasm32-unknown-unknown` reports (4: `cfg-if`, `unicode-ident`, `wasm-bindgen`, `wasm-bindgen-shared`; proc-macro crates run at build time and are not in the module), with licence from `cargo metadata` and the SHA-256 of each crate archive from `Cargo.lock`; `bundleSbom` adds each as a package (`pkg:cargo/…`, CONTAINS) and `release.ts` compares them with `crates/Cargo.lock` and writes their licence files into the element's notices. Run of `node scripts/release/release.ts --dry-run --skip-build` on 2026-11-18: `docedit-element-0.0.0.spdx.json` lists the four crates and the notices have a section for each, and the kernel's `.wasm` is now explained as a file of `@docedit/layout-kernel` (the identical-file search is given that package's `dist/`). Tests: `scripts/release/crates.test.ts` (6 passed: the bill, the comparison with the lock file, a changed checksum, a missing crate, a refused licence, the real module). Criterion 4: `licences/cargo-lock-review.json` pins the SHA-256 of `crates/Cargo.lock`; a changed lock fails the gate (tried: one added line gave "changed since it was reviewed", naming both hashes) until the record is changed in the same commit; the direct dependency in `crates/layout-kernel/Cargo.toml` is exact (`=0.2.130`) and every cargo call in `crates/build.sh` has `--locked` (both checked in `scripts/kernel-supply-chain.test.ts`, 10 passed).

**Notes:** C-RUST, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold, because C-WASM does not hold (SPK-013 is not held) and S10 recommended harfbuzzjs, not a Rust module (ADR 0016, "Result of S10"). The story depends on WASM-001, the Rust workspace, which is blocked for the same reason. There are no crates to list, no build to check and no bill of materials. The spike crate under `packages/perf/wasm/text-kernel/` is measurement code and is not the kernel this story documents. Lane w6 (2026-11-18): the first reason is stale. Decision 27 builds the Rust module and WASM-001 built the workspace, so the crates and the lock file exist and the checks have something to run on. Three of four criteria are ticked. Criterion 2 stays open: it needs an advisory scanner for Cargo and the advisory database. `cargo-audit` and `cargo-deny` are not installed here, the RustSec database is not on this machine, and installing the one and fetching the other is a tool and a download this lane may not add; a wrapper written without the real tool could not be run against its output. To close it: install `cargo-audit` (or `cargo-deny`), run it with `--deny warnings` against `crates/Cargo.lock` in `crates/build.sh` and in CI, and record exceptions like the licence ones (reason, decision, expiry). Chosen without an owner decision, proposed: (a) the explicit data review is a file of exact-version entries that the licence gate demands, not a legal opinion; the entry for `unicode-ident` and the lock review were written by this lane and a maintainer should confirm them (the `decision` fields say so); (b) a lock review is a hash, so a harmless update still needs one edit of the record, which is the point of criterion 4 ("updates are reviewed changes"); a human review of the diff stays a pull-request step, and the `dependency-review` job of SEC-050 (never run, no hosted CI) would see the same lock file; (c) the data review applies to the `crates/` workspace only, because the spike crate under `packages/perf/wasm/text-kernel` is measurement code that does not ship and uses `unicode-linebreak` and `hypher` unreviewed. LPPL pattern files (borrow list section 11) still need counsel before they ship, which is for WASM-010 when it adds patterns. The dry run of the release still fails on four things that are not this story: the release version (`@docedit/tck` is 0.1.0), the pin check, the parity report, and the `events-*.js` Svelte chunk that no package explains.

### WASM-014 Contributor guide for the kernel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | S | could | Maintainer |

**Spec:** ADR 0016; 11 §8, §9 risk 13 · **Requirements:** R15 · **Depends on:** WASM-001

As a maintainer, I want the kernel's boundary and build documented, so that the project does not depend on one person who knows Rust.

**Acceptance criteria**

- [ ] A guide explains how to build, test and profile the kernel, the contract with the layout engine, and the fallback rules.
- [ ] It states what belongs in the kernel (shaping, segmentation, line breaking, hyphenation) and what stays in TypeScript (pagination, the layout tree, the painter).
- [ ] A contributor without a Rust toolchain can run the whole layout test suite against the published kernel package.

**Notes:** C-RUST, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold (see WASM-013 and WASM-001). A guide for the kernel's build and boundary would describe a kernel the project does not ship. The third criterion needs a published kernel package, which does not exist. The guide reopens if SPK-013 says yes and a later measurement changes S10's answer.

## Reach (phase 4)

### WASM-015 Bidirectional text and complex-script shaping in the kernel

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | L | should | Author |

**Spec:** 02 §11; 03 (`dir`); 11 §7 (Reach); ADR 0016 · **Requirements:** R1, R12 · **Depends on:** WASM-008, FE-112

As an author who writes in a right-to-left or complex script, I want the page view to lay out my text correctly, so that pages on screen read as they will in the PDF.

**Acceptance criteria**

- [ ] Bidirectional paragraphs are reordered by UAX #9 with the paragraph direction from `dir`, and the kernel returns both visual order and logical offsets.
- [ ] Arabic and at least one Indic script shape correctly with the chosen shaper and the manifest's fonts, checked against HarfBuzz reference output.
- [ ] Caret positions and selections in mixed-direction lines map to logical offsets consistently with the layout tree.
- [ ] The work follows the plan that 02 §11 requires; this story does not decide that plan.

**Notes:** C-RUST, phase 4 (right-to-left and complex-script content are phase 4 in 11 §7). Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold (see WASM-013). S10 recommended harfbuzzjs with line breaking in TypeScript (ADR 0016, "Result of S10"), so there is no Rust kernel to add UAX #9 reordering or shaping to. The story depends on WASM-008 (blocked for the same reason) and FE-112, which depends on SPK-013 (not held). Criterion 4 asks that the work follow the 02 §11 plan, and this story does not decide that plan. Any bidirectional or shaping work on the TypeScript and harfbuzzjs path is a different story.

### WASM-016 Line-breaking rules for East Asian and South-East Asian scripts

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | could | Author |

**Spec:** 02 §11; 11 §7 (Reach) · **Requirements:** R1, R12 · **Depends on:** WASM-007, FE-112

As an author who writes in Chinese, Japanese, Thai or a related script, I want lines to break where my language allows, so that the page view does not produce lines a reader would reject.

**Acceptance criteria**

- [ ] East Asian text follows the line-breaking rules the 02 §11 plan selects, tested with per-language samples.
- [ ] Thai, Lao, Khmer and Burmese text breaks at word boundaries found with dictionary data, loaded only when a document uses the script.
- [ ] The module's size budget (WASM-012) holds for documents that do not use these scripts.

**Notes:** C-RUST, phase 4. Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold (see WASM-013). The story depends on WASM-007 (blocked, no Rust kernel) and FE-112 (which depends on SPK-013, not held). The 02 §11 plan that criterion 1 refers to is not selected here, and dictionary data for Thai, Lao, Khmer and Burmese would need a library choice that is still open (new third-party libraries, `docs/owner-decisions-2026-11-15.md`). The size budget of criterion 3 depends on WASM-012, which is blocked.

## Coverage

| Source | Stories |
|---|---|
| ADR 0016 decision 1 (TypeScript in phases 0 to 2) | none: a constraint on every other epic |
| ADR 0016 decision 2 (kernels behind interfaces, on demand, in a worker, with a fallback, in Node.js) | WASM-002, WASM-003, WASM-004, WASM-006, WASM-010 |
| ADR 0016 decision 3 (evidence decides) | SPK-018, SPK-023; conditions C-WASM and C-RUST |
| ADR 0016 decision 4 (escalation rule elsewhere) | none: applied when a budget is missed |
| ADR 0016 decision 5 (supply chain) | WASM-001, WASM-013 |
| Assessment §2 (costs) | WASM-002 (serving, bundle), WASM-003 (policy), WASM-004 (threads), WASM-005 and WASM-012 (memory), WASM-014 (skills) |
| 02 §9.1 Pipeline | WASM-004, WASM-006, WASM-010 |
| 02 §9.3 Measurement and line breaking | WASM-006, WASM-007, WASM-008, WASM-009 |
| 02 §9.5 Incremental layout | WASM-004, WASM-008, WASM-012 |
| 02 §9.6 Caret, selection and input | WASM-007, WASM-015 |
| 02 §9.7 Reconciling with the typeset result | WASM-008 |
| 02 §11 Internationalisation | WASM-015, WASM-016 |
| 02 §14 Testing | WASM-010, WASM-011 |
| 13 §9 Budgets | WASM-012 |

## Open questions

- The measurement base (S5) and the kernel boundary and language (S10) decide whether any of this epic is built.
- The unit and rounding of the kernel's advances: the CDM's twentieths of a point may be too coarse for glyph advances. WASM-006 documents the choice; it must be made with FE's layout engine.
- Whether layout runs in a worker from the start (02 §15). WASM-004 puts the kernel in one; FE decides for the rest of the engine.
- Whether the house class will select luaotfload's HarfBuzz renderer (S4 reports; EXP decides). It sets how much the shared fonts and shaper can reduce differences between screen and PDF.
- How Unicode upgrades are scheduled across the kernel, the web view (which uses the browser's own data) and LuaLaTeX.
