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

- [ ] Given a clone with the pinned Rust toolchain, when one documented command runs, then the kernel crate compiles to `wasm32-unknown-unknown`, passes through wasm-bindgen and wasm-opt, and is packaged with TypeScript typings under the working name `@docedit/layout-kernel`.
- [ ] The project's own crates forbid unsafe code.
- [ ] Two builds of the same commit produce byte-identical WebAssembly files.
- [ ] CI runs the crate's native tests and the WebAssembly package's tests on every change that touches the kernel.
- [ ] The kernel depends on no system library and no browser font stack: fonts arrive only from the manifest (WASM-005).
- [ ] The repository layout of 01 §6 is updated with the folder that holds the crates.

**Notes:** C-RUST, phase 3. Not needed if S10 recommends harfbuzzjs alone, which ships as a package. Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold. S10 (SPK-023, done) recommends harfbuzzjs with line breaking in TypeScript, because the Rust module gave no material gain and cost 2.1 times the download, a second toolchain and 21 crates (ADR 0016, "Result of S10"). C-WASM itself waits on the page-view gate (SPK-013), which the owner has not held. The spike crate `packages/perf/wasm/text-kernel/` is measurement code, not the kernel package of this story, and no production Rust workspace was created. The story reopens if the gate says yes and a later measurement changes S10's answer.

### WASM-002 Load WebAssembly modules on demand inside the element

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | M | must | Integrating developer |

**Spec:** 02 §2, §7; 13 §9; ADR 0016 · **Requirements:** R2 · **Depends on:** SPK-015, FND-008, PRO-087

As an integrating developer, I want the kernel downloaded and compiled only when a view needs it, so that embedding the editor costs nothing extra for people who never open pages.

**Acceptance criteria**

- [ ] Given a session that only uses the web view, then no WebAssembly is fetched or compiled.
- [ ] Given the page view or the read-only painter opens, when the module loads, then it is resolved relative to the component's own module URL, compiled with `WebAssembly.instantiateStreaming`, and falls back to `WebAssembly.instantiate` from an ArrayBuffer when the server's media type is not `application/wasm`.
- [ ] Given the host serves the component's chunks from its own origin, then the module loads from there by the same mechanism the PDF viewer's worker uses.
- [ ] The module is never inlined as base64 and never part of the initial chunk; FND-008 fails the build otherwise.
- [ ] The directives a host must allow for the module, as recorded by S2, appear in the integration guide.
- [ ] Load time and load failures are reported through the component's diagnostic events.

**Notes:** C-WASM, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold yet, because the page-view gate (SPK-013) is not held and the owner decides it from customer evidence. S5 did choose measurement from the font files, so the module would be harfbuzzjs's WebAssembly build (ADR 0016, "Result of S10"). The dependencies are largely built (FE-076 6 of 7 ticked, PRO-087 all ticked), so they do not block it. What blocks it is that no page view or read-only painter exists to request a module: every criterion asks for a loader in the element that fetches, compiles and reports on a module, and with nothing to load that loader would be scaffolding built ahead of the gate. S2's directives are recorded in the S2 report (SPK-015) for the integration guide when this story runs.

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

**Notes:** C-RUST, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold. S10 (SPK-023) recommends harfbuzzjs with segmentation and line breaking in TypeScript, and the Rust module gave no material gain (ADR 0016, "Result of S10"). The story also depends on WASM-001, the Rust workspace, which is blocked for the same reason. Every criterion says "in the kernel", and the kernel crate does not exist. The segmentation that S10 chose stays in TypeScript and belongs to the FE stories (FE-080, FE-096), not here. A UAX #14 library is on the owner's list of new third-party libraries still to be decided (`docs/owner-decisions-2026-11-15.md`, last paragraph), so adding one for this story would decide that silently. The story reopens if a later measurement changes S10's answer.

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

- [ ] Each module's compressed size has a budget set from S10's results and enforced by FND-008.
- [ ] Compile and instantiate time on the reference machine has a budget and is measured by FND-007.
- [ ] Kernel memory, font faces included, for a 100-page document is measured against its share of the 300 MB target (13 §9).
- [ ] Kernel time per keystroke in a 100-page document is measured against the share of the 16 ms budget that S10 set.
- [ ] A regression beyond the agreed tolerance fails the scheduled run.

**Notes:** C-WASM, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-WASM does not hold (SPK-013 is not held, see WASM-003). The budgets are for a module the project may never ship. S10's figures are for prototypes (ADR 0016, "Result of S10"), and a budget set from them would fix numbers for an artefact that does not exist. The story depends on FND-007 and FND-008, which are outside this lane. It reopens if SPK-013 says yes.

### WASM-013 Rust supply chain and licences

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| enabler | cond | S | must | Maintainer |

**Spec:** ADR 0016 (decision 5); 10 §3.8 · **Requirements:** R10 · **Depends on:** WASM-001, FND-011, SEC-050, SEC-051

As a maintainer, I want Rust dependencies held to the same rules as npm dependencies, so that a second language does not open a second, weaker supply chain.

**Acceptance criteria**

- [ ] Cargo dependencies are checked against the licence allow-list of FND-011; the Unicode licence of Unicode data and the licence of each hyphenation pattern file are reviewed explicitly.
- [ ] Advisory checks run on every build and fail on a known vulnerability unless an exception is recorded.
- [ ] The element's software bill of materials lists the crates compiled into the module.
- [ ] Dependencies are pinned by lockfile, and updates are reviewed changes.

**Notes:** C-RUST, phase 3. Lane w6 (2026-11-17), blocked, nothing ticked: C-RUST does not hold, because C-WASM does not hold (SPK-013 is not held) and S10 recommended harfbuzzjs, not a Rust module (ADR 0016, "Result of S10"). The story depends on WASM-001, the Rust workspace, which is blocked for the same reason. There are no crates to list, no build to check and no bill of materials. The spike crate under `packages/perf/wasm/text-kernel/` is measurement code and is not the kernel this story documents.

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
