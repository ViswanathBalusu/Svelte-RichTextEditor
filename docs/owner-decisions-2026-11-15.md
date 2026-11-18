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

The owner will review the decisions that have a proposed default (Part B of `owner-blockers-2026-11-17.md`) before any is treated as settled. Until then they stay open: use the default and say so in the story's Notes, as before.

Still open, not asked yet: the PDF text-string encoding and the bookmark string path (EXP-043 criteria 1 and 4), the baseline for comparing published artifact sets (PRO-006), new third-party libraries (Floating UI, a Markdown renderer, a UAX 14 implementation), migration sequencing for search and webhook tables, and the items listed in `docs/owner-decisions-pending.md`.
