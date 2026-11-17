# 11 Roadmap

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Informative. Sizes are relative (S, M, L, XL), not calendar estimates; calendar estimates need a team size.

## 1. Sequencing principles

1. **Prove the differentiators first.** What nobody else offers is the combination of enforced permissions on parts of a document, fillable fields with rules, attributable history, and LaTeX output, behind a protocol. Pagination is something every competitor already has. The differentiators come first, on a conventional editing surface with an authoritative PDF.
2. **The first phase must be small enough for one person to finish.** The review found the original first phase to be most of the product. It is now split into a minimum demo (1a) and a first usable release (1b).
3. **Buy or borrow what is not a differentiator.** Collaboration rebase, suggestion marks, DOCX parsing and writing, PDF viewing, math editing, spellcheck, PDF sealing and, if a spike supports it, a page-layout core all have usable components under permissive licences.
4. **The page view is gated on evidence.** It is the largest and least predictable item. It starts only if phase 2 shows that customers need editable pages rather than a web layout plus real pages to read.

## 2. Phase 0: decisions, spikes and notes

**Decisions to take before phase 1** (section 10): assumptions A1, A2 and A4, which are one-way doors; the first market; who delivers invitations and authenticates workflow participants. The owner decided A1 to A4 on 2026-11-06 (section 10). Because A2 was reversed, spike S11 is added below.

| ID | Question | Exit criterion | Size |
|---|---|---|---|
| S1 | Does ProseMirror inside an open shadow root handle typing, selection and composition input in all supported browsers, including composition while remote commits arrive, and in sub-editors for headers and footnotes? Does the schema of 03 work: definition nodes that are not selectable, a body-scoped "select all", null-default identifiers, the footnote content model? | A test matrix passes on Chrome, Edge, Firefox and Safari for Japanese, Chinese and Korean input, dead keys and at least one Android and one iOS keyboard; failures are listed with workarounds; the footnote content model is decided | M |
| S2 | Does the component run under a strict content security policy and Trusted Types, in a host that itself uses Svelte 5, with every dependency loaded? | A demo page with no unsafe keywords shows no violations; the list of policy names and directives a host must allow is written | S |
| S3 | Is the authority correct? Rebase, acknowledgement, deduplication including commits still being stored, the durable and tentative states, fencing, the grants-revision condition, and the outcome check for regions, suggestions and fills | Property tests show convergence under random concurrent commits, reconnects and failed writes; no commit sequence from a user changes a scope outside their writable set; fuzzing finds no crash or stall | L |
| S4 | Can a generated bundle be compiled safely with a tagging-first class, and report where lines and pages broke? What does a compile of the real class cost? | A minimal converter, a sandboxed LuaLaTeX worker, a PDF that validates with veraPDF, `layout.json` with block-level page starts and a report on line-level precision, measured compile times with tagging on, sandbox escape tests passing | L |
| S5 | How closely do canvas text measurements match painted text per browser, and is measuring from font files with HarfBuzz the better base? | A harness reports the distribution of differences; a decision between the two | M |
| S6 | Is the protocol implementable by someone else? | Machine-readable definitions generated; complete port typings; the mock backend passes the port contract tests; a smoke suite for `core` runs against the reference service | M |
| S7 | Can an existing permissively licensed layout core be driven from CDM flow blocks instead of writing one? Candidates found by the research: Eigenpal's Apache-2.0 core, canvas-editor and Docen (both MIT). Check provenance and maintenance, and expect to fork | A recommendation: adopt, fork or build, with evidence | M |
| S8 | Can a tagged LuaLaTeX PDF be sealed with a key held in a key service, with a time-stamp, and validate in Acrobat? | A sealed sample that validates, with the long-term validation profile chosen | S |
| S9 | What should the input bridge of the page view be, and how do screen readers read and edit a painted page? | A prototype of a projection bridge with input-method windows in the right place; a tested screen-reader plan | L. Only if the page view goes ahead |
| S10 | If S5 chooses measuring from font files: should the page view's text kernel be HarfBuzz's own WebAssembly build with line breaking in TypeScript, or one Rust module for shaping, segmentation, line breaking and hyphenation ([ADR 0016](../adr/0016-rust-wasm-compute-kernels.md))? | Both prototypes behind the same measurement interface, measured on the reference machine; a recommendation naming the kernel, its boundary and its fallback when WebAssembly is blocked; ADR 0016 updated | M. Added 2026-11-06; only if S5 chooses font files |
| S12 | Can per-reader projections of one log (ADR 0019) hide regions and field values without leaking them, keep every client converged, and stay within budget? | The S3 harness extended with readers of different visibility; an oracle that scans every outgoing message for hidden content; projected clients converge; cost of projections and diff steps measured; the list of stories to add and change | M. Added 2026-11-06 |
| S11 | Can the preservation layer of ADR 0017 round-trip real Word files without loss, with a semantic model? | On a corpus of real Word files, a prototype import and export meets R0 (untouched: every part byte-identical) and R1 (edited: everything outside the edits unchanged, unknown properties kept), or lists each failure; size overhead and timings measured; ADR 0017 confirmed or changed before `cdm: 1` is frozen | M. Added 2026-11-06 |

**Notes to write:** a legal note (the project's name and ordinary trademark care in marketing, licences inside the TeX Live image and of the house class, fonts, e-signature claims; recommendation of Apache-2.0 for the project); a unit-cost sheet (06, section 10); the borrow list of principle 3 with licences checked.

## 3. Phase 1a: minimum demo

**Goal:** the smallest thing that proves the risky ideas together.

Paragraphs with three styles, and regions. One Node.js process with PostgreSQL, and an S3-compatible object store for the exported PDFs (06, section 4.2; 13, section 11.2). Two browser tabs with different region grants editing at once; a visible rejection when one of them tries to change the other's region; a grant change taking effect live. The commit log recorded in full (08, section 2). LuaLaTeX in a container without network; a PDF panel. The reference host skeleton: token minting and a document list. A header with presence and save state, and the command registry with a simple toolbar.

**Exit criteria:** the demo runs from a compose file; the property tests of S3 run against the real service. Size: L.

## 4. Phase 1b: first usable release

| Area | Scope |
|---|---|
| Component | Web view; tabbed toolbar from the command registry; styles, numbering, tables, inline images, figures; headers and footers in panels; context menu, format painter, navigation pane, dark mode; the recovery journal |
| Model | CDM version 1 with everything in 03, including the reserved field and extension nodes |
| Sync | `pm-steps/1` end to end; presence; resume with incarnation; recovered edits |
| Permissions | Document roles, region grants, restricted regions, protection of definitions, live changes, audit of rejections and grant changes |
| Form mode | Fields of kinds text, number, date, checkbox and choice; the `fill` capability with roles from a token claim; required and type checks; `mode="fill"`; prefill; flattened PDF (12, section 13) |
| Export | Converter for this model with typed emitters and the math gate; sandboxed workers; preview and final profiles; diagnostics |
| Backend | Stage 1 deployment; control API for documents, content, grants, assets, exports, fields |
| Protocol | The schemas, port contract tests and mock backend; scenarios for `core`, `perm-region` and `perm-fill` |

**Exit criteria:** two users with different grants, and one fill-only participant, work on one document for an hour under fault injection (dropped connections, a killed process, a database outage) and end with identical documents; every rejected change was a real violation; nothing typed was lost across a closed tab; the exported PDF matches the content and validates. Size: XL.

## 5. Phase 2: review, history, workflow

| Area | Scope |
|---|---|
| History | History panel, named versions, read-only time travel, comparison, attribution, changes since last visit, restore of documents and regions |
| Review | Comments as mapped ranges with threads, mentions, tasks and reactions; suggestion mode with accept and reject and the review tools; enforcement of the `suggest` role |
| Workflow | The rules engine; the workflow resource; the signing ceremony; evidence; the certificate of completion; sealing with a time-stamp; webhooks |
| Intake and interchange | DOCX import, and lossless DOCX export through the preservation layer (ADR 0017; moved here from phase 4 by the owner on 2026-11-06); HTML and Markdown export and paste |
| Experience | Command search and access keys; proofing and assistant ports; host-registered extensions and custom blocks; the accessibility checker; the read view with the typeset PDF |
| Governance | Region states, leases, session revocation, audit and administration interfaces, output restrictions |

**Exit criteria:** property tests for the suggestion and fill rules pass; a restore preserves comment ranges and attribution in untouched blocks; history visibility is enforced at every endpoint; a complete workflow ends in a sealed PDF that validates, with an evidence bundle that a third party can verify; a Word file can be uploaded, completed and signed. Size: XL.

**Gate at the end of phase 2:** decide on the page view from customer evidence. The alternatives are the web view plus the read view, the own read-only painter first, or the full editable page view. The gate also decides whether the page view must reproduce Word's pagination for imported documents or follow the house class (00, section 5; ADR 0017).

## 6. Phase 3: pages

If the gate says yes, in this order: the layout engine (own or from S7) with the read-only painter, used for the read view, old versions and page counts; then the editable page view with the input bridge from S9; page-break reconciliation from `layout.json`; tables that split across pages; fields and panes in the page view.

**Exit criteria:** typing latency targets met on a 100-page document; painted line widths match computed widths within tolerance in all browsers; the input matrix of S1 passes in the page view; screen-reader passes succeed; on a test corpus, on-screen page starts equal the PDF's after reconciliation. Size: XL, and the item most likely to grow.

## 7. Phase 4: scale, interoperability, reach

| Area | Scope |
|---|---|
| Scale | Stage 2 deployment: several room hosts, routing, the connect hint, the bus, autoscaled export workers; load tests to the stage 2 targets |
| DOCX | Moved to phase 2 on 2026-11-06: the DOCX writer, fields and regions included, ships with import |
| Workflow | Long-term validation and time-stamp renewal; templates and bulk send; routing rules; the signature provider adapter |
| Reach | Light editing on mobile browsers; right-to-left and complex-script content; sandboxed extensions; classification labels; discovery export; an administration console |
| Ecosystem | The authority service as a product; the local backend; the published conformance kit. A second server implementation, and with it the freeze of protocol 1.0, is scheduled when a partner wants to build one |

Stage 3 of the backend is driven by demand and is not scheduled.

## 8. Skills needed

Browser text editing and input methods; typography and text layout; distributed systems and PostgreSQL; TeX and LuaTeX programming; application security; accessibility; and, for workflows, someone who can read e-signature law with counsel. The layout engine and the LaTeX class are specialist work; the rest is conventional.

## 9. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | The page view takes far longer than planned | High | High | It is last and gated; the web and read views plus the PDF are a usable product without it; S7 looks for a core to adopt |
| 2 | Users expect on-screen pages to be final | High | Medium | The web view does not pretend to show pages; the read view and the PDF are real; reconciliation later |
| 3 | The input bridge fails with input methods, mobile keyboards or screen readers | Medium | High | S9 before any commitment; the web view remains as a permanent fallback |
| 4 | Authority bugs cause divergence or a permission bypass | Medium | High | S3 property tests with the outcome check as the oracle; acknowledgements carry mapped steps; the confirmed document on the client; divergence checks |
| 5 | The server must run the document model, which narrows backend languages | Certain | Medium | The authority service with a normative interface; honest backend tiers (05, section 9) |
| 6 | Schema and component version skew between a hosted service and hosts that pin old components | High | High | Operator-gated migrations, an n-1 support window, feature gating per channel, `ext` for additive attributes |
| 7 | LaTeX compile cost and latency at scale | Medium | Medium | Previews only while visible, caching by bundle hash, tenant budgets, warm workers, the cost sheet |
| 8 | A LaTeX injection or sandbox escape | Low | High | Typed emitters, attribute grammars, the math gate, single-use sandboxes, outputs treated as hostile |
| 9 | ProseMirror's model proves too limiting, as it did for SuperDoc | Medium | High | The document API hides it; the CDM is independent of it; the engine identifier allows a successor |
| 10 | Licence problems: AGPL code studied too closely, obligations of the TeX Live image, fonts, e-signature patents | Medium | High | The legal note of phase 0; read copyleft projects for ideas only; Apache-2.0. The interface is the product's own design, so look-alike claims are not a concern |
| 16 | A feature checklist without interface design produces a cluttered product | Medium | Medium | Parity is judged by capability, which leaves the design free; budget for a designer from phase 1b |
| 11 | Font licensing blocks fonts users expect, and imported documents reflow | High | Low | Metric-compatible substitutes; clear warnings on import; tenant-supplied fonts |
| 12 | Scope creep towards full Word or full e-signature parity | High | High | The parity profile (13, section 2); the out-of-scope list of 12, section 13; the preservation layer, which keeps what the model cannot represent instead of modelling it (ADR 0017) |
| 13 | A single maintainer or a very small team | Unknown | High | Phase 1a; the borrow list; the conformance programme deferred until someone needs it |
| 14 | Data loss perceived by users: closed tabs, outages | Medium | High | The recovery journal; acknowledgement only after storage; incarnations |
| 15 | Over-claiming what signatures mean legally | Medium | High | 12, section 8.3; counsel before launch |

## 10. Decisions needed from the project owner

| # | Decision | Default in this spec |
|---|---|---|
| 1 | A1: is offline-first editing required? One-way door | No; disconnection tolerance through the journal. **Decided 2026-11-06: no** |
| 2 | A2: is lossless DOCX round-trip required? | No. **Decided 2026-11-06: yes**, through the preservation layer of ADR 0017 (S11 tests it) |
| 3 | A3: one house LaTeX class or customer templates? | One house class. **Decided 2026-11-06: one house class** |
| 4 | A4: is LaTeX only an export pipeline? One-way door | Yes. **Decided 2026-11-06: yes** |
| 5 | Must some regions or field values be hidden from some readers? | No; version 1 restricts changing, not reading. **Decided 2026-11-06: yes** (ADR 0019, spike S12) |
| 6 | Which market first? It sets the priority of citations, cross-references, numbering depth, review and signing | Undecided. **Decided 2026-11-06: all three candidate markets**, so citations and a bibliography enter CDM 1 (CDM-052) |
| 7 | Names and licence of the project | Names undecided; Apache-2.0 recommended. **Licence decided 2026-11-06: Apache-2.0**; names still undecided |
| 8 | Hosted service, self-hosted distribution, or both at first release | Both are designed for; neither is scheduled first. **Decided 2026-11-06: the default** |
| 9 | Language of the production backend, if not Node.js | Node.js for the reference service; others through the authority service. **Decided 2026-11-15: Rust or C#, Rust preferred if nothing blocks it**; the Node.js service stays as the reference |
| 10 | Who invites and authenticates workflow participants: the host alone, or also the hosted service? | The host. **Decided 2026-11-06: the host alone** |
| 11 | Which jurisdictions first, and who is the sealing party: the operator or each tenant? | Undecided; simple electronic signature plus seal at launch |
| 12 | May a document reflow while fields are filled, or are fields fixed-width? | Fixed width. **Decided 2026-11-06: fixed width** |
| 13 | Is the page view required for the first customers? | Decided at the gate after phase 2 |
