# Owner decisions pending

**Status:** list of 2026-11-06, kept by the main session. Each row is a question only the project owner can settle, with the default the work uses until the owner decides. Where the default is the second review's recommendation, the source says so (`docs/review/2026-11-06-second-review.md`, §8). When a decision is made, it moves to the decision's own record (00 §5, 11 §10, an ADR or a story) and leaves this list.

## From the second review (2026-11-06)

| # | Question | Default used until decided | Source | Blocks |
|---|---|---|---|---|
| 1 | Who may receive a lossless DOCX export, the original Word file, its source map and its preserved fragments? | Only a requester who sees the whole document. Everyone else gets a file written from their projection; the original package and fragments stay on the server | Review SR-C1 | S11, EXP-116 to EXP-120, EXP-123 |
| 2 | May editors create preserved Word data, for example by pasting from a web page? | No: preserved data is created only by import. Editors may move or delete it, never create or alter it | Review SR-C2 | CDM-051, the authority's outcome check, EXP-118 |
| 3 | Are numbers (clauses, captions, equations) computed on the full document or on each reader's projection? | On the full document, so every reader sees the same numbers. This reveals how many numbered items a hidden region holds | Review SR-C3 | CDM-042, FRW-089, the projection |
| 4 | What is sealed when participants cannot see some values? | One sealed full PDF for the owner, and a sealed rendering of each participant's projection for that participant, with evidence of what each signer saw | Review SR-M3 | FRW-049 to FRW-055, FRW-089 |
| 5 | May a reader delete a field whose value they cannot read? | Only with `manage`; otherwise refused. (S12 allowed it; this default is stricter) | Review SR-M2; ADR 0019 | R1's outcome check, FRW-088 |
| 6 | When are read restrictions built? | Projection plumbing and confidential regions in phase 1b; hidden values together with the workflow in phase 2 | Review SR-M8 | PLAN-1b, FRW-088 |
| 7 | Tables in headers and footers in CDM 1? | Allowed (option A) | Review SR-K5 (contradiction 5) | CDM-021, CDM-027 |
| 8 | What does the phase 2 seal contain? | PAdES B-LT at sealing; B-LTA and its renewal in phase 4 | Review SR-K8 (contradiction 8) | FRW-053, FRW-056 |
| 9 | Phase 2 is overloaded since the DOCX writer moved into it | Split phase 2 into 2a and 2b, and add risks 17 (Word's long tail) and 18 (a leak through a missed projection path) to 11 §9 | Review SR-M21 | 11 §5, PLAN-2 |
| 10 | Citations: which styles does the house class offer, and does biber run in the sandbox? | Two styles (numeric and author-year); the converter writes the bibliography itself, so biber and `.bib` input never enter the sandbox | Review SR-M20 (the review gives no default; this one keeps the sandbox's inputs as they are) | EXP-121, CDM-052 |
| 11 | Charts and shapes from Word in the PDF | Show a labelled placeholder in version 1; render fallback images at import later | Review SR-M17 (no default given) | EXP-119 |
| 12 | Active content in imported files (macros, DDE, remote fields) | Offer tenants an option to strip it at import. Until the owner sets the option's default, active content is preserved, never run, and exported only in full exports (decision 1) | Review SR-M18 | EXP-097 onwards |
| 13 | Tracked changes the model cannot express | Preserve the paragraph unchanged (lossless, A2) | Review SR-M14 (no default given) | EXP-117 |
| 14 | Accept the proposed decisions of the spikes and agents, then fold them into the spec | Accept ADR 0018 and the choices of S3 and S6, with S6's D09 replaced (stale base gives `stale_base` and `rebase`) and D01 amended (error codes stay extensible). The later proposed ADRs (0020, 0030 to 0052) and the protocol decisions (D40 to D119 in `packages/protocol`) wait for the same acceptance: until then the code follows them and the spec prose does not (for example PRO-130 criterion 5, HIS-002 criterion 2, CDM-002, CDM-003). Folding them into 03, 04, 05, 07, 08 and 09 is one editing pass after acceptance | Review SR-N17, SR-N19, SR-M32; the ADRs | CDM-002, CDM-003, CDM-008, CDM-016, BE-008, PRO-001, PRO-130, HIS-002 |
| 15 | Smaller points | Valkey rather than Redis for distribution; a specification licence with a patent commitment, chosen with counsel; a region grant may not lower a document role; correct ADR 0010's checkpoint and retention numbers | Review SR-N7, SR-N62, SR-N32, SR-K4 | BE stage 2, SPK-007, PRM-004 |

## Open from earlier

| # | Question | Default used until decided | Source | Blocks |
|---|---|---|---|---|
| 16 | First jurisdictions and the sealing party (operator or each tenant) | None: no default exists. S8 (sealing) waits | SPK-011; 11 §10 item 11 | SPK-021, FRW-052, FRW-053, FRW-058, FRW-087 |
| 17 | Language of the production backend | TypeScript on Node.js, as the reference service | SPK-009 | none yet |
| 18 | Is form mode without a workflow the first slice? | Yes, as 11 §4 already places it in phase 1b; fill roles travel in a token claim listing role placeholders, and "active" means "while the document is not locked" (review SR-M27) | FRW-083; 12 §15 question 3 | FRW phase 1b ordering |
| 19 | May `everyone` be granted a role on a restricted region? | No (proposed here: such a grant makes the region behave like `inherit` for that role, so forbidding it keeps one meaning per policy) | PRM-061 | PRM-018, PRM-035, PRM-036 |
| 20 | Project and product names | Keep the placeholders (decided for now on 2026-11-06) | SPK-007 | release |
| 21 | Region titles of confidential regions: hidden or shown by default? | Hidden | ADR 0019 | PRM-066 |
| 22 | Who reads a hidden value by default? | The field's assignee role, users with `manage`, and principals named by a grant | ADR 0019 | FRW-088, PRM-067 |
| 23 | Do owners always see everything? | Yes; no separation of duties in version 1 | ADR 0019 | PRM-066 |
| 24 | PRM-002 criteria 1 and 2 contradict 07 §9 and 06 §3 | Follow 07 §9 | PRM-002 Notes | PRM-002 |
| 25 | The page view (phase 3) | Decided by the gate after spikes S5, S7 and S10 | SPK-013 | phase 3 |

## From the agents' proposed ADRs

| # | Question | Default used until decided | Source | Blocks |
|---|---|---|---|---|
| 26 | Do numbering indents override style indents? | No: 03 §6's order, so a style's indent overrides the numbering level's. Word does the reverse, which a lossless DOCX round trip (A2) favours | ADR 0032 (proposed); spike S7 | CDM-041, the writers |
| 27 | Smaller layout semantics: the decimal separator of decimal tabs, tabs in right-to-left paragraphs, whether `spaceBefore` is dropped at the top of a page, footnotes in headers and footers, a way for a paragraph to switch off its style's numbering, a numbering suffix (tab, space or nothing) | As written in ADR 0032 | ADR 0032 (proposed) | CDM-041 to CDM-045 |
| 28 | Permission rules the spec leaves open: `structure` per region, a size quota for region-only editors, what a split or merge does to grants and state, who reads a sensitive value, hidden titles, restoring signatures | As written in ADR 0033: `structure` stays document-level, no quota, the part keeping the identifier keeps grants and state, readers are `manage`, the assignee role and grant holders on the containing region | ADR 0033 (proposed); PRM-063, PRM-064, PRM-065 | PRM-034, PRM-066, FRW-088 |
| 29 | The time zone of `now` in rules when no workflow gives one | UTC | ADR 0030 (proposed); FRW-083 | FRW-016, FRW-017 |
| 30 | May users with `manage` read other users' export jobs, results and logs? | No: only the requester and the tenant's service credentials | ADR 0036 (proposed); decision D69; review SR-C4 | PRO-063, PRO-064, EXP-123 |
| 31 | May content read at a pinned sequence number be cached at shared edges? | No: private caching only, keyed by view token and grants revision | ADR 0036; decision D70; review SR-C4 | BE-036 |
| 32 | May a service credential alone change grants, without a user? | Yes, as PRM-018 has it | ADR 0036 | PRM-018 |
| 38 | The model's remaining questions: node marks limited to paragraphs, rows and tables (ADR 0018's reading); "present in every document" for built-in styles (`newDocument()` now creates them); an identifier changed by a replacement step (CDM-012); the source of the `title` field; `styleRef`; the citation styles offered; how a release checks extension compatibility | As written in ADR 0031 (proposed) | ADR 0031; M1 | CDM-008, CDM-012, CDM-016, CDM-035, CDM-048, CDM-052 |
| 41 | Nested archives in uploads: SEC-038 criterion 3 says they fail, but 10 §3.5 (as edited) and ADR 0017 preserve Word's embedded objects | Archives under `word/embeddings/` are allowed but never expanded; nested archives anywhere else fail | ADR 0043 (proposed); SEC-038 | SEC-038, EXP-117 |
| 40 | Which laptop class does "a mid-range laptop" (00 §9) mean for the reference machine? | Core i5-1235U business laptops: this machine at Chromium CPU throttling rate 1 matches them within the calibration's noise (published WebXPRT 3 medians 251 and 255); the metric for "usable to 300 pages" is the 00 §9 typing targets on pages-300 | ADR 0037 (proposed); FND-007 | FND-007, every performance target |
| 39 | Must the editing core's view layer be a separate package (FE-121 criterion 1), or is a separate entry point enough? | A separate entry point: `@docedit/engine/headless` loads without `prosemirror-view` or a DOM, and 01 §6 lists no view package | ADR 0038 (proposed); FE-121 | FE-121 |
| 35 | Which interface locales ship in version 1? | Only the source table (en-GB), with the pseudo-locales `en-XA` and `ar-XB` for testing | ADR 0041 (proposed); UX-064 | UX-064 |
| 36 | The non-goals of 13 §2 and PRODUCT.md differ | The parity profile follows 13 §2 | ADR 0041; UX-001 | UX-001 |
| 37 | Picture cropping has no attribute in the model; text prediction, translation and read aloud have no port | Left out of version 1's parity profile until decided | ADR 0041; UX-001 | CDM-029, 13 §6 ports |
| 34 | Resume, catch-up and the history visibility gate: who may stream missed commits, and the limits | As ADR 0034 has it: default history visibility `editors` (a non-editor resuming from an old sequence number reloads); beyond 5,000 commits or 5 MiB the answer is a reload; a rule evaluation budget of 100,000 steps per commit, `rate_limited` beyond it | ADR 0034 (proposed); HIS-023 | HIS-023 criterion 5, SYN-026 |
| 33 | Should `page_setup` attributes lose their defaults (nullable), so that an imported section's residue need not keep Word's whole `w:sectPr`? | No change yet: it changes what an omitted value means and the canonical bytes, and so the hashes of stored documents | Spike S11 (model change 5); M1 | CDM-020, CDM-051, EXP-118 |
