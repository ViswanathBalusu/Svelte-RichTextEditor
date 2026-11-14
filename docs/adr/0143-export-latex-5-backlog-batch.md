# 0143. Export LaTeX backlog batch (lane export-latex-5): open questions from stories EXP-038 to EXP-047

**Status:** proposed (2026-11-13). Written by the export-latex-5 developer, round 1. Not reviewed by the owner.

## Context

Lane export-latex-5 works the tables, typed emitters and fonts stories of `docs/stories/EXP-export.md` (EXP-038 to EXP-047), from the end of the slice backwards. Reading the stories against `packages/export-latex` found that the open criteria need a LuaLaTeX compile, a measurement, or a feature the spec does not define. No criterion was ticked in this round. The points below are recorded so that the owner can decide them. Default taken in code: stated for each point.

## Open questions and the default taken

1. **Row height rules (EXP-038 criterion 5).** The CDM gives `table_row` `height` and `heightRule` (03 §4.3). `attributes.ts` maps both to `null`, so they never reach the bundle, and `tables.ts` warns `row_height_approximate`. Question: how is `atLeast` honoured in a `longtable` cell without changing the text position? A strut at the start of the cell pushes the first line down, and a strut at the end does not set a minimum. Question: how is `exact` honoured, given that LaTeX does not clip overflowing cell content? Default in code: unchanged (warning). Any choice needs a compile to check the result.

2. **Row height that is measured (EXP-039 criteria 1, 3 and 4).** Splitting a row taller than a page, and a paragraph taller than a page, need a height measurement before typesetting. The spec does not give the measure (the story's Notes already say so). Question: should the converter measure with the class in a first pass (LuaLaTeX, needs the worker), or use a fixed rule such as line count times the font's line height from the manifest? Default in code: none; no split is made and no measurement is invented.

3. **`\multicolumn` in table spans (EXP-041 criterion 1).** The criterion says spans are produced "by the class's own cell macros". Colspan is written with `\multicolumn`, a LaTeX command; rowspan uses the class's `\DErowspan`. Question: should the class define `\DEcolspan` as a wrapper around `\multicolumn`, so that every span goes through a class macro? Default in code: unchanged. A change touches `tables.test.ts`, which another lane's round 5 wrote, so it was not made here.

4. **Raw writer callers (EXP-045 criterion 3).** The criterion says only the emitters call the raw writer. In the code, `line()` takes a `Tex` value and is called by the block, table and flow writers, which build their `Tex` from emitters. Question: does "call it" mean "build a `Tex` from text" (then the type rule already holds, and the guard test in `emit.guard.test.ts` covers it), or "call `line()` directly" (then the criterion conflicts with the design)? Default in code: the first reading, tested by `emit.guard.test.ts`.

5. **Font hash check (EXP-047 criteria 2 and 5).** The converter does not read font files; the worker mounts them. Question: is a manifest consistency check (each `file` equals `<sha256>` plus its extension) in the converter acceptable as partial evidence for criterion 2, or must the check be in the worker? Default in code: not implemented.

## Consequences

- No criterion of EXP-038 to EXP-047 was newly ticked in this round.
- No compile, measurement, Podman or browser run was made.
- Files of this round: this ADR only. No package source was changed.

## Round 6 (export-latex-5): stories EXP-034, EXP-035, EXP-037

Open questions raised by the round, with the default taken:

6. **Block fallback text emitter (EXP-035 criterion 2).** The criterion says `fallbackText` of an `extension_block` goes through the `text` emitter. The attributes table (`src/attributes.ts`) maps the block's `fallbackText` to `pdfString`, and the class takes a PDF string in `\DEplaceholder` and in the picture's alternative text. Question: is the criterion or the table right? Default in code: unchanged (`pdfString`); criterion 2 stays unticked.

7. **Printed form of a signing date (EXP-034 criterion 2).** A `dateSigned` value is printed as its stored string, with no date formatting. The criterion says the stored date, set in the workflow's time zone by the server, is printed. Question: is the stored string the printed form (as now), or is a date pattern from the field's format applied, as for `date` fields? Default in code: the stored string, unchanged.

8. **Signature image (EXP-034 criterion 1).** A signature or initials value is not drawn from its asset; the converter warns `form_value_not_printed` and prints blank. Drawing it needs an image box for a field value, which the spec places with EXP-058 for appearances. Default in code: unchanged.

9. **Watermark and tagged reading order (EXP-036 criteria 2 and 3).** `page_setup.watermark` maps to `null` in the attributes table, so no watermark is drawn. The spec does not give the mapping (09 has none). Default in code: unchanged; not built.

Changes in this round: a `fallback_asset_missing` warning in `src/blocks.ts` (EXP-035 criterion 4); new tests `src/bidi.controls.test.ts`, `src/extension.fallback.test.ts` and `src/form-fields.signed.test.ts`. Ticked: EXP-035 criteria 1, 3 and 4; EXP-034 criteria 3 and 4; EXP-037 criterion 4. None of these was compiled.

## Round 7 (export-latex-5, round 3): stories EXP-043 and EXP-045

Status: proposed. Open questions raised by the round, with the default taken:

10. **Link title emitter (EXP-043 criterion 4).** The link title is written by `pdfHexString` (`src/inline.ts`, UTF-16BE with a byte order mark, for the link's `/Contents`). The attributes table (`src/attributes.ts`) maps `mark:link.title` to `pdfString`, which writes UTF-8 hex. Question: which form does the link title use, and does the table or the code change? Default in code: unchanged (`pdfHexString`), so criterion 4 stays unticked. A test (`src/emit.output.search.test.ts`) accepts the UTF-16 form and shows the probe is encoded.

11. **Raw writer callers, pinned list (EXP-045 criterion 3).** `src/emit.raw-writer.test.ts` pins the five modules that call `line()` (`blocks.ts`, `convert.ts`, `flow.ts`, `page.ts`, `tables.ts`). This is the reading of question 4 under which the callers build `Tex` from emitters. Question for the owner: is the pinned list the right guard, or should the criterion's "only the emitters call it" be reworded? Default in code: pinned list, criterion 3 stays unticked.

Changes in this round: new tests `src/emit.output.search.test.ts` (six tests, passing) and `src/emit.raw-writer.test.ts` (two tests, passing). Nothing ticked. No compile was run.

## Round 7 (export-latex-5, round 4): story EXP-041

Status: proposed. Stories worked in this round: EXP-041 only. The other stories of the slice in reach either have ticked criteria (the round rule skips them) or need a compile or a measurement.

12. **Span macro (EXP-041 criterion 1; question 3 above, now decided in code).** `class/docedit.cls` defines `\DEcolspan[3]{\multicolumn{#1}{#2}{#3}}`, and `src/tables.ts` writes every column span, including the covered positions of a row span, through it. Single columns that need an alignment spec keep `\multicolumn`, because they are not spans. Question for the owner: is a class macro that wraps `\multicolumn` the intended reading of "the class's own cell macros", or should the class draw the span itself? Default in code: the wrapper. Criterion 1 is ticked on the structural reading; the compile is not run. Test: `src/tables.spans.test.ts`.

Not done in this round, for the next lane (with the reason): EXP-038 criterion 5 (row heights) has ticked criteria, so the round rule skips it; the open question is question 1 above. EXP-039 has no criterion that can be met without a height measurement (question 2). EXP-047 criterion 2 needs the worker's font files, which the converter never reads (question 5).

## Round 8 (export-latex-5): story EXP-039

Status: proposed. Stories worked in this round: EXP-039 only. The slice has no other story without ticked criteria and no claim.

13. **Split rule for a tall row (EXP-039 criteria 1 and 3).** The rule is built as a pure function, `src/tables.split.ts` (`splitRow`). It cuts only at block boundaries, round robin over the cells so that they stay in step, and reports a block that does not fit alone, with its cell and index. The fit test is an argument, so the rule does not depend on a measure. Default in code: the converter does not call `splitRow`, and no height is measured (question 2 stays open). Question for the owner: which measure does the converter use, a first LuaLaTeX pass with the class, or a rule from line counts and the manifest's line height? Criteria 1, 3 and 4 stay unticked. Tests: `src/tables.split.test.ts` (7 passing).

Nothing ticked in this round. No compile was run. `tsc --noEmit` for the package reports no error.

## Round 9 (export-latex-5): stories EXP-038, EXP-040, EXP-043, EXP-046

Status: proposed. Stories worked in this round, from the end of the slice: EXP-046, EXP-043, EXP-040, EXP-038. Sandbox compiles ran here (Podman, the export worker's image), so the compile checks below were run, not only read.

14. **Row heights (EXP-038 criterion 5, supersedes question 1).** The default is now in code: an `atLeast` row gets a strut `\rule{0pt}{h}` at the start of each single-row cell, and an `exact` row gets `\vbox to h{...}\vss` around each single-row cell's content. A row span is not sized. Content taller than an `exact` row is not clipped; it runs into the next row. Question for the owner: is clipping required for `exact` (a `\vbox` with clipping, or a `\DEclip` class macro)? Default in code: no clipping. Test: `src/tables.rowheight.compile.test.ts`, which reads word positions with `pdftotext -bbox`. Criterion 5 is ticked for rows whose content fits.

15. **Title metadata is not written (EXP-043 criterion 1, found by a compile).** `convert.ts` writes `\hypersetup{pdftitle=\DEstr{...}}`. In the compiled PDF there is no `Title` field at all, not even for a plain ASCII title, so the title does not reach the metadata. The cause is not found. Default in code: none; the test in `src/pdfstring.compile.test.ts` is marked `it.fails` and says so. Question for the owner and the class: where should the title go (hyperref's `pdftitle` with a decoded value, or the `\DEstr` string written after `\AtBeginDocument`)? Criterion 1 of EXP-043 stays unticked for this and for bookmarks (not checked). Alternative text on a placeholder is checked by a compile and passes.

16. **Boxed table cell content (EXP-040 criterion 3).** The compile test uses a figure without a picture and an equation the math gate refuses, so their placeholders (`[figure: ...]`, `[equation]`) are what the PDF shows. A typeset formula and a real picture in a boxed cell are not checked. Question: is a placeholder an acceptable reading of "appear" for a figure with no file? Default in code: yes. Criterion 3 is ticked on this reading. Test: `src/tables.boxed.compile.test.ts`.

17. **Batch of text-emitter strings (EXP-046 criterion 1).** The criterion says "each is exported and compiled". The test puts every known-attack seed and 60 fixed-seed random and mutated strings in one document, one paragraph each, and one compile checks all of them. Question: is one compile for a batch enough? Default in code: yes. The batch leaves out hyphens, quotes, lower-case `fi` and `ff`, and glyphs the default font lacks. Test: `src/emit.compile.fuzz.test.ts` (about 90 s).

Nothing else changed in this round. The package type-checks (`tsc --noEmit -p packages/export-latex`). The scoped unit tests (`tables.test.ts`, `tables.spans.test.ts`, `tables.rowspan.overflow.test.ts`, `tables.split.test.ts`, `converter.test.ts`) pass, 38 tests.

## Round 7 (export-latex-5, 2026-11-13)

- **EXP-046 criterion 5, item 3 (proposed).** The stored-failure corpus lives in \packages/export-latex/test/emitter-corpus/\, one JSON file per input (\{emitter, input}\), replayed by \packages/export-latex/src/emit.corpus.test.ts\. The shared corpus package is outside this lane. The owner should say whether the corpus moves to \packages/corpus\. No failure has been found, so the folder is empty and criterion 5 stays unticked.
- **Claim rule (interpretation).** The lane takes stories with unticked criteria that can be advanced inside \packages/export-latex\. Stories with some ticks were not skipped, because most of EXP-038 to EXP-047 carry ticks; fully ticked stories were left alone.

## Round 8 (export-latex-5): stories EXP-038 to EXP-047, from the end of the slice

Read again against `packages/export-latex` (no source or test changed in this round, no story claimed or ticked). Every unticked criterion in EXP-039, EXP-043, EXP-045, EXP-046 and EXP-047 needs one of: a LuaLaTeX compile in the sandbox image, a measured row height (question 2), a worker or editor file (EXP-047 criteria 1, 2 and 3), an owner decision (questions 5 and 6 to 9, and the link title emitter in EXP-043 criterion 4), or a stored failing fixture (EXP-046 criterion 5). EXP-038 criteria 4 and EXP-041 criteria 3 and 4 are unmet in the converter (cell borders and banded rows are not drawn, per the story notes). The pure split rule of EXP-039 (`tables.split.ts`) stays unused by the converter until question 2 is answered.

Decision needed from the owner: question 2 (how row height is measured). Until then no criterion of this batch can move without inventing a measure, which the rules forbid.

Changes in this round: this ADR only.

## Round 8 fix (export-latex-5): cell borders (EXP-038 criterion 4, EXP-041 criterion 3)

Status: proposed. A review found that cell borders could be built in the converter without an owner decision. They are now drawn (`src/tables.ts`, `class/docedit.cls`). Two questions are raised, with the default taken:

18. **Which border wins on a shared edge (EXP-038 criterion 4).** 03 §4.3 gives `table_cell` a `borders` attribute (top, bottom, left, right) but not how it combines with the table's borders or with the next cell's. Default in code: a side the cell sets (style `none` included) replaces the table's border on that side; a side it does not set takes the table's. On an edge two cells share, a drawn border wins over one that is not drawn, of two drawn borders the wider wins, and on a tie the cell on the left or above wins. This is a simplified form of Word's rule for cells without spacing (Word also weighs the style and the colour). The borders of a row span apply to every row it covers, and no rule is drawn between the rows it spans. Dotted, dashed and thick borders are drawn solid, as table borders already were. Question for the owner: is this rule enough, or must the export follow Word's full weighting? Tests: `src/tables.borders.test.ts`, `src/tables.borders.compile.test.ts`.

19. **Colour of banded rows (EXP-038 criterion 4).** 03 §4.3 lists `bandedRows` as a table-style property with no colour, and no other property gives a band colour, so the converter cannot shade bands without inventing one. Default in code: unchanged; a table style with `bandedRows: true` gives the warning `banded_rows` and no band is shaded. Question for the owner: where does the band colour come from (a new table-style property such as `bandShading`, the `shading` of the style's odd or even row, or a fixed house colour of the class)? Until this is answered, EXP-038 criterion 4 stays unticked.
