# ADR 0140: export-latex lane 2, backlog batch (round 1)

Status: proposed

## Context

Lane export-latex-2 works the EXP epic (`docs/stories/EXP-export.md`) from the end of its slice (EXP-033 backwards). In round 1 it touched EXP-030, EXP-031 and EXP-033. The criteria are mostly about the printed PDF, and only the converter's output could be tested here, so few criteria are ticked. The open points below need a decision; none is decided silently.

## Open points

1. Link targets (EXP-030, criterion 1). The story asks for characters special in TeX arguments to be percent-encoded. `url` in `packages/export-latex/src/emit.ts` passes `&`, `#` and `%` through unencoded; they are inert inside its hexadecimal payload, but the wording is not met. Spec default: percent-encode. Not changed in this round.
2. Link titles (EXP-030, criterion 5). The story names `pdfString`; `linkWrap` in `inline.ts` writes `pdfHexString`, and `attributes.ts` maps `mark:link.title` to `pdfString`. Spec default: one emitter, as the story names it. Not changed in this round.
3. Checkbox glyph (EXP-033, criterion 2). The story says the glyph is chosen through `enumLookup`; the model's `valueText` chooses it with a fixed mapping. Either the emitter path or the wording changes. Not changed in this round.
4. Blank space for an empty field and overflow of a wide value (EXP-033, criteria 1 and 6). The converter does not measure widths; the class reports overflow in the log. Left open, as the story's own Notes say.

## Decision

None taken by this lane. Owner or main session to decide points 1 to 3.

## Round 2 (EXP-026, EXP-027, EXP-028)

Lane export-latex-2, round 2, worked from the end of the slice: EXP-032, EXP-029, EXP-028, EXP-027 and EXP-026 were looked at. EXP-032 and EXP-029 were not taken: their criteria need the class's tab and footnote macros, which a compile would check, and the footnote criterion for `\footnote` where LaTeX allows it does not match the class (the class always writes `\footnotemark` and `\footnotetext`, `docedit.cls`). Ticked here: EXP-026 criteria 1 and 4, EXP-027 criteria 1, 3 and 4, EXP-028 criterion 1. Tests: `packages/export-latex/src/glyphs.missing.test.ts`, `languages.typeset.test.ts`, `pictures.typeset.test.ts`.

5. Picture alt text (EXP-028, criterion 4). The story names `pdfString` for the graphic's alternative text; `imageBox` in `inline.ts` passes `alt` to `\DEimg` as a `kvValue` option of `\includegraphics`. Spec default: the emitter the story names, `pdfString`. Not changed in this round; an emitter decision.
6. Figure placement in the PDF (EXP-028, criterion 2). The converter writes the float flag, and the class decides where a float lands. Whether `here` never moves is a LaTeX-run check, not decided here.
7. Footnote macros (EXP-029, criterion 1). The story wants `\footnote` where LaTeX allows it. The class always uses `\footnotemark` with `\footnotetext` (`docedit.cls`, `DEfntext`). Spec default: the story's own wording; the owner or main session to decide whether the class should use `\footnote` for ordinary body footnotes. Not taken in this round.
8. Glyph check job (EXP-026, criteria 3 and 5). The converter gives an error in the final profile; that the worker releases no PDF is in `services/export-worker`, outside this lane.

## Round 4 (EXP-029, EXP-023, EXP-021, EXP-020)

Lane export-latex-2, round 4, worked from the end of the slice. EXP-021 was already tested in `exp-021-spacing.test.ts` but unticked; its criteria 1 to 4 are now ticked. EXP-020 and EXP-029 were taken; EXP-023 was taken and not ticked. Tests: `packages/export-latex/src/exp-020-cascade.test.ts`, `exp-029-footnotes.test.ts`, `exp-023-toc.test.ts`. Ticked: EXP-020 criteria 3, 4 and 5; EXP-021 criteria 1 to 4; EXP-029 criteria 2 and 4. None of the tests compiles a PDF.

9. Footnote restart (EXP-029, criterion 2). The setting is `perPageSection`, but the model (`packages/model/src/numbering/labels.ts`) restarts the marks at every section break, and the converter prints those labels. The name says page. Spec default: the model's meaning, which the converter follows; criterion 2 is ticked on that reading. The owner or main session to decide whether a page restart is wanted; it would need the layout (EXP-055).
10. Paragraph borders (EXP-020, criterion 2). `props.ts` does not draw paragraph borders and warns that shading is not drawn while it still writes `\DEshade`. Not decided; the class needs a change, which is outside this lane.
11. Numbering-level leg of the cascade (EXP-020, criterion 1). Not tested here; criterion 1 stays unticked.
