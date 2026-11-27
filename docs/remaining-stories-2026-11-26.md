# What the remaining stories wait on, 2026-11-26

Source: the unticked criteria and the Notes of the 199 stories that are not done (60 partly done, 139 blocked), read on 2026-11-26 from the epic files in `docs/stories`. The decision records `owner-decisions-2026-11-15.md` (decisions 1 to 224), `owner-blockers-2026-11-17.md` and `owner-decisions-pending.md` were read first. A question answered there is not listed as open. Each story is counted once, under the one thing its last open criterion waits on. Many stories wait on more than one thing; the line says what the main one is. Notes can be stale, and the latest dated note was trusted over older ones. No figure here is a measurement.

## Count per blocker

| Blocker | Stories |
|---|---:|
| The reference machine (performance measurement) | 21 |
| Hosted CI, branch protection or GitHub billing | 13 |
| Real devices and people (phones, tablets, Safari, screen readers, IMEs, Word, Acrobat) | 24 |
| Production signing (key, CA, time-stamp provider or library) | 3 |
| CJK fonts | 7 |
| A cluster, several nodes or a second location | 6 |
| Human review (accessibility, legal, translation, security, second maintainer) | 11 |
| The release run (and the first public release) | 11 |
| An owner decision not yet answered | 41 |
| Another story that is not done | 27 |
| Other: agent work only, nothing external | 26 |
| Other: edit to root config, specs or other epics by the main session | 5 |
| Other: a tool, host or event outside the repository | 4 |
| **Total** | **199** |

## The reference machine (performance measurement)

- BE-024 — Persist commits in group-commit transactions — Load run on the reference machine (BE-058) showing 50 ms median acknowledgement with group-commit writes; dev machine measured 58 to 72 ms.
- BE-030 — Rate-limit by address, connection, user and tenant — Dedicated-runner load test (BE-058) with limit applied before read; owner also sets a tolerance for 'does not rise'.
- BE-058 — Hold the stage 1 targets under load — Acknowledgement and cold-open measurements on the reference machine (runner docedit-reference) plus a nightly job in .github.
- BE-084 — Measure memory per open document — Measure with commits applied (position maps) on the reference machine, then recommend a room budget for SPK-025.
- BE-091 — Enforce live-use quotas per tenant — Quiet runner to measure that a second tenant's acknowledgement latency is unchanged while the first is refused.
- EXP-051 — Reject bad equations at edit time and replace them at export — CPU budget default for the math gate, to be measured on the reference machine (decision 106), then a test against it.
- FE-092 — Virtualise the painted pages — A 1,000-page scroll time and a 100-page memory figure measured on the reference machine; FE-102 budgets define usable.
- FE-119 — Open a 20-page document within the time budget — The docedit-reference self-hosted runner registered and a hosted run of perf.yml showing the build fails over budget.
- FE-120 — Keep long documents usable in the web view — 300-page typing, navigation and pane measurements and the CI perf gate on the docedit-reference runner; typing is also over target.
- FND-007 — Reference machine and client performance harness — Register runner docedit-reference, set the repository variable, let two nightly runs store results and one fail on a regression.
- FRW-023 — Apply rules live in the editor — Agent work to re-evaluate only dependent fields, then browser measurement at 2,000 fields and 500 rules on the reference machine.
- FRW-076 — Fill a document with a guided bar — Keystroke-to-paint measurement on a 100-page form document on the reference machine; no figure exists yet.
- PRO-104 — Apply a commit in the authority service — CPU time per commit measured on the reference machine; the S3 simulation adapter (criterion 3) is agent work.
- SEC-028 — Prove expensive commits cannot stall a process — Load run on the reference machine (BE-058) to set the admission budget default and check other rooms' latency.
- SYN-015 — Acknowledge and broadcast in sequence order, only after storage — Stage 1 reference deployment in one region on the reference machine to record median and 99th percentile latency.
- SYN-037 — Reject expensive commits before doing the work — Acknowledgement latency against the SYN-015 target, measured on the stage 1 reference deployment.
- SYN-040 — Benchmark the cost of a typical commit — Stage 1 reference deployment on the reference machine for latency figures; CI gate and per-commit results also need hosted runs.
- UX-054 — Extension hooks stay off the typing path — Keystroke-to-paint measurement with a slow hook on the reference machine; editor misses 16 ms on 100 pages even without one.
- UX-066 — Accessibility checker: find issues — Typing latency with the checker pane open on a 100-page document, measured on the reference machine (UX-072 figures; decision 22).
- UX-072 — Typing latency with the shell active — 100-page typing measurement with peers and open panes on the docedit-reference runner, then a CI gate.
- UX-074 — Memory for a 100-page document — 100-page fixture with collaborators measured on the reference machine; pane open/close heap growth cause still unisolated.

## Hosted CI, branch protection or GitHub billing

- EXP-075 — Test the sandbox adversarially — Branch protection on main requiring the ci jobs; the other criterion is a practice with nothing to test.
- FE-017 — Publish the policy names and directives a host must allow — A passing hosted e2e run of the strict-policy matrix, and one run where an unlisted violation fails it; fix is on branch ci-a.
- FE-050 — Copy and cut with the document fragment embedded — One passing run of the copy-paste spec in WebKit or Safari on macOS (hosted macOS runner or a Mac).
- FE-116 — Support the declared browser versions — A CI job installing minimum Chrome/Edge 137, Firefox 142 and Safari 17 (.github edit by main session) and a hosted passing run.
- FND-002 — Continuous integration across the supported browsers — A green hosted run, branch protection on main, and a real Safari run (Playwright WebKit is not Safari 17).
- SEC-002 — Build an adversarial protocol client — A CI job calling tests/security/scripts/stack-suite.ps1 on a runner with Podman, and one recorded hosted run.
- SEC-035 — Prove the compile sandbox contains a compromised compile — Hosted run of the export job on every change, and a release gate in release.yml that depends on it.
- SEC-050 — Lock dependencies and review changes — A pull request with a vulnerable dependency to run dependency-review, and an advisories run that opens an issue.
- SYN-047 — Run the convergence property suite against the real service — Hosted CI: a short run gating every merge (branch protection) and a long nightly run.
- SYN-049 — Fuzz the authority — Owner enables branch protection on main requiring the fuzz job, with a pull-request flow; nightly run already seen green.
- UX-048 — Prompt-injection controls for the assistant — A passing hosted CI run that contains the injection corpus tests; the security review is also still outstanding.
- WASM-001 — Rust workspace and build toolchain — Add the test:native step to the kernel job in .github/workflows/ci.yml (root config), then a hosted run.
- WASM-012 — Size, memory and time budgets for the kernel — A scheduled perf.yml job for kernel budgets with an agreed tolerance, and a hosted run that fails on a regression.

## Real devices and people (phones, tablets, Safari, screen readers, IMEs, Word, Acrobat)

- EXP-118 — Write DOCX by patching the original package — Opening every exported corpus file in real Word and LibreOffice on a reviewer's machine; neither is installed here.
- FE-034 — Keep composition steady when remote commits arrive — A person with Japanese, Chinese and Korean input methods checking the OS candidate window stays at the caret during a remote commit.
- FE-038 — Clamp selections at region boundaries — A real touch device or Android emulator with a system image, to make a touch selection by drag past the region end.
- FE-095 — Paint read-only pages for the read view, old versions and page counts — A person with a screen reader must confirm painted text reads in document order (same pass as FE-099).
- FE-098 — Type into the page view through the input bridge — Real Japanese, Chinese and Korean input methods, Android and iOS keyboards, OS input window and the browser find bar.
- FE-099 — Read and edit the page view with a screen reader — Manual passes with real screen readers per platform (NVDA or JAWS, VoiceOver, Orca, TalkBack) on the S9 plan.
- FE-111 — Edit right-to-left and complex-script content in the web view — Real Arabic, Hebrew, Devanagari and Thai keyboards and input methods for the FE-123 matrix; PDF direction check needs EXP.
- FE-113 — View documents on a mobile browser — An iPhone, or WebKit with touch-scroll gestures, to show touch scrolling in iOS Safari.
- FE-114 — Edit lightly on a mobile browser — iOS and Android devices with soft keyboards and native touch selection handles; depends on FE-115 iOS findings.
- FE-115 — Make input methods work on iOS Safari inside shadow roots — An iOS device with a named iOS version to run the S1 iOS keyboard pass and reproduce failures.
- FE-123 — Run the input-method matrix — A person running the scripted manual pass on real keyboards, input methods, Android and iOS devices and Safari.
- FE-126 — Run accessibility checks with axe and screen-reader passes — Manual pass over each listed screen-reader and browser combination, recorded at release time.
- FRW-053 — Seal the final PDF with a time-stamp — A person opening the sealed sample in Acrobat, plus an independent validator (pyHanko or EU DSS) run; decision 223 keeps this manual.
- FRW-056 — Add long-term validation and renew time-stamps — A person opening each update level in Acrobat to see it valid (manual check, decision 223), plus certification levels.
- FRW-057 — Show visible signature appearances at the field positions — A person validating the sealed PDF in Acrobat (manual, decision 223); criterion 1 also needs the layout key choice.
- FRW-079 — Operate every field by keyboard and assistive technology — A person with NVDA, JAWS or VoiceOver must hear a field announce name, kind, required, invalid state, value and role.
- SPK-014 — S1: ProseMirror inside an open shadow root — Safari 17 on macOS, Android and iOS keyboards, and real input methods run from the report section 6 checklist.
- SPK-015 — S2: strict content security policy and Trusted Types, including WebAssembly — Run the s2-wasm test in Safari on a Mac and record the blob worker result in report section 6.
- SPK-021 — S8: seal a tagged PDF with a managed key and a time-stamp — A person opens the sealed sample PDFs in Acrobat and records the validation result (decision 223 keeps it manual).
- SPK-022 — S9: the page view's input bridge and screen-reader plan — People running IMEs per platform, NVDA/JAWS/VoiceOver/Orca/TalkBack, and the browser's own find bar in headed browsers.
- UX-068 — The shell meets WCAG 2.2 level AA — A manual screen-reader pass of the defined flows before each release, with results logged.
- UX-069 — Accessibility conformance report for every release — Logged manual screen-reader passes (NVDA, JAWS, VoiceOver) to name assistive technologies tested; also a .github CI step for axe.
- UX-099 — Reference host: send for completion — A screen-reader run (NVDA, JAWS or VoiceOver) of the participant pages; the participant fill-and-sign view is also unbuilt.
- WASM-006 — Shaping and measurement behind the measurement interface — Typing-budget figure measured in real Safari on macOS on the reference machine.

## Production signing (key, CA, time-stamp provider or library)

- FRW-052 — Run a signing service that holds the keys — Production key store (hardware module or cloud key service, non-exportable) must be chosen; only SoftHSM2 emulator exists (decision 222).
- HIS-036 — Anchor signed, time-stamped heads in write-once storage — Owner choice of the production key service or hardware module; only a software emulator exists (decision 222).
- SEC-041 — Prove signing keys never reach content workers — Production hardware module or cloud key service; separate import and indexer worker images for the network-policy probe.

## CJK fonts

- EXP-016 — Validate every reference PDF with veraPDF in CI — Hangul-capable font in the export image so pages-20 validates; then an observed hosted run of the export job.
- EXP-025 — Typeset text runs as typed — Hangul-capable font in the export image so pages-20 compiles; multi-page text comparison also still to be built.
- EXP-056 — Check `layout.json` against the PDF — Hangul-capable font so pages-20 compiles for the layout test; CI wiring that fails on a mismatch.
- EXP-057 — Report line-level layout — Corpus compile compared with the PDF, blocked by the missing Hangul font for pages-20.
- EXP-078 — Gate TeX Live and class upgrades on reference PDFs — Hangul-capable font in the export image so pages-20 compiles and gets a reference; review step needs branch protection.
- EXP-111 — Produce tagged, accessible PDF — Hangul-capable font so the whole corpus compiles; then veraPDF validation of every tagged corpus PDF.
- EXP-114 — Add reference PDFs to the shared corpus — Owner permission to download CJK fallback fonts (ADR 0045 question 7); margin comments (EXP-084) and a CI veraPDF job.

## A cluster, several nodes or a second location

- BE-066 — Meet the stage 2 targets under load — Several room hosts, Valkey, and a load client for 50,000 connections and 10,000 open documents.
- BE-076 — Recover after a room host crash — A hosted multi-node deployment where a node can be lost and replaced, to time recovery against 15 minutes.
- BE-082 — Recover hosted deployments within the stated objectives — A second location to restore into, plus a scheduler and kept record for rehearsals.
- EXP-070 — Run every job in a single-use sandbox — A second host to show a job marker is invisible, and a real orchestrator running the worker image.
- EXP-076 — Reproduce the same PDF from the same bundle — The same bundle compiled on a second host; only one Podman machine exists.
- EXP-077 — Scale workers on queue depth — An orchestrator autoscaler and two real orchestrators, plus the stage 2 load tests and unit-cost target.

## Human review (accessibility, legal, translation, security, second maintainer)

- CDM-005 — Spike: settle the numbering and spacing semantics and write the fixtures — Named layout-engine and LaTeX-class owners (second maintainer) confirm ADR 0361 fixture review; a human tick of a decided matter.
- FE-112 — Plan bidirectional, complex-script and East Asian layout for the page view — A maintainer's review of the plan in ADR 0208, with reviewer name and date recorded.
- FRW-084 — Decide the default evidence retention period — Counsel must agree the legal basis and tenant-facing wording (FRW-087); the retention rule itself is decided.
- FRW-087 — Obtain legal review of the signing claims before launch — Counsel must review signing claims and record a written outcome; EU member states and US states to review against not named.
- SEC-001 — Keep a threat register that ties every threat to a test — A named second maintainer to review register changes, plus a code-owner rule and branch protection on main.
- SEC-003 — Review the threat model at the end of every phase — People must hold and record the phase 1a threat review; reviewers and date not named, phase 1a not ended.
- SEC-004 — Commission an external penetration test before general availability — Outside firm, scoped test environment and received report; scope settled (decision 98), firm and date not chosen; SEC-003 review first.
- SEC-043 — Prove product language does not over-claim — Counsel's review of the product wording (legal note SPK-024, FRW-087) recorded before launch.
- SEC-055 — Review sandboxed third-party extensions — A named person must sign off the review record (docs/review/2026-11-18-ux-060-sandbox-review.md) and its findings 1 to 4.
- SEC-061 — Decide the abuse-handling policy for hosted mode — Owner and counsel review and acceptance of the drafted policy (decision 97); second approver not named.
- UX-060 — Run extensions in a sandboxed iframe — A completed, signed-off security review of the sandbox, plus the documented supply-chain exception.

## The release run (and the first public release)

- BE-016 — Change the schema with expand-and-contract migrations — A second release whose predecessor's smoke suite can run against the database after an expand step.
- BE-095 — Upgrade self-hosted deployments across one skipped minor version — Two or three tagged semantic-version releases and a CI job that upgrades from N-1 and N-2 and rolls back.
- CDM-048 — Extend nodes and marks additively through `ext` — First public release as the schema baseline (decision 74), plus a .github CI job calling attributeShapeChanges().
- CDM-050 — Support two CDM versions side by side and keep older packages — A real run of release.yml (npm publish with provenance) must show published model packages are never unpublished or overwritten.
- EXP-073 — Build the curated TeX Live image — A published release carrying a TeX Catalogue licence manifest and source offer; also the curated second image build.
- FND-012 — Release pipeline — A pushed tag, owner registration of each package for npm trusted publishing, and a hosted run; reproducible export-worker image also pending.
- PRO-006 — Negotiate the protocol version and features — A first public release as the baseline (decision 74) plus a CI job in .github that compares artifact sets.
- PRO-127 — Publish the kit — A release on hosted CI that signs the kit container image (add it to the distributables list) and publishes it.
- SEC-051 — Produce a software bill of materials per release — A real release run attaching SBOMs, and the Syft comparison of service images (no syft binary here).
- UX-076 — Define the administration API — First public release as the baseline for PRO-006's additive-only compatibility check (decision 74); none exists.
- WASM-014 — Contributor guide for the kernel — Publishing the kernel package (now private) at the first public release so a contributor without Rust can use it.

## An owner decision not yet answered

- BE-005 — Start the whole stack from a compose file — Owner reading of 'export worker container' (ADR 0421) and approval of a Compose provider for podman compose.
- BE-007 — Deploy the authority service as a container — Owner approval to install a Compose provider (blockers list part E), or the Helm chart of BE-006 on a cluster.
- BE-041 — Separate and encrypt each tenant's objects — ADR 0105 question 3: which tenants get per-tenant sealing and how asset and export files read by others are handled; also a hosted bucket definition and BE-078.
- BE-072 — Use a managed queue — No managed queue service is chosen; adapter and its contract tests need a named service or emulator (ADR 0401).
- BE-074 — Assign a home region and forward channels to it — Owner answers ADR 0403 questions 1 to 3, and BE-068 separate tiers plus cross-region transport must exist.
- BE-097 — Define the on-call process for hosted mode — Owner names paging roles and response times; thresholds without a spec target wait on BE-080, BE-084 and BE-085 measurements.
- EXP-037 — Typeset right-to-left and complex-script text — Arabic, Hebrew and complex-script fonts with fallback chain (licence review, download) and a class design for RTL checked by LuaLaTeX.
- EXP-054 — Choose the converter between LaTeX and Office math — texmath container image (a download) and Office-math samples to measure converters; no permissive MathML to Office math converter found.
- EXP-060 — Meet the export latency target — Final 20-page export takes 23 s against 10 s; owner must pick how to meet or relax it, then reference-worker runs and CI gate.
- EXP-063 — Start engines ahead of time in fresh sandboxes — Owner decision whether to build pre-started sandboxes, since the condition (latency target missed) is met but unanswered.
- EXP-079 — Compare two independent compiles before sealing — Owner meaning of independent workers: two sandboxes in one worker (as built), or separate processes or hosts.
- EXP-088 — Export Markdown — Owner approval of a CommonMark renderer as a test-only dependency of export-latex; none is in the lockfile.
- EXP-097 — Choose the parser to build the DOCX importer on — Owner approval to fetch docx4j and Apache POI jars by hand (no Maven or Gradle) to measure them on the corpus.
- EXP-100 — Import text, styles and numbering — Owner decision on widening the label grammar (letters in level text) and number formats (Greek); other corpus gaps need EXP-101 and EXP-093.
- FE-020 — Keep menus, tooltips and dialogs inside the shadow root — Owner has not been asked whether Floating UI may become a dependency of ui; CSS-anchor check also needs a hosted job.
- FE-076 — Define the layout engine API and its injected interfaces — Owner must say whether to fork a layout core (Docen, per spike S7); otherwise criterion 6 never applies and is struck.
- FE-085 — Lay out columns and balance them — Owner's choice for a table taller than a page in a multi-column section (ADR 0206 item 2), or rewording the criterion.
- FE-090 — Paint lines the browser cannot re-wrap — Owner ruling on the measurer kerning pin (spec 02 section 9.3); sharp-at-zoom browser run and FE-099 for assistive reading.
- FE-100 — Reconcile page breaks with the typeset result — Tolerance for 'equal page starts' has no value from owner or spec; corpus run also needs a CJK face in the export image.
- FE-101 — Offer the editable page view as `view="print"` — Owner's word on ADR 0417 item 4 (page view not offered in Firefox for now); fields need a page-view control factory.
- FE-117 — Publish a compatibility list for browser extensions — Maintainers must choose the grammar-checker and password-manager extensions; then a person tests each in every supported browser.
- FE-124 — Run the host matrix — Agent work: add React, Angular, Vue and SvelteKit demo hosts to the element package (new dev dependencies) and run the suite.
- FND-008 — Bundle-size budget gate — Merged build is 330.2 kB gzip against 320 kB; no tolerance agreed. Cut size, or owner sets tolerance. Criterion 4 also needs a CI job.
- FND-013 — Documentation site — Owner names the Markdown renderer and API documentation generator (new third-party libraries); per-release site needs FND-012.
- FRW-059 — Sign through a signature provider — Owner must say whether the audit-log entry is enough evidence of the provider's asserted level, or the evidence bundle must change.
- FRW-063 — Send a template to many recipients — Owner must say what a bulk send counts against the tenant quota; then a new quota dimension, migration and schema change.
- FRW-069 — Drive fill mode through the embedding API — Owner must accept the proposed rewording of the criterion, since methods cannot be called before a custom element is upgraded.
- HIS-039 — Erase a document and everything derived from it — Owner or operator must name the backup schedule and the time by which erased content ages out of backups.
- PRM-063 — Decide whether part of `structure` can be granted per region — Owner answers two questions in ADR 0424 (page setup per region; removing an added style); then three stories are written.
- PRO-128 — Decide when to build a second server implementation — The owner names a partner, target tier and date, or the roadmap review records not scheduled; default of 05 section 11 stands.
- SEC-045 — Prove one tenant cannot reach another's data — Owner must choose ADR 0428 option for node streams and address counters that hold no tenant; the tenant-fonts test is then agent work.
- SEC-066 — Submit roots to a public transparency log and keep the receipts — Owner accepts which public log to use (ADR 0409 proposes Sigstore Rekor); then measure its limits to set the default period.
- SPK-007 — Decide the project's names and licence — The owner has not chosen final names; decision 2 keeps the working names until renamed before publishing.
- UX-012 — Access keys — Owner must settle that Alt alone is reserved by Firefox and Edge: keep it and reword criterion 3, or change the gesture.
- UX-031 — Mention people in a comment — Owner must say whether a comment may be multi-line (ADR 0327 Part A); then a screen-reader check of the picker.
- UX-056 — Custom blocks — Refusal code when a client lacks the extension (unsupported_feature or conflict), then telling the author why; decision 176 leaves it open (ADR 0328 d2).
- UX-091 — Reference host: compose stack and demo harness — A Compose provider on a Linux Podman host, a CI job for the two-user scenario, and a ruling on what S3 means.
- UX-097 — Service calls on behalf of a user — Owner choice among the three options of ADR 0410 for a named user's rights; history pane not mounted in reference host.
- WASM-007 — Unicode segmentation in the kernel — Owner word that unused-script tables count in the budget, or a split-by-script implementation (new dependency).
- WASM-013 — Rust supply chain and licences — Owner word on installing an advisory scanner (cargo-audit or cargo-deny) and downloading the RustSec database.
- WASM-016 — Line-breaking rules for East Asian and South-East Asian scripts — Owner choice of dictionary data source for Thai, Lao, Khmer and Burmese word breaks; no decision names one.

## Another story that is not done

- BE-021 — Close idle rooms and bound room memory — BE-084 must measure memory per open room (reference machine) so a budget can be set; reading of 'memory per room' is open.
- BE-028 — Attach large audiences to follower nodes — BE-067 must show followers are needed; decision 139 defers followers to stage 3, on demand.
- BE-067 — Decide whether follower nodes are needed before stage 3 — BE-066 multi-host run, then a growing-audience measurement on real room hosts.
- BE-068 — Run gateway, room and API tiers as separate deployables — BE-066 shows tiers must scale apart; stage 3 is on demand (decision 139). Then tier setting, charts and an ADR.
- BE-070 — Shard PostgreSQL by tenant — BE-080 fault-test harness (unbuilt, 5 criteria open) to run the fault half; a sharded main.ts and shard-map setting are also undecided.
- BE-075 — Cache version-pinned content and assets near users — A gateway in another region with its own cache fetching from the home region: BE-074 and BE-068 deployed in two regions.
- BE-085 — Meter the cost drivers per tenant — UX-078 durable period-bound meter and usage route; UX-076 defines no usage resource yet.
- BE-093 — Run a dedicated deployment for one tenant — BE-006 Helm chart for criterion 1; BE-095 release pair for criterion 3.
- EXP-090 — Write DOCX text, styles and numbering — EXP-115 criterion 2 (19 numbering cases differ in Word); imported-file warnings need source map persisted at import.
- EXP-096 — Write math to DOCX — EXP-054 must choose and measure a LaTeX to Office math converter; no converter or equation renderer exists.
- EXP-105 — Import Office math — EXP-054 must choose the Office math converter; the image fallback also needs an equation renderer.
- EXP-113 — Report images without alternative text — The accessibility checker pane (UX-066) must read the export job's image list; a change to the checker, not the export.
- EXP-115 — Run the shared numbering and layout fixtures against every writer — DOCX writer fixtures (EXP-090), class line-spacing and header-growth fixes in LaTeX, CDM-005 review, and CI compile runners that skip.
- FE-089 — Paginate long documents in the background — FE-088 keystroke latency target must be met first; then measure typing during background pagination on the reference machine.
- FE-102 — Keep the page view within its budgets — FE-098, FE-099 and FE-100 passes for the phase 3 exit; typing and memory budgets (FE-088, FE-089) and thumbnails not yet met.
- FE-108 — Keep ARIA references inside the shadow root — FE-101 criterion 5: page view field controls with labels, so label and control sharing a root can be checked.
- FND-009 — Service latency, load and fault-injection harness — BE-066 stage 2 load test must reuse the harness; it needs several room hosts and Valkey.
- FRW-085 — Decide whether comments are switched off during a workflow — FRW-068 must write the workflow conformance profile with the comment-during-workflow case; decision 131 already applied.
- PRO-123 — Ship the rules fixtures in the kit — A native (Rust) backend that evaluates every rules fixture case; none exists beyond text and layout kernels.
- PRO-129 — Freeze protocol 1.0 after a second server passes core — PRO-128 must yield a partner and date, and an independent second implementation must pass the core profile.
- SEC-052 — Sign container images and pin base images — BE-006 Helm chart and its deployment policy; plus a release run to sign images with cosign.
- SEC-053 — Pin TeX Live and ship its licence manifest — EXP-078 upgrade gate against reference PDFs, and EXP-073 curated image; licence manifest also needs a release run.
- SEC-058 — Prove data stays in the tenant's home region — Needs per-region stores and gateways: BE-074 criteria 3 and 5 (cross-region transport) and BE-068 separate tiers.
- SYN-042 — Attach viewers to follower nodes that never submit — BE-028 host wiring of a follower over the bus, only when demand shows (decision 139).
- UX-090 — Integration guide — UX-091 compose stack so a CI job can run the quick start; guide-in-same-change check was skipped by owner.
- WASM-011 — Identical results in every browser — Page view must take its lines from the kernel (FE-089, FE-101); also Safari on Apple hardware and a CI step.
- WASM-015 — Bidirectional text and complex-script shaping in the kernel — FE-112 plan reviewed by a maintainer, so the 02 section 11 plan exists for this work to follow.

## Other: agent work only, nothing external

- BE-019 — Open a room from a checkpoint and the log tail — Agent work in the authority package: a RoomInit form from plain data so replay and first projection run in a worker.
- BE-048 — Add tenant-supplied fonts — Agent work only: EXP-048 is done; tick criterion 3 on the worker's tenant-isolation test (exp-048-tenant-fonts.test.ts).
- BE-080 — Run an hour of faults against the stage 1 service — Agent work: extend the fault run (count catchUp kinds, rewind step, oracle, PDF export), then an hour run and nightly job.
- BE-094 — Run CDM migrations only when an operator starts them — Agent work only: build ADR 0435 (one schema per served version, setCdmVersion) across the service, then the migration runner.
- EXP-012 — Map bundle lines back to blocks — Agent work only: EXP-039 is now done; add a test that split-table continuation rows map to the original table block.
- EXP-098 — Import a Word file as a job — Agent work only: end-to-end run Word file to sealed PDF with real compile in worker image and signing service.
- EXP-101 — Import tables, images and figures — Agent work only: importer must group a caption's complex-field characters into one atom and build a seq field node.
- EXP-122 — Write and read citations and bibliographies in DOCX — Agent work: add citation files to the SPK-028 corpus and group field runs in the importer; criterion 1 also needs a Word run.
- EXP-123 — Export as the requester — Agent work only: persist import source map, add full-export docx path using exportDocx, then test restricted requester.
- FE-054 — Paste HTML through the sanitiser and the Word and Google Docs cleaners — Agent work: ADR then build remote-image fetch through the BE-056 egress proxy; real Word and Google Docs captures also needed.
- FE-066 — Edit in the web view — Agent work: footer command across engine, element adapter and ui registry (header/footer panels); IME on Safari later needs a Mac.
- FE-088 — Re-lay out incrementally — Agent work: resumable pagination from a page start and dirty-block layout; typing is far over 16 ms, then measure on reference machine.
- FE-118 — Keep typing latency within budget in the web view — Agent work: typing median far over 16 ms, table-heavy and comment-heavy fixtures; then the docedit-reference runner for the CI gate.
- FE-139 — Show preserved content with its fallback and change it only as a whole — Agent work only: drag-move, find-skip count and checker report for atoms; announcement criterion also needs a real screen-reader check.
- FND-001 — Monorepo with the package layout of the architecture — Agent work only: integrator fixes lint, type-check, generated-artifact and test failures from merged lanes, then repeat the fresh-clone pnpm check.
- FRW-068 — Publish the workflow, sign and seal conformance profiles — Agent work: kit participant tokens, a test hook for the expiry sweep and workflow deadline, and authorisation rows in 07 section 12.
- PRM-057 — Test the matrix: channel, commits, assets, export and service routes — Agent work on an idle machine: asset-read scenario needs an S3 store and sandboxed asset worker; then package perm-doc and perm-region profiles.
- PRO-057 — Fork a document from the host — Agent work only: adapter from the protocol history port to the shell history pane in the element, so the copy action can run end to end.
- PRO-092 — Publish complete typings for the optional ports — Agent work: behavioural contract cases for every member of all twelve ports, and backends that offer them (assets, exports, imports, fields, workflow).
- PRO-097 — backend-dep: implement the history, comments, lease and import ports — Criterion 2 reworded to the built behaviour (closing note of the decisions file); criterion 4 needs the ImportJob states (gap G74) defined in the spec.
- PRO-115 — Test every authorisation row and every rejection code negatively — Agent work: add test-mode hooks that provoke internal, slow_consumer and busy (not named by ADR 0219), then kit scenarios.
- SEC-010 — Prove prompt injection cannot cause side effects — Agent work only: assistant pane must insert through the agent connection so the agent is named; bridge drops the agent field.
- SEC-048 — Prove secrets are managed and rotated with overlap — Agent work: per-service secret split in demo stack proved under Podman; also a secret-scan CI step in .github (main session).
- SEC-056 — Prove users are known only as surrogates and erasure works — Agent work: the test harness needs a real export runner that writes a file, plus a sweep of the object store.
- UX-067 — Accessibility checker: act on issues — Agent work only: core commands for table header row, link text and colour, plus fix fields in the checker pane.
- UX-079 — Manage fonts and webhooks through the administration API — Agent work only: EXP-048 is now built; re-check the manifest-and-load path and tick criterion 1 on its worker tests.

## Other: edit to root config, specs or other epics by the main session

- EXP-045 — Allow TeX output only through the emitters — A reviewer rule rejecting new TeX contexts until an emitter covers them; needs CODEOWNERS or a PR template in .github (main session).
- PRM-064 — Decide a size quota for region-only editors — Decision 134 (no quota) makes the criterion not applicable; the main session strikes it.
- SEC-062 — Decide key management for per-document and tenant-owned keys — The main session applies the two edits listed in ADR 0156 to the BE-041, SPK-021, FRW-052 and FRW-053 story files.
- SPK-009 — Decide the language of the production backend — Move PRO-102 to PRO-107 and BE-007 out of phase 4 in their epic files (decision 96); an edit in other epics, done by the main session.
- UX-059 — Decision: build sandboxed third-party extensions? — Reword the criterion to record decision 120 (build tier 2 without partner or usage evidence); spec and story edit by the main session.

## Other: a tool, host or event outside the repository

- BE-006 — Install the service with a Helm chart — A Helm 3 client (a download, needs owner permission) and a local cluster such as minikube; then the chart is written and tested.
- BE-071 — Evaluate moving the commit log to a log store — A candidate log store or emulator to run the BE-002 LogStore suite against; conditional story (ADR 0006).
- EXP-069 — Choose the sandbox technology for compile workers — gVisor runsc and Firecracker on a Linux host with KVM, to measure start-up time and memory against the Podman figures.
- PRO-007 — Signal deprecations — Nothing is deprecated in 1.0: waits for the first deprecated resource or field, and a major version that removes one.

## Open owner decisions

The owner answered these questions on 2026-11-26. They are recorded in `docs/owner-decisions-2026-11-26.md` (decisions 225 to 282).

Each question below is not answered in the decision records. They are ordered by the number of stories each one unblocks (a story may appear under more than one). The first option is the recommended default. Where a question only asks the owner to accept the wording of a criterion, the story can finish once it is answered.

Not asked here, because the owner has already settled them or deferred them: the production certificate authority, time-stamp provider and signing library (decisions 221 to 223 keep them open until the options are reviewed), and the mapping of the 1009 close, the tagpdf table module (EXP-041), names of hidden region scopes (HIS-037) and the size limit of inline custom content (UX-057), for which the decisions file says to use the built behaviour.

### 1. May we register the reference laptop as a dedicated self-hosted runner for measurements, so performance figures and gates can be recorded?

Unblocks 28: FND-007, FND-009, BE-024, BE-030, BE-058, BE-084, BE-091, BE-021, SEC-028, EXP-051, FE-088, FE-089, FE-092, FE-102, FE-118, FE-119, FE-120, FRW-023, FRW-076, PRO-104, SYN-015, SYN-037, SYN-040, UX-054, UX-066, UX-072, UX-074, WASM-012

- **Register a dedicated runner** (recommended): Figures are stored on the results branch (decision 103) and gates can fail the build; the machine must be left idle during runs.
- **Measure by hand only**: No CI gate for now; figures are logged manually and stay provisional.
- **Rent a matching machine**: A hosted machine of the same class; costs money and must be shown to match decision 22.

### 2. When should we cut the first tagged release, so that publishing, signing and the compatibility baseline can run for real?

Unblocks 15: FND-012, CDM-048, CDM-050, PRO-006, UX-076, BE-016, BE-095, BE-093, PRO-127, SEC-051, SEC-052, SEC-053, EXP-073, WASM-014, FND-013

- **Pre-release tag soon** (recommended): Rehearses npm publishing, SBOMs and image signing early. Counts as the baseline only if you say so (decision 74 names the first public release).
- **Wait for first public release**: Nothing is published until you say so; the baseline and release-run criteria stay open.
- **Rehearse in private registry**: Proves the pipeline without publishing; the criteria that need a public release still stay open.

### 3. May we protect the main branch on GitHub so the named CI jobs must pass before a merge, and run those jobs (including a macOS runner for Safari) on pull requests?

Unblocks 14: FND-002, SYN-047, SYN-049, EXP-075, EXP-078, SEC-001, FE-017, FE-050, FE-116, SEC-002, SEC-035, SEC-050, UX-048, WASM-001

- **Protect main, require CI jobs** (recommended): Gives the gated merge and nightly run the stories ask for; one maintainer can still merge.
- **Also require a second reviewer**: Meets SEC-001 as written but needs a named second maintainer first.
- **Leave main unprotected**: Stories that need a gated merge or a recorded hosted run stay open.

### 4. May the PDF export image include open-licence Chinese, Japanese and Korean fonts such as Noto Serif KR?

Unblocks 9: EXP-016, EXP-025, EXP-056, EXP-057, EXP-078, EXP-111, EXP-114, FE-100, SEC-053

- **Add Noto fonts (OFL)** (recommended): One pinned font download; the corpus compiles and several export stories can finish.
- **Accept Baekmuk fonts**: Already in the TeX tree, but its licence is outside the licence policy, which would have to change.
- **No CJK in version 1**: No download; CJK stays unsupported in export and the corpus drops Korean.

### 5. Who is the named second maintainer or security reviewer for register changes, plans and sandbox sign-offs?

Unblocks 9: SEC-001, SEC-003, CDM-005, FE-112, WASM-015, EXP-045, SEC-055, UX-060, UX-048

- **Owner names a person** (recommended): A code owner is added and the criteria are met as written.
- **Owner reviews for now**: The owner is the second reviewer until someone joins; criteria are reworded to say so.
- **Outside reviewer**: Independent review; costs money and needs booking.

### 6. May a Compose provider (a tool that lets podman compose start the stack) be installed on the build machines?

Unblocks 5: BE-005, BE-007, UX-091, UX-090, SEC-002

- **Yes, install it** (recommended): Lets the compose file be started as the criteria say, here and in CI.
- **Accept podman run as proof**: Starting the images with the compose file's options counts; criteria are reworded.
- **Wait for the Helm chart**: Prove it on a cluster with BE-006; slower and needs a cluster and Helm.

### 7. Where should the production signing and sealing keys live: a cloud key service, a hardware security module, or whichever the operator chooses?

Unblocks 3: HIS-036, SEC-041, FRW-052

- **Operator chooses via a port** (recommended): One key-service interface; hosted uses a cloud service, self-hosted may use a hardware module. Fits both modes (decision 28).
- **Cloud key service only**: Simplest to build and rotate; self-hosted customers depend on that cloud.
- **Hardware module only**: Strongest custody; every deployment needs the hardware.

### 8. Which EU countries and US states should counsel review the signing claims against?

Unblocks 3: FRW-087, FRW-084, SEC-043

- **Counsel proposes the list** (recommended): Counsel picks from our first customers; fastest to start.
- **Owner names them now**: More control; needs your market knowledge first.
- **One country, one state**: Cheaper start with a narrower claim at launch.

### 9. May a gateway outside a tenant's home region read that tenant's document head and region from the home region's database to route a channel?

Unblocks 3: BE-074, BE-075, SEC-058

- **No, route by region alone** (recommended): Strictest data residency; the receiving node checks the owner (ADR 0403, recommended).
- **Yes, read from home region**: Simpler routing, but outside gateways touch the tenant's rows.
- **Copy assignment to each region**: Reads stay local; the copy must be kept in step.

### 10. May we pull the texmath converter as a container image and add Word equation samples, to measure LaTeX to Word maths conversion?

Unblocks 3: EXP-054, EXP-096, EXP-105

- **Yes, pull texmath image** (recommended): Runs as a separate process because it is GPL; measured on real equations.
- **Build our own converter**: No GPL code, but a large piece of work to maintain.
- **Equations as images only**: No converter; equations are not editable in Word.

### 11. A final 20-page PDF export takes about 23 seconds against a 10 second target; how should we proceed?

Unblocks 2: EXP-060, EXP-063

- **Target for preview only** (recommended): Keep 10 s for the quick preview; the final export gets its own longer target. Nothing to build.
- **Pre-start sandboxes**: Build EXP-063; its own notes say it alone will not reach 10 s.
- **Reduce compile passes**: Cut the three passes of the final export (EXP-061); risks unresolved page numbers and references.

### 12. Do you confirm the proposed size and start-up budgets for the Rust text module, counting the Unicode tables inside it?

Unblocks 2: WASM-007, WASM-012

- **Accept budgets, count the data** (recommended): The budget is checked against the real module; WASM-007 criterion 5 is reworded and the scheduled gate can be built.
- **Split tables by script**: Meets WASM-007 as written; needs another implementation and a new dependency.
- **Set tolerances after measuring**: Wait for measurements of the finished kernel; the gate is delayed.

### 13. Is any partner going to build a second protocol server, and if so who, at which tier and by when?

Unblocks 2: PRO-128, PRO-129

- **Not scheduled** (recommended): The roadmap records it; the 1.0 freeze stays open.
- **Name partner, tier and date**: PRO-129 and the roadmap are updated to match.

### 14. In the 19 rare numbering cases where Word and our rule give different labels, which should win?

Unblocks 2: EXP-090, EXP-115

- **Match Word** (recommended): Supports lossless Word round trip (A2) but changes the PDF labels.
- **Keep our rule**: Document the differences; Word files may show other numbers than the PDF.
- **Decide case by case**: Most precise, slowest.

### 15. Should Word's content controls (text, date, drop-down and checkbox boxes) be imported as our own form fields?

Unblocks 1: EXP-098

- **Yes, map common kinds** (recommended): An imported form can be filled and signed; some kinds stay preserved.
- **Keep preserved only**: Controls stay untouched Word data; fields are added in the editor.

### 16. Word lists can use labels such as NEW-1-FORMAT or Greek numerals that the editor cannot show; should the editor learn them?

Unblocks 1: EXP-100

- **Widen the label rules** (recommended): Labels match Word on the corpus.
- **Keep rules, preserve the list**: Such lists stay preserved Word data with a different label; criterion is reworded.
- **Widen number formats only**: Greek and similar formats added; free letter text stays preserved.

### 17. Which fonts should the PDF export use for Arabic, Hebrew and other complex scripts?

Unblocks 1: EXP-037

- **Noto families (OFL)** (recommended): Matches the image's existing Noto fonts; each face licence-reviewed and hash-pinned.
- **Other open-licence fonts**: More choice, but each needs its own review.
- **Defer to phase 4**: Right-to-left and complex-script export stays unsupported and warns until then.

### 18. For a sealed PDF, what counts as two independent compiles?

Unblocks 1: EXP-079

- **Two sandboxes, one worker** (recommended): As built; each sandbox is single-use and separate. No queue change.
- **Two worker processes**: Stronger separation; needs a queue and document-service change.
- **Two hosts**: Strongest; needs a second machine and costs more per sealed export.

### 19. May we add a Markdown renderer (for example markdown-it) as a test-only tool?

Unblocks 1: EXP-088

- **Yes, markdown-it (test only)** (recommended): Permissive licence; nothing ships to users.
- **Another renderer**: micromark or similar; same effect, different review.
- **No, reword criterion**: Keep the unescape round trip as proof; no new dependency.

### 20. Do you want the two Java Word readers (docx4j and Apache POI) measured too, which means downloading about a dozen jar files?

Unblocks 1: EXP-097

- **No, close with four readers** (recommended): The importer exists and ADR 0383 recommends building; criterion is reworded.
- **Yes, download and measure**: Completes the comparison; files kept in an isolated folder, not shipped.
- **Install Maven and Gradle**: Heavier tooling; same data, easier to repeat.

### 21. The first editor load is over the 320 kB budget; should we cut size, accept a tolerance, or raise the budget again?

Unblocks 1: FND-008

- **Cut size, keep budget** (recommended): Lazy-load more of the engine; takes engineering time.
- **Agree a tolerance**: You state how far over still passes; quick, weakens the gate.
- **Raise the budget**: Quickest; the page loads slower for every user.

### 22. Which tools should build the documentation site, and may we add them as new dependencies?

Unblocks 1: FND-013

- **VitePress plus TypeDoc** (recommended): One site tool with Markdown built in, TypeDoc for API pages.
- **markdown-it plus TypeDoc**: Smaller custom build; more site code to maintain.
- **You name another**: Agents wire it in.

### 23. Should the page layout be built on a copy of an existing open-source layout core (Docen), or keep our own engine with the Rust modules?

Unblocks 1: FE-076

- **Keep our own engine** (recommended): No fork to maintain; the adapter criterion is struck.
- **Fork Docen**: Faster layout start; we maintain a fork and an adapter.

### 24. The page view measures text with the canvas, which misses the tolerance in Firefox; may it stay unavailable in Firefox for now?

Unblocks 1: FE-101

- **Not in Firefox for now** (recommended): Firefox shows the web view plus a notice (ADR 0417); fastest.
- **Move layout to the worker**: Font-file measurement works in Firefox; larger piece of work.

### 25. How far may a page start on screen differ from the PDF's page start and still count as equal?

Unblocks 1: FE-100

- **Within one line** (recommended): Practical default, tuned on the corpus.
- **Set after measuring**: Run the corpus first, then you pick from the observed spread.
- **Exactly equal**: Strict; likely to fail on edge cases.

### 26. Should text measuring and painting both use normal kerning so lines match exactly (a spec change), or stay on automatic kerning with small mismatches?

Unblocks 1: FE-090

- **Pin both to normal** (recommended): Measure and paint agree exactly; 02 section 9.3 changes.
- **Keep automatic kerning**: Spec stays; kerned pairs can differ slightly.
- **Wait for Rust shaper**: Settle when the Rust module replaces the measurer; criterion stays open longer.

### 27. In a multi-column section, what should happen to a table that is taller than one page?

Unblocks 1: FE-085

- **Span pages and flag it** (recommended): Smallest change, already built; criterion reworded.
- **Split at paragraph boundaries**: Matches 03 section 10; needs a new layout rule.
- **Let it overflow the page**: Keeps the table whole but poor print result.

### 28. In the page view, should find-in-page be the editor's own search command or the browser's find bar?

Unblocks 1: SPK-022

- **Editor's own find command** (recommended): Reliable across engines (ADR 0380); browser bar stays but is not relied on.
- **Browser find bar only**: Less to build; misses text on unmounted pages.

### 29. May we add the Floating UI library to place menus and dialogs near the screen edge?

Unblocks 1: FE-020

- **Yes, add Floating UI** (recommended): Replaces our own placement; criterion met as written.
- **No, keep own placement**: No new dependency; criterion is reworded.

### 30. Which grammar-checking and password-manager browser extensions should we test the editor against?

Unblocks 1: FE-117

- **Agents propose, you approve** (recommended): We suggest the most widely used few of each kind; quick.
- **You name the list**: Best fit to your customers; needs your input.

### 31. May we add React, Angular, Vue and SvelteKit as test-only dependencies to build demo hosts?

Unblocks 1: FE-124

- **Yes, test-only** (recommended): Four demo hosts and the host matrix; nothing ships.
- **React and Vue first**: Smaller addition; criterion stays open for the rest.
- **No new dependencies**: Criterion reworded to the plain-HTML and Svelte hosts.

### 32. How should the 100-page memory limit be measured: browser script memory in Chromium, or the whole browser process?

Unblocks 1: UX-074

- **Script heap, Chromium only** (recommended): As built (ADR 0329); repeatable, ignores memory outside the heap.
- **Both, heap is the gate**: Record both; only the heap figure fails the build.
- **Whole browser process**: Closer to what a user sees; noisier.

### 33. While one tenant is rate-limited, how much may another tenant's acknowledgement time rise and still count as 'does not rise'?

Unblocks 1: BE-030

- **Within normal targets** (recommended): Median and 99th percentile stay inside the usual targets (BE-024); practical to measure.
- **No measurable change**: Stricter; needs per-tenant processes or read-time limiting.
- **Reword the criterion**: Only separate buckets are required (already shown).

### 34. Should 'memory per room' be reported as a sum and largest per tenant, or as a size distribution without document labels?

Unblocks 1: BE-021

- **Sum and largest per tenant** (recommended): As built; fits the spec's metric labels.
- **Size distribution**: Histogram without document ids; needs a new metric.

### 35. Firefox and Edge already use a lone Alt key press for their own menus; keep it for access keys anyway, or use Alt+Shift plus a letter?

Unblocks 1: UX-012

- **Keep Alt, reword criterion** (recommended): Decision 116 stands; the known conflict is documented.
- **Use Alt+Shift+letter**: No browser conflict; reverses decision 116 and changes spec and tests.

### 36. May a comment be only one line, so the mention picker can be a standard combobox, or must comments stay multi-line?

Unblocks 1: UX-031

- **Keep multi-line** (recommended): Criterion reworded to another accessible popup pattern, then checked with a screen reader.
- **Single-line comments**: Criterion met as written; longer comments lose line breaks.

### 37. When an editor without the needed extension tries to add or edit a custom block, which refusal should the room return?

Unblocks 1: UX-056

- **Keep conflict, reword story** (recommended): No protocol change; the criterion matches the built code.
- **Use unsupported_feature**: Matches the story wording; adds one refusal code to the protocol.
- **New dedicated code**: Clearest message; more protocol and spec edits.

### 38. When a service acts on behalf of a user, what should decide whether the user is allowed to do that action?

Unblocks 1: UX-097

- **Check what service can verify** (recommended): Refuse only where no role could allow it; the role stays the host's word.
- **Fail closed**: Refuse every prefill or replace naming a user; safest but breaks attribution on real hosts.
- **Host states the role**: New wire field; precise but a protocol change and a second source of the role.

### 39. Does the conformance kit's property test against the stack count as 'the S3 property tests', or must the S3 simulation suite get a remote mode?

Unblocks 1: UX-091

- **Kit property test counts** (recommended): Criterion reworded; no new harness.
- **Build remote mode**: Closer to the original wording; more work.

### 40. Should each field entry in layout.json carry the field's key, or should the criterion be reworded so the key is read from the document by identifier?

Unblocks 1: FRW-057

- **Reword the criterion** (recommended): Spec default (09 7.1); the published schema is unchanged.
- **Add key to the schema**: Changes the layout.json schema, the converter's map and validators.

### 41. When an outside signing provider reports a signature level, is the audit log enough, or must it also go into the evidence bundle?

Unblocks 1: FRW-059

- **Audit log is enough** (recommended): As built; criterion reworded.
- **Add to evidence bundle**: Changes 12 sections 7 and 8.2 and needs new work.

### 42. What should a bulk send count against a tenant's quota?

Unblocks 1: FRW-063

- **Rows per month** (recommended): Calendar month in UTC, like other usage.
- **Rows in running sends**: Limits work in flight; no monthly cap.
- **Documents a tenant holds**: Simple, but blocks other uses of the space.

### 43. A web component has no methods before it loads; may we reword the criterion to cover early properties and attributes, and methods called before a document loads?

Unblocks 1: FRW-069

- **Accept the rewording** (recommended): Early properties take effect on upgrade; methods with no document answer 'nothing applies'.
- **Drop the criterion**: Treat as not applicable; PRO lifecycle rules already cover properties.

### 44. When a tenant has not set a quota dimension, may the quota API clear a limit to 'no limit' (null) as the schema allows?

Unblocks 1: PRO-115

- **Yes, accept null** (recommended): Follows the schema; a limit can be removed exactly.
- **Whole numbers only**: As built: the largest whole number stands in; the schema narrows.

### 45. Counters per network address and the message streams between servers do not name the tenant; may they stay that way?

Unblocks 1: SEC-045

- **Accept both as exceptions** (recommended): Least change; written into the spec and pinned in the test (ADR 0428).
- **Key streams by tenant**: Fully separated streams; more streams and reader code.
- **Dedicated deployment per tenant**: Strict separation for tenants who need it (BE-093).

### 46. May history and attribution answers on the wire name an author by the host's own user id, even if it looks like an e-mail address?

Unblocks 1: SEC-056

- **Yes, as built** (recommended): The guide warns hosts not to use e-mail addresses as ids.
- **No, send surrogates**: Authors always appear as surrogates; protocol and history views change.

### 47. For a document with its own key, should its search index be encrypted under that same key?

Unblocks 1: SEC-062

- **Encrypt under document key** (recommended): Default to build against; search for those documents is slower or limited.
- **Leave index under tenant key**: Faster, but destroying the key leaves its words in the index.
- **No search for those documents**: Strongest; such documents cannot be searched.

### 48. Which public transparency log should the service anchor its signed roots in?

Unblocks 1: SEC-066

- **Sigstore Rekor public log** (recommended): Proposed in ADR 0409; relies on its terms and limits.
- **Timestamping authority**: Proves time only; not auditable by a third party.
- **Tenant-consortium log**: Operator-independent; someone must run it.

### 49. Which firm should run the outside penetration test, and when relative to the first public release?

Unblocks 1: SEC-004

- **Before first public release** (recommended): You pick and book a firm; safest, may delay launch.
- **When sealing first ships**: Covers the riskiest features earlier.
- **After launch**: Faster to market; critical findings could reach customers.

### 50. Who is the second person who must agree before an operator reads a customer's document content in an abuse case?

Unblocks 1: SEC-061

- **A named security lead** (recommended): Clear accountability; a single point of delay.
- **Any other administrator**: Quicker, less independent.
- **Owner for each case**: Strongest control; does not scale.

### 51. Should every tenant's stored files be sealed with its own key from the first release, or only tenants who opt in?

Unblocks 1: BE-041

- **Only tenants who opt in** (recommended): Ties to SEC-062 key custody; others unchanged.
- **All tenants, some objects**: Documents and checkpoints sealed; assets and exports stay unsealed.
- **All tenants, all objects**: Strongest; asset origin and downloads need the service or a key unwrap.

### 52. Which managed queue service should hosted deployments use for background jobs, if any?

Unblocks 1: BE-072

- **None until stage 3** (recommended): Keep the PostgreSQL queue; nothing to build.
- **Amazon SQS**: Dispatch only; job rows stay in PostgreSQL.
- **Azure Service Bus or Pub/Sub**: Same design; ties hosting to that cloud.

### 53. Who should be paged for hosted-service alerts, and how fast must they respond?

Unblocks 1: BE-097

- **Named rota, business hours** (recommended): Lowest cost; slower night response.
- **Round-the-clock cover**: Fastest; needs enough people and tooling.
- **Best effort for now**: No promise yet; criterion stays partly met.

### 54. How often are backups taken and how long are they kept, so we can state when erased content leaves them?

Unblocks 1: HIS-039

- **Operator sets it** (recommended): Document the rule (purge time plus backup retention); each deployment fills in its figures.
- **Owner names a default**: A schedule and retention for the hosted service; the backup job matches.

### 55. How long must the previous model version stay supported after a new one is released?

Unblocks 1: CDM-050

- **Until the next version after** (recommended): Counted in versions, no time limit (ADR 0424).
- **Add a minimum period**: A promise hosts can plan around.

### 56. A person who may edit only one region may rename it and add styles; should that be all they may do about structure?

Unblocks 1: PRM-063

- **Rename and add style only** (recommended): Proposed default; they cannot remove the style they added.
- **Also page setup per region**: Allows a landscape page for the region; moves text around it.
- **Also remove own added style**: Allowed if nobody has applied it yet.

### 57. What should the product, protocol and package names be, and when?

Unblocks 1: SPK-007

- **Decide before first release** (recommended): Keep working names now; rename once, before anything is published.
- **Choose names now**: You supply them; agents rename everywhere, more churn.

### 58. May we install a Rust security scanner and download its public list of vulnerable crates to check every build?

Unblocks 1: WASM-013

- **cargo-deny** (recommended): Advisories, licences and sources in one tool; downloads the RustSec database each CI run.
- **cargo-audit**: Advisories only; licences checked separately.
- **Not now**: Criterion stays open; dependencies reviewed by hand.

### 59. Which word-list data should the kernel use to break Thai, Lao, Khmer and Burmese text into lines?

Unblocks 1: WASM-016

- **ICU4X segmenter data** (recommended): Loaded only when a document uses these scripts; permissive licence; adds one Rust crate.
- **Another dictionary source**: Needs a new licence and size review first.
- **Break by script rules only**: No data, but lines may split inside words.
