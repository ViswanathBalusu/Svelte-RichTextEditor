# 0144. Export DOCX lane 2 backlog batch: decisions taken and open questions

**Status:** proposed (2026-11-13). Written by the developer of lane export-docx-2 (round 1). Not reviewed by the owner.

## Context

Lane export-docx-2 works the DOCX stories of [EXP-export](../stories/EXP-export.md) from the end of the slice backwards. Round 1 claimed EXP-101, EXP-103 and EXP-106. The code lives in `packages/export-docx`, and the tests are `test/exp-101.test.ts`, `test/exp-103.test.ts` and `test/exp-106.test.ts`.

## Decisions taken without the spec

These are the spec's open questions that the round had to answer to write code. Each one is the spec's default where the spec gives one. The owner decides the rest.

1. **Default font for families the manifest lacks (EXP-106).** 02 §6 names the manifest for Calibri, Cambria, Arial, Times New Roman and Courier New, and says that Aptos reflows. It does not name the default. The round uses `Liberation Sans` (`DEFAULT_IMPORT_FONT` in `src/font-substitution.ts`), which is metric-compatible with Arial. Proposed; the owner may choose another family. The option `fonts.defaultFamily` changes it per call.
2. **Open families are used as they are (EXP-106).** Carlito, Caladea and the Liberation families need no substitute and give no line in the result. Any other family without a manifest entry gets the default and a reflow warning.
3. **Tenant fonts (EXP-106, criterion 4).** The manifest is an ordered list and the first entry that names a family wins. Tenant entries come first. The source of tenant entries is BE-047, which is not built, so criterion 4 stays open.
4. **Result shape (EXP-106).** `ImportResult.fonts` holds one line per family the document names, apart from the open families. It is the list the job (EXP-098) will return. The document keeps the names of the file (SR-M12).
5. **Suggestion labels (EXP-103).** The round keeps the A2 form of the label: `word:` plus the author's name, as the importer already writes. The CDM's `user` attribute is a string of up to 255 characters with no grammar (`packages/model/src/definition/cdm1.ts`), so the rule that a label never matches a real user (criterion 2) rests on the authority, and the criterion stays open.
6. **Nested tables (EXP-101, criterion 2).** The criterion says "dropped or flattened" with a warning. Under A2 the importer keeps the table as a preserved block with the label `nested table`. The two readings conflict, and the owner decides which holds. Nothing changed in the importer.

## Changes to shared files

- `packages/export-docx/src/import.ts`: `ImportOptions.fonts`, `ImportResult.fonts`, and the call of `substituteFonts` in the result. Small additions; the rest of the file is unchanged.
- `packages/export-docx/src/font-substitution.ts`: new.
- `packages/export-docx/src/index.ts` was not changed; the new module is imported by its path.

## Open questions for the owner

- Whether a label of a suggestion (`word:` plus a name) is enough to keep an imported revision from any real user, or the authority needs an explicit rule (EXP-103, criterion 2).
- The reading of "dropped or flattened" for nested tables (EXP-101, criterion 2).
- The default family of EXP-106 (decision 1).

## Round 2 (lane export-docx-2, 2026-11-13)

Decisions taken by the developer, all within the spec's default; none is an owner decision.

1. A table style's borders (`w:tblPr` inside `w:style w:type="table"`) are read into the style's `borders` attribute, by the same side reading as a table's own borders (EXP-101 follow-up). Spec default: the model's border grammar as EXP-101 defines it.
2. A drawn preserved atom (text box, shape, chart and similar) with no fallback picture takes its kind name as `fallbackText`, not the text of its drawing XML (EXP-117, criterion 3). The `fallbackText` of other small atoms is unchanged.

Changed shared files in round 2: `packages/export-docx/src/writer.ts` (three ESLint findings only: two unused imports removed, an unused parameter of `tocXml` removed, and the initial value of `instr` removed); `packages/export-docx/src/props.ts` (`styleSpec('table')` nests `w:tblPr`); `packages/export-docx/src/import.ts` (`fragmentAtom` fallback text).

Open for the owner, not decided here:

- Whether a table style's other `tblPr` children (for example `w:tblInd`) should be written back from the residue. The style writer does not do it yet (EXP-101 Notes).
- The two border decisions of EXP-101 (a border style the model does not name reads as `single`; `w:start` and `w:end` read as left and right in a right-to-left table).

## Round 3 (lane export-docx-2, 2026-11-13)

Scope: the slice's stories with no ticked criteria, from the end backwards. Checked: EXP-096, EXP-097, EXP-098 and EXP-102 (EXP-122 and the importer stories with ticks were done in earlier rounds).

Decisions taken by the developer, within the spec's default; none is an owner decision.

1. **EXP-102 criterion 1 ticked.** Sections become `page_setup` and `section_break` nodes; headers and footers become `story` nodes, and a section's first-page and even-page variants resolve to them. Test: `packages/export-docx/test/exp-102-sections.test.ts` (four cases on `docx4j/sections_multiple.docx` and `poi/headerFooter.docx`).
2. **EXP-102 criteria 2 to 5 stay unticked.** The importer keeps footnotes, endnotes, fields, bookmarks, hyperlinks and content controls as preserved atoms under ADR 0017 (A2). It produces no `footnote`, `anchor` or `link` node or mark, and reports these kinds with action `preserved`, not `dropped` or unsupported. The multi-paragraph footnote approximation is not built. Spec default kept: A2 preservation. Owner decision needed: whether the story's wording (nodes, marks and "reported as unsupported") replaces the A2 form, or A2 wins and the story is reworded.

Not claimed, with the reason:

- EXP-096 (math to DOCX): criteria 1 and 2 need the converter of EXP-054, which is not chosen; criterion 3 needs an equation renderer outside this package; criterion 4 needs the gate of EXP-049 and the replacement of EXP-051, which this package does not hold.
- EXP-097 (choose the parser): the candidate comparison needs the candidate libraries, their licence and security history, and a run in another runtime. The package holds `test/parser-eval.test.ts` (`@rgrove/parse-xml` against `src/xml.ts`), which covers part of criterion 2 only; no candidate report is written here.
- EXP-098 (import as a job): the endpoints, job states, `sync.reset`, versions and webhooks belong to the document service (`services/document-service`), not to this package.

Files changed in round 3: `packages/export-docx/test/exp-102-sections.test.ts` (new); `docs/stories/EXP-export.md` (EXP-102: criterion 1 ticked, Evidence and Notes added, claim line added and removed).

Open for the owner: the EXP-102 wording question in item 2 above.

## Round 4 (lane export-docx-2, 2026-11-13)

Scope: the slice's stories from the end backwards with an open criterion that the package can meet. Stories EXP-119, EXP-118 and EXP-120 have open criteria that need Word, LibreOffice or a release process. EXP-116, EXP-107 and EXP-108 have open criteria that need the importer's job, the footnotes part or the document service. EXP-090, EXP-091, EXP-093 and EXP-095 already have tests in `test/exp-091-095.test.ts` from another lane, so they were not taken here.

Decisions taken by the developer, within the spec's default; none is an owner decision.

1. **Test bounds for the hostile corpus (EXP-110, criterion 2).** A 30-second bound per import, chosen for the test (`BOUND_MS` in `test/hostile-corpus.test.ts`), not a figure of the spec. Memory is not measured, so criterion 2 stays open.
2. **Lists of figures and tables show the caption labels (EXP-092, criterion 3).** The writer read a caption's text without its `seq` fields, so each entry lost its number. The entries now take the labels that `computeLabels` gives, through `shownText` in `src/writer.ts`. Spec default: the shared algorithm (CDM-042).

Changed shared files in round 4: `packages/export-docx/src/writer.ts` (`shownText` method, `blockId` helper, and the three list-entry calls in `tocXml`; `textOf` removed because nothing else used it). No root configuration, package file or other package changed.

Not decided here: whether a list-of-figures entry should show its label only (as now) or the whole caption text, which the spec does not say.

## Round 6 (lane export-docx-2, 2026-11-13)

Scope: the slice from the end backwards, with the open criteria the package can meet. Taken: EXP-117 (criteria 2 and 4 in part), EXP-091 (criterion 2 in part) and EXP-090 (criterion 4). EXP-108 (criteria 2 to 4) and EXP-107 (criteria 1 and 4) need the document service, the footnotes part or the import job. EXP-116 criterion 3 needs the identity fix in `src/props.ts`, not taken this round.

Decisions taken by the developer, within the spec's default; none is an owner decision.

1. **"No external relationship" (EXP-090, criterion 4), proposed reading.** The criterion says the package has no external relationship for any string. A hyperlink carries one external relationship by design, so the criterion is read as: a string never creates an external relationship that the document does not ask for by a hyperlink. The tick is for documents without hyperlinks (`test/exp-090-escape.test.ts`). The owner or the spec should confirm this reading.
2. **Attribute values follow the XML 1.0 rule (EXP-090, criterion 4).** Found by the property test: `el()` and `textElement()` in `src/writer-xml.ts` did not apply `xmlSafe` to attribute values or text, so a style name with a control character produced an invalid part. Both now apply it. Spec default: the rule of EXP-090 ("escaped for XML"). No owner decision.
3. **Fragment checks (EXP-117, criterion 2).** The verbatim XML of an atom is its element's bytes; the test checks that they appear in the source part, which is the spec's "original XML". Spec default.

Not decided here: the wording of the report (EXP-117, criterion 5). The spec names "preserved, not editable"; the importer uses other messages for some kinds. Changing them is an EXP-107 decision, not taken.

Changed files in round 6: `packages/export-docx/src/writer-xml.ts` (two lines, see decision 2); new tests `packages/export-docx/test/exp-090-escape.test.ts`, `packages/export-docx/test/exp-091-figures.test.ts`, `packages/export-docx/test/exp-117-fragments.test.ts`; the stories EXP-090, EXP-091 and EXP-117 in `docs/stories/EXP-export.md`. No root configuration, package file or other package changed.

## Round 7 (lane export-docx-2, 2026-11-13)

Decision taken by the developer, within the spec's default; not an owner decision.

1. The job's preservation report (EXP-116, criterion 5) is defined as: `nodes` is every node the import created; `nodesWithPreserved` is the count of nodes with preserved data (property residue, preserved marks, preserved atoms and blocks), with the same formula as the SPK-028 measurement; the overhead is the canonical UTF-8 size of the document imported with preservation minus that of the same file imported with `preserve: false`. The baseline still keeps the revisions that owner decision 13 holds whole, so the overhead is against that baseline, not against a file without any preserved data. Built in `packages/export-docx/src/preservation-report.ts`, tested in `packages/export-docx/test/exp-116-report.test.ts`. The job (EXP-098) is not built, so the criterion stays open.

Not taken in round 7: the identity fix for `docx4j/cr043-tracked.docx` (EXP-116, criterion 3) needs changes in `src/props.ts` and the writer, which other lanes are editing; the wording of the import messages (EXP-117, criterion 5) is an EXP-107 decision and another lane is working on that test file.

## Round 8 (lane export-docx-2, 2026-11-13)

Scope: the slice from the end backwards. Checked: EXP-100, EXP-095 and EXP-096. EXP-094 and EXP-123 need no work here (EXP-094 is ticked; EXP-123 is phase 1b and its open criteria need the export worker and the document service).

Nothing ticked this round. Reasons:

- EXP-095 (criterion 6, open): the custom parts hold the values a requester may read (redacted values are left out of every part, tested in `test/exp-091-095.test.ts`). The grants part and the role and rule definitions part are written as the host gives them. Whether a restricted requester may read those parts is not decided by the spec: ADR 0019 covers "values of hidden scopes" and does not name grants or definitions. Open question for the owner: should the grants part be omitted, filtered, or kept for every requester? The writer has no visibility input to decide it, so no change was made.
- EXP-100 (criterion 3, open): the labels Word displays need Word, which is not run in this package (as already noted in the story).
- EXP-096 (math to DOCX, all criteria open): unchanged from round 3. The converter of EXP-054 is not chosen, and the gate of EXP-049 is not in this package.

Files changed in round 8: `docs/stories/EXP-export.md` (EXP-095: a Note added, claim line added and removed; no criterion ticked). No code or test was changed.

Open for the owner (new): the visibility of the grants part and of the role and rule definitions part for a requester who does not see the whole document (EXP-095, criterion 6).
