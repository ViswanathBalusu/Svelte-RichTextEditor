# Findings from writing the stories, 2026-11-06

Turning specification draft 0.2 into the backlog in [docs/stories](../stories/README.md) meant reading every normative sentence closely. This note records what that reading found: gaps between epics that the cross-check closed, contradictions in the specification, and points the specification leaves undefined. It is input for the second review (story SPK-027), not a decision record. Nothing here changes the specification.

**How to read it.** Section 2 lists contradictions that were checked against the text of the specification. Section 3 lists what the story writers reported while drafting; those items are not individually verified, and each epic's "Open questions" section has the detail and the affected stories.

## 1. Gaps between epics, closed in the cross-check

| Gap | Resolution |
|---|---|
| No epic owned the authoring commands of the parity profile (13 §2): character and paragraph formatting, styles, lists, table styles and sorting, pictures and figures, links and bookmarks, captions and cross-references, breaks and sections, fields and a table of contents, symbols, page setup and watermark, zoom. CDM defines the data and UX draws the controls; each assumed the other owned the commands | FE-127 to FE-138, in the editing core |
| The export dialog: choosing a target, following the job and jumping from a diagnostic to its block (R5) | UX-101 |
| Rulers, listed as built in by 13 §2 | UX-102 (phase inferred: 2) |
| The page-view gate was written twice | FE-074 merged into SPK-013 |
| 36 further pairs or groups of stories described the same deliverable or overlapped | 24 stories merged into their owners, each leaving a one-line pointer in its epic file; 12 groups narrowed so that each story keeps only its own angle (for example contract, implementation and verification) |
| 78 dependencies pointed at stories scheduled in a later phase | Resolved. Most were links that were not real prerequisites and were removed, with a note where the later story extends the earlier one. Four stories changed phase: FE-029 from 1a to 1b, SEC-035 from 1a to 1b, SEC-056 from 1b to 2, PRO-080 from 1b to 1a |
| 41 pairs of stories depended on each other, and longer cycles ran through 685 stories | Every cycle removed by cutting the edge that pointed the wrong way: a verification story depends on the control it verifies, an interface's implementation on the interface, the shell on the core, a feature on the model |

Cross-epic references that the drafts wrote as placeholders (383 of them) now point to story identifiers. Five point to work no story covers yet, and are marked "gap" in place:

- 05 §6.2 has no resource or event for comment reactions (UX-033).
- 05 §8.1 has no attribute or event for hiding the header, nor events for presence, counts or mode changes (UX stories that depend on them).
- 07 §15's export-identities callback is not in 05 §8.1.
- 09 does not cover exporting a comparison as DOCX tracked changes, which 08 §6 promises.
- The CDM has no crop attributes for pictures, which 13 §2 lists as built in (FE-132).

## 2. Contradictions checked against the specification

| # | Contradiction | Where |
|---|---|---|
| 1 | A commit whose base is older than a snapshot commit is rejected with action `reload` in one place and with `stale_base` (whose action is `rebase`) in another | 04 §3.2 against 04 §5 step 3 and the table in 04 §8 |
| 2 | A spent tenant CPU budget returns `rate_limited` in one document and `quota_exceeded` in another | 04 §12 against 06 §12 |
| 3 | A commit to a locked or archived document is rejected with `read_only` by step 1 of the authority algorithm, while rule P6 rejects commits from connections limited to `view` or `comment` with `permission_denied` | 04 §5 step 1 against 07 §5.2 (P6) and 07 §4 |
| 4 | ADR 0010 says checkpoints are written every 500 commits or 1 MiB of steps and payloads move to cold segments after 180 days; the specification says 2,000 commits or ten minutes, and 30 days | ADR 0010 against 06 §2.2, 06 §10 and 08 §11 |
| 5 | The table mapping gives a boxed `tabular` for tables inside headers, footers and footnotes, but invariant I10 forbids tables inside stories and footnotes | 09 §3.2 against 03 §8 (I10) |
| 6 | The page view adopts the typesetter's breaks for unedited paragraphs with no mention of opt-in, while 09 calls that level "opt-in, from phase 3" | 02 §9.7 against 09 §7 (L1) |
| 7 | The read view is placed in "phases 1 and 2" in one document and in phase 2 in the roadmap | 02 §7 against 11 §5 |
| 8 | Final PDFs are sealed at PAdES B-LT or B-LTA in the phase 2 flow, while long-term validation is scheduled for phase 4; the boundary between what phase 2 includes and what phase 4 adds is not stated | 12 §8.2 against 12 §13 and 11 §7 |

## 3. Reported by the story writers, not individually verified

### 02 Frontend

- The region guard "filters" transactions that touch protected scopes, while 07 §7 says a deletion across scopes removes only the permitted parts.
- "Select all" is limited to the body, while selections that start inside a region are clamped to it.
- 05 §8.1 has no default for `view`, no property for a string catalogue and no setting for the destroy grace period.
- Nothing states how inherited CSS properties are kept out of the shadow root, which R2 requires.
- The recovery journal has no defined behaviour when IndexedDB is unavailable or full, when two tabs open one document, or on shared computers.
- KaTeX display is not in the list of lazy chunks; the text alternative for equations is unspecified.
- No values are given for the page-overflow tolerance, the footnote-placement iteration limit, or "usable" at 300 pages; some browsers reserve Ctrl+F6.

### 03 Document model

- Defaults, most enumeration values, integer ranges, the built-in style list ("and the like"), the bullet-character list, the form of `field.target`, the grammar of `ext` keys and the shape of `fmt.before` are not given; the canonical form and invariant I11 depend on them (CDM-002).
- The canonical form is silent on empty content and marks, defaults inside object attributes, subtree hashes (07 §11 hashes a region) and its own versioning (CDM-003).
- The §12 example gives a definition the identifier `ps1`, while §4.1 says definitions get random identifiers.
- I6 ignores positions covered by row spans; I4 makes deleting a referenced bookmark or heading invalid; I2, I3, I4 and I8 need context beyond the document itself.
- Content expressions cannot express I10, and the ban on form fields in some places (12 §3.2) is in no invariant.
- §7 calls `dateSigned` a field (it is a form-field kind); the `title` field has no data source; `restartAfter`, `numberingRestart` and footnote counting are undefined.
- `ext` is a single attribute, so two concurrent attribute steps overwrite each other, against the one-attribute-per-property principle of §4.1.

### 04 Sync engine and 08 History

- No rejection code is named for commits with no steps, disallowed step types, or a client-sent reserved origin.
- The replay bound of "at most 2,000 commits" fails when checkpoints are spaced two minutes apart and then thinned.
- The byte layout of the hash chain is unspecified, and 06 §4.1 has no column for the payload hash.
- A single `minVisibleSeq` does not fit the `editors` setting of 08 §9 ("named versions only"); several inputs that carry a sequence number are missing from its list.
- 08 §6 shows authors on deleted spans, which the attribution map cannot supply.
- A region restore that falls back to a snapshot commit has no rule protecting other regions.

### 05 Protocol

- `auth.ok` is used but is missing from the session message table and has no payload.
- Event names differ between planes (`document.updated` against `dep.document.changed`); there are no DOM events for threads or versions.
- 05 §8.3 ships the mock backend "from the first phase", while the roadmap puts it in phase 1b; 11 puts webhooks in phase 2 while the reference host sends webhooks to e-mail from phase 1.
- Unspecified: the HTTP status per error code, the code for a missing `If-Match`, the bodies of `POST /tokens`, the purpose of `jwks_uri`, the error-to-close-code mapping, the transport and five call signatures of the authority service.

### 06 Backend and 10 Security

- `GET /documents/{id}/connect` (06 §2.1) is absent from 05 §6.2.
- `POST /sessions/revoke` takes a document, but only a per-user `revoked_before` is stored.
- `versions.kind` omits `sent` and `completed` (08 §4).
- Phase 1a lists only PostgreSQL, but exports and checkpoints need object storage.
- Lease length, partition count, rate limits, send-queue bound, asset limits and signed-URL lifetime are unspecified.

### 07 Permissions

- P3 still speaks of a region's "two boundaries", but regions are now container nodes.
- 07 §3 makes every lease change a control commit; 04 and 08 list only lease breaks.
- The approval hash binds a region's content, but 12 §4.3 allows fills inside approved regions.
- Style protection (07 §5.3) omits `settings`, `role_def` and `rule_def`.
- A `viewer` grant can lower a document `commenter` to `view` in a restricted region.
- 03 §5 allows whole-table suggestions; 07 §17 names only paragraphs and rows.

### 09 Export

- The `tex` target "compiles outside the service", but fonts are not in the bundle.
- Imported tracked changes carry authors as labels, while 03 §5 checks suggestion marks against the submitting user.
- 01 §7 places PDF.js inside the component; 09 §9.3 requires a sandboxed cross-origin frame (compatible if the frame is the component's, but unstated).
- No method is given to know a table row is taller than a page before typesetting; no cap on passes, and no outcome when references do not converge.
- Import is limited to service credentials (07 §12), and the embedding API has no import method.

### 12 Fields, rules and workflow

- A role-granted region for long answers (12 §3.4) cannot be edited once sending locks the document (FRW-086).
- Phase 1b needs roles from a token claim and an "active participant" without a workflow; neither is defined.
- 07 §12 has no rows for the resources of 12; 05 §7 lacks workflow events.
- Undefined: null handling, decimal precision, the regular-expression subset, preset definitions, whether `cc` counts toward completion, what resume resets, and the failure paths when compiles disagree or signing is unavailable.

### 13 Experience

- The administration API is placed in phase 2, but registering token keys and origins is needed from phase 1a.
- The assistant's agent identity has no token claim; `origin` is a client claim, and P4 does not cap an agent acting for an editor.
- `no-export` conflicts with the PDF preview, the read view and printing.
- `trackChanges` lives in the definitions (changing it needs `structure`), but only `manage` should switch it off.
- A page count in the status bar sits uneasily with "no fake pages" in the web view.
- Translate, text prediction and read aloud are listed as coming through ports, but no port is defined.

## 4. Suggested handling

Fix the eight items of section 2 in the specification before phase 1a starts; four of them change error codes or numbers that the conformance kit will pin. Take section 3 into the second review (SPK-027), where each item is either fixed in the specification or turned into a decision story.
