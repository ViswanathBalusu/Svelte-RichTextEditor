# SPK Phase 0: owner decisions, spikes and notes

Phase 0 of [11 Roadmap](../spec/11-roadmap.md) §2: the decisions the project owner must take, the spikes that produce evidence before phase 1, and the notes to write. Spikes S5 and S7 are widened, S2 gains WebAssembly checks, and S10 is new, all following [ADR 0016](../adr/0016-rust-wasm-compute-kernels.md) and the [Rust and WebAssembly assessment](../research/2026-11-06-rust-wasm-assessment.md). Production work that follows a spike lives in the owning epic: S3 in SYN and PRM, S4 in EXP, S6 in PRO and CDM, S8 in FRW, S5, S7 and S9 in FE, S10 in WASM.

Decision stories use the persona Project owner: the person who decides for the project, not a document owner inside the product.

## Decisions before phase 1

### SPK-001 Decide assumption A1: offline-first editing

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Project owner |

**Spec:** 00 §5 (A1); 11 §2, §10 item 1; ADR 0001 · **Requirements:** R4, R7, R13 · **Depends on:** none

As the project owner, I want to decide whether version 1 must support offline-first editing, so that the sync engine, history, permissions and fill rules are built on a foundation that will not be torn out.

**Acceptance criteria**

- [x] Given the default in 11 §10 (no; disconnection tolerance through the recovery journal), when the owner decides, then the decision and its date are recorded in PRODUCT.md and ADR 0001 moves from proposed to accepted or rejected.
- [x] Given the answer is yes, when it is recorded, then the SYN, HIS, PRM and FRW backlogs are re-planned before any phase 1a story starts, because 00 §5 describes the change as a rewrite.
- [x] Given the answer is no, then the journal of 02 §2.2 is confirmed as the design for closed tabs and short disconnections.
- [x] The decision is taken before phase 1a starts (a one-way door, 00 §5).

**Outcome (2026-11-06):** no. Version 1 does not need offline-first editing. PRODUCT.md and 00 §5 record it, ADR 0001 is accepted, and the recovery journal of 02 §2.2 is the design for closed tabs and short disconnections.

### SPK-002 Decide assumption A2: lossless DOCX round-trip

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Project owner |

**Spec:** 00 §5 (A2); 11 §2, §10 item 2; ADR 0004 · **Requirements:** R5 · **Depends on:** none

As the project owner, I want to decide whether Word files must round-trip without loss, so that the scope of the document model is fixed before it is built.

**Acceptance criteria**

- [x] Given the default (no; DOCX is best-effort with documented losses), when the owner decides, then PRODUCT.md and ADR 0004 record the decision.
- [x] Given the answer is yes, then the CDM and EXP backlogs gain work to retain original package parts and unknown XML, and the page-view backlog notes that its layout must chase Word's behaviour (00 §5).
- [x] The decision is taken together with SPK-001 and SPK-004 (00 §5: A2 sets the scope of the model).

**Outcome (2026-11-06):** yes, lossless round-trip is required. This reverses the default. PRODUCT.md, 00 §5, 03 §1 and §4.6, 09 §11 and §12 and ADR 0004 record it. [ADR 0017](../adr/0017-lossless-docx-preservation-layer.md) proposes the preservation layer. The backlog gained:

- spike S11 (SPK-028);
- the preservation feature in the model (CDM-051);
- import and export of preserved content (EXP-116 to EXP-120);
- display of preserved content (FE-139);
- a question at the page-view gate on reproducing Word's pagination (SPK-013).

Whether the lossless writer moves from phase 4 to phase 2 is a new owner question (ADR 0017, Open questions).

### SPK-003 Decide assumption A3: one house LaTeX class

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Project owner |

**Spec:** 00 §5 (A3); 09 §3, §7; 11 §10 item 3; ADR 0007 · **Requirements:** R5 · **Depends on:** none

As the project owner, I want to decide whether version 1 typesets with one house class or with customer templates, so that the export pipeline and page-break reconciliation can be designed.

**Acceptance criteria**

- [x] Given the default (one house class), when the owner decides, then PRODUCT.md and ADR 0007 record it.
- [x] Given customer templates are required, then the EXP backlog records that on-screen pages can only be approximate (00 §5) and the L1 reconciliation of 09 §7 is re-scoped.
- [x] The decision is recorded before spike S4 (SPK-017) chooses its class design.

**Outcome (2026-11-06):** one house class. PRODUCT.md and 00 §5 record it, and ADR 0007 is accepted.

### SPK-004 Decide assumption A4: LaTeX as an export pipeline only

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Project owner |

**Spec:** 00 §5 (A4); 11 §2, §10 item 4; ADR 0004, ADR 0007 · **Requirements:** R5 · **Depends on:** none

As the project owner, I want to confirm that the CDM document, not LaTeX source, is the stored source of truth, so that the editor is not limited to what a visual layer over LaTeX can express.

**Acceptance criteria**

- [x] Given the default (yes, export only), when the owner decides, then PRODUCT.md, ADR 0004 and ADR 0007 record it.
- [x] Given the answer is no, then the CDM, EXP and FE backlogs are re-planned before phase 1a, because 00 §5 describes reversal after phase 1 as a rewrite of the document model.
- [x] The decision is taken before phase 1a starts (a one-way door).

**Outcome (2026-11-06):** yes. LaTeX is an export pipeline, and the CDM document is the stored source of truth. PRODUCT.md, 00 §5 and ADRs 0004 and 0007 record it.

### SPK-005 Decide whether regions or field values may be hidden from some readers

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | should | Project owner |

**Spec:** 00 §3, §10; 07 §1; 11 §10 item 5 · **Requirements:** R3 · **Depends on:** none

As the project owner, I want to decide whether version 1 must restrict reading as well as changing, so that content loading, sync, history, search and export are not designed twice.

**Acceptance criteria**

- [x] Given the default (no: version 1 restricts changing, not reading), when the owner decides, then PRODUCT.md records it.
- [x] Given the answer is yes, then a design task is opened covering content loading, sync, history, search and export (00 §10) before phase 1b, and no story assumes readers see the whole document.
- [x] Given the answer is no, then the non-goal stays in 00 §3 and PRODUCT.md, and the record states what customer evidence would reopen it.

**Outcome (2026-11-06):** yes. Version 1 must be able to hide some regions and some field values from some readers. PRODUCT.md, 00 §3 and §10, 07 §1 and §17, 12 §3.2, §3.3, §13 and §15, and ADRs 0009 and 0011 record it. The design task is open: [ADR 0019](../adr/0019-read-restrictions-by-projection.md) proposes per-reader projections of the one log, and spike S12 (SPK-029) tests it before phase 1b. Stories that asserted full read access were changed (PRM-004, FRW-001, FRW-002, the FRW field reads, EXP-095, UX ports); S12 lists the rest. The third criterion applies only to the answer no.

### SPK-006 Decide the first market

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Project owner |

**Spec:** 00 §10; 11 §2, §10 item 6; PRODUCT.md (Users) · **Requirements:** R1, R13, R14 · **Depends on:** none

As the project owner, I want to choose the first market, so that the priority of citations, cross-references, numbering depth, review and signing is set by real customers.

**Acceptance criteria**

- [x] Given the candidates in PRODUCT.md (agreements and forms, controlled documents, academic and technical writing, or another), when the owner chooses, then PRODUCT.md records the market and the date.
- [x] Given a market is chosen, then the priorities of the affected stories in CDM, EXP, FRW and UX are reviewed and changed where the market requires it.
- [x] The decision is taken before phase 1 (11 §2).

**Outcome (2026-11-06):** all three candidate markets: agreements and forms, controlled documents, and academic and technical writing. PRODUCT.md records it. Priorities were reviewed: citations and a bibliography join CDM 1 (CDM-004 resolves to yes; new stories CDM-052, EXP-121, EXP-122, FE-140, UX-103). Every other capability the three markets need (cross-references, deep numbering, review, signing) was already in the backlog, so no other priority changed.

### SPK-007 Decide the project's names and licence

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Project owner |

**Spec:** 00 §10; 11 §10 item 7; README (Working names); PRODUCT.md (Brand commitments) · **Requirements:** R6 · **Depends on:** SPK-024

As the project owner, I want to choose the project's names and licence, so that packages, the element, the protocol and the house class can be published under their real names.

**Acceptance criteria**

- [x] Given the legal note (SPK-024), when the owner decides, then the licence is recorded; Apache-2.0 is the recommendation because it carries a patent grant.
- [ ] Given names are chosen, then every working name in the README's table (`<doc-editor>`, DEP, `dep.v1`, `/.well-known/dep`, CDM, `pm-steps/1`, `de-`, `dep.`, `docedit.cls`, `\DE`, `@docedit/*`, `--de-`) has a replacement recorded.
- [x] Until then, nothing is published to a public registry under a working name.

**Outcome (2026-11-06):** the licence is Apache-2.0 (`LICENSE`, `NOTICE`; root `package.json`). The names are not decided yet, so the second criterion stays open, and every package stays private under its working name.

**Notes:** Lane w4 (2026-11-15): the second criterion is still blocked on the owner. A replacement for each working name is the owner's choice, and neither the spec nor PRODUCT.md proposes one (PRODUCT.md lists the project's names as undecided and says a name is never to be invented). No names were proposed here and nothing new was ticked.

### SPK-008 Decide hosted service, self-hosted distribution, or both at first release

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | should | Project owner |

**Spec:** 01 §5; 06 §6, §14; 11 §10 item 8 · **Requirements:** R9, R15 · **Depends on:** SPK-025

As the project owner, I want to decide which deployment mode ships first, so that operations work is scheduled for the mode customers will actually run.

**Acceptance criteria**

- [x] Given the default (both are designed for; neither is scheduled first), when the owner decides, then PRODUCT.md records it.
- [x] Given hosted first, then the BE backlog's multi-tenant operations, availability and recovery stories are scheduled before self-hosting adapters; given self-hosted first, the reverse.
- [x] The record names who operates the first production deployment, and therefore whose recovery objectives (06 §9) apply first.

**Outcome (2026-11-06):** both the hosted service and the self-hosted distribution are designed for, and neither is scheduled first (the default). Since neither comes first, the second criterion leaves the BE order as it is. Who operates the first production deployment, and so whose recovery objectives apply first, will be recorded when one is chosen.

### SPK-009 Decide the language of the production backend

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | could | Project owner |

**Spec:** 01 §7; 05 §9, §10; 11 §9 risk 5, §10 item 9; ADR 0016 · **Requirements:** R6, R9 · **Depends on:** none

As the project owner, I want to confirm the production backend's language, so that the authority service is built only if a non-JavaScript backend is really planned.

**Acceptance criteria**

- [x] Given the default (Node.js for the reference service; other languages through the authority service of 05 §10), when the owner decides, then PRODUCT.md records it.
- [ ] Given another language is chosen, then the PRO stories for the authority service are moved earlier.
- [x] The record notes that ADR 0016 keeps the authority, rules and model in TypeScript whatever the backend language.

**Evidence:** owner decision 1 of 2026-11-15 ([docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)): Rust or C#, Rust preferred if nothing blocks it; the Node.js reference service stays. Criteria 1 and 3: `PRODUCT.md` ("Decided by the owner on 2026-11-15") records the language, the reference service and the consequence of ADR 0016; `docs/spec/11-roadmap.md` §10 item 9 says so. This is a decision story: nothing in it is executable, so no test exists. `pnpm stories:check` passes.

**Notes:** Lane w4 (2026-11-15): blocked on the owner; nothing ticked. The default applies until the owner decides: Node.js for the reference service, other languages through the authority service of 05 §10 (11 §10 item 9). PRODUCT.md lists the Node.js reference service under "Proposed, not yet confirmed" and has no owner decision on the backend language, so criterion 1 is open. Criterion 2 applies only if another language is chosen; none is, so no PRO story was moved. Criterion 3 is about the owner's record, which does not exist yet; when it is written it should cite ADR 0016 (proposed), item 1 and its consequence "One language for everything that must agree between client and server: model, authority, rules". PRODUCT.md was not edited. Lane w4 (2026-11-17): the owner decided (decision 1): Rust or C#, Rust preferred if nothing blocks it. Criteria 1 and 3 are ticked. Criterion 2 stays open for two reasons. The authority-service stories (PRO-102 to PRO-107, BE-007) are in phase 4 and belong to the PRO and BE epics, which this lane does not edit. The owner gave no date for the production backend, so "earlier" has no target phase; the lane did not pick one. The PRO lane or the owner names the phase, and then those stories move.

### SPK-010 Decide who invites and authenticates workflow participants

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | must | Project owner |

**Spec:** 12 §6.3, §7, §15; 11 §2, §10 item 10 · **Requirements:** R13 · **Depends on:** none

As the project owner, I want to decide whether the host alone invites and authenticates workflow participants, so that the workflow, evidence and webhook stories have one owner for identity.

**Acceptance criteria**

- [x] Given the default (the host), when the owner decides, then PRODUCT.md records it.
- [x] Given the hosted service must also invite or authenticate participants, then FRW and BE gain the stories for that, and the non-goal "sending e-mail or text messages" (00 §3) is revisited explicitly.
- [x] The decision is taken before phase 1 (11 §2).

**Outcome (2026-11-06):** the host alone invites and authenticates workflow participants (the default). PRODUCT.md records it, and the non-goal "sending e-mail or text messages" stands.

### SPK-011 Decide the first jurisdictions and the sealing party

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | should | Project owner |

**Spec:** 12 §8.2, §8.3, §15; 11 §10 item 11; ADR 0013 · **Requirements:** R13 · **Depends on:** SPK-024

As the project owner, I want to decide which jurisdictions come first and whether the operator or each tenant is the sealing party, so that sealing keys, certificates and evidence are set up for the right party.

**Acceptance criteria**

- [ ] Given the default (undecided; a simple electronic signature plus a seal at launch), when the owner decides, then PRODUCT.md records the jurisdictions and the sealing party.
- [ ] Given a decision, then spike S8 (SPK-021) and the FRW sealing stories use that party's key and certificate arrangement.
- [ ] The decision is taken before phase 2 starts workflow work.

**Notes:** 2026-11-15: no criterion can be ticked without the owner's word, and the owner has not decided; PRODUCT.md still lists "jurisdictions and the sealing party" as undecided. The first needs the owner's choice, the second follows from it, and the third is met only when the choice is made. [ADR 0361](../adr/0361-w4-SPK-011-first-jurisdictions-and-sealing-party.md) (proposed) sets out the options (the European Union, the United States, both or others; the operator, each tenant, or the operator with a tenant's own key where one is supplied) and what each means for keys and certificates. It keeps the spec's default (undecided; a simple electronic signature plus a seal at launch, 11 §10) and proposes one working assumption for design only: a sealing key chosen per tenant with the operator's key as the fallback, which is the reading of 12 §8.3 and serves either final choice. It recommends no jurisdiction.

### SPK-012 Decide fixed-width or reflowing fields

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 0 | S | should | Project owner |

**Spec:** 12 §15; 11 §10 item 12 · **Requirements:** R13 · **Depends on:** none

As the project owner, I want to decide whether a document may reflow while its fields are filled, so that fill mode and the sealed PDF behave predictably.

**Acceptance criteria**

- [x] Given the default (fixed width, 12 §3.2), when the owner decides, then PRODUCT.md records it.
- [x] Given reflowing fields are allowed, then the FRW stories replace the mitigation "fixed-width fields and `maxLength`" for moving page breaks (12 §14) with another one before form mode is built.
- [x] The decision is recorded before the phase 1b form-mode stories in FRW start.

**Outcome (2026-11-06):** fixed width (the default, 12 §3.2). The mitigation "fixed-width fields and `maxLength`" for moving page breaks stays (12 §14).

### SPK-013 Decide on the page view at the end of phase 2

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| decision | 2 | S | must | Project owner |

**Spec:** 11 §1 principle 4, §5 (gate), §10 item 13; ADR 0005; ADR 0016 · **Requirements:** R1 · **Depends on:** SPK-018, SPK-020, SPK-023

As the project owner, I want to decide from customer evidence whether to build editable pages, so that the largest and least predictable item is built only if customers need it.

**Acceptance criteria**

- [ ] Given the evidence gathered in phase 2, when the gate is held, then one of the three alternatives of 11 §5 is chosen and recorded: the web view plus the read view; the own read-only painter first; or the full editable page view.
- [ ] Given the page view goes ahead, then spike S9 (SPK-022) is scheduled before any page-view input work, and the WASM epic's stories are scheduled according to S5 and S10.
- [ ] Given it does not, then the FE page-view stories and the WASM epic stay parked, and the decision states what evidence would reopen it; the web view, the read view and the PDF must then form a complete product (11 §9, risk 1).
- [ ] Given any outcome, then ADR 0005 is updated, and phase 3 stories in FE and WASM that the outcome makes unnecessary are marked dropped.
- [ ] Given the owner's decision that Word files round-trip without loss (A2, 2026-11-06), when the gate is held, then it also decides whether the page view must reproduce Word's pagination for imported documents or follow the house class as ADR 0005 assumes, and records the evidence (ADR 0017, Layout).

**Notes:** absorbed FE-074 during the cross-check. How customer evidence is collected is not specified. The last criterion was added with the A2 decision; 00 §5 said lossless round-trip makes the layout engine chase Word's behaviour, and ADR 0017 leaves that choice to this gate.

Lane w9 (2026-11-17): nothing ticked; blocked on the owner and on evidence that does not exist yet. The story is the owner's decision at the end of phase 2, "from customer evidence" (11 §5), and phase 2 is not finished. The owner's decisions of 2026-11-15 do not list it, so it is still open. The spec gives no default for the three alternatives, so none is proposed here and no ADR 0005 text was changed. What the gate will need, from 11 §5, §6 and §9 risk 1: evidence of whether customers need editable pages (how it is gathered is not specified), a choice of one alternative, and a statement of what evidence would reopen a "no". Its dependencies SPK-018, SPK-020 and SPK-023 are separate stories. Criteria 2 and 3 follow from the choice, criterion 4 follows from it, and criterion 5 needs the Word-pagination evidence of ADR 0017.

## Spikes

### SPK-014 S1: ProseMirror inside an open shadow root

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | must | Maintainer |

**Spec:** 11 §2 (S1); 02 §5.2, §8, §12, §14; 03 §4 · **Requirements:** R1, R2, R12 · **Depends on:** none

As a maintainer, I want evidence that ProseMirror handles typing, selection and composition inside an open shadow root, so that the web view is built on a foundation that works in every supported browser.

**Acceptance criteria**

- [ ] Given Chrome and Edge 137, Firefox 142 and Safari 17 (02 §12), when the matrix runs, then Japanese, Chinese and Korean composition, dead keys, and at least one Android and one iOS keyboard pass, or each failure is listed with a workaround.
- [ ] Given remote commits arriving during composition, then no text is lost or duplicated, in the main editor and in the sub-editors for headers and footnotes.
- [x] Given the schema of 03, then definition nodes are not selectable, "select all" is limited to the body, identifiers default to null, and the footnote content model is decided and written down.
- [x] The side effect of Firefox's patch to `ShadowRoot.prototype.getSelection` on the host page is documented (02 §8).
- [x] The results are written up with the test matrix, kept in the repository for reuse in the input matrix of 02 §14.

**Evidence:** Spike report `docs/spikes/2026-11-06-s1-prosemirror-shadow-root.md` (section 4.7: the `getSelection` patch and its side effects on the host page). `packages/element/e2e/s1-getselection.spec.ts` records `ShadowRoot.prototype.getSelection` before and after the editor, with ProseMirror's own behaviour and with the element's per-instance shim, in Chromium 158, Edge 156, Firefox 159 and WebKit 27.2. The matrix is kept in `packages/element/e2e/s1-*.spec.ts` (shadow root and schema rules, composition with remote commits in the body and the footnote and header sub-editors, input drivers, footnote content models) and `packages/engine/src/core.test.ts`; final run on 2026-11-06: 632 Playwright tests passed (S1 and S2, 0 failed, 0 flaky) and 16 Node.js tests passed. Criterion 3 (2026-11-15, lane w4): the footnote content model is written down in 03 §4.4 and §13 and in `docs/adr/0031-cdm-1-model-completion.md` section 3 (CDM-001: `paragraph+`, one paragraph in version 1, from the report's section 5). `packages/element/e2e/s1-shadow-root.spec.ts` ("schema rules in the browser": select all covers the body only, the caret never leaves the body, a selection on the definition wrapper is clamped, Enter fills identifiers) and `packages/element/e2e/s1-footnote-model.spec.ts` (the decided model in the footnote sub-editor) ran with `pnpm exec playwright test -c packages/element/playwright.config.ts s1-shadow-root s1-footnote-model` on this Windows host in the Chromium, Edge, Firefox and WebKit projects: 60 passed, 0 failed. `packages/engine/src/core.test.ts`, `packages/model/src/prosemirror/schema.test.ts` (definitions and stories not selectable, null `id` defaults, "uses the footnote content model decided in CDM-001") and `packages/model/src/validate/inline.test.ts` ran in Node.js: 53 passed.

**Notes:** S1 ran on current versions (Chromium 158, Edge 156, Firefox 159, WebKit 27.2 on Windows), not the minimums of 02 §12, and not on Safari. Criterion 1 stays open: Chromium and Edge pass, driven through the DevTools protocol; Firefox can be driven only with compositions committed in one step and WebKit not at all; mobile keyboards and operating-system input methods are a manual checklist (report §6). Criterion 2 stays open: no text is lost or duplicated in Chromium, Edge and Firefox (one-step) once the core defers a remote commit that changes the block being composed until `compositionend` (report §4.5; proposed for FE-034, not a decision on SYN's algorithm); without the deferral Chromium and Edge keep the uncommitted text and it ends up twice; WebKit and real input methods are unverified. Criterion 3 stays open: definitions are not selectable, "select all" is limited to the body and identifiers default to null (Node.js and four browsers), but the footnote content model is CDM-001's to decide; the report recommends option B (`paragraph+`, one paragraph in version 1) with an explicit I10 check against nested footnotes and copying through the embedded fragment (report §5). Lane w4 (2026-11-15): criterion 3 is ticked. CDM-001 has since recorded option B in ADR 0031 section 3 and in 03 §4.4 and §13, and the schema and the engine use it. ADR 0031 is still proposed: the owner has not accepted it, and this tick does not accept it for the owner. Criteria 1 and 2 stay open and nothing new could be built for them here: they need Safari 17 on macOS, the minimum browser versions of 02 §12, one Android and one iOS keyboard on real devices, and operating-system input methods, none of which this Windows host has (Playwright's WebKit is not Safari and exposes no command for an open composition). The manual checklist of report §6 is the way to close them. The patch of criterion 4 also happens in WebKit, not only Firefox as 02 §8 says.

### SPK-015 S2: strict content security policy and Trusted Types, including WebAssembly

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | must | Integrating developer |

**Spec:** 11 §2 (S2); 02 §3; 09 §9.3; 10 §3.1; ADR 0002; ADR 0016 · **Requirements:** R2, R10 · **Depends on:** none

As an integrating developer, I want the exact policy directives and Trusted Types policy names the component needs, per feature, so that I can embed it on a page with a strict security policy.

**Acceptance criteria**

- [x] Given a demo page whose policy has no unsafe keywords and enforces Trusted Types, when the web view, panes, PDF panel and math editor are loaded, then no violation is reported, or each one is listed with the feature that causes it.
- [x] Given a host page that itself uses Svelte 5 and restricts policy names, then the component, compiled with `fragments: "tree"`, loads without throwing.
- [x] Given ProseMirror's view assigns `style.cssText`, then its behaviour under the policy is recorded, and the nonce-carrying `<style>` fallback of 02 §3 is verified.
- [ ] Given a worker created from a `blob:` URL and a same-origin worker, in each supported browser, then the spike records where `'wasm-unsafe-eval'` must appear for a WebAssembly module to compile (the page's policy, the worker script's own policy, or both), and how Safari treats `blob:` workers under `worker-src` (ADR 0016).
- [x] Given WebAssembly is blocked, then the PDF panel's behaviour is recorded, since PDF.js ships optional WebAssembly decoders.
- [x] The list of directives and policy names a host must allow, per feature, is written for the integration guide.

**Evidence:** Spike report `docs/spikes/2026-11-06-s2-csp-trusted-types.md`; section 8 is the per-feature list for the integration guide. Tests in `packages/element/e2e/`: `s2-features.spec.ts` (web view, paste, a lazy pane, the PDF panel, KaTeX and MathLive under the strict baseline and under the guide's additions), `s2-svelte-host.spec.ts` (a Svelte 5 host with restricted policy names: the component built with `fragments: "tree"` loads, the `fragments: "html"` control does not), `s2-styles.spec.ts` (style probes, ProseMirror's `cssText` writes, the nonce `<style>` fallback), `s2-pdf.spec.ts` (PDF.js with WebAssembly allowed, blocked by the worker policy and switched off) and `s2-wasm.spec.ts`; the header-policy server and pages in `packages/element/demo/`. Final run on 2026-11-06: 43 S2 tests passed in each of Chromium 158, Edge 156, Firefox 159 and WebKit 27.2.

**Notes:** sized S in 11 §2; widened by ADR 0016. Criterion 4 stays open: the WebAssembly matrix (report §6) ran in Chromium 158, Edge 156, Firefox 159 and WebKit 27.2 on Windows, with the same result in all four ('wasm-unsafe-eval' in the page's policy for the page and `blob:` workers, in the worker script's own policy for a same-origin worker; WebKit applies `worker-src` to `blob:` like the others but sends no report for a refused compilation); Safari itself and the minimum versions of 02 §12 were not run. Criterion 1 holds with three policy names (`ProseMirrorClipboard`, `docedit-worker`, `docedit-math`) and one unsafe keyword, `style-src-attr 'unsafe-inline'`, which only the math editor needs (MathLive's markup). The PDF viewer's sandboxed cross-origin frame (09 §9.3, FE-071) was not built; the measurements describe PDF.js under the host's own policy. Lane w4 (2026-11-15): criterion 4 stays open and nothing new could be built for it here. It asks how Safari treats `blob:` workers under `worker-src`, in each supported browser; that needs Safari on macOS (and iOS) and the minimum versions of 02 §12, and this Windows host has neither. Playwright's WebKit build is not Safari, so its result in report §6 is an indication, not the record the criterion asks for. To close it, run `packages/element/e2e/s2-wasm.spec.ts` against the header-policy server in `packages/element/demo/` from Safari on a Mac and add the result to report §6.

### SPK-016 S3: correctness of the authority

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | L | must | Maintainer |

**Spec:** 11 §2 (S3); 04 §2, §5–§9; 07 §5.1; 12 §4.2 · **Requirements:** R3, R7, R13 · **Depends on:** none

As a maintainer, I want property tests and fuzzing that show the authority converges and never lets a user change a scope outside their writable set, so that the riskiest part of the design is proven before it is built on.

**Acceptance criteria**

- [x] Given random concurrent commits, reconnects and failed writes, when the property tests run, then all clients converge to the same document.
- [x] The tests cover rebase, acknowledgement, deduplication including commits still being stored, the durable and tentative states, fencing, and the grants-revision condition.
- [x] Given the outcome check of 07 §5.1 as the oracle, then no sequence of commits from a user changes a scope outside their writable set, for regions, suggestions and fills.
- [x] Given a fuzzer generating step sequences and envelopes, then no crash or stall is found in the agreed time box.
- [x] The harness is kept, because the phase 1a exit criteria run these property tests against the real service (11 §3).

**Evidence:** `docs/spikes/2026-11-06-s3-authority.md`. `packages/authority/test/convergence.property.test.ts` passes 3,000 random schedules with faults, failovers and lost notifications, checked against the independent oracle in `test/harness/oracle.ts`. `room.test.ts` covers each rule. `rebase.differential.test.ts` compares against prosemirror-collab. `fuzz.test.ts` ran 118,200 hostile submissions in 20 s without a crash or stall. The harness in `test/harness/` is kept; its storage is pluggable for the PostgreSQL run of SYN-047.

### SPK-017 S4: safe LaTeX compiles that report where lines and pages broke

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | L | must | Maintainer |

**Spec:** 11 §2 (S4); 09 §3.1, §7, §8, §9.3, §13; 10 §3.4 · **Requirements:** R5, R10, R11 · **Depends on:** SPK-003, FND-006

As a maintainer, I want a minimal converter and a sandboxed LuaLaTeX worker that produce a validated, tagged PDF and a layout report, so that the export pipeline's feasibility and cost are known.

**Acceptance criteria**

- [x] Given a generated bundle, when the sandboxed worker compiles it with a tagging-first class, then the PDF validates with veraPDF.
- [x] `layout.json` reports block-level page starts, and a report states how precise line-level offsets can be (09 §7.1).
- [x] Compile times with tagging on are measured on the shared corpus, including second and third passes.
- [x] Sandbox escape tests pass (09 §9.3; 10 §3.4).
- [x] The report records which luaotfload renderer the class uses and whether its HarfBuzz mode is viable, as input to S5 (ADR 0016).

**Evidence:** Spike result docs/spikes/2026-11-06-s4-latex-compile.md section 1. Criterion 1: veraPDF 1.30.3 (pinned image), PDF/UA-2 and PDF/A-4f with 0 failed checks at 1, 22 and 99 pages and for headings 1 to 9 (services/export-worker/scripts/measure.ts --validate; test services/export-worker/src/compile.e2e.test.ts). Criterion 2: every block has page and y, every page starts and opensWith; 3,073 of 3,074 line starts and all page starts match the PDF text (scripts/check-layout.ts; tests layout.test.ts and compile.e2e.test.ts; report section 5). Criterion 4: 14 of 14 in services/export-worker/src/sandbox.escape.test.ts (report section 6). Criterion 5: node mode in the class, HarfBuzz mode viable with identical breaks, ligatures extracted as U+FB01 (report section 7). Code: packages/export-latex/src/*, packages/export-latex/class/docedit.cls, services/export-worker/*. Criterion 3 (2026-11-06, packet X3): the shared corpus version 2 (fingerprint dd2dac5a) compiled with tagging on, exactly three passes, three runs each, in the Podman sandbox (image localhost/docedit-export-worker:s4, TeX Live 2026, one CPU and 1.5 GiB per job, WSL machine route) on the development desktop (Intel Core i9-10900KF, 128 GiB, Windows 11 Pro), while other agents ran tests on it. The reference worker of EXP-060 is not named yet; ADR 0037 names this desktop as the client reference machine only. Medians of passes 1, 2 and 3, and of the wall time: pages-1 (1 page) 5.47, 6.37, 7.91 s, 23.59 s; form-fields (1 page) 7.62, 6.94, 6.92 s, 24.25 s; pages-20 (19 pages) 16.00, 14.42, 19.63 s, 56.88 s; pages-100 (81 pages) 20.16, 28.71, 22.16 s, 75.06 s; all converged in three passes. Converter profile preview (a missing glyph is logged, not fatal; the image has no CJK font yet), which costs the same per pass. Command: node services/export-worker/scripts/measure.ts --corpus packages/corpus/out --docs pages-1,form-fields,pages-20,pages-100 --runs 3 --env podman --tagging on --passes 3 --profile preview --wall 300 --validate; results in services/export-worker/out/measure/corpus-v2/ (not under version control); ADR 0045. pages-300 and pages-1000 were not measured.

**Notes:** criterion 3 was first left open, because the shared corpus (FND-006) was not ready when the spike started and it measured its own 1-, 22- and 99-page documents; packet X3 measured the corpus (version 2) on 2026-11-06 (Evidence). The figures were taken on a busy machine and are higher and more spread than S4's on an idle one; repeat them on the reference worker once it is named. Choices the spike made where 09 is silent (layout units, `opensWith`, cascade step 1, `widowControl` null meaning on) and the spec gaps it found (`luacolor` missing from 09's package list, the `url` emitter rule, no units in 09 §7.1) are in its report, sections 5 and 8, for an ADR or a spec change. During the earlier session, before the owner asked for Podman, the spike started Docker Desktop once; its backend failed to start and it was stopped; no Docker command has run since.

### SPK-018 S5: how to measure text for the page view

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | should | Maintainer |

**Spec:** 11 §2 (S5); 02 §6, §9.3; ADR 0005; ADR 0016; review F9 · **Requirements:** R1, R12 · **Depends on:** FND-006, FND-007

As a maintainer, I want to know whether canvas measurement or shaping from the font files gives line widths that match painted text, so that the layout engine starts on the right base.

**Acceptance criteria**

- [x] Given the shared corpus, when the harness runs in each supported browser, then it reports the distribution of differences between computed and painted line widths for canvas `measureText`.
- [x] Given the manifest's font files, then the same report is produced for two WebAssembly shapers: HarfBuzz's own build (harfbuzzjs) and HarfRust compiled to WebAssembly.
- [x] For each WebAssembly shaper, the spike reports compressed size, compile and instantiate time on the reference machine, memory with a Latin face and with a CJK face, and whether results are identical across the four browsers and Node.js.
- [x] It reports whether the painter can render the shaper's ligature and kerning choices within the half-pixel tolerance of 02 §9.3.
- [x] A written decision chooses canvas or font-file measurement and names the fallback when the host blocks WebAssembly (SPK-015).

**Evidence:** [The S5 report](../spikes/2026-11-06-s5-text-measurement.md). `packages/perf`: `e2e/s5.spec.ts` with `pages/s5.html`, `src/browser/s5-page.ts`, `src/s5.ts` and `src/lines.ts`; the shapers in `src/shapers/` (harfbuzzjs 1.6.1, and HarfRust 0.15.0 built from `wasm/text-kernel/` by `scripts/build-wasm.ts`, crates checked against the licence policy by `scripts/cargo-licences.ts`); fonts in `fonts/manifest.json` (Noto from TeX Live 2025 and Harano Aji Gothic, all OFL-1.1, with version and SHA-256, checked by `test/fonts.test.ts`). Run on 2026-11-06 on the reference machine of ADR 0037 with `pnpm exec playwright test -c packages/perf/playwright.config.ts s5 --project=chromium --project=msedge --project=firefox --project=webkit` in Chromium 158, Edge 156, Firefox 159 and WebKit 27.2 on 2,361 lines of corpus version 2. Canvas came within 0.5 px of painted width on 99.66 % of lines in Chromium and Edge, 99.79 % in WebKit and 40.58 % in Firefox. harfbuzzjs came within 0.30 px on every Latin line in all four engines. HarfRust equals harfbuzzjs glyph for glyph, and both shapers' digests are equal in the four engines and in Node.js (also `test/shapers.test.ts`). Sizes, compile and instantiate times and memory with the Latin and CJK faces are in report §3.5; ligatures and kerning in §3.4. Decision: measure from the font files; without WebAssembly, canvas in Chromium, Edge and WebKit and the web view in Firefox.

**Notes:** widened by ADR 0016 to compare two shapers. If font files win, S10 (SPK-023) follows.

- **S5 chose font files,** so S10 followed ([S10 report](../spikes/2026-11-06-s10-text-kernel.md)).
- **WebKit stands in for Safari.** It ran as Playwright's Windows build until the macOS job of CI runs.
- **CJK.** CJK text (28 lines) differs between engines in ways that CSS defaults do not settle (report §3.2). It needs its own page-view story (02 §11).
- **Not measured.** Korean and simplified Chinese: no face with an allowed licence was on the machine. NanumGothic was refused because its name table does not state the OFL.
- **Input from S4.** In luaotfload's HarfBuzz mode the breaks equal node mode's, and ligatures extract as presentation forms (report, "Input from S4").

### SPK-019 S6: can someone else implement the protocol?

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | must | Integrating developer |

**Spec:** 11 §2 (S6); 05 §8.3, §11; 03 §2 · **Requirements:** R6 · **Depends on:** FND-001

As an integrating developer, I want machine-readable protocol definitions and a mock backend that passes contract tests, so that I can trust DEP to be implementable without reading the reference code.

**Acceptance criteria**

- [x] AsyncAPI for the real-time plane, OpenAPI for the control plane, and JSON Schema for the CDM and webhook bodies are generated and stored in `spec/`.
- [x] The backend port typings are complete.
- [x] The mock backend passes the port contract tests.
- [x] A smoke suite for the `core` profile runs against the reference service.
- [x] Gaps between the prose of 03 to 05 and the generated definitions are listed and fed back into the spec.

**Evidence:** `spec/dep/` (AsyncAPI 3.0, OpenAPI 3.1, JSON Schema bundle, 35 webhook schemas, registry, gaps, manifest that references `spec/cdm/cdm-1.schema.json` unchanged), generated by `packages/protocol/scripts/generate.ts` from `packages/protocol/src/definition/`; checked by `packages/protocol/test/artifacts.test.ts`, `schemas.test.ts`, `prose.test.ts`, `definition.test.ts`. Port typings in `packages/protocol/src/ports/` (core and all twelve optional ports, host callbacks), checked by `packages/protocol/test/ports.test.ts`. `packages/backend-mock` (real `Room` over an in-memory log) passes the reusable suite `packages/protocol/src/contract/` in `packages/backend-mock/test/contract.test.ts` (36 cases run and pass, 11 optional-port cases skipped with their reason). Gaps: 103 listed (4 resolved by the spec revision of 2026-11-06) in `spec/dep/dep-1.gaps.json` and [the S6 report](../spikes/2026-11-06-s6-protocol.md) §4, kept equal by `packages/protocol/test/report.test.ts`, and taken up by the second review. Smoke suite against the reference service (criterion 4): `packages/backend-dep/test/service.test.ts`, "smoke suite for the core profile": the five scenarios of `packages/protocol/src/contract/smoke-core.ts` (`core.conversation`, `core.convergence`, `core.reconnect`, `core.reset`, `core.revocation`) pass through `backend-dep` against `services/document-service` started in process on an ephemeral port with its in-memory parts; the write hold that `core.reconnect` needs is a wrapper round the service's in-memory log in the test (`holdableLogs`); S6 report §7.

**Notes:** Second review (2026-11-06, SPK-027): gaps G19, G37, G39 and G40 are settled in the spec. Decision D09 does not stand: a base older than a snapshot commit gets `stale_base` with action `rebase` (04 §3.2 as edited; SR-K1), so the definition data and SYN-005 change. D01 makes the error `code` a closed enumeration, which would stop a minor version adding a code (SR-N64). The review recommends the other decisions for the prose ([review](../review/2026-11-06-second-review.md) §8). S6 has since followed the revision: G19, G37, G39 and G40 are marked resolved, D09 is withdrawn, and the mock and the contract suite expect `stale_base` with action `rebase`; D01 is unchanged until SR-N64 is decided (receivers could instead treat codes as an open vocabulary, since `action`, `retryable` and `fatal` already say what to do). The protocol findings of spike S12 (ADR 0019) are folded in as an optional `view` on `ch.opened` and `resume` (D28) and as gaps G101 to G103. The smoke suite for `core` (`packages/protocol/src/contract/smoke-core.ts`, five scenarios through the ports) passes against `backend-mock`; it stayed unticked until it ran against the reference service, which needed BE-001 and `backend-dep` (PRO-093 to PRO-095). 2026-11-15: it now runs there and all five scenarios pass. `core.conversation`, `core.convergence` and `core.reset` were skipped as pending in `packages/backend-dep/test/service.test.ts` for reasons traced on 2026-11-06 that the service no longer has, so they were taken off the pending list; the port-contract cases on that list were left as they are (PRO lane). The write-hold hook added to that harness also lets the contract case `channel.reject.retry` run, and it passes. Limits: the service runs on its in-memory parts, not PostgreSQL, and in the test's process; the dependency FND-001 still has open criteria of its own (fresh-clone setup, Node.js target of services), which no criterion here needs.

### SPK-020 S7: adopt, fork or build the layout core

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | should | Maintainer |

**Spec:** 11 §2 (S7), §9 risks 1 and 10; 02 §9.1; ADR 0005; ADR 0016; research summary · **Requirements:** R1 · **Depends on:** SPK-026

As a maintainer, I want to know whether an existing permissively licensed layout core can be driven from CDM flow blocks, so that the project does not write a layout engine it could fork.

**Acceptance criteria**

- [x] Given the candidates from the research (Eigenpal's Apache-2.0 core, canvas-editor and Docen) and the Rust candidates of ADR 0016 (Typst's layout crates, Parley, cosmic-text), when each is assessed, then provenance, licence and maintenance are recorded; Eigenpal's repository was deleted and re-created in mid 2026.
- [x] At least the leading candidate is driven from CDM flow blocks in a prototype; the others are assessed on paper with reasons.
- [x] For each candidate, the spike records how it shapes and measures text and whether its measurement can be injected (02 §9.1).
- [x] Copyleft projects are read for ideas only (risk 10).
- [x] The recommendation is adopt, fork or build, with evidence, expecting to fork.

**Evidence:** `docs/spikes/2026-11-06-s7-layout-core.md` records each candidate in its §2, from the registry, the repository and the npm tarballs. In `packages/layout` (`@docedit/layout`, universal), both leading candidates are driven from CDM flow blocks. `src/flow.ts` converts CDM to flow blocks, and `src/measure.ts` holds the injected measurer and its stubs. `src/docen.ts` drives Docen's core; `src/ooxml.ts` and `src/eigenpal.ts` drive Eigenpal's through a WordprocessingML projection. `src/tree.ts` is the layout tree. `src/layout.universal.test.ts` lays out five documents with two stubs, with no coverage gaps. It reproduces the Node.js results in Chromium, Firefox and WebKit for Eigenpal in all ten cases and for Docen in nine of ten; the tenth is a DOM probe in Docen's measurement. `src/canvas.universal.test.ts` injects a canvas measurer in the three browsers. `src/flow.test.ts` covers the conversion. `test/benchmark.test.ts` (opt-in) gives the timings and call counts. No copyleft project was a candidate or was opened. Recommendation: fork Docen's block and flow layers (MIT) and build the text layer; neither adopt nor fork Eigenpal.

**Notes:** questions the spike raised for other stories, none decided here (report §7):
- how 03 §6 orders the default paragraph style against a table style, and numbering indents against style indents (CDM);
- whether runs of spaces collapse, as in TeX and Docen, or stay, as in Word, the web view and Eigenpal (CDM, EXP);
- `differentOddEven` is per page setup in the CDM but document-wide in Word (EXP).

For the licence gate (FND-011): `@docen/*` (MIT), and the unidentified BSD-3-Clause part of `@chenglou/pretext` if any of it is kept. `@docx-editor.dev/core` 2.35.0 and its dependencies are spike-only dependencies of `packages/layout`. Any further use, even test-only, waits for counsel on the provenance of Eigenpal's repository (legal note §7). S10 (SPK-023) inputs are in report §6.

### SPK-021 S8: seal a tagged PDF with a managed key and a time-stamp

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | S | should | Relying party |

**Spec:** 11 §2 (S8); 12 §8.2; ADR 0013 · **Requirements:** R13 · **Depends on:** SPK-017, SPK-011

As a relying party, I want a sealed sample PDF that validates, so that the final-PDF design is known to work before the workflow is built.

**Acceptance criteria**

- [ ] Given a tagged LuaLaTeX PDF, when it is sealed with a key held in a key service and given an RFC 3161 time-stamp, then the seal validates in Acrobat.
- [ ] The long-term validation profile is chosen (PAdES baseline B-LT or B-LTA, 12 §8.2) and the reason recorded.
- [ ] The key never leaves the key service and is never present on a compile worker.
- [ ] Tagging survives sealing: the sealed PDF still validates with veraPDF.

**Notes:** Second review (2026-11-06, SPK-027), SR-K8: the review recommends that phase 2 seals at B-LT, with the validation data collected at sealing, and that B-LTA archive time-stamps and their renewal come in phase 4. The owner decides; this spike records the evidence ([review](../review/2026-11-06-second-review.md)). 2026-11-15, lane w4: blocked, nothing ticked and nothing built. What exists here: the tagged PDFs of S4 (SPK-017) with veraPDF 1.30.3 as a pinned container image, Podman, OpenSSL, and Acrobat 25.1 on the development machine. What does not: (1) the sealing party (SPK-011 is undecided, [ADR 0361](../adr/0361-w4-SPK-011-first-jurisdictions-and-sealing-party.md)), so there is no certificate of the right party, and a self-made certificate would show in Acrobat as untrusted unless Acrobat's trust settings were changed by hand; (2) a key service: none is configured, and a key file on the worker would break the third criterion; (3) a time-stamping authority: none is chosen (legal note §5.4 leaves it to this spike), and it is an external service; (4) code that writes a PAdES signature with the hash signed remotely: no package of the workspace does this, and this run may not add a dependency or an image. The first, third and fourth criteria need all of these and a person reading Acrobat's signature panel; a mock of any of them would not meet them. The second is the owner's choice between B-LT and B-LTA (SR-K8 recommends B-LT in phase 2 and B-LTA in phase 4); it is left unticked, not decided here. To unblock: the owner's answer to SPK-011, a test certificate chain for that party, a key service for the spike (an HSM emulator or a key service in a Podman container would do), a named time-stamping authority, and leave to add a signing tool.

### SPK-022 S9: the page view's input bridge and screen-reader plan

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | cond | L | must | Maintainer |

**Spec:** 11 §2 (S9), §9 risk 3; 02 §9.6, §10; ADR 0005 · **Requirements:** R1, R11 · **Depends on:** SPK-013, SPK-014

As a maintainer, I want a prototype input bridge and a tested screen-reader plan for painted pages, so that the page view is not committed to before its hardest problem has a working answer.

**Acceptance criteria**

- [ ] Given a prototype bridge that is a small projection of the current block, story or footnote with its steps mapped onto the document, when composition input runs, then input-method windows appear at the caret in every supported browser.
- [ ] Navigation by line, page, Home and End is driven from the layout tree, not the DOM.
- [ ] A screen-reader plan is tested with at least one screen reader per platform and records what is read and how editing works.
- [ ] The EditContext API is evaluated as an option and not assumed (02 §9.6).
- [ ] Browser find-in-page behaviour in the page view is recorded.

**Notes:** listed in phase 0 by 11 §2 but run only if the page view goes ahead (SPK-013).

### SPK-023 S10: text kernel in TypeScript or in Rust compiled to WebAssembly

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | could | Maintainer |

**Spec:** ADR 0016; Rust and WebAssembly assessment §4; 02 §9.3, §9.5; 13 §9 · **Requirements:** R1, R12 · **Depends on:** SPK-018, SPK-020, FND-006, FND-007

As a maintainer, I want measured evidence on where the boundary of the page view's text kernel should be and in which language, so that Rust is added only if it pays for itself.

**Acceptance criteria**

- [x] Given S5 chose canvas measurement, when S10 starts, then it closes with a short note and no prototypes.
- [x] Given S5 chose font-file measurement, then two prototypes are built behind the same measurement interface: harfbuzzjs with segmentation and first-fit line breaking in TypeScript; and one Rust module with HarfRust, UAX #14 segmentation, first-fit line breaking (02 §9.3) and TeX-pattern hyphenation.
- [x] Before measuring, the spike writes down the share of the 16 ms typing budget the kernel may use; then it measures, on the reference machine and inside a worker with realistic message passing, the kernel time per keystroke in a 100-page document and background pagination of 1,000 pages (13 §9 targets).
- [x] It reports cold start (fetch, compile, instantiate), compressed size, memory, and whether outputs are identical across the four browsers and Node.js.
- [x] It reports the engineering cost of each: code size, build and CI time, and skills needed (roadmap §8; risk 13).
- [x] The recommendation names the kernel, its boundary and its fallback when WebAssembly is blocked, and ADR 0016 is updated.

**Evidence:** [The S10 report](../spikes/2026-11-06-s10-text-kernel.md). (1) This branch did not apply: S5 chose font-file measurement. (2) `packages/perf/src/kernel/`: `ts-kernel.ts` (harfbuzzjs 1.6.1, `linebreak` 1.1.0, first-fit in TypeScript) and `rust-kernel.ts` over `wasm/text-kernel/` (HarfRust 0.15.0, `unicode-linebreak` 0.1.5, first-fit, `hypher` 0.1.8 English), both behind `types.ts` (the S7 `TextMeasurer` plus `breakParagraph`); `test/kernel.test.ts`. (3) The budget, a quarter of each typing target (4 ms median, 12.5 ms 95th percentile), is written in `e2e/s10.spec.ts` and report §2. Measured on 2026-11-06 on the reference machine of ADR 0037 in a layout worker (`src/browser/kernel-worker.ts`, `s10-page.ts`) with `pnpm exec playwright test -c packages/perf/playwright.config.ts s10 --project=reference` (three passes): per keystroke in `pages-100`, 0.015 to 0.025 ms at the median and at most 0.31 ms at the 95th percentile for either kernel; a cold pass over `pages-1000` in 183 to 326 ms. (4) Cold start, sizes (`scripts/kernel-sizes.ts`: 197,592 against 422,858 bytes gzip) and memory are in report §3.3. Both kernels gave identical breaks and widths in Chromium, Edge, Firefox, WebKit and Node.js (§3.4). (5) Code, dependencies, build, CI and skills are in §3.5. (6) Recommendation: harfbuzzjs with line breaking in TypeScript, per paragraph in the layout worker, with canvas as the fallback in Chromium, Edge and WebKit and the web view in Firefox; ADR 0016 has its "Result of S10".

**Notes:** new with ADR 0016. It informs how to build the page view, not whether, so it may move to the start of phase 3 if the gate (SPK-013) looks unlikely to pass.

- **Ran in phase 0 (2026-11-06).** S5 chose font files, so this branch ran.
- **Decisions the spike took for itself.** The kernel's share of the typing budget (a quarter of each target) is S10's allocation, not the spec's; FE-088 and FE-089 may move it. The first-fit details are in report §4.
- **Not measured.** The TypeScript kernel's cache lives in the JavaScript heap, which was not measured. Korean text was timed with the CJK face's missing glyph. The machine was shared during the runs, so times are ranges over passes.
- **For other stories.** Condition C-RUST of the WASM epic does not hold. The batch size of background pagination matters (report §6, item 4; FE-089).

### SPK-028 S11: prove lossless DOCX round-trip on real Word files

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | must | Maintainer |

**Spec:** ADR 0017; 00 §5 (A2); 03 §4.6; 09 §11, §12 · **Requirements:** R5 · **Depends on:** none

As a maintainer, I want evidence that the preservation layer round-trips real Word files without loss, so that the model is not frozen on a design that cannot meet the owner's requirement.

**Acceptance criteria**

- [x] Given a corpus of real Word files with their licences recorded, covering text boxes, shapes, charts, SmartArt, embedded objects, nested tables, content controls, tracked changes, comments, complex fields, Office math and several sections, when a prototype imports each file with the preservation layer and exports it without an edit, then every part is byte-identical (R0 of ADR 0017), or each failure is listed with its cause.
- [x] Given scripted edits (typing in a paragraph, splitting it, deleting a block, changing its style, moving a preserved atom), when each edited file is exported, then parts and elements outside the edits are unchanged and edited elements keep their unknown properties (R1), measured per file.
- [x] Given each exported file, when it is opened in Word and in LibreOffice, then neither shows a repair prompt (target).
- [x] The spike reports the share of imported nodes that carry preserved data, the size overhead of imported documents and of their first 1,000 commits, and import and export times on the reference machine.
- [x] The spike settles the open questions of ADR 0017 that block `cdm: 1`: inline atoms without identifiers, the grammar and size limits of element trees, and the elements dropped on purpose because Word regenerates them.
- [x] The written result confirms ADR 0017 or names the changes it needs, and CDM-051 is updated before `cdm: 1` is frozen.

**Evidence:** [S11 report](../spikes/2026-11-06-s11-lossless-docx.md). Prototype in `packages/export-docx` (importer `src/import.ts`, writer `src/export.ts`, lenses `src/props.ts`, checks `src/conformance.ts`, edits `src/edits.ts`); corpus of 78 files with origin, licence and hash in `packages/export-docx/corpus/SOURCES.md`. R0: `test/roundtrip.test.ts`, 78 of 78 files byte-identical in every part, each document valid with `preserve` in `requires`. R1: `test/edits.test.ts`, all 263 applicable scripted edits pass and every file passes with every paragraph regenerated; per-file table in the report. Questions settled: report §"Open questions of ADR 0017", with the tree measurements of `test/measure.test.ts`. Word: `scripts/word-open-check.ps1`, 492 of 497 originals and exports open without a prompt in Word 16.0.20527; the 5 others come from `poi/deep-table-cell.docx`, whose original prompts too. LibreOffice (2026-11-17, LibreOffice 26.8.3.1, `C:\Program Files\LibreOffice\program\soffice.exe`): `scripts/libreoffice-open-check.ps1` converts each file to PDF headless; 505 of 511 files load (the 497 of the Word check and 14 from the patch cases); the 6 that do not are `docx4j/2010-mcAlternateContent.docx` and its 5 exports, and the original does not load alone either ("source file could not be loaded"), so no export is worse than its original. Calibration: a document with malformed XML does not load; a file that is not a package loads as text, so this check does not catch that case. Report §"Opening in Word and LibreOffice". Measurements (criterion 4): report §"On the reference machine (2026-11-15)", from `packages/export-docx/test/measure.test.ts` run on `reference-1` of ADR 0037 (proposed), which is the spike machine; 68 % of non-text nodes carry preserved data, the CDM is 2.3 times larger with preservation, the step payloads of 1,000 simulated commits per file are 35 % larger, import takes 24 ms and export 10 ms for the median file, with four other worktrees busy on the machine. Result and CDM-051 (criterion 6): report §"Changes the model needs" and §"State of these changes on 2026-11-15"; ADR 0017 §"Changes from spike S11"; CDM-051's second criterion and Evidence state the S11 limits, tested by `packages/model/src/validate/validate.test.ts` ("preserved content (CDM-051)") and `packages/model/src/validate/preserve.test.ts`.

**Notes:** new with the owner's decision on A2 (2026-11-06). Third criterion (2026-11-17): met. LibreOffice 26.8.3.1 is now installed at `C:\Program Files\LibreOffice\program\soffice.exe`, and the exports were opened in it (see Evidence). It is read as "the exports are not worse than their originals": the one file that LibreOffice does not load, `docx4j/2010-mcAlternateContent.docx`, does not load as an original, and the one file Word prompts on, `poi/deep-table-cell.docx`, prompts as an original. LibreOffice has no repair prompt for .docx in headless mode, so "loaded" stands for "no prompt" and a silent repair is not seen; Word was checked with alerts on and is the stronger check. The file `docx4j/2010-mcAlternateContent.docx` is a candidate for a bug report to LibreOffice, not for a change here. The sixth was met on 2026-11-15: the report names the changes, the model definition and 03 carry model changes 1 to 4 and 7 (report §"State of these changes on 2026-11-15"), ADR 0017 and ADR 0018 state the S11 limits, and the CDM lane has updated CDM-051 (seen after the merge of 2026-11-15); `cdm: 1` is still a draft. Limits of the fourth criterion's measurement: the commits are simulated step payloads, not a replay through the authority; the reference machine of ADR 0037 is a proposal the owner has not confirmed; the times were taken while other work ran on the machine. Earlier state (2026-11-06): the fourth was measured before the reference machine was named, and CDM-051 was still to take model changes 1 to 4 of the report before `cdm: 1` is frozen. Of the second review's corpus additions listed at the end of this note, the prototype covers deleted commented paragraphs, theme colours and values the CDM rounds (lens rules), pictures in edited paragraphs, data-bound and legacy forms (round trip only, not filling), endnotes, and records the canonical-form version for migrations; it does not yet cover a confidential region, forged preserved data, a renamed heading behind a contents field, a numbering change, every revision kind, multi-paragraph footnotes or a migration. Production work follows in CDM-051, EXP-116 to EXP-120 and FE-139. Which parser the prototype builds on overlaps with EXP-097; the spike may use the candidate EXP-097 favours, or the borrow list (SPK-026). Second review (2026-11-06, SPK-027): add to the corpus and the scripted edits a document with a confidential region (SR-C1), forged preserved data (SR-C2), equations and pictures in edited paragraphs (SR-M10), a renamed heading that a contents field or a cross-reference uses, a deleted commented paragraph and a numbering change (SR-M11), theme colours and values the CDM rounds (SR-M12), each revision kind (SR-M14), Word forms with data binding (SR-M15), footnotes of several paragraphs and endnotes (SR-M16), and a CDM migration (SR-M19). R1 needs a block-level granularity and a named canonicalisation (SR-M13) ([review](../review/2026-11-06-second-review.md)).

### SPK-029 S12: hide regions and field values from some readers by projection

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | must | Maintainer |

**Spec:** ADR 0019; 07 §1, §8, §17; 12 §3.2; 04 §5, §9, §11, §13 · **Requirements:** R3, R4, R7, R13 · **Depends on:** SPK-005, SPK-016

As a maintainer, I want evidence that per-reader projections of the one log hide what they must without breaking sync, so that read restrictions are built on a design that holds before phase 1b.

**Acceptance criteria**

- [x] Given the S3 simulation extended with readers of different visibility (confidential regions, sensitive values), when it runs with the same faults as S3, then every client converges to the projection of the head for its visibility class.
- [x] Given an oracle that scans every message, checkpoint and content read sent to a reader, then no hidden text, title (when hidden) or value ever reaches a reader without access, whatever the commits and faults.
- [x] Given a reader's commit in projected positions, when the room maps it to the full document, then it passes or fails steps 5 to 7 of 04 §5 exactly as an equivalent commit made on the full document would, and a slice that contains a hidden atom is refused.
- [x] Given grants that hide or reveal a region for a connected reader, when they change, then the reader receives the new projection (in S12: the channel closes and the next open is a forced reload; ADR 0019, change 2) and unconfirmed work that no longer applies goes to recovered edits.
- [x] Given documents of the shared corpus (FND-006), when projections and diff steps are computed per commit, then their cost per visibility class is measured on the reference machine.
- [x] The written result confirms ADR 0019 or names the changes it needs, settles its open questions where evidence allows, and lists the stories to add or change in PRM, SYN, PRO, BE, HIS, EXP, FRW, FE and UX so that no story assumes readers see the whole document.

**Evidence:** Spike result docs/spikes/2026-11-06-s12-read-restrictions.md. Criteria 1, 2 and 4: packages/authority/test/projection.property.test.ts (1,000 schedules with the S3 faults; leak oracle on every outgoing message, including the content of every ch.opened; convergence to the projection for each view; access changes close the channel and force a reload, unconfirmed work counted in recovered edits), harness packages/authority/test/harness/projection-sim.ts. Criterion 3: packages/authority/test/projection.differential.test.ts (the same edit through the gateway and on the full document gets the same verdict; edits touching a placeholder or a hidden value are refused) and packages/authority/test/projection.test.ts. Code: packages/authority/src/projection/projection.ts, gateway.ts. Criterion 6: the S12 report's Changes ADR 0019 needs, Open questions and Stories to add or change sections; ADR 0019's section Changes from spike S12; the 17 new stories CDM-053, PRM-066, PRM-067, SYN-050 to SYN-053, PRO-130, PRO-131, BE-098, HIS-046, EXP-123, FRW-088, FRW-089, FE-141, UX-104 and SEC-064; rule 8 of docs/stories/README.md for the existing stories listed in the report. Criterion 5: the S12 report's section "On the reference machine (2026-11-15)", from `node packages/authority/scripts/projection-cost.ts 300 1` on `reference-1` of ADR 0037 (proposed), corpus `docedit-corpus 2`, two classes per document; at 1,000 pages a class costs 0.073 ms (half hidden) and 0.165 ms (all hidden) per commit at the median with mapped steps, 2.073 ms and 3.005 ms with projection and diff, and 123 ms and 107 ms for a cold projection, with other worktrees busy on the machine.

**Notes:** new with the owner's decision on SPK-005 (2026-11-06). The leaks ADR 0019 accepts (existence and position of a hidden region; timing of commits that change only hidden content) are measured and reported, not removed, unless the owner asks for that. Criterion 5 (2026-11-15): measured again once ADR 0037 named the reference machine, which is the development machine. Its limits: ADR 0037 is a proposal the owner has not confirmed; one run, taken while other work ran on the machine; the workload is single-character typing, so no commit took the diff fallback, and structural commits and catch-up are unmeasured (SR-M7). Second review (2026-11-06, SPK-027): the leak oracle should also cover DOCX exports, the original Word file, the source map and fragments (SR-C1); values derived from hidden content, such as `field.cached`, labels, rule verdicts and formulas (SR-C3); asset reads, export jobs and caches (SR-C4); and metadata such as authors of hidden-only commits and region titles (SR-M4). The diff-step fallback still drops readers' concurrent edits between two changes (SR-M1), and the cost of projected catch-up and per-class previews is unmeasured (SR-M7) ([review](../review/2026-11-06-second-review.md)).

## Notes

### SPK-024 Legal note

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | must | Project owner |

**Spec:** 11 §2 (notes), §9 risks 10 and 15; 00 §10; 02 §6; 12 §8.3; PRODUCT.md (Brand commitments) · **Requirements:** R5, R13 · **Depends on:** none

As the project owner, I want a legal note on names, licences, fonts and signature claims, so that the project avoids obligations and claims it cannot meet.

**Acceptance criteria**

- [x] The note covers the project's name and ordinary trademark care in marketing; "compatible with" a Microsoft format is the only permitted reference to Microsoft products.
- [x] It covers the licences inside the pinned TeX Live image and the licence of the house class.
- [x] It covers fonts: bundling and server use, and that fonts under the Open Font License with reserved names are not subsetted under their own name (02 §6).
- [x] It covers e-signature claims: the product never says "qualified", "legally binding everywhere" or similar (12 §8.3).
- [x] It recommends the project licence, with Apache-2.0 recommended for its patent grant, and states that counsel reviews signing claims before launch.

**Evidence:** `docs/research/2026-11-06-legal-note.md`, criterion map in its section 8. Counsel's review itself is FRW-087.

### SPK-025 Unit-cost sheet

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | S | should | Operator |

**Spec:** 11 §2 (notes), §9 risk 7; 06 §10; review §6 · **Requirements:** R9 · **Depends on:** none

As an operator, I want a sheet that estimates the unit costs of running the document service, so that pricing, quotas and the hosted-or-self-hosted decision rest on numbers.

**Acceptance criteria**

- [x] The sheet estimates the cost per open document hour, per stored commit, per gigabyte-month of checkpoints and assets, per preview compile and per final export (06 §10).
- [x] Every input is marked as measured or assumed; assumptions name the story that will measure them.
- [x] It lists the inputs the review found the spec could only estimate: compile cost with tagging, memory per open document, log volume and admission-control budgets (review §6).
- [x] Preview compiles are costed only while someone is looking at a view that needs them (09 §9.1).

**Evidence:** `docs/research/2026-11-06-unit-cost-sheet.md`, criterion map in its section 10; Azure prices measured 2026-11-06, every product input assumed and tied to the story that will measure it.

### SPK-026 Borrow list with licences checked

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | must | Maintainer |

**Spec:** 11 §1 principle 3, §2 (notes), §9 risk 10; ADR 0016; Rust and WebAssembly assessment §6 · **Requirements:** R6 · **Depends on:** none

As a maintainer, I want a list of the components the project will borrow, each with its licence checked, so that nothing non-differentiating is built from scratch and nothing copyleft slips in.

**Acceptance criteria**

- [x] The list covers collaboration rebase, suggestion marks, DOCX parsing and writing, PDF viewing, math display and editing, spellcheck, PDF sealing, the layout core candidates of S7, and the WebAssembly candidates of the assessment (HarfRust, harfbuzzjs, ICU4X, unicode-linebreak, hypher).
- [x] Each entry records licence, version, maintenance status and provenance.
- [x] Hyphenation patterns are listed per language with their own licences.
- [x] Copyleft projects appear only as "read for ideas", never as dependencies.
- [x] The list feeds the licence gate (FND-011).

**Evidence:** `docs/research/2026-11-06-borrow-list.md`, criterion map in its section 16; the allow-, conditional and deny-lists for FND-011 are in its section 15.

### SPK-027 Second review of the specification

| Type | Phase | Size | Priority | Persona |
|---|---|---|---|---|
| spike | 0 | M | should | Project owner |

**Spec:** README (What is not here yet); review §1 (caveat), §6 · **Requirements:** all · **Depends on:** SPK-001, SPK-002, SPK-004, SPK-006, SPK-010

As the project owner, I want an independent second review of draft 0.2 after my decisions, so that the changes made after the first review are themselves checked before phase 1.

**Acceptance criteria**

- [x] Given the decisions of SPK-001, SPK-002, SPK-004, SPK-006 and SPK-010, when the review runs, then it covers every spec document and ADR 0001 to 0016.
- [x] Findings and dispositions are recorded in `docs/review/` in the same form as the first review.
- [x] Every finding that changes scope is reflected in the affected epics before phase 1a starts.

**Evidence:** `docs/review/2026-11-06-second-review.md`. Criterion 1: section 1 (spec 00 to 13, ADRs 0001 to 0020, PRODUCT.md, the S3, S6 and S12 results and the research notes of 2026-11-06, read against the decisions of 2026-11-06). Criterion 2: sections 3 and 4 give 111 findings (4 critical, 38 major, 69 minor) with identifier, place, problem, reason and disposition, as tables like the first review's; section 5 checks the 50 items of the findings note; section 6 lists the 37 local edits to the spec. Criterion 3: section 7 lists the notes added to 79 stories in 12 epics, and which finding each reflects.

**Notes:** The criterion names ADRs 0001 to 0016; the review also covers 0017 to 0020, which appeared on 2026-11-06. Three findings change the roadmap rather than a story and wait for the owner: SR-M2, SR-M8 and SR-M21. Edits proposed outside the specification (ADR 0010, ADR 0005, ADR 0019, PRODUCT.md, SPK-002) are listed in section 6 of the review and were not made.

## Coverage

| Roadmap section | Stories |
|---|---|
| §1 Sequencing principles | none: informative; principle 3 → SPK-026; principle 4 → SPK-013 |
| §2 Phase 0 decisions | SPK-001, SPK-002, SPK-004, SPK-006, SPK-010 |
| §2 Spikes S1 to S9 | SPK-014 to SPK-022 |
| §2 Spike S11 (added 2026-11-06 with the A2 decision) | SPK-028 |
| §2 Spike S12 (added 2026-11-06 with the SPK-005 decision) | SPK-029 |
| §2 Notes | SPK-024, SPK-025, SPK-026 |
| §3 to §7 Phases 1a to 4 | none: owned by the epics, phased per story |
| §8 Skills needed | none: informative; considered in SPK-023 |
| §9 Risk register | see the table below |
| §10 Decisions needed | SPK-001 to SPK-013 |
| ADR 0016 (new) | SPK-015, SPK-017, SPK-018, SPK-020, SPK-023, SPK-026 |

| Risk (11 §9) | Stories that reduce it |
|---|---|
| 1 Page view takes far longer | SPK-013, SPK-020, SPK-022, SPK-023 |
| 3 Input bridge fails | SPK-022 |
| 4 Authority bugs | SPK-016 |
| 5 Server must run the document model | SPK-009, SPK-019 |
| 7 LaTeX compile cost | SPK-017, SPK-025 |
| 8 LaTeX injection or sandbox escape | SPK-017 |
| 9 ProseMirror too limiting | SPK-014 |
| 10 Licence problems | SPK-024, SPK-026 |
| 12 Scope creep | SPK-002, SPK-006 |
| 13 Very small team | SPK-023 (skills), SPK-026 (borrowing) |
| 15 Over-claiming signatures | SPK-024 |

## Open questions

- Whether S10 (SPK-023) runs in phase 0 or at the start of phase 3 depends on how likely the page view looks; the owner's view after SPK-006 helps.
- S9 (SPK-022) is listed in phase 0 by the roadmap but runs only if the page view goes ahead.
