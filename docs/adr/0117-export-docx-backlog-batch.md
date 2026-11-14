# ADR 0117: DOCX import and export backlog batch (round 1)

Status: proposed (2026-11-13). Scope: `packages/export-docx`, stories EXP-116 to EXP-120 and SPK-028.

## Context

The DOCX prototype of spike S11 already implements the importer with the preservation layer, the
patching writer and the R0 and R1 checks (ADR 0017). Its tests exist but the production stories
had no ticks. This batch ticked the criteria that existing tests prove and added two tests.

## Decisions taken here (spec default, not owner decisions)

1. Identity-bound values (EXP-116 criterion 3). The spec says they are kept only in the source map.
   The new test `packages/export-docx/test/identity.test.ts` finds two revision-session values of
   `docx4j/cr043-tracked.docx` in the imported document. The test lists them as known leaks instead
   of failing, so that a new leak fails CI. The cause is not traced; EXP-116 criterion 3 stays open.
   Owner or implementer to choose: fix the leak in the importer, or record the value class as allowed.
2. Failure messages (EXP-120 criterion 3). `packages/export-docx/test/ci-report.test.ts` checks that
   an R0 difference names the part and the first differing element, and that an R1 violation names
   the part. The check asserts the body path for an inserted paragraph, not a deeper element.

## Not decided here

- EXP-119 criterion 2 (renumbering of clashing relationship identifiers) has no dedicated case.
- EXP-116 criteria 1, 2 and 5 (the source map asset, the JSON-tree preservation and the job report
  of shares and overhead) have no dedicated test.
- EXP-118 criterion 5 and EXP-120 criterion 4 need Word or LibreOffice, and a release process.
  LibreOffice is not installed on this machine.

## Consequences

Ticks added: EXP-116 criterion 4; EXP-118 criteria 1 to 4; EXP-119 criteria 1, 3 and 4; EXP-120
criteria 1 to 3. The package suite passes (10 files, 829 tests, run in PowerShell on 2026-11-13).

## Round 2 (2026-11-13, DOCX developer round 1 of the batch run)

Decisions taken here (spec default, proposed; the owner or the main session may change them):

3. EXP-116 criterion 1 ("stored as an immutable asset"). Read as met by the importer's
   content-addressed asset store: the original and the source map are assets with a sha256 of
   their bytes and the server-only role. The production object store is BE-003, not built here, so
   the criterion holds for the package interface only. Test: `test/source-map.test.ts`.
4. EXP-099 criterion 2 (limits before expansion) stays open. The limits check the sizes the central
   directory declares, and `entryData` inflates before it compares sizes, so a lying header is not
   stopped first. The fix (a capped streaming inflate) is not made here; the values of the limits
   are still open in 09.
5. EXP-099 criterion 4 is tested with a stubbed `fetch` in Node (`test/package-safety.test.ts`).
   That shows no request from the importer in Node; it does not prove the absence of network
   access in a sandbox, which is BE-043 and EXP-099 criterion 1.

Cause found for EXP-116 criterion 3 (replaces "not traced"): the leak is in a `preserved` tree of
`w:sectPrChange` in `docx4j/cr043-tracked.docx`. Its `w:sectPr` keeps `w:rsidR` and `w:rsidSect`,
because residue trees built by `readContainer` (`src/props.ts`) do not strip identity attributes.
The fix needs residue identity in the source map and its restoration on write.

Ticks added in round 2: EXP-099 criteria 3 to 5; EXP-116 criteria 1 and 2; EXP-119 criterion 2
(`patch-cases.ts`, `clash-relationship-ids`; the clash is produced by the fixture, not assumed).

Still not decided: EXP-116 criterion 5 (the job's report, EXP-098); EXP-099 criterion 6 (EXP-117).

## Round 3 (2026-11-13, fixer for group 4, round 1)

The reviewer unticked EXP-116 criterion 1: the test covered blocks only, and section breaks and
shared trees had no source-map entry. "Every node" is kept as written, not narrowed to blocks. The
source map (now `v: 3`, `src/source-map.ts`) records every identified node the import creates:

6. Blocks and stories stay in `nodes`; style and page setup definitions stay in `defs`.
7. A section break gets an entry in a new `breaks` record: the byte range of the paragraph-level
   `w:sectPr` it came from, and its hash. It is not put in `nodes`, because the writer and the R1
   check read every entry there as a block.
8. A node with no single original element gets an entry in a new `derived` record with its hash:
   the synthetic nodes (also still listed in `synthetic`), and each shared tree (`preserved_def`),
   with the identified nodes that refer to it (`holders`), whose own entries give the locations.
   This is how the criterion's "location of its original element" is read for these nodes
   (proposed; the main session may change it).

Test: `test/source-map.test.ts` checks every identified node of every corpus file: an entry, a
range inside its part, and a recorded hash equal to the node's hash. Decision 3 (the asset store)
is unchanged. Tick restored: EXP-116 criterion 1.

## Round 4 (2026-11-13, developer for packet export-docx, round 2)

Status: proposed. Stories touched: EXP-099, EXP-110, EXP-117 (not ticked), SPK-028 (not changed).

10. ZIP entries are inflated through fflate's streaming `Inflate` in 64 KiB slices, and the
    entry is refused as soon as its output passes the declared size (`src/zip.ts`,
    `inflateBounded`). Before this, `inflateSync` filled a buffer of the declared size, so a header
    that lied was caught only after full expansion. The ratio and the entry-count and total-size
    limits still use the declared sizes; the values of the limits are not changed (09 leaves them
    open). Test: `test/zip-bounded.test.ts`.
11. EXP-110 criterion 3 is ticked on a fast-check smoke property with 60 runs at seed 110 over
    three corpus files (`test/fuzz.test.ts`). The run count is a choice of this round, not a
    target; a longer campaign is a CI decision for the owner.
12. EXP-099 criterion 6 is ticked on the embedding part of `poi/EmbeddedDocument.docx`, kept byte
    for byte in its fragment (`test/embedded-opaque.test.ts`). The other parts of the fragment stay
    EXP-117's concern.
13. EXP-117 is not ticked. Its atoms exist for text boxes, shapes, charts, embedded objects and
    form fields, but `fallbackText` of drawings holds drawing XML text, not a kind name, and some
    kinds were not probed. Left for the next round.

Package checks run: `pnpm vitest run packages/export-docx` (15 files, 1073 tests, pass) and
`tsc --noEmit` for `tsconfig.json` and `tsconfig.test.json` (clean). Not run: Word, LibreOffice
and any container.

## Round 4 (2026-11-13, DOCX developer round 3 of the batch run)

Decisions taken here (spec default, proposed; the owner or the main session may change them):

9. EXP-107 criterion 2 ("dropped or approximated"). The report also has the action `preserved`
   (A2, the owner's reversal). The criterion is read as "says whether the construct was dropped,
   approximated or preserved". Test: `test/import-report.test.ts`.
10. Floating objects (EXP-107 criterion 1). The report has no kind for floating drawings: an anchored
    drawing is reported as picture, shape or text box, like an inline one. Criterion 1 stays open
    until the owner or the spec names the kind (proposed: a `floating` flag on those kinds).
11. Built-in style identifiers (EXP-100 criterion 4). A built-in style keeps the model's reserved
    identifier (`Heading1`, `Normal`, `TableGrid` and so on), not a random one. Read as "not taken
    from the file": the identifier is the model's, not the file's `w:styleId`. Test:
    `test/fresh-ids.test.ts` (the only identifiers two imports share are the model's built-in ones).
12. EXP-109 criterion 2, second clause (no reuse of a removed region's identifier). It applies to
    an import into an existing document, which is EXP-098. Left open.
13. EXP-109 criteria 3 and 4 contradict A2 (preserved content, not dropped or converted). Left open
    for the owner to decide whether A2 or the criteria govern.

Ticks added in round 4: EXP-100 criteria 1, 2, 4 and 5; EXP-107 criteria 2 and 3; EXP-109
criterion 1. Criterion 2 of EXP-109 and criteria 3 and 4 of EXP-100 are not ticked; the reasons
are in the story Notes. Package suite: 18 files, 1716 tests pass (PowerShell, 2026-11-13);
`tsc --noEmit` passes for `tsconfig.json` and `tsconfig.test.json`. Container, Word and browser
runs were not needed for these tests.

## Round 5 (2026-11-13, DOCX developer, batch round 4 of the run)

Status: proposed. Stories touched: EXP-109 (refusal test, no new tick), EXP-090 (criterion 3), EXP-091 (criterion 1), EXP-093 (criteria 1 and 3), EXP-095 (criteria 1 to 5).

Tests added or strengthened: `test/import-refusal.test.ts` (new, 3 tests: a body of about 17 MB is refused with `canonical_too_large` named, the same content with the check off fails `validate()` with that code, and a 64-column table is kept as preserved content); `test/writer.test.ts` (banded rows, exact form labels as aliases, inline controls, escaped value text in the values part, the assignees part separate from the values part, the advisory warning for forms).

Open questions, not decided here:
1. EXP-109 criterion 5 says a table over 63 columns fails the import. The importer keeps such a table as preserved content (A2), so no limit is exceeded. Spec default kept: the current behaviour. The owner decides which reading holds. The 500-region limit cannot be tested until EXP-104 produces regions.
2. EXP-090 criterion 4 forbids every external relationship, while SR-M18 proposes allowing hyperlinks. The writer test allows hyperlinks. The wording is left as written; the owner or the story decides.
3. EXP-093 criterion 2: the suggestion date is supplied by the caller (`suggestionDates`). The commit time is the host's (EXP-098, not built).

Ticks added in round 5: EXP-090 criterion 3; EXP-091 criterion 1; EXP-093 criteria 1 and 3; EXP-095 criteria 1 to 5. Package suite: 19 files, 1722 tests pass (PowerShell, 2026-11-13); `tsc --noEmit` passes for `tsconfig.json` and `tsconfig.test.json`; `check-stories.ps1` reports no problems. Word and LibreOffice runs were not needed for these tests and were not run.

## Round 5 (2026-11-13, developer for packet export-docx, batch round 5)

Decisions taken here (spec default, proposed; the owner or the main session may change them):

8. EXP-094 criterion 3 without export identities: the spec's reading is kept. A restricted region gets only the `everyone` range when the host names no identities, and per-user ranges only for the identities the callback returns. Test: `test/exp-092-094.test.ts`.
9. EXP-092 criterion 1 defaults: the spec names no page size or margins for a page setup that gives none. The writer uses A4 in twips and 1440-twip margins (observed). The test asserts those values; a named default is for the owner or the main session.
10. EXP-092 criterion 4 date: the writer reads the instant from its options and never from the client. The caller must pass the server's instant at job creation (EXP-098, not built), so the criterion holds for the package interface only.

Not changed in this round (EXP-117 is in the do-not-redo list, so it was not reworked):

- EXP-117 criterion 3: `fallbackText` of text boxes and shapes holds the drawing's own text, not the kind name. A trial change in `src/import.ts` (`fallbackText` = label when there is no `fallbackAsset`) kept all package tests green, and it was reverted. Open reading for an earlier round to decide: the zero-width markers (bookmark, comment anchor, permission range, field, field code) have no fallback text by design (`MARKER_LABELS`), so the criterion would apply to the other atoms only.
- EXP-117 criterion 5 reading: "preserved, not editable" applies to content atoms. Preserved properties keep their own message (for example "kept with the paragraph and written back to Word; not shown or editable in the editor"). The trial check (each atom kind's report count equals the number of atoms of that kind, over the corpus) passed under that reading. The check was not kept, because the story is out of this round's scope.

Ticks added in round 5: EXP-092 criteria 1, 2, 4 and 5 (criterion 3 open: caption labels not compared with `computeLabels`); EXP-094 criteria 1 to 6. Test file added: `packages/export-docx/test/exp-092-094.test.ts` (8 tests). Package suite: 20 files, 1730 tests pass (PowerShell, 2026-11-13); `tsc --noEmit -p tsconfig.test.json` passes; `check-stories.ps1` reports no problems. No Word or LibreOffice run was needed for these tests.

## Round 6 (2026-11-13, developer for packet export-docx, batch round 6)

Status: proposed. Stories touched: EXP-108 (criterion 1 ticked, Evidence and Notes added), EXP-101 (new test file, no tick; the story is marked "In progress: lane export-docx-2" by another lane, so its Notes were left to that lane).

Decisions taken here (spec default, proposed):

14. EXP-108 criterion 1 ("content-addressed, immutable asset attached to the document") is read as the package's store, as in decision 3. "Attached" is read as the import's asset set passed to `validate()`. The store's map is not frozen by its type, so "immutable" is a property of the API. Test: `test/original-asset.test.ts`.
15. EXP-101 criterion 1 is not ticked: table borders are not a modelled property (they stay in the `preserved` residue, `src/props.ts` TBLPR), so "borders" does not hold as written. The grid, spans, header rows and cell shading of each body table are checked against the source XML in `test/tables-import.test.ts`. Owner or spec decision needed: whether borders become a model property (CDM) or stay preserved.
16. EXP-101 criterion 2 (a nested table is dropped or flattened) conflicts with A2: the importer keeps a nested table as a preserved block. Left open for the owner (same as EXP-109 criteria 3 and 4).

Coordination: while this round ran, another lane wrote `src/font-substitution.ts` and `test/exp-106.test.ts` (EXP-106) and `test/exp-103.test.ts` (EXP-103). This round wrote a draft EXP-106 module and a draft EXP-103 test, and removed both to avoid duplicate code. No file of those lanes was changed.

Package checks: see the report of this round (`pnpm vitest run packages/export-docx`, PowerShell). Not run: Word, LibreOffice and any container.

## Round 7 (2026-11-13, developer for packet export-docx, batch round 7)

Status: proposed. Stories touched: EXP-107 (criterion 1 partly evidenced, not ticked; Evidence and Notes). No other story was ticked in this round.

17. Floating objects in the import report (EXP-107 criterion 1). Decision 10 of round 4 left them without a line. Now each preserved atom whose drawing holds an anchor (`wp:anchor`) also gets a report line with the kind `floating object`, action `preserved`, the message "preserved, not editable", and the blocks that hold it. The content kind (text box, shape, picture and so on) keeps its own line, so a floating text box is counted under both kinds. The name `floating object` and the double count are a spec-default proposal, not an owner decision. The count equals the number of `wp:anchor` elements in the package's document, header, footer, footnote and endnote parts over the S11 corpus (`test/floating-report.test.ts`). Code: `src/import.ts` (`FLOATING_KIND`, `isAnchored`, `fragmentAtom`).

Candidates looked at and left unchanged in this round, with the reason:

- EXP-104 (editable ranges as regions): the body writer and the source map's gap ranges assume body children that match the blocks of the original. A region wrapper would also duplicate the `permStart` and `permEnd` markers that the gaps still copy. That is a change to the R0 and R1 paths, not a packet-local change; the owner or the main session should decide the design first.
- EXP-105 and EXP-096 (Office math): no OMML to LaTeX converter exists in the repository (EXP-054 is not built), so no equation can pass the gate. EXP-105 criterion 3 also conflicts with A2, which keeps an unconvertible equation in place as an atom.
- EXP-102 (sections, notes, fields, links): the footnotes and endnotes parts are not read, so no footnote node or multi-paragraph approximation exists. Hyperlinks and bookmarks stay preserved atoms and markers, not `link` marks or `anchor` nodes; changing them alters the writer's patch path. Content controls and form fields appear in the report, but form fields only as `field` lines, so criterion 5 is not met as written.
- EXP-100 criterion 3 (labels equal those Word displays): needs a Word listing of the rendered labels for each numbered paragraph and the editor's label function. The spike's Word script opens files but does not list labels. Not built here.
- EXP-122 (citations in DOCX): the writer writes citations as their text and the bibliography as plain entries (`src/writer.ts`, EXP-122 notes). Citation fields and the sources part are not built.
- SPK-028 criterion 4 (measurements on the reference machine) and EXP-118 criterion 5 (Word and LibreOffice): the reference machine is not named, and LibreOffice is not installed on the spike machine.

Package checks (PowerShell, 2026-11-13): `pnpm vitest run packages/export-docx`: 26 files, 2100 tests pass. `pnpm exec tsc --noEmit -p packages/export-docx/tsconfig.json` and `-p packages/export-docx/tsconfig.test.json`: pass. Not run: Word, LibreOffice, Podman, PostgreSQL and browsers.

## Round 8 (2026-11-13, DOCX developer round 8 of the batch run)

Checked: `pnpm vitest run packages/export-docx` passes (27 files, 2,106 tests) and the
`tsconfig.json` type-check is clean. The `tsconfig.test.json` check failed on one line of
`test/exp-101-style-borders.test.ts` (`TreeNode` has no `name`); the line now narrows with `'name' in c`.
Test behaviour is unchanged and the file passes.

Remaining DOCX criteria in this packet, none ticked this round:

- EXP-096 (math) criteria 1 and 2 need the LaTeX-to-Office-math converter of EXP-054, a spike that
  is not done. Criterion 3 (an unconvertible equation becomes an image with the LaTeX source as
  alt text) needs an equation renderer, which is outside this package. The writer today writes the
  LaTeX source as text (`src/writer.ts`, `equation_block` and `equation`). Criterion 4 needs the gate
  of EXP-049 and the replacement of EXP-051, which are not in this package.
- EXP-097 (choose the parser) is a time-boxed comparison that needs the candidate libraries and a
  report; it is not a code criterion here.
- EXP-118 criterion 5 and EXP-120 criterion 4 (Word and LibreOffice, release notes) stay open, as in
  round 1.
- SPK-028 criteria 3, 4 and 6 stay open: no LibreOffice here, measurements on the development machine
  only (the reference machine is not named), and the CDM-051 update is another story.

Decision taken here (spec default, proposed): an equation in an export is LaTeX source text until
EXP-054 chooses a converter. This is the current behaviour, and it is not a silent change of EXP-096.

## Round 5 (export-docx developer, 2026-11-13)

Stories worked: EXP-091, EXP-093, EXP-095 (criteria listed in each story's Evidence). New tests in
`packages/export-docx/test/exp-091-095.test.ts` (6 tests, passing; type-checked with `tsconfig.test.json`).

Ticked this round:

- EXP-091 criteria 3, 4 and 5. Criterion 5 reads "attached" as the asset store the caller passes for
  the document. The writer writes only the assets its nodes refer to. Which assets a job attaches is
  for EXP-098. Proposed, not owner-decided.
- EXP-093 criterion 5 (a whole table as a tracked row change on each row).
- EXP-095 criterion 2 (assignees and rules in one definitions part, apart from the values).

Not ticked, with the reason in each story's Notes:

- EXP-091 criterion 2: an inline image's `align` is not tested.
- EXP-093 criterion 4: the writer has no comment part, so no Word comments or replies are written.
- EXP-095 criterion 6: the grants part is written as the host gives it and is not checked against a
  requester's visibility.

Decision taken here (spec default, proposed): the custom parts of a requester's package are read as
"the form-values part holds no redacted value", and the grants part is left to its own story.
Owner question for later: does ADR 0019 cover the grants part of a projection?

## Round 9 (2026-11-13, DOCX developer round 9 of the batch run)

Fixed first: the three test files reported by the last review are formatted with Prettier. The
ESLint error in 	est/exp-091-figures.test.ts (
o-control-regex) is fixed: the string generator
maps control characters and surrogates by code unit, without a control-character regex.

Stories worked: EXP-117 (criteria 1 and 5). Ticked:

- EXP-117 criterion 1. New test 	est/exp-117-kinds.test.ts: a synthetic package holds each kind in
  source order and each becomes a preserved atom or block at its position. Two kinds needed new
  labels in labelFor (src/import.ts): w14:contentPart is ink, and a w:object whose
  o:OLEObject has Type="Link" is linked object. Before, every w:object was mbedded object.
  Proposed, not owner-decided: the labels are the story's own words.
- EXP-117 criterion 5 (its tick stands; the Evidence now names the test of the wording). Decision
  taken here (spec default, proposed): "preserved, not editable" is read as the start of the message
  of each preserved line; a reason may follow after a colon. The importer's messages do that now.

Not ticked, with the reason in the story's Notes:

- EXP-104 (editable ranges as regions): not built. A region import changes the container order and
  gaps of the source map, which the lossless tests (R0, R1) depend on, and the policy and grants of
  imported regions are open questions. No corpus file holds w:permStart.
- EXP-116 criterion 3 (identity-bound values only in the source map): the fix needs the restoration of
  revision identifiers on write. Not done.
- EXP-101 criterion 2 (nested table dropped or flattened) contradicts A2, where it is kept as a
  preserved block. Owner decides.
- EXP-093 criterion 4 and EXP-090 criteria 1, 2, 5, 6 and 7 need Word, LibreOffice, the cascade of
  03 §6 for the corpus, or the fixtures of EXP-115. Unchanged.

Checks: pnpm vitest run packages/export-docx (see the story Evidence for the count). 	sc with
packages/export-docx/tsconfig.test.json is clean; ESLint is clean on the files this round touched.
Known flaky case: 	est/exp-106.test.ts took over 100 s in the full package run while other agents
were using the machine, and passes alone (17 tests). Not caused by this round.

## Round 10 (export-docx, 2026-11-13)

Status: proposed. Decisions below are the spec default or a reading of a criterion, and the owner
may change them.

Decisions:

1. EXP-116 criterion 3 (identity-bound values only in the source map). Identity-bound attributes
   (`IDENTITY_ATTRS`, `src/ooxml.ts`) are taken out of the preserved residue of paragraph
   properties, section properties and style definitions at import (`splitIdentity`, `src/tree.ts`)
   and kept in the source map as `identityTree`. The writer puts them back through `preservedOf`
   (`restoreIdentity`), so a regenerated node is canonically equal to the original. Table, row,
   cell and run residues are not split yet; the criterion stays unticked for that reason.
2. EXP-106 criterion 4 (tenant font with the same family name). Read as the importer's decision for
   the manifest it is given: the first entry that names a family wins, and the family is listed
   once with its source. The supply of tenant fonts (BE-047) is not checked here.

Not ticked, with the reason in the story's Notes: EXP-116 criterion 3 (table, row, cell and run
residues); EXP-109 criterion 5 (the 63-column clause contradicts A2, owner decides; the 16 MiB case
is tested in `test/import-refusal.test.ts`); EXP-110 criteria 1, 2 and 4 (agreed rate, memory bound,
PDF pipeline); EXP-096 and EXP-105 (the Office math converter of EXP-054 is not built); EXP-097
(a comparison that needs candidate research outside this package); EXP-098 and everything that needs
the job (EXP-106 criterion 3, EXP-108 criterion 3, EXP-107 criterion 4).

Checks: `pnpm vitest run packages/export-docx` ran with 42 files and 2239 tests passing (one run in
the same round timed out `test/exp-106.test.ts` under load and passed alone, 17 tests). After that,
only a lint fix in `src/tree.ts`: the targeted tests, ESLint and `tsc --noEmit` with
`packages/export-docx/tsconfig.json` and `tsconfig.test.json` is clean.

## Round 11 (2026-11-13, developer for packet export-docx, batch round 11)

Status: proposed. Decision 18 (spec default, under A2).

18. A footnote of more than one paragraph gets its own import report line, `footnote of several
    paragraphs`, action `preserved`, message "preserved, not editable: the note has several
    paragraphs and is kept whole", counted once per reference in the body or a story. The note is
    kept whole as a preserved atom, so no content is approximated; the criterion of EXP-107 says
    "approximated", and this reading (A2) is the one the report uses. Consequence: EXP-107
    criterion 1 is ticked on that reading, with the evidence in `test/exp-107-footnotes.test.ts`.
    No S11 corpus file holds such a note (checked by a plain reading of the XML parts), so the test
    uses a synthetic edit of `poi/footnotes.docx`.

Not ticked this round, with the reason in the story Notes: EXP-099 criterion 1 (the sandboxed worker
of BE-043); EXP-102 criterion 2 (the warning says "approximated" but A2 keeps the note whole, so the
criterion contradicts A2; owner decides); EXP-103 criteria 2 and 3 (a label rule needs the authority,
accept and reject need the editor); EXP-108 criteria 2 to 4 (BE and EXP-098); EXP-110 criteria 1, 2
(memory is not measured; the agreed rate is not set) and 4; EXP-118 and SPK-028 criteria on Word and
LibreOffice (LibreOffice is not installed here); EXP-120 criterion 4 (release process); EXP-122
criteria 2 and 3 (the importer does not read citation fields or `b:Sources`; not built in this round).
