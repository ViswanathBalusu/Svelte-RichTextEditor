# Owner decisions, 2026-11-26

The project owner answered these on 2026-11-26, against the open-decisions section of `remaining-stories-2026-11-26.md`. They are settled. A story that waited on one of them applies the answer, updates the spec text or the story wording it names, and records this file as the source. Where an answer says "reword", the criterion is rewritten to the decided behaviour before it is ticked.

Decisions 225 to 238 are the owner's own answers. Decision 234 takes the option that was not recommended. Decisions 239 to 282 accept the recommended (first-listed) option of each question, as the owner asked for every other question. The question numbers of the remaining-stories file are not used; each decision keeps its own number here.

Question 21 of that section (the FND-008 bundle) is not recorded here as a new decision. The owner decided it earlier: keep the 320 kB budget and keep splitting (decision 32).

## Owner's answers

| # | Topic | Stories | Decision |
|---|---|---|---|
| 225 | Reference laptop as a performance runner | FND-007, FND-009, BE-024, BE-030, BE-058, BE-084, BE-091, BE-021, SEC-028, EXP-051, FE-088, FE-089, FE-092, FE-102, FE-118, FE-119, FE-120, FRW-023, FRW-076, PRO-104, SYN-015, SYN-037, SYN-040, UX-054, UX-066, UX-072, UX-074, WASM-012 | The reference laptop is registered as a dedicated self-hosted runner for measurements. Figures are stored on the results branch (decision 103). The machine is left idle during runs. |
| 226 | First tagged release | FND-012, CDM-048, CDM-050, PRO-006, UX-076, BE-016, BE-095, BE-093, PRO-127, SEC-051, SEC-052, SEC-053, EXP-073, WASM-014, FND-013 | A pre-release tag is cut soon. It rehearses publishing, SBOMs and signing. It is not the compatibility baseline unless the owner says so later; decision 74 still names the first public release. |
| 227 | Branch protection and named CI jobs | FND-002, SYN-047, SYN-049, EXP-075, EXP-078, SEC-001, FE-017, FE-050, FE-116, SEC-002, SEC-035, SEC-050, UX-048, WASM-001 | Protect `main` so the named CI jobs must pass before a merge. Those jobs run on pull requests, including a macOS runner for Safari. No second reviewer is required. |
| 228 | Hangul and CJK fonts in the export image | EXP-016, EXP-025, EXP-056, EXP-057, EXP-078, EXP-111, EXP-114, FE-100, SEC-053 | The Noto CJK fonts (OFL) are added to the export image. |
| 229 | Second reviewer for register changes and sign-offs | SEC-001, SEC-003, CDM-005, FE-112, WASM-015, EXP-045, SEC-055, UX-060, UX-048 | The owner reviews for now. Each criterion that names a second reviewer is reworded to say so. |
| 230 | Compose provider for `podman compose` | BE-005, BE-007, UX-091, UX-090, SEC-002 | A Compose provider is installed so that `podman compose` can start the stack, here and in CI. |
| 231 | Where signing and sealing keys live | HIS-036, SEC-041, FRW-052 | The operator chooses the key store through a key-service port. Hosted deployments may use a cloud service; self-hosted deployments may use a hardware module. |
| 232 | Jurisdictions for signing claims | FRW-087, FRW-084, SEC-043 | Counsel proposes the list of EU countries and US states to review the signing claims against. |
| 233 | Data residency of cross-region routing | BE-074, BE-075, SEC-058 | No cross-region read. A gateway routes by region alone, and the receiving node checks the owner (ADR 0403). |
| 234 | LaTeX to Word maths converter | EXP-054, EXP-096, EXP-105 | We build our own converter. texmath is not used. This is the owner's choice against the recommended option. |
| 235 | Time target for the final PDF export | EXP-060, EXP-063 | The 10 s target applies to the preview only. The final export gets its own longer target, to be measured on the reference machine. No pre-started sandboxes are built for this reason. |
| 236 | Budgets of the Rust text module | WASM-007, WASM-012 | The proposed size and start-up budgets are accepted, with the Unicode tables counted inside the module. WASM-007 criterion 5 is reworded to match. |
| 237 | Second protocol server | PRO-128, PRO-129 | Not scheduled. The roadmap records it, and the 1.0 freeze stays open. |
| 238 | Word numbering conflicts | EXP-090, EXP-115 | Where Word and our rule give different labels (19 rare cases), Word's labels win. The PDF labels change to match. |

## Recommended options accepted

| # | Topic | Stories | Decision |
|---|---|---|---|
| 239 | Word content controls | EXP-098 | Word's content controls (text, date, drop-down and checkbox boxes) are imported as our own form fields for the common kinds. Some kinds stay preserved. |
| 240 | Word list labels | EXP-100 | The label rules are widened, so labels such as NEW-1-FORMAT match Word on the corpus. |
| 241 | Fonts for Arabic, Hebrew and other complex scripts | EXP-037 | The Noto families (OFL) are used. Each face is licence-reviewed and hash-pinned. |
| 242 | Two independent compiles of a sealed PDF | EXP-079 | Two sandboxes in one worker, as built. Each sandbox is single-use and separate. |
| 243 | Markdown renderer for export tests | EXP-088 | markdown-it is added as a test-only tool. Nothing ships to users. |
| 244 | Java Word readers (docx4j and Apache POI) | EXP-097 | Not measured. The comparison closes with the four readers already measured; ADR 0383 recommends building the importer. |
| 245 | Documentation site tools | FND-013 | VitePress and TypeDoc are added as new dependencies. |
| 246 | Layout core for the page view | FE-076 | We keep our own engine. Docen is not forked, and the adapter criterion is struck. |
| 247 | Page view in Firefox | FE-101 | The page view stays unavailable in Firefox for now. Firefox shows the web view with a notice (ADR 0417). |
| 248 | Tolerance for equal page starts | FE-100 | A page start on screen counts as equal to the PDF's when it is within one line. |
| 249 | Kerning of measured and painted text | FE-090 | Measuring and painting both use normal kerning, so lines match exactly. 02 section 9.3 changes. |
| 250 | Table taller than a page in a multi-column section | FE-085 | The table spans pages and is flagged. The criterion is reworded. |
| 251 | Find in page for the page view | SPK-022 | The editor's own find command is used. The browser find bar stays but is not relied on (ADR 0380). |
| 252 | Floating UI for menus and dialogs | FE-020 | Floating UI is added to place menus, tooltips and dialogs near the screen edge. |
| 253 | Browser extensions for compatibility tests | FE-117 | Agents propose the few most widely used grammar-checking and password-manager extensions; the owner approves the list. |
| 254 | Test-only framework hosts | FE-124 | React, Angular, Vue and SvelteKit are added as test-only dependencies for demo hosts. Nothing ships. |
| 255 | Memory measurement of a 100-page document | UX-074 | Script heap, measured in Chromium only, as built (ADR 0329). |
| 256 | Another tenant's time while one is rate-limited | BE-030 | Median and 99th percentile of the other tenant stay inside the usual targets (BE-024). |
| 257 | Memory per room | BE-021 | Reported as a sum and largest per tenant, as built. |
| 258 | Access keys and the Alt key | UX-012 | Alt is kept for access keys. The criterion is reworded, and the known conflict with Firefox and Edge is documented. |
| 259 | Comments on one line or several | UX-031 | Comments stay multi-line. The criterion is reworded to another accessible popup pattern, then checked with a screen reader. |
| 260 | Refusal for a custom block the client cannot use | UX-056 | The refusal is `conflict`, as built. The story wording is reworded to match. |
| 261 | Service acting on behalf of a user | UX-097 | The service checks what it can verify and refuses only where no role could allow the action. The host's stated role is not used. |
| 262 | Stack property test as the S3 property test | UX-091 | The conformance kit's property test counts. The criterion is reworded; no remote mode is built. |
| 263 | Key of each field in `layout.json` | FRW-057 | The criterion is reworded so the key is read from the document by identifier (09 section 7.1). The schema is unchanged. |
| 264 | Signature level reported by an outside provider | FRW-059 | The audit log entry is enough evidence. The criterion is reworded. |
| 265 | Quota for a bulk send | FRW-063 | A bulk send counts rows per calendar month in UTC, like other usage. |
| 266 | Early properties and methods of the web component | FRW-069 | The rewording is accepted. Early properties take effect on upgrade; methods called with no document answer that nothing applies. |
| 267 | Clearing a quota limit | PRO-115 | A quota limit may be set to null (no limit), as the schema allows. |
| 268 | Counters and streams that do not name the tenant | SEC-045 | Both are accepted as stated exceptions, written into the spec and pinned in a test (ADR 0428). |
| 269 | Author names on the wire | SEC-056 | Authors may be named by the host's own user id, as built. The guide already warns hosts against e-mail addresses as ids. |
| 270 | Search index of a document with its own key | SEC-062 | The index is encrypted under the document's key. |
| 271 | Public transparency log | SEC-066 | The Sigstore Rekor public log is used (ADR 0409). |
| 272 | Outside penetration test | SEC-004 | The test is run before the first public release. The owner picks and books the firm. |
| 273 | Second person for an operator's read in an abuse case | SEC-061 | A named security lead is the second person. |
| 274 | Sealing of tenant files | BE-041 | Only tenants who opt in have their files sealed with their own key. |
| 275 | Managed queue for background jobs | BE-072 | None until stage 3. The PostgreSQL queue stays. |
| 276 | Alert paging for hosted service | BE-097 | A named rota covers business hours. |
| 277 | Backup schedule and retention | HIS-039 | The operator sets the schedule and retention. The rule (purge time plus backup retention) is documented; each deployment fills in its figures. |
| 278 | Support period of a previous model version | CDM-050 | The previous version stays supported until the next version after the new one. Support is counted in versions, with no time limit (ADR 0424). |
| 279 | Structure a region editor may change | PRM-063 | A person who may edit only one region may rename it and add styles. They may not change page setup or remove a style. |
| 280 | Product, protocol and package names | SPK-007 | The working names are kept until they are changed, once, before anything is published. |
| 281 | Rust security scanner | WASM-013 | cargo-deny is installed. It checks advisories, licences and sources on each build and downloads the RustSec database each CI run. |
| 282 | Word lists for Thai, Lao, Khmer and Burmese | WASM-016 | ICU4X segmenter data is used. It is loaded only when a document uses these scripts. |
