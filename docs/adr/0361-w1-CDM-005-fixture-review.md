# ADR 0361: Review record for the semantics fixtures (CDM-005, criterion 4)

**Status:** proposed, 2026-11-15. Prepared by lane w1 (epics FE, CDM, WASM) from the code and the tests as they stand. It is a record for review, not a decision. The owner of the LaTeX class (EXP) has not confirmed it. Refreshed by lane w6 on 2026-11-20 against the test files of that day: the project owner has accepted ADR 0032 since (decisions 9, 10 and 11 of [docs/owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)), the rows that had changed were brought up to date, and the gaps that the compiles of CDM-043 found were added. The confirmation by the EXP owner is still missing, so CDM-005 criterion 4 stays unticked.

## Context

CDM-005 criterion 4 asks the owners of the layout engine (FE) and of the LaTeX class (EXP) to review the fixtures in `packages/model/fixtures/semantics/` and to confirm, rule by rule, that their engine can implement the rule, or to list the gap. ADR 0032 holds the rules. Since ADR 0032 was written, both engines have started to call the shared functions of `@docedit/model` and to run some fixture files in their own tests. This record states what is run today and what is not.

No measurement was taken for this record. "Run" means that a test file of the package imports the fixture file; it does not mean that every case in the file is checked.

## Record

| Fixture file | Layout engine (`packages/layout`) | LaTeX export (`packages/export-latex`) |
|---|---|---|
| `cascade.json` | Run since 2026-11-15 (CDM-041): `src/cdm-041-cascade-fixtures.test.ts`; `flow.ts` now calls `resolveParagraph`, `resolveRun` and `resolveLabelRun` | Run: `src/cdm-041-cascade-fixtures.test.ts`, and on the converter's own output `src/cdm-041-converter-fixtures.test.ts` |
| `numbering-lists.json` | Run: `src/numbering-labels.test.ts`. Labels come from `computeLabels` | Gap. Not run. `convert.ts` calls `computeLabels` and `counterEffects`, so the labels are the shared ones, but no test proves it against the fixture |
| `numbering-footnotes.json` | Run: `src/footnote-labels.test.ts` | Gap. Not run. Marks come from `computeLabels` |
| `numbering-sequences.json` | Run: `src/fe-077-fixtures.test.ts` (FE-077, 2026-11-18) | Gap. Not run. Uses `computeLabels` |
| `numbering-references.json` | Run: `src/fe-077-fixtures.test.ts` (FE-077, 2026-11-18) | Gap. Not run. `convert.ts` and `inline.ts` call `referenceText` |
| `numbering-projections.json` | Run: `src/fe-077-fixtures.test.ts` (FE-077, 2026-11-18) | Gap. Not run. `counterEffects` is called in `convert.ts`, `bundle.ts` and `writer.ts` |
| `paragraph-spacing.json` | Run: `src/cdm-043-fixtures.test.ts`, `src/cdm-043-flows.test.ts` (the container flows) and `src/cdm-043-note-gaps.test.ts` (consecutive footnotes) | Run: `src/cdm-043-fixtures.test.ts`, `src/cdm-043-gap-compile.test.ts` and, since 2026-11-18, `src/cdm-043-flows-compile.test.ts`. Gap in the class, found by that compile and pinned there as expected failures: it does not place the leading and the trailing gap of a table cell, the leading gap of a footnote, or the gap between consecutive footnotes (CDM-043, Notes) |
| `line-spacing.json` | Run: `src/cdm-043-line-heights.test.ts`, exact since owner decision 78 (a `multiple` height is rounded to whole twips) | Run since 2026-11-18: `src/cdm-043-lines-compile.test.ts` compiles the ten cases with the class, which applies `multiple` per line in a `post_linebreak_filter` callback (`class/docedit.lua`, 09 §3.1) |
| `tabs.json` | Run: `src/cdm-044-tabs.test.ts` | Run: `src/cdm-044-tabs.test.ts` |
| `header-growth.json` | Run: `src/cdm-045-header-growth.test.ts` (the body start of all 8 frames) and `src/cdm-045-slots-bottom.test.ts` (the body end and which story a page shows) | Run: `src/cdm-045-header-growth.test.ts`, body start only, and only where `lualatex` starts on the machine. The frame with no room for the body is settled by owner decision 77 (the body starts on the next page), and the fixture, the layout and the class agree on it. Gap: the class has not run the body end or the cases of which story a page shows |
| `date-fields.json` | Gap. Not run. A date field with no cached text shows a fixed stand-in date (`fieldText` in `flow.ts`); `dateFieldText` is not called | Gap. Not run. `convert.ts` and `inline.ts` call `dateFieldText` |
| `whitespace.json` | Gap. Not run. The layout does not call `spaceRuns` | Gap. Not run. `spaces.ts`, `emit.ts` and `convert.ts` call `spaceRuns` |

`packages/model/test/semantics-fixture-consumers.test.ts` holds the same table and fails when a test file starts or stops importing a fixture file, or when this record does not name a fixture file.

## What the record shows

- No rule has been found that either engine cannot implement. Every rule is either run against its fixture in that engine, or computed by a shared function that the engine already calls, or not yet wired in.
- The per-line `multiple` rule, which the criterion gives as its example, needs the callback in the class. The callback exists.
- Layout gaps that are code, not only missing tests (as of 2026-11-20): a date field with no cached text shows a stand-in, and runs of spaces do not go through `spaceRuns`. The cascade is the shared one since CDM-041, and sequences, references and projections run their fixtures since FE-077. These belong to the FE stories that own those features; nothing is changed here.
- LaTeX gaps that are missing fixture tests for rules whose shared functions the converter already calls: numbering (five files), date fields and spaces. Line spacing is run since 2026-11-18.
- LaTeX gaps that are the class's own, found by compiling the fixtures: the four gaps of `paragraph-spacing.json` named in the table (cell edges and footnotes), and the body end and the header and footer slots of `header-growth.json`, which have not been run. The footnote gap between consecutive notes depends on which notes share a page, which only TeX knows.

## Not decided here

- Whether this record counts as the review that criterion 4 asks for. Lane w1 owns the FE epic in this run and states the layout column as its own reading. The EXP column was read from the code by the same lane and is not a confirmation by the EXP owner. Default applied: the criterion stays unticked until the EXP owner confirms or corrects the column.
- Settled since this record was written: the two open questions of ADR 0032 (owner decision 9: the numbering level's indent overrides the paragraph style's; owner decision 11: a projection shows the full document's numbers) and the page with no room for the body (owner decision 77). Still with the owner: whether `spaceBefore` is dropped at the top of a page (ADR 0353; ADR 0032, open question 7).
