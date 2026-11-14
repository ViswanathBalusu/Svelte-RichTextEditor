# Second review of the specification, 2026-11-06

**Status:** review record, 2026-11-06, story SPK-027. Written by one review agent; not reviewed by the project owner. It follows the form of the [first review](2026-09-18-pitfall-review.md).

This records the second independent review of the specification: draft 0.2 of 2026-09-18 as it stands after the owner's decisions of 2026-11-06, together with ADRs 0001 to 0020 and the spike results available on that day. It records what the review found, what it changed in the text, and what it proposes.

## 1. How the review was run

One reviewer read in full: docs/spec 00 to 13; ADRs 0001 to 0020 (0020 appeared during the review); PRODUCT.md; the first review; the [story-writing findings](2026-11-06-story-writing-findings.md); the spike results of S3, S6 and S12 (S6 and S12 appeared during the review); and the research notes of 2026-11-06 (Rust and WebAssembly assessment, unit-cost sheet, legal note, borrow list). Stories were read only to check whether a finding is already covered and to place notes. No code was run; the spikes' evidence is taken as reported.

| Lens | Checked against |
|---|---|
| The eight contradictions of the findings note, section 2 | The text on both sides; the S3 and S6 spikes |
| Section 3 of the findings note, item by item | The text each item cites |
| The owner's decisions of 2026-11-06 | Every statement about A1 to A4, the market, the licence, participants, read restrictions, deployment and fields |
| Lossless DOCX (ADR 0017) | 03, 09, ADR 0004, 0015 and 0018, the EXP stories, and how Word files are built |
| Read restrictions (ADR 0019) | 04, 05, 06, 07, 08, 09, 12, 13 and the S12 result |
| Security of ADR 0017 and ADR 0019 | 07 §16, 10, and every path that carries content, positions or metadata |
| Citations in CDM 1 | 03, 09, 13 and the CDM, EXP, FE and UX stories |
| Phase moves | 01, 09, 11, 12, 13 and the stories they affect |

**Which text wins.** Where two texts disagree, the review applied these rules in order:

1. An owner decision beats text written before it.
2. A normative document beats an informative one. 03, 04, 05 and 07 are normative, and so are 08 §2, 09 §4, §6.3 and §9.3, and 12 §3 to §6 and §10. 01, 02 (except the embedding contract), 06, 10, 11 and 13 are informative.
3. The roadmap (11) owns phasing.
4. Where both sides are normative, or the choice changes scope, the review recommends and the owner decides.

**Dispositions.** "Fixed" means the review changed the text; section 6 lists the edit. "Proposed" gives the change the review recommends, often with exact text, without making it: it needs judgement, an owner decision, or a file outside the specification (an ADR, PRODUCT.md or a story). "Open" means a spike or a decision story already owns it.

**Caveat.** One reviewer, not eight. ADR 0017 and ADR 0019 are proposals; S11 has not run, and S12 tested sync, permissions and recovery but not presence, comments, history, search or export, which do not exist yet. Most findings on these two ADRs are inputs for those spikes and their follow-ups. The edits made here have not themselves been reviewed.

## 2. Summary

- **111 findings: 4 critical, 38 major, 69 minor.** The eight contradictions of the findings note are counted among them (section 3: four major, four minor).
- The four critical findings all arise where the two new designs meet each other or the rest of the specification:
  1. **Lossless DOCX export and the original Word package bypass read restrictions** (SR-C1).
  2. **Preserved Word data can be written by any editor and reaches the DOCX writer unchecked** (SR-C2).
  3. **Fields, generated content and rules carry hidden content into visible nodes** (SR-C3).
  4. **Assets, export jobs and caches serve hidden content, and bypass `no-export`** (SR-C4).
- **Contradictions:** five are fixed in the text (1, 2, 3, 6, 7); one needs an edit to ADR 0010, proposed (4); two need the owner (5, tables in headers; 8, what the phase 2 seal contains). The fix for contradiction 1 overrules S6's decision D09.
- **Section 3 of the findings note:** of 50 items, 42 are confirmed, 3 partly confirmed, 1 not confirmed, and 4 changed by ADR 0018 (proposed). Six are fixed by the edits of section 6.
- **37 edits** to 13 of the 14 specification documents (all but 08). **Notes on 79 stories** in 12 epics.
- **Confirmations.**
  - The decisions of 2026-11-06 are recorded consistently in PRODUCT.md, 00 §5, 11 §10 and the ADRs, apart from the stale statements fixed in section 6.
  - ADR 0017's choice of JSON element trees rather than XML text inside the document is sound: the authority checks them without an XML parser and writers serialise them with their own escaping. The weakness is who may write them (SR-C2), not their form.
  - ADR 0019's choice of one log and one authority fits ADR 0001: once a reader's commit is mapped to full positions, the outcome check of 07 §5.1 runs unchanged on the whole document, so read restrictions do not weaken write enforcement. S12's five changes (view token, close and reload on access changes, content reads that check the grants revision, mapped steps first, what a reader may not send) are sound and this review builds on them.
  - S3's resolution of contradiction 3 (`read_only` before P6) agrees with every other text and is adopted.
  - S6's decisions are sound except D09 (contradiction 1) and D01 (SR-N64).
  - The LaTeX security design (typed emitters, math gate, sandbox) is unaffected by the decisions, except that citations add an input language and possibly a second program (SR-M20).

## 3. The eight checked contradictions

| # | Contradiction | Which text wins, and why | Exact fix | Sev. | Status |
|---|---|---|---|---|---|
| SR-K1 | A base older than a snapshot commit: action `reload` (04 §3.2) or `stale_base`, whose action is `rebase` (04 §5 step 3, §8) | 04 §5 step 3 and the §8 table. Nothing is sent out of `seq` order (§5 step 10), so the client has processed `sync.reset` for the snapshot before the rejection arrives; on `sync.reset` it re-applies its in-flight and queued steps and moves failures to recovered edits (§8; SYN-023). "Wait until the confirmed `seq` reaches `head`, then resubmit" therefore succeeds. The only client behaviour 04 §8 defines for `reload` ("discard local state and reload", in the `invalid_op` row) would throw away the work the reset has just saved, against principle 4 of PRODUCT.md. One code then means "base too old" in both cases, as in relay mode (§14). S6's decision D09 (`stale_base` with `reload`) keeps the words of both sentences but gives the client no defined, loss-free behaviour; the SYN open question ("cannot succeed after a snapshot") holds only if the reset did not re-apply in-flight work | 04 §3.2, last sentence, now: "A commit whose `base` is older than a snapshot commit is rejected with `stale_base` and action `rebase` (section 5, step 3). Nothing is sent out of `seq` order (section 5, step 10), so the client has already received `sync.reset` for the snapshot: it has re-applied its local steps to the new content, moving those that fail to recovered edits (section 8), and it resubmits the rest as a new commit." S6's D09 and the generated definition change; PRO-030 and SYN-023 criteria change | Major | Fixed (E13) |
| SR-K2 | A spent tenant CPU budget: `rate_limited` (04 §12) or `quota_exceeded` (06 §12) | 04 §12. 04 is normative; 06 describes the reference implementation. The budget is an admission-control rate that refills (the unit-cost sheet models it as CPU per second, A23), so "retry after `retryAfterMs`" is the right client behaviour, and 04 §8 gives `quota_exceeded` no client behaviour at all | 06 §12, second bullet, now ends: "Exceeding one returns `quota_exceeded`, except the CPU budget in rooms: a commit that would exceed the tenant's budget is rejected with `rate_limited` and action `retry`, as for a connection's budget (04, section 12)." The other quotas can still refuse a commit with a code 04 §8 does not list (SR-N25) | Minor | Fixed (E18) |
| SR-K3 | A locked or archived document: `read_only` (04 §5 step 1) or `permission_denied` through P6 (07 §5.2), once limit 1 of 07 §4 has reduced capabilities to `view` and `comment` | 04 §5 step 1. `read_only` exists for this case and has its own client behaviour (switch the editor to read-only); if P6 ran first, limit 1 would make `read_only` unreachable except for workflows. S3 implemented this order ("`read_only` when no fill is possible, before P6") and its suite passes | 04 §5 step 1 now checks the document's state first: "…reject with `read_only`. This is checked first, so a connection whose capabilities the document's state has reduced (07, section 4) gets `read_only`, not `permission_denied`. Otherwise the connection must hold … (07, rule P6)." P6 gains: "When the document's state is what limits them (`locked`, `archived` or a workflow; section 4, limit 1), step 1 of the authority algorithm rejects them with `read_only` first (04, section 5)." | Major | Fixed (E14, E19) |
| SR-K4 | Checkpoints every 500 commits or 1 MiB, and cold payloads after 180 days (ADR 0010), against 2,000 commits or ten minutes at most every two minutes, and 30 days (06 §2.2, §10; 08 §3, §11) | The specification. It was revised after the first review; ADR 0006's own after-review note says payloads move after 30 days and checkpoints are time-based; ADR 0010's after-review section says checkpoints are time-based, but its Decision and Consequences were not updated. The unit-cost sheet uses the spec's values (A9, A10) | ADR 0010 (outside the specification, so proposed). Decision, second bullet: "Checkpoints (full copies with an attribution map) are written after 2,000 commits or ten minutes of activity, whichever comes first, but at most every two minutes (06, section 2.2). Any version is the nearest checkpoint plus a short replay." Consequences, Bad, first bullet: "…Rows are small, compress well and move to cold segments after 30 days (08, section 11)." | Minor | Proposed |
| SR-K5 | A boxed `tabular` for tables in headers, footers and footnotes (09 §3.2; 03 §10, "tables inside … headers and footnotes cannot span pages") against I10, which forbids tables inside stories and footnotes (03 §8), implemented as the content expression `story_block+` (ADR 0018) | Owner decision, because it sets CDM 1. By rule 2, I10 wins, and the minimal fix is to 09 §3.2 and 03 §10. The review recommends the other way for headers and footers: the controlled-documents market puts tables in headers (document number, revision, page), and under A2 imported header tables would otherwise become preserved atoms that nobody can edit; the first review's fix M-3 added the boxed writer for exactly this case. Footnotes cannot hold a table either way, because their content is `inline*` | Option A (recommended): I10 drops "tables inside stories" and keeps "tables inside footnotes"; ADR 0018's story content admits tables; 09 §3.2 row reads "Inside multi-column sections, headers and footers"; 03 §10 note reads "Tables inside multi-column sections, headers and footers cannot span pages"; EXP-109 stops converting header tables. Option B: 09 §3.2 row reads "Inside multi-column sections"; 03 §10 note reads "Tables inside multi-column sections cannot span pages"; EXP-109 imports header tables as preserved atoms instead of converting them (A2) | Major | Proposed (owner) |
| SR-K6 | The page view adopts the typesetter's breaks (02 §9.7) against L1 "opt-in, from phase 3" (09 §7) | 09 §7, which 06 §10 confirms ("page-break reconciliation is opt-in per tenant") and 11 §6 places in phase 3 | 02 §9.7 now: "When page-break reconciliation is switched on (level L1 of 09, section 7: opt-in per tenant, from phase 3; 06, section 10), the layout engine adopts the typesetter's breaks for paragraphs that have not been edited since, and uses its own for the rest." | Minor | Fixed (E9) |
| SR-K7 | The read view in "phases 1 and 2" (02 §7) against phase 2 (11 §5) | 11, which owns phasing. The read view with the typeset PDF is phase 2 (11 §5); the own read-only painter is phase 3 if the gate allows (11 §6; 13 §12). The phase 1a "PDF panel" (11 §3) is the preview pane (FE-071), not `view="read"` | 02 §7, column "When" of the `read` row: "Phase 2 with the typeset PDF; the own painter in phase 3, if the gate at the end of phase 2 allows it (11, sections 5 and 6)" | Minor | Fixed (E8) |
| SR-K8 | Final PDFs sealed at PAdES B-LT or B-LTA in the phase 2 flow (12 §8.2; the example of 12 §6.1 uses `pades-b-lta`) against long-term validation in phase 4 (12 §13; 11 §7) | Neither as written; owner decision. 12 §8.2 describes the target and 12 §13 and 11 §7 phase it, but nothing says where the boundary lies. The review recommends: phase 2 seals at B-LT, with the time-stamp and the validation data collected at sealing; phase 4 adds archive time-stamps (B-LTA) and their scheduled renewal. Revocation data (OCSP responses, CRLs) is reliably obtainable only while the certificates are current, so a PDF sealed at B-T in phase 2 may not be upgradable to B-LT later. Renewal is the one part that can wait, provided phase 4 arrives before the first time-stamping certificate nears expiry. S8 (SPK-021) records the evidence | 12 §8.2 step 3: "…applies a PAdES seal at baseline B-LT: an RFC 3161 time-stamp and the validation data collected at sealing. Archive time-stamps (B-LTA) and their renewal (step 5) arrive in phase 4 (section 13)." 12 §6.1 example: `"seal": "pades-b-lt"`. 12 §13, phase 2: "seal with a time-stamp and validation data (PAdES B-LT)"; phase 4: "archive time-stamps (PAdES B-LTA) and their renewal" instead of "Long-term validation and re-time-stamping". 11 §5, Workflow: "sealing with a time-stamp and validation data (PAdES B-LT)"; 11 §7, Workflow: "Archive time-stamps (PAdES B-LTA) and their renewal" | Major | Proposed (owner) |

## 4. Findings and dispositions

### 4.1 Critical

| ID | Where | What is wrong | Why it matters | Disposition |
|---|---|---|---|---|
| SR-C1 | ADR 0017 §1, §3; ADR 0019 Decision 5; 09 §11; 07 §12 ("Read an asset"); 06 §4.4; EXP-108 | The package-patching writer copies parts and elements of the original file verbatim. The original file, the source map and the fragment assets are assets attached to the document, which anyone with `view` may read; EXP-108 makes the original file a download for `view`. ADR 0019 says exports run as the requester's projection, but a projection cannot be patched into the original package without copying what the package holds: the text of hidden regions in `document.xml`, comments and footnotes anchored there, document variables, data-binding custom XML parts with hidden values, and the fragments of preserved atoms inside hidden regions. Where imported nodes contain hidden values, the source map's per-node hashes also let short values be guessed offline | A reader barred from a confidential region gets its text by downloading the original file or by asking for a DOCX export. S12's oracle (messages, checkpoints, content reads) does not look there | Proposed for ADR 0017 and ADR 0019: (1) the original package, the source map and fragments are server-only assets that `/assets/resolve` never serves; the original file is downloadable only by principals who see the whole document, so EXP-108's second criterion changes; (2) a patched DOCX is produced only for a requester whose visibility class hides nothing; anyone else gets a package written fresh from their projection, with no original part reused, and the result says it is not a lossless round trip; (3) S12's oracle covers DOCX exports, asset reads and the source map, and S11's corpus includes a document with a confidential region |
| SR-C2 | 03 §4.6; ADR 0017 §2, §3; CDM-051 (fifth criterion); 06 §4.4; 02 §5.2 (clipboard); 10 §3.1, §3.5 | The `preserved` attribute, the `preserved` mark and the preserved atoms are ordinary schema content: a client step can set them wherever the user has `edit`, and CDM-051 says so. The authority checks only the grammar of the element tree (I11) and that a `fragment` is attached, and a user may attach a file they upload (06 §4.4); nothing says a fragment comes only from an import. The clipboard pastes CDM fragments embedded in HTML, which any web page can put there; FE-051 strips identifiers and bookmarks, not preserved data. Nothing limits which OOXML elements a tree may hold | Someone who may edit one region can make the exported DOCX differ from what the editor and the PDF show, or attack whoever opens it: hide text in Word (`w:vanish`), place a frame over another region (`w:framePr`), insert section properties that change other people's pages, add field codes that fetch remote content or run DDE (`w:instrText`), or plant a crafted fragment with arbitrary XML, embedded objects or external relationships, which the writer puts back. This reopens for DOCX the overpainting threat that the math gate closed for PDF (07 §16) | Proposed for ADR 0017, CDM-051, EXP-117 to EXP-119, FE-051 and SEC-039: (1) only import creates preserved data: the authority refuses a client commit that creates a preserved value, mark or atom not already in the document; the import records the hashes of the values it created, and clients may keep, copy within the document or delete them; (2) fragment assets are written only by the import worker, are never accepted as uploads, and can be referenced only in the document they came from or a fork of it; (3) paste keeps preserved data only within the same document; (4) the writer serialises a tree only against an allow-list, per position, of elements the CDM does not model and that cannot change how Word shows other content (no frames, section properties, field codes or relationship references), and drops the rest with a warning; (5) active content that arrives with the original file is SR-M18 |
| SR-C3 | ADR 0019; 03 §4.3 (`toc`), §4.4 (`field.cached`), §7; 12 §3.4, §5, §10 | ADR 0019 hides region content and field values, but not what is computed from them and stored or shown elsewhere. `field.cached` holds "the last computed text": a `ref` to a heading in a hidden region, a `styleRef` in a header that shows a hidden heading, and a `formValue` mirror of a hidden value (12 §3.4) all carry hidden text in a visible node. Labels are computed across regions (03 §7): computed on the projection, clause numbers differ between readers; computed on the full document, they reveal how many numbered items a hidden region holds. The table of contents lists hidden headings unless it is built from the projection. `rule_def` sits in `defs`, readable by everyone, and may compare a hidden value with a literal; the editor evaluates rules locally (12 §5.3), which needs the hidden values; a `formula` derived from a hidden value shows it in a visible field; `field_invalid` rejections and `de-field-change` (`empty`) answer questions about hidden values | These paths carry hidden text and values to readers without access, against ADR 0019's central promise. S12's oracle looks for hidden text and would not recognise a sum, a verdict or a count | Proposed for ADR 0019 and SPK-029: (1) projections redact `cached` on fields that target hidden content, and build the table of contents and lists of figures and tables from the projection; (2) labels are computed on the full document, so that every reader sees the same clause numbers; the review recommends accepting the count this reveals and listing it beside the two accepted leaks; (3) visibility propagates: a mirror or a formula that reads a hidden value is hidden from the same readers; (4) a rule that reads a hidden value is evaluated only by the server for readers without access, its verdict is returned without the value, and a rule literal compared with a hidden value is itself hidden; (5) S12's oracle checks derived values, verdicts and labels as well as text |
| SR-C4 | 07 §12; 06 §4.4, §7; 05 §5.6, §6.1, §6.2; 09 §9.2; ADR 0019 | Three read paths lie outside ADR 0019's list and S12's oracle. *Assets:* "Read an asset: `view` on a document the asset is attached to", so an image in a hidden region can be fetched by any viewer who learns its identifier, for example from a version before the region was hidden, a fork or an export. *Export jobs:* a bare identifier such as `/exports/{jid}` needs only a token that covers its document (05 §6.1), so any reader can fetch an owner's full export and, as an editor, its raw compile log, whose context lines quote the source; nothing says export events go only to the requester. The same path lets a user restricted with `no-export` download someone else's export today, without ADR 0019. *Caches:* pinned reads are "immutable, cacheable" (05 §6.2) and may be cached near users (06 §7; BE-075), but under ADR 0019 they differ by visibility class and stop being valid when access changes | Each is a leak of hidden content; the `no-export` bypass is a defect in the current design | Proposed for 05, 06, 07 and ADR 0019: an asset is readable only through a scope the caller can see; an export job belongs to its requester and their visibility class, and its events and logs go to that requester (and holders of `manage`) only; pinned reads carry `Cache-Control: private`, vary by visibility class, check the grants revision (S12 change 3), and are not cached at shared edges for documents with hidden scopes; S12's oracle covers REST reads, asset resolution and export results |

### 4.2 Major

Four further major findings are contradictions of section 3 (SR-K1, SR-K3, SR-K5, SR-K8).

**Read restrictions (ADR 0019)**

| ID | Where | What is wrong | Why it matters | Disposition |
|---|---|---|---|---|
| SR-M1 | ADR 0019 Decision 3 and change 4; 04 §6, §7 | S12 made mapped steps the normal path, but a commit that touches hidden content still goes to other classes as one diff step "from the first to the last differing position". When such a commit also changes visible content in two places (replace all across a confidential region, accept all, or the `rules` commit at completion that writes formulas and clears hidden values across the document), the step replaces everything between them. ProseMirror maps a step inside a replaced range to nothing, so readers' in-flight and queued steps there are dropped by the client or refused with `rebase_failed`, and their selections and comment ranges collapse to the edge. A reader's own commits never touch hidden content (S12 change 5), so acknowledgements are not affected | Concurrent work of readers with projections is lost at exactly the moments when several participants are active. S12's criteria (convergence, no leak) still pass, because drops converge | Proposed for ADR 0019, SYN and PRO: send the visible parts of such a commit as mapped steps and use diff steps only for the ranges next to hidden content, one per changed range; S12's follow-up measures dropped steps for readers with projections against full readers under the S3 schedules |
| SR-M2 | ADR 0019 Open questions; S12 change 5; 12 §3.2 | S12 closed the paths by which a reader overwrote or copied a hidden value. Deleting the paragraph that holds a hidden value is still allowed and silently destroys a value the deleting person cannot see; cut and paste of such a paragraph is now refused, with no explanation defined | Hidden values are often the ones that matter most (a salary, a price, identity data) | Proposed (owner): deleting a field whose value one cannot read needs `manage`, or is refused with an explanation; the editor explains refused moves |
| SR-M3 | 12 §7, §8.2; ADR 0019 Open questions | Completion creates one export at `completedSeq` with all values flattened, which participants, including `cc`, receive. Either it contains what some participants may not read, or each gets a projection, and then there is no single sealed document and the evidence does not record what each signer saw | A signer must be able to show what they signed, and a confidential value must not reach a counterparty through the final PDF. It shapes FRW-049 to FRW-055 | Proposed (owner): one sealed full PDF held by the owner and the operator; each participant signs over, and receives, a sealed rendering of their own projection; the evidence records the visibility class and the hash of the projection each participant saw; the certificate names what was hidden from each participant by placeholder, never by content |
| SR-M4 | 05 §5.3, §5.4, §5.5, §6.2 (`/regions`, `/history`, `/activity`, `/attribution`); 08 §5, §9; 07 §5.3 | Leaks beyond the two that ADR 0019 accepts: the author and time of commits that touched only hidden content; a peer listed in presence with no caret, who must therefore be in hidden content; region titles and "who can edit" in `/regions`; region identifiers in rejections; rejections that reveal hidden references or use (I4 for a heading that a hidden cross-reference targets, I13 for a key a hidden field holds, 07 §5.3 for a style a hidden region uses, P2 when matching marks a hidden region as moved). Nothing says which visibility governs old versions | Who works on a confidential section, and what it relates to, is often itself confidential | Proposed for ADR 0019: list each and decide. Recommended: commits that change only hidden content carry no author for readers without access; history shows them as one anonymous "hidden content changed" entry; titles are hidden per region; rejections never name hidden scopes; the current visibility governs every version, so revoked access also hides history |
| SR-M5 | 05 §5.6, §7; 13 §5, §10; 06 §16 | The host is told about threads, mentions and changes in hidden content, and `GET /search` returns full text across documents, with nothing that tells the host who may read what. A mention can name someone who cannot read the thread; the host then e-mails them its content | Hosts turn webhooks into e-mail and build catalogue search on this API | Proposed: webhooks carry the scope; `GET /search` takes the principal it searches for and returns only what that principal can read; a mention of a principal who cannot see the thread's scope is refused or becomes a request for access |
| SR-M6 | 03 §4.2; 04 §5, §8; 05 §2, §5.2, §5.3, §5.5, §6.2, §9, §10, §11; 06 §3; 07 §1, §4 | None of ADR 0019 or of S12's changes is in the normative text yet: the `confidential` policy and the projection-only `hidden_region` atom; the view token in `ch.opened` and `resume` (S12 change 1); access changes as a close and a forced reload (change 2); content reads that check the grants revision (change 3, against 06 §3, "content reads do not need the room"); the refusals of change 5 and their code; an `access` object that says which scopes are hidden; the form of an empty commit in `sync.commit`; a feature name; relays, which cannot project, refusing documents with hidden scopes; projection calls in the authority service; a conformance profile | 05 is normative, and PRO-001 generates the wire definitions from it | Proposed: once the owner confirms ADR 0019, CDM, PRO, SYN and BE stories write it in (notes added). Until then 05 §9 should say that a backend that cannot project refuses a document with hidden scopes |
| SR-M7 | 04 §12; 06 §2, §3, §10; unit-cost sheet | S12 measured 1 to 1.3 ms per class per commit at 1,000 pages (median, development machine), above the authority's target of well under a millisecond (04 §12), and a cold projection of about 100 ms per class. Still unmeasured: projected catch-up and history over REST, which need historical documents (06 §4.1's "position maps … need no document" does not hold for projected steps); follower nodes, which must project; preview compiles, which multiply by visibility class and are already the largest variable cost (cost sheet §6); and admission control, which does not count the projection work a commit causes | A cheap commit costs one projection per class, which an attacker can multiply | Proposed: S12's follow-up measures catch-up and compile multiplication on the reference machine; 04 §12 counts projection work in the budget; 06 §10 and the cost sheet gain the per-class factor |
| SR-M8 | 11 §3 to §7; 12 §13; 07 §17 | Read restrictions are required since 2026-11-06, but no phase builds them; 12 §13 says hidden values are "in scope" without a phase | Stories cannot be scheduled, and the 1b exit criteria say nothing about leaks | Proposed (owner): projection plumbing and confidential regions in 1b, after S12; hidden values with the workflow in phase 2 |
| SR-M9 | ADR 0019 Decision 6; 02 §2.2; 04 §8; 08 §5 | An access change is now a close and a forced reload (S12 change 2), which drops undo history, but the client keeps on disk and in caches what it held: journal entries and recovered edits with hidden text, cached pinned reads, PDFs, `layout.json` and old versions. All unconfirmed work goes to recovered edits (5,376 edits in S12's run of 1,000 schedules) | A reader keeps what they may no longer read, on shared computers too, and loses work on every grant change that moves them to another class | Proposed for ADR 0019 and FE: the forced reload purges journal entries, recovered edits and caches that hold content now hidden; S12's suggested refinement (one step from the old projection to the new) keeps the rest of the work |

**Lossless DOCX (ADR 0017)**

| ID | Where | What is wrong | Why it matters | Disposition |
|---|---|---|---|---|
| SR-M10 | 03 §4.6; ADR 0017 Open questions; 09 §6.1; EXP-096, EXP-105 | Inline atoms have nowhere to keep their original XML: `preserved` exists on block and definition nodes and as a mark on text, not on `equation`, `image`, `field`, `footnote` or `anchor`. An edited paragraph is regenerated, so its equations are rebuilt from LaTeX (a lossy conversion, or an image), its pictures from CDM attributes (crop, effects and EMU sizes lost), and fields of kinds the CDM lacks are lost. 09 §6.1 said imported Office math "becomes an image" (fixed, E20); EXP-105 and EXP-096 still say so | Typing one word in a paragraph with an equation or a picture breaks R1 (c) and (d), on the commonest edits of academic and technical documents | Proposed: inline atoms get a `preserved` attribute holding the original element and a hash of the modelled attributes, as ADR 0017's open question suggests; decided in S11 before `cdm: 1` |
| SR-M11 | ADR 0017 §1; EXP-118, EXP-119 | "Unedited by hash" ignores dependencies and identifiers. A verbatim element can carry a table-of-contents result, cross-reference and sequence results, a list instance number (`w:numId`), comment range markers, and bookmark, footnote, revision and relationship identifiers. They go stale or dangle when other parts change: a referenced heading is renamed; a thread is resolved or deleted while comments are regenerated from the thread store; numbering is regenerated; a fragment's relationships are renumbered | Word shows stale contents and references, or a repair prompt, which R2 and the "no repair prompt" target exclude | Proposed for ADR 0017 and SPK-028: an identifier policy (original identifiers kept; new ones from ranges that cannot collide; references inside verbatim elements may be rewritten); dependency rules (generated field results regenerated, or `w:updateFields` set, when their sources changed); scripted S11 edits that rename a referenced heading, delete a commented paragraph and change numbering |
| SR-M12 | ADR 0017 §2; 03 §2 (units); ADR 0018 (borders); 09 §12; EXP-106 | Integer twips cannot hold some Word values exactly: border widths are in eighths of a point, pictures in EMUs. Theme colours and theme fonts (`w:themeColor`, `w:asciiTheme`) stay in preserved data and override an edited `color` or `fontFamily` in Word. Font substitution at import (09 §12; EXP-106) would write Carlito back where the file said Calibri | Each makes an edited, or merely re-exported, file differ from what the editor showed or from the original | Proposed for ADR 0017: (a) the source map keeps the original lexical value of a modelled attribute, reused while the modelled value is unchanged; (b) a precedence table: editing a modelled property removes the preserved attributes that override it in Word; (c) substitution is for display and typesetting only, and the CDM keeps the family the file names, as 02 §6 already implies |
| SR-M13 | ADR 0017 (R1) | "Every element outside the edited content is unchanged" has no granularity. ProseMirror merges adjacent text nodes with equal marks, so inside an edited paragraph the original runs, their revision-session identifiers and the positions of `w:proofErr` and bookmarks cannot be kept. "Compared as canonical XML" names no canonicalisation | S11 and EXP-120 need a pass-or-fail rule that two people compute the same way | Proposed: R1 (b) at block level (paragraph, table row and cell, section properties); runs inside an edited block are regenerated; name the canonicalisation (for example exclusive XML canonicalisation, which the borrow list's `xml-crypto` implements) and S11's tolerance |
| SR-M14 | 03 §5; 07 §15; 09 §12; ADR 0017 R1 (c); EXP-103 | Marks carry no time, so an edited paragraph loses the dates and original author strings of its imported tracked changes. Revision kinds the CDM cannot express (moves, formatting changes with their previous properties, numbering changes, cell insertions, deletions and merges, section property changes) have no home inside editable paragraphs. 03 §5's check that `user` equals the submitting user refuses the import labels that 07 §15 requires | Review is a first-release capability in all three markets, and tracked changes are what people most often send through Word | Proposed: S11's corpus covers each revision kind; the source map keeps revision metadata keyed by suggestion `id`; 03 §5 gains "except in a commit with origin `import`, where `user` may be an import label (07, section 15)"; the owner decides whether revisions the CDM cannot express are accepted or rejected at import with the importer's consent, or keep their paragraph preserved |
| SR-M15 | ADR 0017 §3; 09 §12; 12 §12; EXP-095 | Content controls that the model does not map become preserved atoms nobody can edit or fill, yet content controls are how Word forms carry their blanks. For mapped controls, Word re-reads a bound control from its custom XML part, so copying the original part verbatim while writing new values into the controls makes Word show the old values | Imported forms, the native format of the agreements-and-forms market, arrive dead or show stale values | Proposed for EXP and FRW: decide in phase 2 how plain-text, rich-text, date, drop-down and checkbox controls map to `form_field` kinds, and block rich-text controls to regions; the writer treats a bound control and its custom XML part as one unit; S11's corpus includes forms |
| SR-M16 | 03 §4.4, §4.6, §13; ADR 0017 §3; CDM-001 | Imported footnotes of several paragraphs must be merged (lossy) or preserved (not editable); endnotes are in neither preserved list; comment parts are an open question of ADR 0017. The footnote content decision (CDM-001, S1) was framed before A2 | `cdm: 1` freezes the footnote content model | Proposed: CDM-001 weighs A2 (recommended: `paragraph+`, limited to one paragraph for editing, with longer imported footnotes preserved whole); endnotes become preserved inline atoms with their part; comment parts are regenerated from the thread store, with original metadata kept in the source map |
| SR-M17 | ADR 0017 §3; 09 §1; A3 | The LaTeX writer typesets a preserved atom's fallback, and many have none: charts carry no picture, SmartArt carries drawing shapes, text boxes carry text without an image. The PDF of an imported document then shows labels ("Chart") where content was | Final output is typeset by LaTeX (R5); a chart missing from a sealed report changes the document | Proposed (owner): render fallback images at import in a sandboxed renderer run as a separate tool (the borrow list allows LibreOffice only that way), or accept labels and say so in the import report, the preflight and the PDF |
| SR-M18 | ADR 0017 §3; 09 §12; 10 §3.5; EXP-090, EXP-117 | Preservation writes back active content from the original file to everyone who exports: embedded objects (including macro-enabled workbooks inside a .docx), external relationships (remote templates on network paths, linked pictures) and field codes. 10 §3.5 said embedded objects are dropped (fixed, E22). EXP-090's "no external relationship" contradicts hyperlinks, which are external relationships, and A2 | The service distributes content it never inspected to people who trust its output | Proposed: the import report lists active content; fragments are scanned for malware; a tenant option strips active content, breaking R0 on purpose and saying so; the writer adds no external relationship of its own except hyperlinks |
| SR-M19 | ADR 0017 §1; ADR 0018 (canonical-form version); 03 §11.3; 08 §8; 12 §9 | The source map compares hashes computed under the CDM and canonical-form versions of the import. A migration or a new canonical-form version changes every hash, so every node then looks edited and R0 fails. A fork, a template instance or a bulk send carries the content but not the source package and map | Migrations are planned (an n-1 window); templates and bulk send are how forms are reused | Proposed: a migration recomputes the import hashes with the same transform, or the map records the canonical-form version and the writer compares under it; fork copies the source package and map |

**Markets, phases and the model**

| ID | Where | What is wrong | Why it matters | Disposition |
|---|---|---|---|---|
| SR-M20 | 03 §13; 09 §4, §8, §9.3; 13 §2; A3; CDM-052, EXP-121, EXP-122, FE-140, UX-103 | Citations reach further than 03 §13 says. biblatex normally runs biber, a second program, inside the sandbox; the `.bib` data is a new input language that the emitters of 09 §4 do not cover; extra passes raise compile cost; one house class (A3) meets an academic market used to journal citation styles; Word citations (CITATION fields and a sources part) and reference-manager fields must round-trip under A2; the editor would render a bibliography with a different engine from the PDF; 11 places none of it | Two of these are security boundaries (the sandbox and the emitters); the rest are scope | Proposed: a `bibField` emitter with fuzzing, or a converter that writes the bibliography itself so that no second program runs; 09 §9.3 names biber if it runs; the owner decides which citation styles the house class offers; CDM-052 lands before `cdm: 1`; 11 places citations (the stories say 1b for the model and the PDF, 2 for DOCX) |
| SR-M21 | 11 §5, §9; ADR 0017 (Consequences) | Phase 2 gains the package-patching writer, which ADR 0017 calls more work than the direct writer, on top of history, review, workflow, signing, import, HTML and Markdown, the experience items and governance, and probably hidden values and the DOCX side of citations. The risk register has no entry for the long tail of Word's features under lossless round trip, nor for a leak through a missed projection path; risk 12 cited A2 as a mitigation (fixed, E27) | Phase 1 was split for the same reason in the first review (PD-2) | Proposed (owner): decide whether to split phase 2 (for example 2a: history, review, import and export; 2b: workflow, signing, sealing); add risk 17, "Lossless round trip meets the long tail of Word's features" (high, high; mitigation: S11's corpus, R0 and R1 in CI, the preservation layer), and risk 18, "A missed projection path leaks hidden content" (medium, high; mitigation: S12's oracle over every outgoing path, one projection function per visibility class) |
| SR-M22 | 03 §4.1 (`numbering_def.levels.text`); ADR 0018 Open questions; EXP-109 | The numbering template grammar allows only `%1` to `%9`, the punctuation `. ( ) - §` and space, so "Article %1", "Section %1.%2" and "Schedule %1" cannot be modelled, and EXP-109 would drop them on import | These templates are standard in agreements, one of the three markets, imported or not | Proposed: widen the grammar to letters and digits in any script, spaces and punctuation, plus placeholders, kept safe by the `text` emitter, as a CDM-002 decision before `cdm: 1` |

**Permissions, history and sync**

| ID | Where | What is wrong | Why it matters | Disposition |
|---|---|---|---|---|
| SR-M23 | 13 §6.2; ADR 0014; 04 §3.1; 05 §3.1; 08 §2; UX-044 | 13 §6.2 and ADR 0014 promise that the server caps an assistant at `suggest` and that history separates what a model wrote, but `origin` is a client claim, no token claim or channel identifies an agent, and P4 caps users who hold `suggest` without `edit`, not agents acting for editors | A security claim that the design cannot yet enforce | Open in UX-044. Recommended: a separate agent token with an actor claim in the manner of RFC 8693, whose capabilities the room caps; until then 13 §6.2 should not claim server enforcement |
| SR-M24 | 03 §4.1 (`settings.trackChanges`); 07 §5.2; 13 §5; S3 | `trackChanges` is in `defs`, so `structure` changes it, and document-level editors hold `structure`; 07 §5.2 says only `manage` switches it off; while it is `everyone`, P4 applies to every user, so the direct change to `off` is refused for everyone, owners included. S3 implemented "turning it off needs `manage`" | Either editors can switch off enforced review, or nobody can | Proposed for 07 §5.2: "Changing `settings.trackChanges` requires `manage`, and P4 does not apply to that change" |
| SR-M25 | 12 §4.3; 07 §11; ADR 0018 (subtree hashes); FRW-011, PRM-047 | 12 §4.3 allows fills inside approved regions; 07 §11 says nothing may change an approved region and binds the approval to the region's canonical hash, which includes field values | The conformance kit would test both | Proposed: the approval hash excludes `form_field` values, and 07 §11 adds "except fills under P7 and server commits with origins `sign` and `rules`" |
| SR-M26 | 12 §3.4, §6.2; 07 §4 (limit 1); FRW-086 | Once `send` locks the document, limit 1 leaves `view`, `comment` and `fill`, so the region granted to a role for a long answer (12 §3.4) cannot be written | Long answers are a stated workflow feature | Open in FRW-086. Recommended: limit 1 keeps `edit` in regions granted to a role whose participant is active |
| SR-M27 | 12 §4.2 (P7), §13; 05 §3.1; FRW-083 | Form mode in phase 1b has no source for a participant's roles and no meaning for "active" without a workflow: `wfp` names a participant, not roles | A phase 1b capability cannot be built | Open in FRW-083. Recommended: a claim listing role placeholders (for example `wfr`), with "active" meaning "while the document is not locked" |
| SR-M28 | 07 §8; 08 §9; 05 §6.2; 12 §10; HIS-023 | `minVisibleSeq(user)` cannot express the default setting `editors` (named versions only), and 07 §8's list omits `GET /threads?seq`, `GET /field-values?seq`, `restore` with `toSeq` and `dryRun`, and `POST /versions` with `seq` | The gate is normative and tested on every endpoint | Open in HIS-023. Recommended: a predicate over (user, `seq`), and the complete list of inputs |
| SR-M29 | 08 §8 | A region restore that is too large "falls back to a snapshot commit", which replaces the whole document, cannot be rebased over, resets every client, and could overwrite commits made in other regions after it was computed | A region restore must not touch other regions (07 §13) | Proposed: split the restore into several commits, or refuse it with `too_large`; never a snapshot |
| SR-M30 | 04 §8; PRODUCT.md principle 4; 12 §6.2 | Only `permission_denied` keeps discarded content as recovered edits. `read_only` (the document was locked while someone typed) and `invalid_op` throw typed text away; 12 §6.2 already sends unsent values to recovered edits on `read_only` | "Work is never lost" | Proposed for 04 §8: every rejection with action `drop` or `reload` keeps the discarded content as recovered edits |
| SR-M31 | 03 §8 (I4 on `field.target`); ADR 0019 | Deleting a heading, numbered paragraph or bookmark that a cross-reference targets makes the commit invalid, so a single reference freezes its target; under ADR 0019 the reference may be where the deleting user cannot see it | Ordinary editing is blocked by content the user may not be able to find | Proposed: a dangling `field.target` is allowed and shown as a broken reference, as Word does; I4 keeps definitions, stories and assets |

**Protocol, frontend and definitions**

| ID | Where | What is wrong | Why it matters | Disposition |
|---|---|---|---|---|
| SR-M32 | 05 §2, §5.7, §5.8, §6.1, §6.2, §10; 04 §3.1, §4; S6 | S6 found 100 gaps and concluded that the control plane "cannot yet be implemented without guessing": no HTTP status for any code, no bodies for most routes including `POST /tokens`, no purpose for `jwks_uri`, no mapping from fatal errors to close codes, no transport for the authority service, no rejection code for an empty commit, a disallowed step type or a reserved origin, and no rule on whether identifiers on the wire are `sub` or the per-tenant surrogate (G11). Twelve gaps change wire behaviour the kit will pin | R6 is the product's claim; PRO-001 and PRO-002 generate the definitions from this text | Fixed in part: G19, G37, G39 and G40 (E13 to E15, E18, E19). Proposed: S6's decisions D02 to D08 and D10 to D27 move into 05 (D01 amended, SR-N64; D09 replaced by SR-K1); G50 (HTTP statuses) and G11 are settled before PRO-001 and PRO-002 publish |
| SR-M33 | 02 §2.2; FE-008 | The journal has no defined behaviour when IndexedDB is unavailable or full, when two tabs open one document, or on shared computers; under ADR 0019 it can also hold content later hidden | It is the product's answer to "work is never lost", and it keeps document content on disk | Proposed: a "not protected" save state when the journal cannot write; one tab owns a document's journal through a lock; the host can ask the element to clear its journal at sign-out; access resets purge it (SR-M9) |
| SR-M34 | 07 §5.3 | Protection of definitions covers styles, numbering definitions and page setups that regions use, not `settings` (language, hyphenation, default tab stop, footnote format), `role_def` or `rule_def` | An editor with `structure` can change how approved and restricted regions hyphenate, or which of their fields are required, which 07 §5.3 exists to prevent | Proposed: a change to `settings` needs `manage` once any region is restricted or approved; role and rule changes need the rights of the regions whose fields they touch |

### 4.3 Minor

Four further minor findings are contradictions of section 3 (SR-K2, SR-K4, SR-K6, SR-K7).

| ID | Where | What is wrong | Why it matters | Disposition |
|---|---|---|---|---|
| SR-N1 | 00 §1 | Fields "assigned to people"; 12 §2 says roles, never people | Contradicts the field model | Fixed (E1) |
| SR-N2 | 00 §7 | The glossary's capability list lacks `fill`; its scope lacks the top level and field values | Disagrees with 07 §1 | Fixed (E2, E3) |
| SR-N3 | 00 §10 | Licence, legal note and first market listed as open | Stale after the decisions | Fixed (E4, E5) |
| SR-N4 | 00 §4 | No requirement names read restrictions; stories trace them to R3, which speaks only of changing | Traceability (FND-014) | Proposed: R3 adds "…; some regions and field values can be hidden from some readers (ADR 0019)" |
| SR-N5 | 01 §3 | Key decisions stop at ADR 0015 | Readers miss four decisions | Fixed (E6) |
| SR-N6 | 01 §6 | `export-docx` "(phases 2 and 4)" | Stale after the phase move | Fixed (E7) |
| SR-N7 | 01 §2, §7; 06 §4.3 | "Redis or Valkey": Redis 8 and later is under RSALv2, SSPLv1 or AGPLv3, which the licence gate denies (borrow list §14, §15) | A self-hosted distribution could ship a denied licence | Proposed (main session): name Valkey |
| SR-N8 | 01 §7; 09 §9.3 | "PDF.js inside the component" and "a sandboxed cross-origin frame" agree only if the frame is the component's; who serves the frame's origin, and which `frame-src` a host must allow, are unstated | A deployment requirement nobody owns | Proposed: 09 §9.3 names the viewer origin as a deployment requirement; S2 records `frame-src` |
| SR-N9 | 02 §6 | The subsetting rule covers reserved font names only; the legal note adds trademark notices (Noto) and no subsetting in version 1 | Licence compliance | Proposed: align 02 §6 with the legal note §4.2 |
| SR-N10 | 02 §3, §5.2, §10 | The 02 items of the findings note (section 5): region guard wording, "select all" inside a region, inherited CSS properties crossing the shadow boundary, KaTeX outside the lazy chunks, a text alternative for equations, Ctrl+F6 | Each leaves FE to guess | Proposed: see section 5 |
| SR-N11 | 03 §1 principle 4 | "The DOCX writer can approximate it" predates A2 | Stale | Proposed: "…and the DOCX writer can write it so that Word shows what the editor shows (R2 of ADR 0017)" |
| SR-N12 | 03 §4.3, §4.6; ADR 0017 §3 | `table_cell` content omits `preserved_block`, which 03 §4.6 allows in cells; 03 §4.6 lists fewer kinds than ADR 0017 (linked objects, ink, alternate content); neither lists endnotes | The schema generator needs one list | Proposed (CDM-051) |
| SR-N13 | 03 §7 | `dateSigned` called a field; it is a form-field kind | Two node types confused | Fixed (E10) |
| SR-N14 | 03 §8 (I10) | Form fields in stories and footnotes are banned by 12 §3.2 and ADR 0018, but by no invariant | The authority enforces invariants, not prose | Fixed (E11) |
| SR-N15 | 03 §10 | The writer-support table predates A2: floating figures "No" for DOCX though imported ones are preserved; math "Partial" though imported equations must round-trip; no rows for preserved content or citations | The published table (CDM-046) would mislead | Proposed (CDM-046) |
| SR-N16 | 03 §13 | Nested tables, floating figures, text boxes and endnotes "excluded"; under A2 imported ones are preserved | Stale | Fixed (E12) |
| SR-N17 | 03 §2, §4, §8, §9; ADR 0018 | Most open items of 03 are decided in ADR 0018 (proposed): the grammars, the canonical-form gaps, the grammar of definition identifiers (under which `ps1` is valid), the mid-split rule, I6 with row spans, "present in every document" read as "available". 03 still says otherwise in places. Also: I3, I4 and I8 need context beyond the document; the `title` field has no data source; `restartAfter`, `numberingRestart` and footnote counting are undefined | Two texts disagree until ADR 0018 is accepted | Proposed: accept ADR 0018 and edit 03 to match; 03 §8 says `model.validate()` takes a context; CDM-005 and CDM-042 define the numbering terms; decide the `title` source (the document resource at export, outside the hash) |
| SR-N18 | 03 §4 (`ext`) | `ext` is one attribute, so concurrent changes to different keys overwrite each other | Against the one-attribute-per-property rule of 03 §4.1 | Proposed: accept for version 1, and move busy keys out at the next major version |
| SR-N19 | 03 §8 (I2); 07 §5.2; 04 §5 step 9; S3 | S3's choices are not in the text: "a non-null `id` never changes for its only holder"; creating a restricted region needs `manage`; region moves are detected by longest common subsequence; one write carries commits checked against one grants revision | The kit will test the text, not the spike | Proposed: write them into 03, 07 and 04 once the owner accepts S3 |
| SR-N20 | 05 §5.1 | `auth.ok` used but not listed (S6 G19) | The AsyncAPI is generated from the table | Fixed (E15) |
| SR-N21 | 05 §5.6, §7, §8.1; 12 §10 | Socket `document.updated` against webhook `dep.document.changed`, against the "same stems" rule (S6 G49); no DOM events for threads, versions, presence or mode changes; workflow webhooks missing from 05 §7 and named inconsistently (G85) | Three vocabularies for one thing | Proposed (PRO): one stem per event; S6's D17 for workflow names |
| SR-N22 | 06 §2.1; 05 §6.2 | `GET /documents/{id}/connect` is not a DEP resource (G78) | The component reaches the backend only through DEP | Proposed: add to 05 §6.2 as optional, behind a feature, from stage 2 |
| SR-N23 | 05 §3.3; 06 §4.1 | `POST /sessions/revoke` takes a document, but only a per-user `revoked_before` is stored (G09) | Revoking one document revokes all of them | Proposed: a watermark per user and document, or drop the parameter |
| SR-N24 | 05 §8.1; 07 §12; 13 §2, §8 | No default for `view` or `mode`; no property for strings and icons, which hosts may replace (13 §8); no setting for the destroy grace period; import is built in (13 §2) but service-credential only (07 §12; S6 G79, D16), and the element has no import method | Integrators guess | Proposed (PRO-077, PRO-079, PRO-081) |
| SR-N25 | 04 §8; 05 §5.8 | `quota_exceeded`, `forbidden` and `internal` can reach `sync.reject` with no client action in 04 §8 (S6 G34) | Undefined client behaviour | Proposed: a row for each; `quota_exceeded` keeps the content as recovered edits and tells the user |
| SR-N26 | 06 §4.1; 08 §2, §4, §11 | No column for the payload hash that 08 §2 and §11 rely on; `versions.kind` omits `sent` and `completed` | The chain could not be verified after thinning | Fixed (E16, E17). The byte layout is provisional in ADR 0020 (proposed); HIS-002 publishes it |
| SR-N27 | 06 §11; 10 §3.7 | The support dump replaces text runs, not the strings inside preserved trees and fragments (field codes, text-box text, chart caches) | Support staff could read content | Proposed: the dump replaces every string in preserved data and omits fragments |
| SR-N28 | 06 §2.1, §2.4, §4.4; 02 §9.4, §9.7; 09 §8; 13 §9 | Unspecified numbers: node liveness lease, rate limits, send-queue bound, asset limits, signed-URL lifetime, page-overflow tolerance, footnote iteration limit, "usable" at 300 pages, a cap on compile passes and the outcome when references do not converge. The region lease is specified (07 §10); the partition count is now 64 in ADR 0020 (proposed) | Untestable without a value | Proposed: each owning story sets a target and says it is one |
| SR-N29 | 08 §3, §11 | "A replay of at most 2,000 commits" fails once checkpoints are thinned to daily and weekly, or when 2,000 commits arrive within the two-minute floor | A stated bound that does not hold | Proposed: the bound holds within the unthinned window, and thinning keeps at least one checkpoint per 2,000 commits |
| SR-N30 | 07 §5.2 (P3) | "A region's two boundaries" is wording from range markers | Misleading since ADR 0009 | Proposed: "A step may not join a region's content with content outside it, or split a region; structural changes are whole-node operations (P2)" |
| SR-N31 | 07 §3; 04 §3.2; 08 §2 | 07 makes every lease change a control commit; 04 and 08 list only lease breaks; heartbeats as control commits would fill the log | Log growth | Proposed: acquisition, release, break and expiry are control commits; heartbeats are not |
| SR-N32 | 07 §4 | A `viewer` region grant lowers a document `commenter` to `view` in a restricted region | Surprising for owners | Proposed (owner): a grant never lowers the document-role fallback |
| SR-N33 | 02 §5.2; 03 §5; 07 §17 | Three lists of block suggestions: whole rows and cell content (02); paragraphs, whole rows and whole tables (03); paragraphs and rows (07) | P4 cannot be specified against three lists | Proposed: 03 wins (normative); 02 and 07 aligned; PRM-062 specifies P4 for each |
| SR-N34 | 07 §15; EXP-094 | The exported DOCX carries "the original grants" in a custom XML part, telling anyone with the file who may edit, and under ADR 0019 read, what; under A2 a re-import would preserve the part and export it again, stale | Disclosure and staleness | Proposed: export grants only on request; the importer discards parts that the writer generates |
| SR-N35 | 07 §12 | The matrix has no rows for reading grants or regions, read markers, activity, asset URLs, comment edits, the document state, or any resource of 12 (S6 G80) | Negative tests cannot be written | Proposed (PRM-056) |
| SR-N36 | 08 §6 | On deleted spans, `user` is the deleter in the changeset path and unavailable in the block-aligned path | One field, two meanings | Proposed: `deletedBy` where known; `author` from the attribution map |
| SR-N37 | 09 §2, §11 | The `tex` download "compiles outside the service", but fonts are not in the bundle | The claim is false as written | Proposed: "compiles outside the service with the fonts of the manifest", with the bundle naming them by hash |
| SR-N38 | 09 §6.1 | Imported Office math "becomes an image" | Contradicts A2 | Fixed (E20) |
| SR-N39 | 09 §15 | Citations listed as open without the decision | Stale | Fixed (E21) |
| SR-N40 | 10 §3.5 | "Embedded objects are dropped" | Contradicts A2 and 09 §12 | Fixed (E22) |
| SR-N41 | 10 §1, §3, §5 | No asset, threat or test for read restrictions or preserved content | The threat register (SEC-001) follows 10 | Proposed: rows from SR-C1 to SR-C4, SR-M1 to SR-M5 and SR-M18 |
| SR-N42 | 11 §2 | Cross-reference to section 9 for the decisions; spike S10 missing from the table | Wrong reference; incomplete table | Fixed (E23, E24) |
| SR-N43 | 11 §3 | Phase 1a lists only PostgreSQL, but its exports need object storage (BE-003 and BE-005 already infer it) | The 1a compose file needs it | Fixed (E25) |
| SR-N44 | 11 §5 | 00 §5 says the Word-pagination question was added to the gate; the gate did not mention it | Broken cross-reference | Fixed (E26) |
| SR-N45 | 11 §9 | Risk 12 cites A2 as a mitigation | A2 now adds scope | Fixed (E27) |
| SR-N46 | 11 §10 | Items 8 and 12 decided but not marked | Stale | Fixed (E28, E29) |
| SR-N47 | 12 §12 | Custom parts hold every value; EXP-095 already redacts per requester, but 12 does not say so | 12 is normative for fields | Proposed: "…hold only the values the requester may read (ADR 0019)" |
| SR-N48 | 12 §13 | "DOCX round trip of fields" in phase 4 | Stale after the phase move | Fixed (E30, E31) |
| SR-N49 | 12 §15 | Questions 1 and 8 decided but not marked | Stale | Fixed (E32, E33) |
| SR-N50 | 12 §5.2, §6.2, §8 | Null handling, decimal precision, the regular-expression subset and presets are undefined; whether `cc` counts toward completion, what `resume` resets, and the failure paths when compiles disagree or signing is unavailable are open | The rules language must be fixed before phase 2 | Open in FRW-014 and the FRW open questions |
| SR-N51 | 13 §2, §13 | Citations "through ports unless the first market is academic"; non-goals without "creating or editing"; citations still an open issue | Stale after the decisions | Fixed (E34 to E37) |
| SR-N52 | 13 §5 | `no-export` conflicts with the PDF preview, the read view and printing, which export jobs produce | A restricted user loses the read view | Proposed: `no-export` blocks downloads, not on-screen previews; `no-print` governs printing |
| SR-N53 | 13 §3 | A page count in the status bar beside "no fake pages" in the web view | Principle 3 of PRODUCT.md | Proposed: the count comes from the last compile and says so |
| SR-N54 | 13 §2; 05 §8.3 | Translate, text prediction and read aloud come "through ports", but only proofing and assistant ports exist | A parity claim without a mechanism | Proposed: "through extensions", or define the ports |
| SR-N55 | 13 §11.1, §12; UX-077 | Hosts must register keys and origins from phase 1a; the administration API is phase 2 | The 1a demo needs registration | Proposed: 13 §12 says that phase 1a seeds keys and origins from configuration, as UX-091 does |
| SR-N56 | ADR 0005 | Not updated for A2 (the Word-pagination question at the gate) or ADR 0016 | The record of the page view is incomplete | Proposed: a short section "after the owner's decisions" |
| SR-N57 | ADR 0019 Decision 5 | "an operator with `manage`" mixes the operator (00 §6) with a capability | Ambiguous about who may export in full | Proposed: "a user with `manage`" |
| SR-N58 | PRODUCT.md | "Decision records: docs/adr/0001 to docs/adr/0017"; "Draft 0.2 has not had a second review" | Stale | Proposed (main session): 0001 to 0020; the second review is recorded here |
| SR-N59 | Stories | Stale notes: SPK-002 (the phase question is decided), EXP-118 (a sentence still places it in phase 4), FE-072 and FE-100 (the contradictions are now fixed), the SYN open questions on contradictions 1 and 2 | Readers act on stale text | Notes added where this review annotated the story (section 7); SPK-002 is for the main session |
| SR-N60 | Findings note §1 | Five gaps marked in stories remain in the spec: comment reactions, hiding the header and its events, the export-identities callback, comparing to DOCX tracked changes, picture crop attributes | The stories point at nothing | Proposed: each owning epic writes the missing resource or attribute into the spec |
| SR-N61 | Unit-cost sheet | Predates ADR 0017 and ADR 0019: no preservation overhead, no per-class previews | Pricing inputs | Proposed: re-run after S11 and the S12 follow-up |
| SR-N62 | Legal note §6.4 | Apache-2.0's patent licence attaches to the code, not to teams that implement DEP from the prose | R6 invites such teams | Proposed (owner, with counsel): a specification licence with a patent commitment, for example the Open Web Foundation Agreement 1.0 |
| SR-N63 | Borrow list | No entry for citation processing (biber, citeproc-js, CSL styles) | The licence gate (FND-011) cannot check it | Proposed: add with SR-M20 |
| SR-N64 | S6 decision D01 | Closing `code` as an enumeration within version 1 stops a minor version from adding an error code, which ADR 0019 and others will need | Rigid protocol evolution | Proposed: keep `action` closed and make `code` open, receivers acting on `action` and `retryable` for an unknown code |
| SR-N65 | ADR 0020 | Sessions stored as `text`, though 01 §8 makes them UUID version 7; the room's `StoredCommit` lacks `base`, `rebased`, `jti` and `agent`, which 08 §2 requires recording from the first release, so the provisional chain hashes nulls for them | A normative MUST unmet in 1a, and a chain layout that must change later | Proposed: align sessions with 01 §8 or amend 01 §8; HIS-001 adds the missing fields before the 1a exit |

## 5. Section 3 of the findings note, item by item

Verdicts: **confirmed** (the text says what the item says), **partly confirmed**, **not confirmed**, or **changed** (a decision or a proposed ADR settles it).

**02 Frontend**

| Item | Verdict | Disposition |
|---|---|---|
| The region guard "filters" transactions, while a deletion across scopes removes only the permitted parts (07 §7) | Partly confirmed: compatible if cross-scope commands trim themselves before the guard sees them, but neither text says so | SR-N10: 02 §5.2 to say that commands spanning scopes, such as a deletion across regions, first trim themselves to the permitted parts |
| "Select all" limited to the body, while selections starting in a region are clamped to it | Confirmed: which rule applies inside a region is undefined | SR-N10: inside a region the first "select all" selects the region, the second the body |
| 05 §8.1 has no default for `view`, no string catalogue, no destroy grace period | Confirmed, and no default for `mode` either | SR-N24 |
| Nothing keeps inherited CSS properties out of the shadow root (R2) | Confirmed: inherited properties cross the boundary by design | SR-N10: reset inherited properties on the host and test with a hostile host page |
| The journal has no behaviour when IndexedDB is unavailable or full, for two tabs, or on shared computers | Confirmed, and wider under ADR 0019 | SR-M33, SR-M9 |
| KaTeX display not among the lazy chunks; no text alternative for equations | Confirmed | SR-N10 |
| No values for the overflow tolerance, the footnote iteration limit or "usable" at 300 pages; some browsers reserve Ctrl+F6 | Confirmed; 13 §4 already requires the shortcut table to name alternatives | SR-N28, SR-N10 |

**03 Document model**

| Item | Verdict | Disposition |
|---|---|---|
| Defaults, enumerations, ranges, built-in styles, bullets, `field.target`, `ext` keys and `fmt.before` not given | Changed: ADR 0018 (proposed) decides each | SR-N17 |
| The canonical form is silent on empty content, defaults inside objects, subtree hashes and versioning | Changed: ADR 0018 (proposed) | SR-N17 |
| The example's `ps1` against random identifiers | Changed: under ADR 0018 definition identifiers have their own grammar and `ps1` is valid; random identifiers are how the editor creates them | SR-N17 |
| I6 ignores row spans; I4 forbids deleting a referenced bookmark or heading; I2, I3, I4 and I8 need context | Partly: I6 changed by ADR 0018; the I4 and context points confirmed | SR-M31, SR-N17 |
| Content expressions cannot express I10; the form-field ban is in no invariant | Changed: ADR 0018 carries what it can of I10 in content expressions; the ban is now in I10 | Fixed (E11) |
| §7 calls `dateSigned` a field; `title` has no data source; `restartAfter`, `numberingRestart` and footnote counting undefined | Confirmed | Fixed (E10); SR-N17 |
| `ext` is one attribute, so concurrent changes overwrite each other | Confirmed | SR-N18 |

**04 Sync engine and 08 History**

| Item | Verdict | Disposition |
|---|---|---|
| No code for commits with no steps, disallowed step types or a reserved origin | Confirmed; S3 and S6 had to choose (`invalid_op`) | SR-M32 |
| The replay bound of 2,000 commits fails with thinning | Confirmed | SR-N29 |
| The hash chain's byte layout is unspecified; no column for the payload hash | Confirmed | Fixed (E16); layout provisional in ADR 0020 (SR-N26) |
| `minVisibleSeq` does not fit `editors`; inputs missing from the gate's list | Confirmed; four inputs named | SR-M28 |
| 08 §6 shows authors on deleted spans | Confirmed | SR-N36 |
| A region restore that falls back to a snapshot has no rule protecting other regions | Confirmed | SR-M29 |

**05 Protocol**

| Item | Verdict | Disposition |
|---|---|---|
| `auth.ok` missing | Confirmed | Fixed (E15) |
| Event names differ between planes; no DOM events for threads or versions | Confirmed (S6 G49) | SR-N21 |
| The mock "from the first phase" against 1b; webhooks in phase 2 against the reference host sending them from phase 1 | Not confirmed as contradictions: the mock exists from phase 0 (S6) and "the first phase" includes 1b; 13 §11.2 lists what the host covers eventually, and webhooks arrive in phase 2 (11 §5) | None needed; SR-N21 covers the vocabulary |
| HTTP statuses, the code for a missing `If-Match`, `POST /tokens` bodies, `jwks_uri`, close-code mapping and the authority service's transport and five calls unspecified | Confirmed (S6 G04, G07, G24, G50) | SR-M32 |

**06 Backend and 10 Security**

| Item | Verdict | Disposition |
|---|---|---|
| `GET /documents/{id}/connect` absent from 05 §6.2 | Confirmed (G78) | SR-N22 |
| `POST /sessions/revoke` takes a document; only a per-user watermark is stored | Confirmed (G09) | SR-N23 |
| `versions.kind` omits `sent` and `completed` | Confirmed | Fixed (E17) |
| Phase 1a lists only PostgreSQL | Confirmed | Fixed (E25) |
| Lease length, partition count, rate limits, send-queue bound, asset limits and signed-URL lifetime unspecified | Confirmed, except the region lease (07 §10: five minutes, at most eight hours); the node liveness lease has no value; the partition count is now proposed in ADR 0020 | SR-N28 |

**07 Permissions**

| Item | Verdict | Disposition |
|---|---|---|
| P3 speaks of "two boundaries" | Confirmed as stale wording | SR-N30 |
| Every lease change a control commit, against breaks only in 04 and 08 | Confirmed | SR-N31 |
| The approval hash covers values that fills may change | Confirmed | SR-M25 |
| Style protection omits `settings`, `role_def` and `rule_def` | Confirmed | SR-M34 |
| A `viewer` grant lowers a commenter | Confirmed | SR-N32 |
| Whole-table suggestions in 03 against paragraphs and rows in 07 | Confirmed, and 02 §5.2 has a third list | SR-N33 |

**09 Export**

| Item | Verdict | Disposition |
|---|---|---|
| The `tex` target compiles outside the service, but fonts are not in the bundle | Confirmed | SR-N37 |
| Imported authors become labels, against the check of `user` in 03 §5 | Confirmed | SR-M14 |
| PDF.js inside the component against a sandboxed cross-origin frame | Partly confirmed: compatible, but the frame's origin is unstated | SR-N8 |
| No way to know a row is taller than a page before typesetting; no cap on passes; no outcome when references do not converge | Confirmed | SR-N28 |
| Import limited to service credentials; no import method in the embedding API | Confirmed (S6 G79, D16) | SR-N24 |

**12 Fields, rules and workflow**

| Item | Verdict | Disposition |
|---|---|---|
| A role-granted region for long answers cannot be edited once `send` locks the document | Confirmed | SR-M26 |
| Phase 1b needs roles from a token claim and an "active participant" without a workflow | Confirmed | SR-M27 |
| 07 §12 has no rows for the resources of 12; 05 §7 lacks workflow events | Confirmed | SR-N35, SR-N21 |
| Null handling, precision, the regular-expression subset, presets, `cc`, `resume` and failure paths undefined | Confirmed | SR-N50 |

**13 Experience**

| Item | Verdict | Disposition |
|---|---|---|
| The administration API is phase 2, but key and origin registration is needed from 1a | Confirmed | SR-N55 |
| The assistant's agent identity has no token claim, and P4 does not cap an agent acting for an editor | Confirmed | SR-M23 |
| `no-export` conflicts with the PDF preview, the read view and printing | Confirmed | SR-N52 |
| `trackChanges` needs `structure` to change, but only `manage` should switch it off | Confirmed, and worse: while it is `everyone`, P4 refuses the change for everyone | SR-M24 |
| A page count in the status bar against "no fake pages" | Confirmed | SR-N53 |
| Translate, text prediction and read aloud come through ports that are not defined | Confirmed | SR-N54 |

Totals: 50 items; 42 confirmed, 3 partly confirmed, 1 not confirmed, 4 changed by ADR 0018. Six are fixed by the edits of section 6.

## 6. Edits made

Each edit is a local change of a sentence, a table row or a list item. All are in docs/spec.

| Edit | Where | Change | Finding |
|---|---|---|---|
| E1 | 00 §1 | Fields are "assigned to roles", not "to people" | SR-N1 |
| E2 | 00 §7, Capability | Adds `fill` and points to 07 §1 | SR-N2 |
| E3 | 00 §7, Scope | Adds the top level of the tree and the value of a form field | SR-N2 |
| E4 | 00 §10, first item | The licence is Apache-2.0 (SPK-007); the legal note is written; counsel still reviews signing claims | SR-N3 |
| E5 | 00 §10, third item | The first market is decided: all three; citations in CDM 1 | SR-N3 |
| E6 | 01 §3 | Rows for ADRs 0016, 0017, 0018 and 0019 | SR-N5 |
| E7 | 01 §6 | `export-docx`: "a package patcher for imported files (ADR 0017) … (phase 2)" | SR-N6 |
| E8 | 02 §7, `read` row | "Phase 2 with the typeset PDF; the own painter in phase 3, if the gate … allows it" | SR-K7 |
| E9 | 02 §9.7 | Adoption of the typesetter's breaks happens only when reconciliation is switched on (opt-in per tenant, from phase 3) | SR-K6 |
| E10 | 03 §7, Fields | "`date` fields, and form fields of kind `dateSigned`" | SR-N13 |
| E11 | 03 §8, I10 | Adds "form fields inside stories and footnotes (12, section 3.2)" | SR-N14 |
| E12 | 03 §13 | The excluded constructs cannot be created or edited; those in imported Word files are preserved and written back | SR-N16 |
| E13 | 04 §3.2 | A base older than a snapshot commit gets `stale_base` with action `rebase`, with the reason | SR-K1 |
| E14 | 04 §5, step 1 | The document's state is checked first (`read_only`), then the capability check (`permission_denied`, P6) | SR-K3 |
| E15 | 05 §5.1 | Row for `auth.ok` (S to C, `tokenExp`, reply to `auth.refresh`) | SR-N20 |
| E16 | 06 §4.1, `doc_commits` | Adds `payload_hash bytea not null` | SR-N26 |
| E17 | 06 §4.1, `versions` | Adds the kinds `sent` and `completed` | SR-N26 |
| E18 | 06 §12 | The tenant's CPU budget gives `rate_limited` with action `retry` (04 §12) | SR-K2 |
| E19 | 07 §5.2, P6 | When the document's state limits a connection, step 1 rejects with `read_only` first | SR-K3 |
| E20 | 09 §6.1 | Under A2 an imported equation is written back as its original Office math while unedited; one that fails the gate is preserved with an image fallback, not turned into an image | SR-N38, SR-M10 |
| E21 | 09 §15 | Citations are in version 1; how biblatex and biber fit the emitters, passes and sandbox is not yet specified | SR-N39, SR-M20 |
| E22 | 10 §3.5 | Embedded objects are kept as opaque preserved content and written back, not dropped | SR-N40, SR-M18 |
| E23 | 11 §2 | "(section 9)" becomes "(section 10)" | SR-N42 |
| E24 | 11 §2 | Row for spike S10 (ADR 0016) | SR-N42 |
| E25 | 11 §3 | Phase 1a adds an S3-compatible object store for the exported PDFs | SR-N43 |
| E26 | 11 §5 | The gate also decides whether the page view reproduces Word's pagination for imported documents | SR-N44 |
| E27 | 11 §9, risk 12 | "assumption A2" becomes the preservation layer as mitigation | SR-N45 |
| E28 | 11 §10, item 8 | Marked decided: the default | SR-N46 |
| E29 | 11 §10, item 12 | Marked decided: fixed width | SR-N46 |
| E30 | 12 §13, phase 2 | Adds the DOCX round trip of fields, with the DOCX writer | SR-N48 |
| E31 | 12 §13, phase 4 | Removes the DOCX round trip of fields | SR-N48 |
| E32 | 12 §15, question 1 | Marked decided: the host alone (SPK-010) | SR-N49 |
| E33 | 12 §15, question 8 | Marked decided: fixed width (SPK-012) | SR-N49 |
| E34 | 13 §2, Built in | Adds citations and bibliography | SR-N51 |
| E35 | 13 §2, Through ports and extensions | Removes citations | SR-N51 |
| E36 | 13 §2, Non-goals | "Creating or editing" SmartArt, charts, shapes, text boxes and ink; imported ones are preserved | SR-N51 |
| E37 | 13 §13 | Citations are built in; the styles offered and the editor's rendering are open | SR-N51 |

**Proposed edits outside the specification**, not made: ADR 0010 (SR-K4); ADR 0005 (SR-N56); ADR 0019 wording (SR-N57); PRODUCT.md (SR-N58); SPK-002's outcome note (SR-N59).

## 7. Notes added to stories

Each note is one appended sentence or paragraph, beginning "Second review (2026-11-06, SPK-027)", naming the finding and linking here. No criterion was ticked or unticked.

| Epic | Stories with a note |
|---|---|
| SPK | SPK-019, SPK-021, SPK-028, SPK-029 |
| CDM | CDM-001, CDM-019, CDM-021, CDM-024, CDM-036, CDM-039, CDM-051, CDM-052 |
| SYN | SYN-005, SYN-017, SYN-020, SYN-023, SYN-037 |
| PRM | PRM-004, PRM-005, PRM-010, PRM-012, PRM-015, PRM-032, PRM-047, PRM-057 |
| PRO | PRO-015, PRO-028, PRO-030, PRO-032, PRO-036, PRO-038, PRO-049, PRO-062, PRO-064, PRO-101, PRO-104 |
| FE | FE-008, FE-051, FE-072, FE-100, FE-139, FE-140 |
| EXP | EXP-090, EXP-095, EXP-096, EXP-103, EXP-105, EXP-106, EXP-108, EXP-109, EXP-116, EXP-117, EXP-118, EXP-119, EXP-121, EXP-122 |
| FRW | FRW-006, FRW-011, FRW-023, FRW-049, FRW-053, FRW-083, FRW-086 |
| HIS | HIS-002, HIS-010, HIS-017, HIS-018, HIS-023 |
| UX | UX-031, UX-044, UX-084, UX-103 |
| BE | BE-019, BE-044, BE-054, BE-075 |
| SEC | SEC-001, SEC-033, SEC-039 |

Where each finding that changes scope is reflected:

| Finding | Stories |
|---|---|
| SR-C1 | SPK-028, SPK-029, EXP-108, EXP-116, EXP-118, PRO-062, BE-044 |
| SR-C2 | SPK-028, CDM-051, FE-051, FE-139, EXP-117, EXP-119, BE-044, SEC-039 |
| SR-C3 | SPK-029, CDM-036, FRW-006, FRW-023 |
| SR-C4 | SPK-029, PRM-057, PRO-049, PRO-062, PRO-064, BE-044, BE-075, HIS-010 |
| SR-K1, SR-K2, SR-K3 | SPK-019, SYN-005, SYN-020, SYN-023, SYN-037, PRM-005, PRM-010, PRO-028, PRO-030 |
| SR-K5, SR-K6, SR-K7, SR-K8 | CDM-021, EXP-109, FE-100, FE-072, SPK-021, FRW-053 |
| SR-M1, SR-M4, SR-M6, SR-M7, SR-M9 | SPK-029, SYN-017, SYN-023, SYN-037, PRM-004, PRM-032, CDM-024, PRO-028, PRO-030, PRO-032, PRO-049, PRO-101, PRO-104, FE-008, HIS-010, BE-019 |
| SR-M3, SR-M5 | FRW-049, PRO-036, UX-031, UX-084, BE-054 |
| SR-M10 to SR-M19 | SPK-028, CDM-001, CDM-039, CDM-051, EXP-090, EXP-095, EXP-096, EXP-103, EXP-105, EXP-106, EXP-116 to EXP-119, FE-139, SEC-039 |
| SR-M20, SR-M22 | CDM-019, CDM-052, EXP-109, EXP-121, EXP-122, FE-140, UX-103, SEC-033 |
| SR-M23 to SR-M34 | PRO-015, PRO-028, PRO-038, UX-044, HIS-017, PRM-005, PRM-012, PRM-015, PRM-047, FRW-011, FRW-083, FRW-086, HIS-018, HIS-023, SYN-020, CDM-036, FE-008 |

Three findings change the roadmap rather than a story and wait for the owner: SR-M2 (deleting hidden values), SR-M8 (the phase that builds read restrictions) and SR-M21 (splitting phase 2 and the new risks).

## 8. Decisions recommended to the owner

1. **Read restrictions and lossless DOCX together (SR-C1).** The original package, the source map and fragments are server-only, and a lossless DOCX export is produced only for a requester who sees the whole document; everyone else gets a package written from their projection.
2. **Preserved data is created only by import (SR-C2),** as part of ADR 0017.
3. **Labels on the full document (SR-C3):** clause, caption and equation numbers are computed on the full document, so every reader sees the same numbers; accept that this reveals how many numbered items a hidden region holds.
4. **The final PDF under read restrictions (SR-M3):** one sealed full PDF for the owner, and a sealed rendering of each participant's projection for that participant, with evidence of what each signer saw.
5. **Deleting a value one cannot read (SR-M2):** needs `manage`, or is refused.
6. **When read restrictions are built (SR-M8):** projection plumbing and confidential regions in 1b; hidden values with the workflow in phase 2.
7. **Tables in headers and footers (SR-K5):** allow them in CDM 1 (option A).
8. **What the phase 2 seal contains (SR-K8):** B-LT at sealing; B-LTA and renewal in phase 4.
9. **Phase 2 (SR-M21):** split it, and add risks 17 and 18.
10. **Citations (SR-M20):** which citation styles the house class offers under A3, and whether biber runs in the sandbox or the converter writes the bibliography.
11. **Charts and shapes in the PDF (SR-M17):** render fallback images at import, or accept labels.
12. **Active content in imported files (SR-M18):** offer tenants an option to strip it.
13. **Tracked changes the model cannot express (SR-M14):** accept or reject at import with the importer's consent, or preserve the paragraph.
14. **Accept ADR 0018 and the choices of S3 and S6** (SR-N17, SR-N19, SR-M32), with S6's D09 replaced (SR-K1) and D01 amended (SR-N64), then fold them into 03, 04, 05 and 07.
15. **Smaller decisions:** Valkey for the distribution (SR-N7); a specification licence with a patent commitment, with counsel (SR-N62); whether a grant may lower a document role (SR-N32); the correction to ADR 0010 (SR-K4).

## 9. What remains open

1. Spike S11 has not run; most SR-M10 to SR-M19 findings are its inputs.
2. S12's follow-up: the gaps of SR-C1, SR-C3, SR-C4, SR-M1, SR-M4 and SR-M7, and S12's own open questions (titles, timing, default readers of hidden values, suggestions and comments in hidden regions, separation of duties, deleting hidden values).
3. ADR 0017's open questions (corpus, regenerated elements, comment parts, inline atoms, the page view).
4. The owner decisions of section 8, and those already pending in 11 §10 (names, jurisdictions and the sealing party, the page view).
5. The edits proposed outside the specification (section 6).
6. S6's 96 remaining gaps, above all HTTP statuses (G50) and identifiers on the wire (G11), before PRO-001 and PRO-002 publish.
7. A third pass once S11 and S12's follow-up have reported and their ADR changes have landed, because this review's own edits have not been reviewed.
