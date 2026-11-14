# 0115. Export LaTeX backlog batch: open questions from packet X1

**Status:** proposed (2026-11-13). Written by the export-latex developer in the backlog batch for packet X1 (converter and emitters). Not reviewed by the owner.

## Context

Stories EXP-042, EXP-043 and EXP-044 are emitter stories of 09 §4. Implementing their criteria in `packages/export-latex` left four points that the spec does not settle. The stories say "never decide an open question silently" (CLAUDE.md), so each point is recorded here with the default taken in code and the question for the owner.

## Open questions and the default taken

1. **Percent-encoding of TeX-special characters in link targets (EXP-043 criterion 3).** The story asks that characters special in TeX arguments are percent-encoded. Percent-encoding `%` would change the meaning of existing escapes such as `%20`, so a literal rule cannot be applied as written. Default in code: `url()` refuses every scheme outside invariant I9 and hex-encodes the whole target, so `#`, `%`, `&`, `$`, `~` and `_` never reach TeX as TeX. Question: does the owner accept hex encoding as the rule, or should the spec name the exact set to percent-encode and how `%` is handled?

2. **Encoding of bookmark and metadata strings (EXP-043 criterion 1).** `pdfString` writes UTF-8 hexadecimal digits that `docedit.lua` decodes into catcode-12 characters. The UTF-16BE form with a byte order mark (`pdfHexString`) is used for dictionary entries. Default in code: both forms exist, and which one bookmarks use is left to the class. Question: should the spec name one encoding for every PDF text string, to be checked by veraPDF (EXP-016) once compiles run?

3. **Where the diagnostic for an unsafe value is raised (EXP-044 criteria 2 and 4).** `color` returns `null` and `enumLookup` returns the fallback with `known: false`. The emitters do not raise diagnostics. Default in code: the callers raise them. Question: should the emitters return a diagnostic value, so no caller can forget it?

4. **Generated counters (EXP-042 criterion 4).** `generatedId` now rejects negative and non-integer counters (change made in this batch). Default in code: a counter is a non-negative safe integer. Question: none beyond confirming the default.

## Consequences

- EXP-042, EXP-043 and EXP-044 are partly ticked. The unticked criteria are listed in each story's Notes with the reason.
- No compile was run (no LuaLaTeX, no Podman in this batch), so no criterion that needs a PDF has been ticked.
- The EXP-045 guard check, which the `emit.ts` header refers to as `emit.guard.test.ts`, does not exist yet. It is the next step for criterion 4 of EXP-043.

## Round 1 (packet X2): bundle, source map and images

Stories EXP-002, EXP-011, EXP-012 and EXP-014 were worked in this round. Tests are in `packages/export-latex/src/converter.test.ts` and `map-assets.test.ts`. Status: proposed.

5. **Footnote text in `map.json` (EXP-012 criterion 2).** 09 §2 says footnote text lines map to the footnote. The code registers the footnote paragraph as its own block with the footnote as owner, but emits the footnote's text inside the host paragraph's lines, so `map.json` attributes those lines to the paragraph. No default was chosen in code; this is a gap against the spec default and is left unticked. Default to follow: give footnote text its own line scope. Question for the owner: none beyond confirming the spec default.

6. **Bundle hash change test (EXP-011 criterion 4).** The test varies `docedit.cls` and `main.tex`, and checks that the manifest lists the hash of every file. It does not vary `assets/` or `map.json` one by one. Default in code: the hash is over every file listed in the manifest. No owner decision needed.

7. **SVG on the converter (EXP-014 criterion 2).** The converter refuses SVG with `asset_type_unsupported`; the conversion on upload is the asset worker's (BE-043, BE-045). Default in code: refuse, do not convert. No owner decision needed.

## Round 2 (export-latex developer, 2026-11-13): emitter diagnostics, attribute table, bundle uniqueness, class audit

Stories EXP-042, EXP-044 and EXP-045 were extended and EXP-015 was audited in this round. Status: proposed. Tests: `packages/export-latex/src/diagnostics.test.ts`, `attributes.test.ts`, `emit.guard.test.ts`, `emit.bundle.test.ts`, `class.test.ts`.

8. **Diagnostics from the callers, through two helpers (answers question 3).** `colourOf` and `enumOf` in `context.ts` wrap `color` and `enumLookup` and raise `colour_invalid` and `enum_unknown` with the block id. Every lookup on a user value now goes through `enumOf`; the only direct `enumLookup` call left is a converter constant (`'a-4f'`). Default in code: the emitters still return plain values, and the helpers raise the diagnostic. Question for the owner: should the emitters themselves return the diagnostic, so that no caller can forget it?

9. **Diagnostics for values that belong to no block (EXP-044 criteria 2 and 4).** Some values do not belong to a block: a colour or a lookup in a style definition, a tab list (shared by many paragraphs), a page setup's page number format, and the export options. Their diagnostics carry `blockId: null`. Default in code: this, because the spec names no other owner for these values. Question for the owner: should a style or page setup name its own owner in `map.json` instead?

10. **Gated math and the eight emitters (EXP-045 criterion 1).** `gatedMath` writes LaTeX that passed the math gate (09 §6.3) without one of the eight emitters. The criterion lists the eight only. Default in code: the gate is the sanctioned path (EXP-049 to EXP-051) and the criterion stays unticked. Question for the owner: does the criterion mean the gate is a ninth emitter, or that math must be written through the gate's own check?

11. **Test of the attribute table (EXP-045 criterion 2).** `attributes.test.ts` compares the keys of the CDM definition (nodes, projection nodes and marks) with the table, in both directions. It does not check that the emitter named for an attribute is the one the converter really uses. Default in code: the names are the table's own. No owner decision needed.

12. **Class audit (EXP-015).** `class.test.ts` reads `docedit.cls` as text. It checks that none of the six forbidden packages is loaded, that the loaded packages are the fixed list, and that the class version equals the converter's `CLASS_VERSION`. It does not run TeX, so it cannot show that the packages work with tagging. No owner decision needed.

## Round 3 (export-latex developer, packet X2): math gate

Stories EXP-049, EXP-050 and EXP-053 were worked in this round. Status: proposed. Tests: `packages/export-latex/src/math/gate.test.ts` and `packages/export-latex/src/math/gate.fuzz.test.ts`. No TeX engine was run, so nothing that needs a compile is ticked.

13. **Display environment inside a value (EXP-050 criterion 4).** The criterion says that `equation` is the only display environment allowed. The gate refuses `\begin{equation}` inside a `latex` value, and accepts `aligned`, `gathered`, `cases` and the matrix environments. Default in code: the class supplies the display wrapper (09 §6.3), so the user value never opens `equation`. The criterion stays unticked. Question for the owner: is the criterion meant as "the display wrapper is `equation`" (current code) or as "a value may contain `equation`"?

14. **Allow-list currency and compile (EXP-049 criterion 5).** The generated file has a fingerprint, and the generator is `scripts/math-allow-list.ts`. A currency test and the compile of every sample under the class are not written, because the compile needs the TeX engine. Default in code: the criterion stays unticked. No owner decision needed.

15. **Gate as the one implementation (EXP-049 criterion 6).** The converter imports `mathGate`. The authority receives the gate by injection (`RoomInit.mathGate`), and the editor has no caller yet. Default in code: the criterion stays unticked until the editor and the host wire the same function. No owner decision needed.

16. **Fuzzing without a compile (EXP-053 criteria 2 and 5).** The fuzzer checks the lexical half of criterion 2 (every control word of an accepted value is on the allow-list). The token-stream trace and the box check need the engine. Criterion 5 (regression fixtures) stays unticked, because no failure has been found yet. Default in code: the 2 s bound per call is a hang guard, not a target. No owner decision needed.

## Round 4 (export-latex developer, packets X1 and X2): preflight, style macros, emitter fuzz

Batch 2026-11-13, round 4. Stories EXP-003, EXP-013 and EXP-046 (packets X1 and X2).

17. **Glyph warnings per occurrence (EXP-003 criterion 1).** The spec asks for "one warning for each occurrence". `preflight()` gives one `glyph_missing` warning per distinct missing code point in each block, so a character repeated in a paragraph is reported once. Default in code: one per block and code point. Question for the owner: should every occurrence be reported, or is one per block and character what "occurrence" means?
18. **Table warning reported once (EXP-003 criterion 5).** The table writer (`tables.ts`) reports `table_cannot_span_pages` when it sets a table as a box, and the preflight reports the same case earlier. Both were in the job, so the warning appeared twice. Default in code: the converter drops the preflight copy of this code and keeps the writer's, which also covers footnote tables. The preflight still returns the warning for the editor. No owner decision needed.
19. **Style macros are written when a style is first used (EXP-013 criterion 1).** `styleMacro` in `props.ts` writes a macro for a style when a paragraph first uses it, so an unused `style_def` has no macro in `styles.tex`. The spec says "one macro per style". Default in code: lazy, which keeps the file to the styles used. Question for the owner: should `styles.tex` hold a macro for every style definition, used or not?
20. **Emitter fuzzing checks grammar, not compile (EXP-046 criteria 1, 2 and 5).** `emit.fuzz.test.ts` reads each emitter's output back and checks its grammar (no bare TeX special or backslash, hex digits only for `pdfString`, `kvValue` and `url`). It does not compile the output or trace the token stream, which needs the sandbox and Podman. Failing inputs are not stored as corpus fixtures, because no failure has been found. Default in code: criteria 1, 2 and 5 stay unticked. No owner decision needed.

## Round 5 (export-latex developer, packets X1 and X2): tables, font manifest

Status: proposed. Stories EXP-038, EXP-040, EXP-041 and EXP-047.

21. **Width of a table column (EXP-038 criterion 1).** The `p` column is the grid width less the left and right cell margins (`(grid - 216) / 20` bp with the default margins). Default in code: the grid width of the column is the one the criterion means, with the cell margins taken out, as the converter has always done. Question for the owner: should the column be the full grid width, with the margins inside the column?
22. **A boxed table is reported whatever its height (EXP-040 criterion 2).** The converter does not measure height, so `table_cannot_span_pages` is raised for every table in a multi-column section, a header or a footer. Default in code: the report is a superset of the taller case, and the criterion is ticked on that reading. Question for the owner: should the converter measure the table and report only the tall ones?
23. **Spans use `\multicolumn` (EXP-041 criterion 1).** The criterion says spans are produced by the class's own cell macros. Colspans are written with `\multicolumn`, a LaTeX command, and rowspans with `\DErowspan`, the class's macro. Default in code: unchanged, and the criterion stays unticked. Question for the owner: should colspans also go through a class macro, so that the boxed and longtable writers share one path?
24. **Font chain without a fallback list (EXP-047 criterion 4).** When the font manifest has no `fallback` list, the glyph check uses the math face as its chain, and the bundle manifest lists it with role `math`, not `fallback`. Default in code: this, as recorded. The manifest does not record the coverage ranges or switch-off of the check. Question for the owner: should the bundle manifest record the coverage ranges the glyph check used?

## Round 6 (export-latex developer, packet X1 and X2): style macros and class structure

25. **Answer to question 19: a macro for every style definition.** `convert.ts` now calls `styleMacro` for every `style_def` after the body and the TOC, so an unused style also has its macro in `styles.tex`. Default in code: the spec default ("one macro per style", 09 §2), which is eager. The macro names of styles in use do not change, because the body and the TOC are written first. The owner may still choose the lazy form; then EXP-013 criterion 1 is unticked again. Question for the owner: confirm eager.
26. **Class structure read as a source audit (EXP-015 criterion 2).** `class.structure.test.ts` reads `docedit.cls` and `docedit.lua` as text and checks how headings, lists, labels, tab stops and row spans are built. This is a check of the construction, not of the PDF. Default in code: a source audit is accepted for "is built on" in this criterion, and the criterion is ticked. Question for the owner: should the same claim also be checked on a compiled PDF (for example, the tagged structure tree) once TeX runs in CI?
27. **Footnote text line scope (EXP-012 criterion 2), still open.** Footnote text is written inside the host paragraph's line (`inline.ts`, `footnoteText`), so a line-level map cannot give it the footnote's identifier without changing how `\DEfntext` is placed in the flow. Not changed this round. Default to follow: give footnote text its own line scope, as item 5 says. Question for the owner: none beyond confirming item 5.
28. **Compiled checks in the package (packet X1, 2026-11-13).** `src/typeset.compile.test.ts` compiles bundles in the Podman sandbox of the export worker (`test/harness.ts`) and reads the PDF text with `pdftotext`. It backs EXP-042 criterion 5, EXP-027 criterion 2, EXP-031 criteria 1 and 2, and EXP-038 criterion 3. Default in code: the tests skip when `sandboxReady()` is not ok, as the harness already does, so a machine without Podman runs them as skipped, not as passed. Question for the owner: should CI run this file on a runner with Podman, and should `pdftotext` (Poppler or Xpdf) be a declared tool of the test image?
29. **Page and text checks only, not positions.** The new compile checks read pages and text, not positions. Column breaks (EXP-031 criterion 3) and the placement of figures (EXP-028 criterion 2) need positions from `layout.json`, and stay unticked.

## Round 7 (export-latex developer, packets X1 and X2): main.tex structure, checkbox glyph

Status: proposed. Stories EXP-011 and EXP-033. Batch 2026-11-13, round 7.

30. **Structure of main.tex (EXP-011 criterion 2).** `src/exp-011-main-tex.test.ts` checks that main.tex starts with the generated seed macro, that each block owns one contiguous range of map.json, that every body line with no block is generated structure, and that a probe with TeX specials reaches main.tex only escaped. The generated-line check accepts any line that starts with a command, so it is looser than a list of macros. Default in code: criterion 2 is ticked on this reading. Question for the owner: should the check name the generated macros exactly?
31. **Checkbox glyph through enumLookup (EXP-033 criterion 2, part).** The converter now chooses the checkbox glyph (checked or unchecked) through `enumLookup` (`CHECKBOX_GLYPHS` in `src/inline.ts`); the value never reaches the output, and any value that is not `true` prints the unchecked glyph, as the model's `valueText` did. Default in code: this. The glyph characters are the model's, now held in the converter's table. No owner decision needed.
32. **Date pattern and the job's time zone (EXP-033 criterion 2, part, still open).** A form date is a calendar date (`YYYY-MM-DD`). The converter applies its date pattern at UTC noon (`formFieldValue`), so the day does not move. The criterion says "dates using the export job's time zone". A calendar date has no instant, so the zone does not change its day, but the criterion and the code read differently. Default in code: UTC noon, and criterion 2 stays unticked. Question for the owner: should a form date be printed without any time zone (the calendar date), or should the job's zone apply to it?

## Round 10 (export-latex, 2026-11-13)

Status: proposed.

- Podman could not start containers on this host during this round (`crun: controller pids is not available`), so no sandbox compile ran. Compile-based criteria (EXP-026 criterion 2, EXP-028 criterion 5, EXP-030 criterion 3) stay unticked. The host needs its cgroup pids controller restored before those tests can be run. This is for the main session, not the export-latex package.
- EXP-028: the converter test `exp-028-figure-caption.test.ts` checks the literal caption label and the `align` class code. Whether `align` should move the caption as well as the picture remains the owner's question (decision 12 of ADR 0223). No change made.
- EXP-026: the class sets `\tracinglostchars=3` for final exports (`docedit.cls`, line 65). Whether a character no image font covers is in fact lost at compile time is not confirmed, because the compile could not run.

## Round 6 of the packet (export-latex, 2026-11-13, packet X1/X2 lane)

Status: proposed.

- EXP-032 criterion 1: the underscore and heavy tab leaders drew nothing. `make_leader` in `class/docedit.lua` built a bare rule node of width 0 for them, and a bare rule in an hlist is not drawn as a bar. The rule now sits in a 1 pt hbox, so its repeats join into one line. The class output changed for those two leaders. `CLASS_VERSION` (`src/convert.ts`, `0.2.0`) is not bumped. Owner question: does a change to the class's output need a new `classVersion`?
- EXP-022 criterion 1: the compiled PDF has no `/Outlines` object, so no bookmark is written for any heading, although `\DEh` sets each heading with the kernel `\section` and the pdfString as its optional argument, and hyperref is loaded. The cause is not found. `src/exp-022-bookmarks.compile.test.ts` is written as `it.fails` (it also passes if the compile itself fails, so a compile error reads as a pass); it must become `it` once the outline is written.
  Corrected in round 7 (export-latex, 2026-11-13): this entry is wrong. The outline exists. The defect was the test's `/Title` parser, which did not follow indirect `/Title` references inside object streams. The test is now a plain `it()` (`pdfLinks` in `test/exp-023-pdf-links.ts` inflates object streams), and it checks the outline of four headings. The `it.fails` form no longer exists.
- EXP-055: `src/exp-055-layout.compile.test.ts` was run again in this round after two additions: a seq of 42 in the criteria 3 and 6 tests, and a page setup check against the bundle's setup list in criterion 2. The ticks were already set by an earlier lane and are unchanged.

## Round 7 of the packet (export-latex, 2026-11-13, packet X1/X2 lane)

Status: proposed.

- No criterion was ticked in this round. The candidates in the packet's stories were checked against the code and the tools on this host, and each unticked criterion needs one of these, none of which this round could provide: a LuaLaTeX compile in the sandbox (Podman's sandbox gate reports not ready here, see EXP-072 in `services/export-worker`), a change to the class or the converter's output that cannot be checked without a compile, or an owner decision.
- EXP-051 criterion 4 (the converter's gate result equals the commit-time result for the same gate version): stays unticked. The manifest records neither `ALLOW_LIST_VERSION` nor the KaTeX version. A decision is needed on whether the manifest records the gate version (owner, or the reproducibility stories EXP-076).
- EXP-052 criterion 5 (the class clips every equation to its box): stays unticked. `docedit.cls` has no clipping box. Adding one changes the class output and needs a compile.
- EXP-012 criterion 2 (footnote text maps to its footnote block): stays unticked. The footnote text is returned as inline material of the host paragraph's line (`inline.ts`, `footnoteText`), so `map.json` cannot separate it without a change to the line structure of `main.tex`. Header and footer text lives in `styles.tex`, which `map.json` does not cover.
- EXP-115 criteria 1 to 3 (the model's fixtures run against the LaTeX writer): unticked. The fixtures are in `packages/model/fixtures/semantics`; the criterion 1 comparison is of labels in the extracted PDF text, which needs a compile. No runner that names a failing fixture and writer exists in this package.
- EXP-114 criterion 1 (every mapping has a stored reference PDF): two reference PDFs exist (`packages/export-latex/test/references`). They do not cover every mapping of 09 §3.
- EXP-043 criteria 1 and 3 and EXP-030 criterion 1 (PDF string encoding; percent-encoding of TeX-special characters in URLs) remain the open question recorded in EXP-043 Notes. The `url` emitter hex-encodes the whole target instead.
- EXP-085 criterion 4 (the licence manifest of the packages in the archive): the manifest is produced by the export worker image (EXP-073), outside this package.
- EXP-022 Evidence: the superseded criterion 2 sentence is withdrawn in `docs/stories/EXP-export.md`. The EXP-022 and EXP-032 progress counts were not updated (orchestrator).

## Round 11 (export-latex developer, packets X1 and X2, 2026-11-13)

Status: proposed.

- Layout compile test timeouts (review item, `src/exp-055-layout.compile.test.ts`): the four cases now pass `COMPILE_TIMEOUT_MS` (300 s) to `it`, instead of the 60 s `testTimeout` of the shared config. Default in code: 300 s per case, chosen here without a measurement. No owner decision needed. This round the file was skipped, not run: `sandboxReady()` reported the sandbox as not ready when it ran at 21:28, so the timeout change is not confirmed by a run.
- VeraPDF reference check (review item, `src/exp-114-references.compile.test.ts`): a run of the file on this host at about 21:10 passed both reference PDFs (SHA-256 matched, `ua2` and `4f` flavours compliant, 396 s in total, one test skipped as not required). The reviewer's failure was not reproduced and its cause was not found. `class/releases.json` (version 0.2.0) was not changed in this round. The reference PDFs were not regenerated.
- Pagination with no room for the body (review item, ADR 0032). Open, not decided. The class ships page 1 with an empty body, sets the body line on page 2 and makes a page 3. Questions for the owner or for a proposed ADR under ADR 0032: (a) should page 1 carry the body line as overfull; (b) should a page be skipped, and which; (c) why does page 3 appear. The layout engine (`services/export-worker/src/layout.ts`, not this package) has no test for this frame, and no test in this package reaches it without a compile. Default in code: unchanged.
- EXP-111 criterion 3 (document language and passage language), converter side. New file `src/exp-111-language.test.ts`: the `\DocumentMetadata` line takes `lang` from the settings, falls back to en-GB, and a marked run is wrapped in `\DElang` with the other text left in the document language. The criterion stays unticked: the PDF's passage-level language (for example `/Lang` on a marked span) is not checked, and the document-level `/Lang` test is in `src/exp-111-tagged.compile.test.ts`, which was not run in this round.
- EXP-043 criterion 2 (percent-encoding in `url`). The same open conflict as in the EXP-043 Notes: the story asks for TeX-special characters to be percent-encoded, but percent-encoding `&`, `#` and `%` would change valid URLs, and the `url` emitter hex-encodes the whole target before TeX reads it. Default in code: unchanged. Question for the owner: is the hex encoding the intended meaning of the criterion, or must the literal percent-encoding be added?
- Podman on this host was slow during this round: `podman version` did not answer within 20 s, and the compile suites skipped at one point and ran at another. Compile-based criteria in this round were not run unless a run is named in the story Evidence.
