# What blocks the unfinished stories, 2026-11-17

Source: the Notes of every story with an unticked criterion, read on 2026-11-17 from the lane worktrees (five readers, one per group of epics). Counts are stories, each counted once under its main cause. Notes can be stale; where a reader found one, it is said. Decisions already answered are in `owner-decisions-2026-11-15.md` and are not repeated here.

## Summary

| Main cause | Stories | Who can clear it |
|---|---:|---|
| Waits on another story's code | 183 | The agents, by building the dependency first |
| Just unfinished | 95 | The agents |
| Owner decision | 181 | The owner (parts A and B) |
| Hosted CI or an external service | 37 | The owner (part C) |
| A real device or a person | 29 | The owner (part D) |
| A new library or tool | 8 | The owner (part E) |
| Unclear, or not started | 42 | The agents |

About 30 stories wait only on a decision of 2026-11-15 being applied (for example CDM-002, CDM-003, CDM-004, CDM-008, CDM-016, FE-002, FE-032, FE-121, EXP-018, EXP-121, HIS-003, SPK-011, FRW-052, FRW-066, FRW-067, FRW-069, FRW-089). They need no new answer.

## Part A. Decisions with no default: these need an answer

### The four with the widest reach

1. **Page view (SPK-013, the gate).** Should the product draw its own pages on screen, as Word's print layout does? Options: (a) keep the scrolling web view plus the PDF read view; (b) add a read-only page painter first; (c) a full editable page view. Sub-question: must it reproduce Word's page breaks for imported files, or follow the house class? Waiting: FE-075, FE-076, FE-079, FE-089, FE-092, FE-094, FE-095, FE-097 to FE-102, SPK-022, and all 16 WASM stories.
2. **Rust module in the browser.** Spike S10 (SPK-023) measured a Rust WebAssembly module against harfbuzzjs with line breaking in TypeScript and recommended harfbuzzjs: no material gain from Rust, 2.1 times the download, a second toolchain and 21 crates. Eight WASM stories (001, 007, 008, 009, 013 to 016) run only if the owner overrides that. The other eight (002 to 006, 010 to 012) run on harfbuzzjs's own WebAssembly build as soon as question 1 is answered (b) or (c).
3. **Hosted service, self-hosted, or both first** (11 §10 decision 8). Waiting: BE-041, BE-076, BE-082, BE-083, BE-095, BE-097, SEC-061 (abuse policy).
4. **When the Rust production backend starts** (SPK-009 criterion 2). Name the phase, so PRO-102 to PRO-107 and BE-007 can be scheduled.

### Retention periods and limits (a number is needed)

- Deleted document: how long before purge, and who may shorten it (PRO-047, HIS-039).
- Signing evidence (IP address, browser string, times): how long, and from when (FRW-084, FRW-043, SEC-044, SEC-057).
- Age at which daily checkpoints thin to weekly (HIS-030).
- How often log heads are signed and time-stamped, and per document or per tenant batch (HIS-035, HIS-036). ADR 0145 leans to one batch root per tenant.
- How long old code packages stay runnable for compare and restore (HIS-045).
- Size limit of the attribution map (HIS-044).
- Default admission budget for expensive commits (SEC-028); CPU limit of the math gate per commit (EXP-051).
- Importer success rate on real Word files that lets CI pass (EXP-110).
- Subscriber count that counts as "many" for broadcast batching (SYN-041).
- Bundle budget: settled by owner decision 32 (320 kB gzip). The build is still over it; see FND-008 Notes for the current figures.

### Product behaviour

- Comment reactions: build them or drop the story (UX-033).
- Form of a comment link and how the host opens it (UX-034).
- Custom dictionaries: per user, tenant or document (UX-042).
- Mention inside hidden content: refuse, or turn into an access request (UX-031).
- What the user sees on a fatal error such as no access, update needed, quota spent (PRO-039).
- Which settings are feature switches that remove controls (PRO-081).
- Printing from the PDF viewer, whose frame may not open dialogs (FE-073).
- How a suggested row or block change is drawn (FE-044, FE-045; ADR 0302 has no pick).
- Numbered paragraphs as a list for screen readers: an owner element or a wrapper (FE-105, FE-130).
- Are refreshed caption and cross-reference texts written into the document (FE-134).
- Does Replace all in suggestion mode make suggestions; where a suggestion's time comes from (FE-060, FE-046).
- Whose unsent work a returning user may resubmit (FE-009, FE-010, FE-012).
- Catch-up on a first visit with no read marker (HIS-027, HIS-028).
- Restore of one region: several commits, or refuse as too large (HIS-018, HIS-007, HIS-020, HIS-021).
- Text written by commits a reader may not see: author hidden, "unknown person", or kept (HIS-026, HIS-015).
- Erasing a person who appears in a document under legal hold; erasure against write-once copies (HIS-031, HIS-038, HIS-039, HIS-040).
- An erased user in history: surrogate or "unknown person" (SEC-056).
- Assistant identity in attribution, and whether accepting its suggestion changes the author (HIS-017).
- What "copy a version into a new document" copies (HIS-022).
- Per-document key destruction: build or drop (HIS-041).
- Spreadsheet export of field values: ever, or drop the story (FRW-064).
- Error summary lists optional problems but the counter counts required fields only (FRW-078).
- Colour of banded table rows (EXP-038); where the classification marking appears (EXP-089).
- Author names and resolved threads in margin comments (EXP-084); anchor of a Word comment (EXP-093).
- "Imported as locked": meaning, policy, and the file's document protection (EXP-104).

### Technical choices

- Refusal for a resource of another tenant, or a thread the token does not cover: `forbidden` or `not_found`. D69 says `forbidden`; the code answers `not_found` (SEC-016, BE-032, PRO-059).
- Burst of 1000 copies of one commit: "busy" answers acceptable, or every copy acknowledged (SEC-015).
- Level-1 TeX trace or a full trace as proof of escaping (SEC-033).
- Origin that serves export results, and whether the viewer frame may be same-origin (SEC-036); two PDF.js exceptions (SEC-054).
- Secrets criterion judged on the demo stack, and secrets split per service (SEC-048).
- Credentials model of the administration API; meaning of "signing keys" (UX-076).
- Definition of usage figures and where a quota refusal carries its kind (UX-078).
- Transport of the audit stream: polling, server-sent events or a webhook (UX-082).
- Network of the export worker: the host's or none (UX-091, BE-005).
- Payload of mention and task events; source of e-mail addresses; mail sink (UX-098).
- One interface update per frame: change the scheduler or reword (UX-072).
- Secret manager for webhook secrets (BE-057).
- Font types and limits the asset sandbox accepts (BE-048); is `GET /fonts` tenant-wide (BE-098).
- Commit id of an outbox item (BE-039); `Idempotency-Key` on `replaceContent` (BE-037).
- Open a 16 MiB document in a worker, a large change, or accept the main thread (BE-019).
- Order of comment activity, which has no sequence number (PRO-058).
- Which layer owns rule P3 (PRO-110, PRO-111).
- Baseline for comparing published versions: protocol (PRO-006) and schema (CDM-048).
- Support window for versions n and n-1, and whether to make a first CDM 2 to exercise migrations (CDM-049, CDM-050).
- Line height 290.95 rounded to 291; where the body goes when the header leaves no room (CDM-043, CDM-045).
- "Text before the suggestions" when two users suggest formatting on the same text (PRM-013).
- Must the editor compare its access with the commit that created a region (PRM-006).
- Does the history gate apply to the host's service credential (PRM-041, PRM-042, PRO-057).
- Comment positions kept per checkpoint or at the head only (SYN-032, HIS-010); does the command-line rebuild tool count as heavy work (SYN-039).
- Store for the suggestion-to-commit index, and backfill of old checkpoints (HIS-042, HIS-014).
- Table row height before splitting: a first compile pass or a rule (EXP-039, EXP-003).
- How "permits server-side use" of a font is recorded (EXP-048).
- How the two compiles of a sealed export count against the tenant budget (EXP-079).
- What the suggestion export payload carries (EXP-081); how an imported document gets its source file as an asset (EXP-098).
- Where per-commit performance results are stored (FND-007).
- Trend store aside, `fuzz` and `fuzz-nightly` are duplicate jobs in `ci.yml`; the main session removes one.

## Part B. Decisions with a proposed default

These can be accepted in one go. Each line gives the default the spec, an ADR or the built code already follows. Say which ones you object to.

**Editor and interface.** UX-010 focus key into the format bar: ADR 0325. UX-011 command synonyms: locale tables. UX-012 access letters: Alt alone (ADR 0231 A). UX-023 panes: open and closed only, reword. UX-035 markup views: as inferred (ADR 0233). UX-038 tracked changes for everyone: `manage`. UX-044, UX-045, UX-046 assistant identity: ADR 0234 A; server refuses an assistant's direct edit. UX-049, UX-055 extension API: ADR 0234 B. UX-056, UX-057: none stated, built answer is `conflict`. UX-059, UX-060 sandboxed third-party extensions: not built. UX-066, UX-068 checker choices: as built (ADR 0329, ADR 0137). UX-070 themes: in the start chunk. UX-079 webhook ping, replay and font routes: ADR 0330 §2 (also PRO-068, BE-057). UX-085 classification event: `document.updated`. UX-086 data-loss hook silent: fail closed. UX-087, UX-088 export bundles: ADR 0373. UX-096, UX-097 `DEP-Actor`: proposed, needs a security review. FE-005 two listeners stay on `document`: accept, reword. FE-054 remote images in pasted HTML: not fetched. FE-065 switch to read view with unsent work: keep the session (ADR 0304). FE-068 page guides after an edit: keep. FE-082, FE-085 page-break rules: ADR 0120, ADR 0206. FE-119, FE-120 performance definitions: ADR 0209. FE-128: format mark stays alongside the suggestion, reword. FE-140 bibliography style on screen: the house class. FE-062 font substitutes: a `substitutes` field in `GET /fonts` (ADR 0144). FE-077: switch the layout cascade to the model's resolver.

**Permissions and workflow.** PRM-063 structure: document level only. PRM-064 region quota: none. PRM-065 split and merge: the part keeping the id keeps everything. PRM-066: titles of confidential regions hidden, owners see everything, refusal stays `forbidden`. PRM-045: reword to "accepted if grants allow". PRM-062: ADR 0146. FRW-085 comments while out for signing: always on. FRW-086 long answers under a lock: the participant may edit their granted region. FRW-049, FRW-089: one sealed full PDF for the owner and a sealed view per participant. FRW-061: accept `Idempotency-Key`. FRW-076: reword. FRW-018 and others: `read_only` and `conflict` as built. FRW-039 to FRW-080 workflow gaps and ADRs 0249, 0250, 0148, 0340 to 0343, 0252, 0366: as proposed. SYN-042 follower nodes: not before stage 3. SYN-046: check the session layer and protocol only.

**Protocol and backend.** BE-008, BE-009: 64 log partitions (ADR 0020). BE-011: `node_leases` exempt. BE-036 old-version reads: private caching only. BE-059: Valkey streams. BE-061 node address: lease row, fallback to routing. PRO-002: status ranges. PRO-037, PRO-111, BE-093 close codes: 1000 or 1001 tolerated. PRO-085 `exec()`: boolean. PRO-096, PRO-097 upload returns the id. PRO-109 test timers: 60 s. PRO-115: comments, history and leases not announced by default. PRO-126: ADR 0219. PRO-102 authority wire format: as proposed. PRO-131: `read-restrictions`. BE-038: `reload`. BE-045: uploader may resolve their own upload. BE-052 legal hold: per document. FND-004: rules in three places accepted. SEC-001: FE-125. SEC-011 browser extensions: the spec's position. SEC-039 embedded Word objects: kept and reported. SEC-062 key custody: as proposed. SEC-063 public transparency log: no.

**History.** HIS-023 to HIS-026, HIS-046 history gate: ADR 0034 (`editors` see full history, others named versions only). HIS-025: state current when access was given. HIS-037: hidden commits left out with one link hash. HIS-032: `not_found` with a reason. HIS-022: `copyGrants` false. HIS-010 fonts of old versions: the live manifest.

**Export and import.** EXP-013: converter lines stand. EXP-028: `align` does not move the caption. EXP-043, EXP-030, EXP-045: one string emitter. EXP-035: `pdfString`. EXP-005: document language, else `en-GB`, and UTC. EXP-033: stored day in UTC. EXP-050: as built. EXP-046, EXP-053: denylist of dangerous primitives. EXP-059 forced line breaks: not built. EXP-066: job without a log URL. EXP-069: gVisor. EXP-075: "outside the sandbox", reword. EXP-090: external relationships for hyperlinks allowed. EXP-095: as built. EXP-101, EXP-102, EXP-103, EXP-109: preserve what the model cannot hold, reword. EXP-117, EXP-041: labelled placeholder. CDM-042: Word's native numbering.

**From `owner-decisions-pending.md`, still open, defaults as recorded there:** items 1, 2, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 21, 22, 23, 28 to 38 and 41.

## Part C. Hosted CI and external services

- **A first hosted CI run.** The workflows trigger on `main` only and no run is recorded. Waiting: FND-001, FND-002, FND-008, BE-002, BE-003, BE-016, PRO-006, HIS-003, EXP-016, EXP-075, EXP-078, EXP-115, FE-017, FE-116, FE-121, CDM-048, SEC-002, SEC-035, SEC-048, SEC-050, SYN-047, SYN-049, UX-090, UX-091.
- **Branch protection on `main`**, and someone naming one gated merge and one nightly run (FND-002, SYN-047, SYN-049, EXP-075, EXP-078).
- **A self-hosted runner labelled `docedit-reference`** on the reference machine. Waiting: FND-007, FND-009, FE-118, FE-119, FE-120, FE-088, FE-092, FE-102, BE-019, BE-021, BE-024, BE-084, BE-091, PRO-102, UX-054, UX-072, EXP-060, SYN-015, SYN-037, SYN-040.
- **A release run** with npm trusted publishing, signing, SBOM and attestation (FND-012, SEC-051, SEC-052, PRO-127, EXP-073, EXP-120).
- **Signing infrastructure:** a key service or HSM (or an emulator), a test certificate chain, an RFC 3161 time-stamp authority, write-once storage (SPK-021, FRW-052 to FRW-057, HIS-036, SEC-041).
- **A cluster and a second location** (BE-016, BE-082, BE-093, BE-076, SEC-020, EXP-070, EXP-076).

## Part D. Devices and people

- Safari on macOS, an iPhone or iPad, an Android phone, touch selection (FE-038, FE-066, FE-113, FE-114, FE-115, FE-123, SPK-014, SPK-015).
- Japanese, Chinese and Korean input methods with a second client (FE-034, FE-056, FE-123).
- Screen-reader passes with NVDA, JAWS or VoiceOver (UX-068, UX-069, FE-095, FE-099, FRW-079).
- Word and Acrobat checks by a person (EXP-100, EXP-118, EXP-122, SPK-021, FRW-053, FRW-056, FRW-057); real Word and Google Docs clipboard samples (FE-054).
- Reviews: a second maintainer (SEC-001, FE-112, CDM-005), an end-of-phase threat review (SEC-003), an outside penetration test (SEC-004), counsel (FRW-087, FRW-050, SEC-043), a designer (UX-035), a security review (UX-044, UX-048, UX-096).
- One small task: fill the Firefox column of the shortcuts table from Mozilla's article (UX-013).

## Part E. Libraries and tools

- Floating UI (FE-020). A UAX #14 line-breaking library and its test data (FE-080, WASM-007, WASM-016). A Markdown renderer (EXP-088). An OOXML schema validator (EXP-090). `eslint-plugin-svelte` (FE-108).
- A Hangul and CJK font for the export image, for example Noto Serif KR under the OFL (EXP-016, EXP-025, EXP-056, EXP-057, EXP-078, EXP-111, EXP-114).
- The texmath container image and Office-math samples for the math converter spike (EXP-054, then EXP-096, EXP-105).
- A Compose provider for `podman compose` (BE-005, UX-091). `helm` (BE-093). Syft and cosign (SEC-051, SEC-052). An SMTP client and a mail sink (UX-098). A PAdES signing library (SPK-021).

## Part F. What the agents can do without anyone

The dependency stories that hold up the most others, to be built first:

- The workflow service: FRW-027, FRW-025, FRW-030, FRW-047, FRW-036, FRW-040, FRW-038, FRW-053, FRW-035, FRW-031. About 50 FRW, SEC, UX, HIS and EXP stories wait on this chain.
- History routes and cold storage: HIS-026, HIS-029, HIS-009, HIS-018.
- Comments and threads: PRO-059, PRO-060, UX-028, SYN-032.
- The authority service: PRO-102 to PRO-107.
- The PDF pane and `exports` in the real editor: FE-071, UX-101, PRO-086, PRO-079; the DOCX export job in the worker.
- UX-037 (review pane), UX-041 (proofing), UX-076 (administration API), UX-090 (integration guide), UX-045 (assistant pane), BE-044, BE-058, PRO-126, PRO-066, FE-101, FE-009, FE-083.
