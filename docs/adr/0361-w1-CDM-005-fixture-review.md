# ADR 0361: Review record for the semantics fixtures (CDM-005, criterion 4)

**Status:** proposed, 2026-11-15. Prepared by lane w1 (epics FE, CDM, WASM) from the code and the tests as they stand. It is a record for review, not a decision. The owner of the LaTeX class (EXP) has not confirmed it, and the project owner has not accepted ADR 0032.

## Context

CDM-005 criterion 4 asks the owners of the layout engine (FE) and of the LaTeX class (EXP) to review the fixtures in `packages/model/fixtures/semantics/` and to confirm, rule by rule, that their engine can implement the rule, or to list the gap. ADR 0032 holds the rules. Since ADR 0032 was written, both engines have started to call the shared functions of `@docedit/model` and to run some fixture files in their own tests. This record states what is run today and what is not.

No measurement was taken for this record. "Run" means that a test file of the package imports the fixture file; it does not mean that every case in the file is checked.

## Record

| Fixture file | Layout engine (`packages/layout`) | LaTeX export (`packages/export-latex`) |
|---|---|---|
| `cascade.json` | Run since 2026-11-15 (CDM-041): `src/cdm-041-cascade-fixtures.test.ts`; `flow.ts` now calls `resolveParagraph`, `resolveRun` and `resolveLabelRun` | Run: `src/cdm-041-cascade-fixtures.test.ts` |
| `numbering-lists.json` | Run: `src/numbering-labels.test.ts`. Labels come from `computeLabels` | Gap. Not run. `convert.ts` calls `computeLabels` and `counterEffects`, so the labels are the shared ones, but no test proves it against the fixture |
| `numbering-footnotes.json` | Run: `src/footnote-labels.test.ts` | Gap. Not run. Marks come from `computeLabels` |
| `numbering-sequences.json` | Gap. Not run. A `seq` field with no cached text shows the stand-in `1` (`fieldText` in `flow.ts`) | Gap. Not run. Uses `computeLabels` |
| `numbering-references.json` | Gap. Not run. The layout does not call `referenceText`; it shows the cached text of a reference | Gap. Not run. `convert.ts` and `inline.ts` call `referenceText` |
| `numbering-projections.json` | Gap. Not run | Gap. Not run. `counterEffects` is called in `convert.ts`, `bundle.ts` and `writer.ts` |
| `paragraph-spacing.json` | Run: `src/cdm-043-fixtures.test.ts` | Run: `src/cdm-043-fixtures.test.ts`, `src/cdm-043-gap-compile.test.ts` |
| `line-spacing.json` | Run: `src/cdm-043-line-heights.test.ts` | Gap. Not run. The class applies `multiple` per line in a `post_linebreak_filter` callback (`class/docedit.lua`, 09 §3.1), and `src/exp-021-spacing.test.ts` checks that rule, but not against the fixture |
| `tabs.json` | Run: `src/cdm-044-tabs.test.ts` | Run: `src/cdm-044-tabs.test.ts` |
| `header-growth.json` | Run: `src/cdm-045-header-growth.test.ts`, body start only. The layout does not expose the bottom of the body, so `bottom` and `height` are not checked | Run: `src/cdm-045-header-growth.test.ts`, body start only, and only where `lualatex` starts on the machine. The frame with no room for the body differs from the fixture (ADR 0353, lane V; open for the owner) |
| `date-fields.json` | Gap. Not run. A date field with no cached text shows a fixed stand-in date (`fieldText` in `flow.ts`); `dateFieldText` is not called | Gap. Not run. `convert.ts` and `inline.ts` call `dateFieldText` |
| `whitespace.json` | Gap. Not run. The layout does not call `spaceRuns` | Gap. Not run. `spaces.ts`, `emit.ts` and `convert.ts` call `spaceRuns` |

`packages/model/test/semantics-fixture-consumers.test.ts` holds the same table and fails when a test file starts or stops importing a fixture file, or when this record does not name a fixture file.

## What the record shows

- No rule has been found that either engine cannot implement. Every rule is either run against its fixture in that engine, or computed by a shared function that the engine already calls, or not yet wired in.
- The per-line `multiple` rule, which the criterion gives as its example, needs the callback in the class. The callback exists.
- Layout gaps that are code, not only missing tests: the cascade is not the shared one, `seq` and date fields with no cached text show stand-ins, references show cached text only, and runs of spaces do not go through `spaceRuns`. These belong to the FE stories that own those features; nothing is changed here.
- LaTeX gaps are missing fixture tests for rules whose shared functions the converter already calls: numbering (four files), line spacing, date fields and spaces.

## Not decided here

- Whether this record counts as the review that criterion 4 asks for. Lane w1 owns the FE epic in this run and states the layout column as its own reading. The EXP column was read from the code by the same lane and is not a confirmation by the EXP owner. Default applied: the criterion stays unticked until the EXP owner confirms or corrects the column.
- The open questions of ADR 0032 (numbering indents against style indents; which numbers a reader of a projection sees) and of ADR 0353 (spacing before at the top of a page; a page with no room for the body). They stay with the owner.
