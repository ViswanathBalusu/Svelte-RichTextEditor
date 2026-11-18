# Owner decisions, 2026-11-15

The project owner answered these in the working session of 2026-11-15. They are settled. A story that waited on one of them applies the answer, updates the spec text or the story wording it names, and records this file as the source. Where an answer says "reword", the criterion is rewritten to the decided behaviour before it is ticked.

| # | Topic | Stories | Decision |
|---|---|---|---|
| 1 | Language of the production backend | SPK-009 | Rust or C#. Rust is preferred if nothing blocks it. The Node.js reference service stays as the reference. |
| 2 | Project names | SPK-007 | Keep the working names. Final names are not chosen yet, so the last criterion stays open. |
| 3 | Citations, the "no" branch | CDM-004 | The criterion for the "no" branch is not applicable (citations are in CDM 1). Strike it. |
| 4 | Select all inside a region | FE-032 | Select all selects the whole body (02 §5.2). |
| 5 | Form mode without a workflow | FRW-083 | Yes. It is the first slice and stays in phase 1b. |
| 5a | Token claim that carries fill roles | FRW-083 | The claim name is configurable per tenant. `wfr` is the default (my reading: the owner asked for it to be configurable and did not reject the proposed name). |
| 5b | "Active" without a workflow | FRW-083 | A participant may fill while the document is not locked. |
| 5c | "Finish" and `completeFilling()` | FRW-083 | Configurable per document, with a tenant default. The default validates and raises events only. The other setting also makes that person's fields read-only. |
| 5d | Authoring fields in 1b | FRW-083 | Through the editor (palette and properties panel), not the API alone. |
| 6 | Hosted CI | FND-002 and others | The repository has a remote: `origin` on GitHub. `master` is pushed as `main`; `stories/integration` is pushed. |
| 7 | ADR 0018, attribute grammars and canonical form | CDM-002, CDM-003, CDM-008, CDM-016 | Accepted as proposed. A document that lacks a built-in style is not an I1 violation. Suggestion marks on `paragraph`, `table_row` and `table` only are enforced by `model.validate()`. |
| 8 | Header and footer page styles | EXP-018 | The house class's own page styles are accepted. `fancyhdr` is not required; reword criterion 1. |
| 9 | Numbering indent against paragraph-style indent | ADR 0032, CDM-005 | Word's order: the numbering level's indent overrides the paragraph style's. Change 03 §6 and the resolver. |
| 10 | ADR 0032, the rest | CDM-005 | Accepted as proposed, with decision 9 and decision 11 in place of its open items. |
| 11 | Numbers shown to a reader of a projection with hidden regions | ADR 0032, ADR 0019 | The full document's numbers. Gaps may show. |
| 12 | `everyone` on a restricted region | PRM-061 | Forbidden. Grant validation refuses it and the pane does not offer it (ADR 0146). |
| 13 | First jurisdictions | SPK-011 | Both the European Union and the United States from the start. |
| 14 | Sealing party | SPK-011 | The operator seals by default; a tenant's own key and certificate are used where the tenant supplies them. |
| 15 | Seal level | SPK-021, FRW sealing stories | PAdES B-LT in phase 2, B-LTA in phase 4. |
| 16 | Bibliography | EXP-121 | Use a generated `.bib` file and biber, as 09 §3 and §4 say. This replaces the default recorded in ADR 0230 §1. |
| 17 | Control commit for a grant change | PRM-002 | The spec and the code are right (07 §9, 06 §3): the rows and the revision are one transaction, and the room records the control commit. Reword criteria 1 and 2. |
| 18 | Component stylesheet | FE-002 | The CSS stays a string in the editor chunk, adopted into a constructable sheet (ADR 0039 §3). Reword criterion 1 and 02 §2. |
| 19 | View layer | FE-121 | The separate entry point of `packages/engine` is enough. No separate package; reword criterion 1. |
| 20 | Node identity "by replacement" | CDM-012 | The narrow reading of ADR 0362: only a replacement of one node around its own content. |
| 21 | Answer on a locked document | SYN-007 | `read_only`, as ADR 0363 proposes and as built. |
| 22 | Performance reference | FND-007 | The reference machine and laptop class of ADR 0037 are confirmed. The tolerances stay provisional until they are measured again on a dedicated runner. |
| 23 | Bound on repeated retries | PRO-028 | No bound. The client retries until acknowledged, refused with another action, or the channel closes. |
| 24 | Session records | HIS-003 | Kept as long as the document's history. Proposed by the session and not objected to: the control plane of the document service holds them in its own table, and a user agent string is reduced to family and major version. |
| 25 | Link targets in PDF | EXP-043 | Hex encoding of the whole target is the rule. Reword criterion 3. |

## Added on 2026-11-17

The owner answered these in the working session of 2026-11-17. They are settled in the same way.

| # | Topic | Stories | Decision |
|---|---|---|---|
| 26 | Page view (the SPK-013 gate, pending item 25) | SPK-013, SPK-022, FE-075, FE-076, FE-079, FE-089, FE-092, FE-094, FE-095, FE-097 to FE-102, the WASM epic | The full editable page view (alternative (c) of 11 §5). Condition C-WASM holds. Not asked yet: whether the page view must reproduce Word's page breaks for imported files; until it is, ADR 0005's assumption (the house class) stands. |
| 27 | Rust module in the browser | WASM-001, WASM-007, WASM-008, WASM-009, WASM-013 to WASM-016, SPK-023 | Build the Rust WebAssembly module. This overrides the recommendation of spike S10 (harfbuzzjs with line breaking in TypeScript), which the owner was shown with its measured cost (2.1 times the download, a second toolchain, 21 crates). Condition C-RUST holds, so all 16 WASM stories may start. ADR 0016 moves from proposed to accepted on this point. |
| 28 | Hosted or self-hosted first (11 §10 decision 8) | BE-041, BE-076, BE-082, BE-083, BE-095, BE-097, SEC-061 | Both from the start. The stories conditional on a hosted mode and those conditional on a self-hosted mode all apply. |

| 29 | Page breaks in the page view | SPK-013, FE page-view stories | Our own layout (the house class). The page view matches the exported PDF; Word's page breaks are not reproduced. |
| 30 | Deleted documents | PRO-047, HIS-039 | Recoverable for 30 days by default; a tenant may set another period. |
| 31 | Signing evidence | FRW-084, FRW-043, SEC-044, SEC-057 | Kept as long as the signed document exists; deleted with it. |
| 32 | Bundle budget | FND-008 | Raised from 300 kB to 320 kB gzip. |
| 33 | Comment reactions | UX-033 | Build them: protocol, server and comment pane. |
| 34 | Custom dictionaries | UX-042 | One list per person, and one shared list per tenant kept by an administrator. |
| 35 | Mention inside content the person cannot see | UX-031 | Refused with a message. No access request. |
| 36 | Region restore over the commit size limit | HIS-018, HIS-007, HIS-020, HIS-021 | Split into several linked commits. |
| 37 | Author of text written below a reader's history gate | HIS-026, HIS-015 | Shown as "unknown person"; author and time withheld. |
| 38 | Erasure against a legal hold | HIS-031, HIS-038 | The hold wins. The erasure runs when the hold is released; the request and the delay are audited. |
| 39 | An erased person in history | SEC-056 | "Unknown person". No per-person surrogate is shown. |
| 40 | Catch-up on a first visit | HIS-027, HIS-028 | Nothing is shown; tracking starts from that visit. |
| 41 | Author of an accepted assistant suggestion | HIS-017 | The assistant is recorded as the source and the person as the one who accepted. |
| 42 | Copy a version into a new document | HIS-022 | Text only. No threads, history, workflow state or grants (`copyGrants` false). |
| 43 | Per-document key destruction | HIS-041 | Build it. |
| 44 | Spreadsheet export of field values | FRW-064 | Yes, as CSV, with formula neutralising. |
| 45 | Fatal errors in the element | PRO-039 | A full message in the editor area with one action, and an event to the host. |
| 46 | Replace all in suggestion mode | FE-060 | Each replacement is a suggestion. |
| 47 | Unsent work of a returning user | FE-009, FE-010, FE-012 | Resubmitted only for the same signed-in user; otherwise discarded after a warning. |
| 48 | Printing from the PDF viewer | FE-073 | A separate print-only frame that may open the print dialog; the viewer frame stays as it is. |
| 49 | Error summary against the progress counter | FRW-078 | Both stay: the summary lists every problem, the counter counts required fields and says so. |
| 50 | Banded table rows | EXP-038 | A fixed light grey in the editor, the PDF and the DOCX. |
| 51 | Classification marking in output | EXP-089 | Header and footer of every page. |
| 52 | Margin comments in the PDF | EXP-084 | Open threads only, with display names. Resolved threads are left out. |
| 53 | Document protection of an imported Word file | EXP-104 | Protected parts become locked regions that the owner can unlock. The password is not carried over. |
| 54 | Importer success rate | EXP-110 | 100% of the corpus. A failing file is fixed or removed with a written reason. |
| 55 | Thinning of daily checkpoints | HIS-030 | Daily checkpoints thin to weekly after 90 days. |
| 56 | Signing of log heads | HIS-035, HIS-036 | One signed batch root per tenant, every hour. |
| 57 | Answer for a resource the caller may not see | SEC-016, BE-032, PRO-059 | `not_found`, as built. D69 changes to match. |
| 58 | Old formats in history | HIS-045 | Readers of old formats stay in the product for as long as history is kept. History is never rewritten. |
| 59 | Audit feed to outside systems | UX-082 | Polling of `GET /audit` with a stated cadence. No new route. |
| 60 | Network of the export worker | UX-091, BE-005 | None. |
| 61 | A table row taller than the space left | EXP-039, EXP-003 | The row splits across pages when it does not fit. How its height is measured is still open. |
| 62 | Server-side use of an uploaded font | EXP-048 | A flag set by the administrator on upload. A font without it is used on screen only and substituted in the PDF. |
| 63 | Budget of a sealed export | EXP-079 | Both compiles count against the tenant budget. |
| 64 | A burst of copies of one commit | SEC-015 | Rate-limited or "busy" answers are acceptable; the commit is applied once. |
| 65 | Proof of escaping in the TeX trace | SEC-033 | The level-1 trace is enough. |
| 66 | Origin of export results | SEC-036 | The asset origin, with the headers we control. Not presigned store URLs. |
| 67 | PDF.js exceptions | SEC-054 | The two computed imports are allowed in the viewer frame, documented and checked. |
| 68 | Credentials of the administration API | UX-076 | Two kinds: an operator credential for every tenant, and a tenant administrator credential bound to one tenant. |
| 69 | Usage window | UX-078 | The calendar month in UTC. |
| 70 | Secret store | BE-057 | A port, with an encrypted table as the default adapter; an operator may plug in a secret manager. |
| 71 | E-mail addresses for notifications | UX-098 | The host resolves them from the user id. The service stores none. |
| 72 | Opening a 16 MiB document | BE-019 | Off the main thread, in a worker; the room is built from plain data (ADR 0333). |
| 73 | Order of comment activity | PRO-058 | Comments get a sequence number of their own. |
| 74 | Baseline for compatibility checks | PRO-006, CDM-048 | The first public release. Until one exists the comparison has no baseline, and the criteria that need it stay open. |
| 75 | Supported format versions | CDM-049, CDM-050 | n and n-1. |
| 76 | A first CDM 2 to exercise migrations | CDM-049, CDM-050 | Yes, a test-only version 2. Nothing ships. |
| 77 | A header that leaves no room for the body | CDM-043, CDM-045 | The body starts on the next page, as TeX does. The layout changes to match. |
| 78 | Unrounded line height | CDM-043, CDM-045 | Rounded to whole units (290.95 becomes 291) in the layout and the export. |
| 79 | "Before" formatting under several suggestions | PRM-013 | Recorded against the baseline when the first suggestion is made (option ii of ADR 0378). |
| 80 | History gate and the host's service credential | PRM-041, PRM-042, PRO-057 | The service credential is exempt. When it acts for a named user, that user's gate applies. PRO-057 criterion 4 is reworded. |
| 81 | Comments on old versions | SYN-032, HIS-010 | Shown in their positions of that time. Thread positions are kept for every checkpoint. |
| 82 | Threshold for broadcast batching | SYN-041 | Not set yet. Batching stays switchable with a 40 ms window; the threshold comes from a load test on the reference machine. |
| 83 | Size of the attribution map | HIS-044 | One map per document, capped at the document size limit; beyond it the oldest detail is merged. |
| 84 | Erasure against write-once copies | HIS-039, HIS-040 | A sealed PDF stays intact. Checkpoints and the attribution map are cleaned of the person's identity. |
| 85 | Release of a legal hold | HIS-031 | A release operation is added and audited as the placement is. Pending erasures then run. |
| 86 | Suggestion-to-commit index | HIS-042, HIS-014 | A new column (06 §4.1 changes), with a backfill of existing checkpoints. |
| 87 | Admission budget for expensive commits | SEC-028 | A budget exists and operators may tune it. The default is set from a measurement on the reference machine and is off until then. |
| 88 | Link to a comment | UX-034 | The element gives the host a marker for the comment; the host builds the link with its own page address and passes the marker back on open. |
| 89 | Feature switches | PRO-081 | Four groups can be switched off: comments and suggestions; export and print; history; assistant and proofing. |
| 90 | Refreshed caption and cross-reference texts | FE-134 | Not written into the document. Computed when shown and when exported. |
| 91 | Numbered paragraphs for screen readers | FE-105, FE-130 | Consecutive list paragraphs are drawn inside a real list element. |
| 92 | Drawing of a block suggestion | FE-044, FE-045 | The block state is stored as a node attribute (the second option of ADR 0302). This amends decision 7 where ADR 0018 keeps block suggestions as node marks; the ADRs are to be reconciled before the stories are built. |
| 93 | One interface update per frame | UX-072 | The scheduler is fixed; the criterion stands. |
| 94 | Font files an administrator may upload | BE-048 | TTF, OTF and WOFF2, each checked in the sandbox. Collections and other formats are refused. |
| 95 | Font list | BE-098 | `GET /fonts` is tenant-wide for every user of the tenant. |
| 96 | Start of the Rust production backend | SPK-009, PRO-102 to PRO-107, BE-007 | Now, alongside the rest. The Node.js service stays the reference. |
| 97 | Abuse-handling policy for the hosted mode | SEC-061 | Agents draft the policy and the controls; nothing is final until the owner and counsel have reviewed it. |
| 98 | Scope of the penetration test | SEC-004 | Everything shipped: element, service, protocol, export, import and the administration API. The owner chooses the firm and the date. |
| 99 | The word "qualified" | FRW-058 | The specification may use it to name signature levels; the wording check covers interface texts and outward-facing documents. |
| 100 | Commit id of an outbox item | BE-039 | Derived from the idempotency key and the operation. |
| 101 | `Idempotency-Key` on `replaceContent` | BE-037 | Accepted. |
| 102 | Anchor of a Word comment | EXP-093 | The exact range of text the thread is on. |
| 103 | Store of performance results | FND-007 | A dedicated branch in the repository. |

The owner chose to be asked every remaining decision, including the engineering ones.

The owner will review the decisions that have a proposed default (Part B of `owner-blockers-2026-11-17.md`) before any is treated as settled. Until then they stay open: use the default and say so in the story's Notes, as before.

Still open, not asked yet: the PDF text-string encoding and the bookmark string path (EXP-043 criteria 1 and 4), the baseline for comparing published artifact sets (PRO-006), new third-party libraries (Floating UI, a Markdown renderer, a UAX 14 implementation), migration sequencing for search and webhook tables, and the items listed in `docs/owner-decisions-pending.md`.
