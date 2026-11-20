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
| 104 | Access against the commit that created a region | PRM-006 | The region-listing rule is enough; the engine does no extra tracking. Criterion 1 is reworded. |
| 105 | The rebuild and verify tool and "heavy work off the event loop" | SYN-039 | The command-line tool is exempt. |
| 106 | CPU limit of the math gate | EXP-051 | A tunable limit; the default comes from a measurement on the reference machine. Open until measured. |
| 107 | Where the secrets criterion is judged | SEC-048 | On the demo stack, with secrets split per service; checked again on a real deployment later. |
| 108 | Source file of an imported document | EXP-098 | The document is created first, the source file is attached to it, then the content is written. A failed import removes the document. |
| 109 | Time of a suggestion | FE-046 | The server's time at acceptance of the commit. |
| 110 | Quota refusals | UX-078 | Every refusal names the quota kind: socket error, `sync.reject` and the REST problem. |
| 111 | "Accept" in a suggestion export | EXP-081 | Checked per suggestion against the requester's grants. The payload carries the owners of the suggestion ids and the requester's grants. |
| 112 | "Signing keys" in the administration API | UX-076 | Both token keys and PDF sealing keys, as separate sections. |
| 113 | Mail sink for tests | UX-098 | Mailpit, in a container with a pinned image. |
| 114 | Height of a table row before splitting | EXP-039, EXP-003 | From the editor's own page layout. No first compile pass. |
| 115 | Layer that owns rule P3 | PRO-110, PRO-111 | The pure engine (the authority), so every backend enforces it and the kit covers it. The owner was given a short description of P3, not its text. |
| 116 | Key that shows the access letters | UX-012 | Alt pressed and released alone (ADR 0231 option A). |
| 117 | States of a side pane | UX-023 | Open and closed only. The criterion is reworded. |
| 118 | Who switches on tracked changes for everyone | UX-038 | `manage` only. |
| 119 | An assistant's direct edit | UX-046, UX-044 | Refused by the server. An assistant's output arrives as suggestions only. |
| 120 | Sandboxed third-party extensions | UX-059, UX-060, SEC-055 | Build them. This reverses the spec default (tier 2 not built); the spec changes. |
| 121 | Dark and high-contrast themes | UX-070 | In the start chunk, as built. |
| 122 | A data-loss hook that does not answer | UX-086 | Fail closed: refused with `unavailable` and an audit entry. |
| 123 | Remote images in pasted HTML | FE-054 | Fetched and stored as assets. This reverses the built default (dropped). The fetch goes through the egress proxy with its policy; the design goes in an ADR before it is built. |
| 124 | Switch to the read view with unsent work | FE-065 | The session keeps running behind the read view (ADR 0304 option a). |
| 125 | Font substitutes | FE-062 | A `substitutes` field in `GET /fonts`, with `defaultFamily` as the fallback (ADR 0144). |
| 126 | Citation style | FE-140, EXP-121 | Selectable styles, not the house style alone. This reverses the proposed default. The web view and the PDF must offer the same styles; with decision 16 the PDF side is a biblatex style option run through biber. How the styles are chosen and stored goes in an ADR. |
| 127 | A format change made as a suggestion | FE-128 | The format mark stays on the text alongside the suggestion, as built. Criterion 7 is reworded. |
| 128 | "Structure" per region | PRM-063 | Grantable per region. This reverses ADR 0033 item 4 (document level only); the role-table stories follow the new rule, and the design goes in an ADR first. |
| 129 | Titles of confidential regions; owners | PRM-066 | Titles hidden. Owners always see everything (pending items 21 and 23). |
| 130 | Split and merge of a region | PRM-065, PRM-034 | The part that keeps the id keeps grants, state and policy; the other part gets a fresh id (ADR 0033 item 3). |
| 131 | Comments while a document is out for signing | FRW-085 | Always on. |
| 132 | Long answers under a workflow lock | FRW-086, FRW-012 | The participant may edit their granted region while the document is locked (review SR-M26, option a). |
| 133 | What is sealed when values are hidden from some participants | FRW-049, FRW-089, FRW-050 to FRW-055 | One sealed full PDF for the owner and a sealed view per participant, with evidence of what each saw (pending item 4). |
| 134 | Quota for region-only editors | PRM-064 | None. The 16 MiB risk is recorded (ADR 0033 item 5). |
| 135 | A pending change after a broken lease | PRM-045 | Accepted if the former holder's grants allow it. Criterion 4 is reworded (ADR 0146). |
| 136 | Bus between nodes in stage 2 | BE-059, BE-060, BE-062, BE-063, BE-028 | Valkey streams (pending item 15). |
| 137 | Partitions of the commit log | BE-008, BE-009 | 64 (ADR 0020). |
| 138 | Caching of pinned reads | BE-036 | Private only (D70, pending item 31). |
| 139 | Read-only follower nodes | SYN-042 | Not before stage 3, on demand. A submission on a follower is refused with `read_only` (ADR 0147). |
| 140 | Default history gate | HIS-023 to HIS-026, HIS-046 | ADR 0034: `editors` see full history, everyone else named versions only; an owner may change it per document. |
| 141 | History "from when they got access" | HIS-025 | Starts at the state current at that moment, as built. |
| 142 | Hidden commits in an exported log | HIS-037 | Left out, with one link hash revealed, as built. Whether the names of hidden region scopes may show is still open. |
| 143 | Public transparency log | SEC-063 | Yes: chain heads are anchored in a public log. This reverses the proposed default (none in version 1). The choice of log goes in an ADR. |
| 144 | Word constructs the model cannot hold | EXP-101, EXP-102, EXP-103, EXP-109 | Kept as preserved blocks (A2, ADR 0017, pending item 13). The criteria are reworded. |
| 145 | Charts and SmartArt from Word | EXP-117 | A labelled placeholder; the original is preserved (pending item 11). The tagpdf table module question of EXP-041 is still open. |
| 146 | Sandbox of the compile workers | EXP-069 | gVisor (ADR 0045), still to be measured. |
| 147 | Forced line breaks (parity level L2) | EXP-059 | Build them. This reverses the proposed default (not built). |
| 148 | Default locale and time zone of an export | EXP-005, EXP-033 | The document's language, else `en-GB`, and UTC (ADR 0045 q5). Date fields print the stored day in UTC. |
| 149 | A figure's `align` and its caption | EXP-028 | The caption does not move (ADR 0223 decision 12). |
| 150 | Raw compile log | EXP-066 | Callers without `edit` get the job without a log URL, as built. |
| 151 | Grants and rules parts of an exported DOCX | EXP-095 | The host decides what it passes, as built. |
| 152 | Audience of the lossless DOCX export | pending item 1 | Only a requester who sees the whole document. |
| 153 | Active content in imports | pending item 12, SEC-039 | Preserved, never run, and reported. SEC-039 is reworded to "kept and reported". |
| 154 | Tables in headers and footers | pending item 7 | Allowed. |
| 155 | Time zone of `now` in rules | pending item 29 | The tenant's time zone. This reverses the proposed default (UTC). The tenant setting and its default go in an ADR. |
| 156 | Who reads hidden values | pending item 22 | The assignee role, `manage`, and grant holders. |
| 157 | Deleting a field the reader cannot read | pending item 5 | Only with `manage`. |
| 158 | Timing of read restrictions | pending item 6 | Confidential regions in phase 1b; hidden values with the workflow in phase 2. |
| 159 | A `manage` user and other users' export jobs | pending item 30 | Not readable. |
| 160 | A service credential changing grants alone | pending item 32 | Allowed; audited as the host. |
| 161 | Interface locales | pending item 35 | en-GB plus pseudo-locales. |
| 162 | Picture cropping, text prediction, translation, read aloud | pending item 37 | Left out of version 1. |
| 163 | Nested archives in uploads | pending item 41 | Allowed under `word/embeddings/`, never expanded. |
| 164 | Editors creating preserved Word data | pending item 2 | No. Preserved blocks come from imports only. |
| 165 | Phase 2 | pending item 9 | Split into 2a and 2b. |
| 166 | Resume and catch-up limits | pending item 34, HIS-023 | A resume beyond 5,000 commits or 5 MiB reloads (ADR 0034). Starting values, tunable by operators. |
| 167 | A region grant against a document role | pending item 15 | A region grant cannot lower a document role. |
| 168 | Key that moves focus into the floating format bar | UX-010 | Alt+F10. |
| 169 | The four markup views | UX-035 | As built (ADR 0233 d4): `all`, `simple`, `none` (as if accepted), `original` (as if rejected). |
| 170 | Search synonyms for commands | UX-011 | In the locale tables (13 §8). |
| 171 | Choices of the accessibility checker | UX-066, UX-068 | As built: 4.5:1 contrast, heading levels 1 to 9, headers and footers included, no "decorative image" mark (ADR 0329, ADR 0137). |
| 172 | Identity of an assistant | UX-044, UX-045, UX-046 | ADR 0234 A: a separate agent token derived from the user's, capped by the room at `suggest`. |
| 173 | Extension API | UX-049, UX-055 | ADR 0234 B accepted, with the commit origin hint `extension` (04 changes) and the deprecation window. |
| 174 | `DEP-Actor` | UX-096, UX-097 | Tightened against the proposal: a service credential acting for a user is bounded by that user's rights, and the audit trail records the credential as well as the user. A security review is still required. |
| 175 | Discovery and tenant export bundles | UX-087, UX-088 | ADR 0373 accepted, with its new DEP operation. |
| 176 | A client without an extension the document uses | UX-056, UX-057 | The document opens; the custom block shows as a locked placeholder and is kept untouched. The refusal code for an attempt to edit it, and the size limit of inline custom content, are still open (ADR 0328 d2). |
| 177 | Webhook test ping and delivery replay | UX-079, PRO-068, BE-057 | Both, on the routes ADR 0330 §2 proposes. |
| 178 | `keepNext` against widow control | FE-082, FE-085 | A `keepNext` chain wins (ADR 0120, ADR 0206). The other fixtures of those ADRs were not put to the owner. |
| 179 | Page guides after an edit | FE-068 | Kept; `seq` is not compared (open question 28). |
| 180 | Performance definitions | FE-119, FE-120 | ADR 0209 accepted. The owner was given a paraphrase of its definitions; figures are still to be measured. |
| 181 | Listeners left on `document` while suspended | FE-005 | Accepted. The criterion is reworded. |
| 182 | Layout cascade | FE-077 | Switched to the model's resolver (ADR 0304 item 3). `toFlow` fixtures are re-approved. |
| 183 | Scope of block-level suggestions | PRM-062, PRM-013, PRM-014 | ADR 0146 and ADR 0132 as proposed: `style`, `align` and `numbering` only. |
| 184 | The workflow design ADRs | FRW-027 to FRW-080 | Accepted as a set: ADR 0249, 0250, 0148, 0340, 0341, 0342, 0343, 0252 and 0366, with the proposals in the notes of FRW-039, 044, 045, 054, 055, 062, 063, 071 and 080. `Idempotency-Key` on the prefill route (FRW-061) is part of ADR 0342. |
| 185 | Code for a declined or voided document | FRW-018, FRW-020, FRW-022, FRW-029 | `read_only`, as built. Restore under a workflow lock answers `conflict`, as built. Every rule problem is refused at save (ADR 0340). |
| 186 | A value typed and not yet acknowledged | FRW-076 | Resubmitted once on return, without a "recovered edit" offer. Criterion 5 is reworded. |
| 187 | Message of `validation.pattern` | FRW-018 | The field definition carries an optional message (ADR 0030 item 3; the model gains the member). |
| 188 | Result of `exec()` | PRO-085 | `{ok, reason}`, not a boolean. This reverses the built default. |
| 189 | Answer to an upload | PRO-096, PRO-097 | The asset id, as built. |
| 190 | Features the reference service announces | PRO-115 | Comments, history and leases are on by default. This reverses the built default (ADR 0315). |
| 191 | Test-mode timers | PRO-109, PRO-043 | 60 s, with a guard against production use and a security review of the switch. |
| 192 | Fault-injection hooks | PRO-126, PRO-024 | ADR 0219 accepted: the hooks and the `test-hooks` feature exist only in test mode. |
| 193 | Wire format of the authority service | PRO-102 | Accepted as the starting point; it may be refined while it is built and measured. |
| 194 | Close for a silent client | PRO-037, PRO-111, BE-093 | The server sends a proper close (1000 or 1001) instead of dropping the connection. The mapping of the 1009 close is still open. |
| 195 | `node_leases` without a tenant column | BE-011 | Allowed (ADR 0332). The rule is reworded to tables that hold tenant data. |

After decision 195 the owner said to take the proposed default for what was left. Decisions 196 to 220 are those defaults; none was put to the owner one by one.

| # | Topic | Stories | Decision |
|---|---|---|---|
| 196 | HTTP status per error code | PRO-002 | Status ranges only (D13). |
| 197 | Scope of a legal hold | BE-052 | Per document (08 §11). |
| 198 | An uploader resolving their own upload | BE-045 | Allowed before any commit references it, as built (ADR 0242). The spec text changes. |
| 199 | Browser extensions | SEC-011 | The position of 10 §6: they run with the user's privileges and the guide says so. |
| 200 | Node address hint for `/connect` | BE-061, BE-060, BE-062 | An address on the node lease row, falling back to rendezvous routing (ADR 0243). |
| 201 | Name of the read-restriction feature | PRO-131 | `read-restrictions`. |
| 202 | `page` against `reload` | BE-038 | `reload`, as the gateway answers. ADR 0034 is corrected. |
| 203 | "One configuration file" for the boundary rules | FND-004 | The split over three places is accepted. |
| 204 | Proving story of register row T-3.1-host-policies | SEC-001 | FE-125 (ADR 0360). |
| 205 | Key-custody record | SEC-062 | Accepted as proposed, with the two-person recovery rule. |
| 206 | A range whose payloads are gone | HIS-032, HIS-030 | `not_found` with a reason, as built. |
| 207 | Fonts of old versions | HIS-010 | The live font manifest. |
| 208 | Spacing and keep-with-next in style macros | EXP-013 | The converter's `\DEgap` and `\DEkeep` lines stand; 09 §3.1 is reworded. |
| 209 | PDF text strings and bookmarks | EXP-043, EXP-030, EXP-045 | One string emitter for titles, with the class change it needs. Decision 25 (hex for link targets) stands. |
| 210 | A block's `fallbackText` | EXP-035 | Through `pdfString`, as built. |
| 211 | Display environments at the math gate | EXP-050 | As built; the criterion is reworded to match the gate. |
| 212 | "Nothing unexpected" in the token trace | EXP-046, EXP-053 | A denylist of dangerous primitives (ADR 0320). |
| 213 | "Files outside the working directory" | EXP-075 | Read as outside the sandbox; the criterion is reworded (ADR 0368). |
| 214 | External relationships in a written DOCX | EXP-090 | Allowed for hyperlinks and for those the original had (review SR-M18). |
| 215 | Numbers in the DOCX writer | CDM-042 | Word's native numbering, as built. |
| 216 | Event that drives the classification label | UX-085 | `document.updated`. |
| 217 | "The gateway uses no ProseMirror type" | SYN-046 | Checked on the session layer and the protocol only. |
| 218 | Non-goals that differ between documents | pending item 36 | Follow 13 §2. |
| 219 | Refusal codes in two criteria | PRO-059, PRM-066 | PRO-059 is read as the REST code (ADR 0372). A grant change by a user without `manage` stays `forbidden`. |
| 220 | The remaining proposed ADRs | pending items 13, 14, 28, 33 | Spike choices S3 and S6, ADRs 0020 and 0030 to 0052, and protocol decisions D40 to D119 are accepted as proposed, except where a decision above says otherwise (ADR 0033 item 4 is reversed by decision 128). `page_setup` nullable attributes: no change. |
| 221 | Signing library for sealing the final PDF | SPK-021, FRW-052 to FRW-057 | Answered 2026-11-18. Go ahead: the spike may choose and add a PAdES signing library for development and tests, and records the choice in an ADR. For production the owner wants either a suitable library found or our own built; that choice stays open until the options are reviewed. |
| 222 | Where the sealing key is kept | SPK-021, FRW-052, FRW-053 | Answered 2026-11-18. A software key emulator in development. The production options (hardware module, cloud key service) are to be researched and put to the owner; not decided. |
| 223 | Seal certificate and time-stamp authority | SPK-021, FRW-053 | Answered 2026-11-18. A self-signed test certificate and a local test time-stamp authority for now. The production certificate and time-stamp provider are not decided. The Acrobat validation criteria stay manual checks. |
| 224 | Rust libraries for line breaking and text segmentation | WASM-007 and the WASM stories behind it | Answered 2026-11-18. Yes: add `unicode-linebreak` 0.1.5 and `unicode-segmentation` 1.13.3, and download the Unicode consortium's two official conformance test files for the tests. |

Not settled by "use the defaults", because no default is recorded: whether a final export that does not converge fails or is delivered flagged (EXP-061); what "the export worker container" means and whether `stack.ps1` counts as the compose file (BE-005); the rest of ADR 0031 (pending item 38); the specification licence (pending item 15); the mapping of the 1009 close (PRO-037); the tagpdf table module (EXP-041); names of hidden region scopes in an exported log (HIS-037); the size limit of inline custom content (UX-057); the small gaps of UX-029, UX-032, UX-036 and UX-063; SEC-005 and SEC-029; a store in `backend-dep` for thread events (PRO-097). Use the built behaviour and say so in the story's Notes.

The owner chose to be asked every remaining decision, including the engineering ones, until decision 195.

The decisions that had a proposed default (Part B of `owner-blockers-2026-11-17.md`) are settled by decisions 116 to 220.

Still open, not asked yet: the PDF text-string encoding and the bookmark string path (EXP-043 criteria 1 and 4), the baseline for comparing published artifact sets (PRO-006), new third-party libraries (Floating UI, a Markdown renderer, a UAX 14 implementation), migration sequencing for search and webhook tables, and the items listed in `docs/owner-decisions-pending.md`.
