# ADR 0482: Layout fixtures where Word differs from the model (lane w2, EXP-115, EXP-090)

- Status: proposed
- Date: 2026-11-27
- Story: EXP-115 criterion 2 and EXP-090 criterion 6

## Context

The four layout fixtures of `packages/model/fixtures/semantics` (`line-spacing`, `paragraph-spacing`, `tabs`, `header-growth`) had no DOCX runner. They now have one each (`packages/export-docx/test/exp-115-*.word.test.ts`): the fixture's case is written by `writeDocx`, Microsoft Word 16 lays it out and exports a PDF, and the positions are read from the PDF with `pdftotext -bbox`. Most cases agree with the fixture. Four do not. Owner decision 238 (2026-11-26) says that where Word and the model give different numbering labels, Word's labels win. It names labels only, so it is not applied to these four. This ADR lists them and proposes what to do. Each runner asserts today's difference, so a change on either side shows.

## The four differences

1. **Line height of a line with an inline picture** (`line-spacing`, case `inline-picture`). The fixture says the line is as high as the picture (1440 twips). Word puts the picture on the baseline, so the line is the picture plus the descent of the text on the line: 1488 twips with 11 pt text.
2. **Contextual spacing on the upper paragraph only** (`paragraph-spacing`, pair `contextual-only-above`). Upper paragraph: space after 160, contextual spacing on. Lower paragraph: same style, space before 120, contextual spacing off. The fixture says 120 (only the upper paragraph's space after is dropped). Word places 0: it drops the whole gap. The mirror case (`contextual-only-below`, 160) agrees with the fixture.
3. **A hanging indent clears the default tab stops before it** (`tabs`, case `hanging-indent-does-not-clear-default-stops`). A paragraph with left indent 2880 and first line -2880: a tab from the start of the line goes to 720 in the fixture, to 2880 in Word (the hanging indent is a custom stop, and a custom stop clears the default stops before it). The other hanging-indent cases agree because their hanging indent lies on or before the next default stop.
4. **No room left for the body** (`header-growth`, frame `nothing-left-for-the-body`). The top of the body agrees (9708 twips). The fixture (owner decision 77) starts the body on page 2. Word prints one body line on page 1 (the run counted one line there).

## Proposed decision (for the owner)

The default of decision 238 applied by analogy: Word's behaviour wins, the fixture and the rule in 03 §7 change, the LaTeX class follows. For each:

1. An inline box is measured from the baseline: the line is the tallest ascent plus the tallest descent. The fixture case then needs the descent of the paragraph font in its input. The layout engine (FE-076) and the class change with it.
2. Contextual spacing on either paragraph of a same-style pair drops the whole gap between them.
3. A hanging indent is a custom stop, so default stops before it do not apply to the first line.
4. Decision 77 cannot be met in Word: a body that has no room still gets its first line on the page. Either decision 77 is relaxed for DOCX, or the DOCX export is allowed to differ here.

None of these is changed here. Until the owner answers, the criteria of EXP-115 (2) and EXP-090 (6) stay unticked.

## Writer changes made on the way

- A figure's paragraph, the caption of a figure that has no `Caption` style, and an equation block's paragraph now carry `w:spacing before=0 after=0` (`NO_BLOCK_SPACING` in `packages/export-docx/src/writer.ts`). Before, they took the spacing of the default style (160 after in the fixture), so the gap after a figure or an equation was larger in Word than the model's rule (a block that is not a paragraph has no spacing of its own). `paragraph-spacing` flow `figure-and-equation` shows it: the gap from the equation to the next paragraph was 0 beyond the reference, now 120.

## Method notes

- Word's PDF export places text on a grid of about 0.12 pt (2.4 twips). Gaps are compared within 5 twips (a difference of two positions), tabs within 1.5 pt. The smallest difference between two rules in these fixtures is 40 twips, apart from the one-twip header case, whose push is not asserted.
- Word's natural line height is not the model's 1.15. The `line-spacing` runner measures it for every size from 6 pt to 70 pt in the same Word run, sets each run at the size whose Word height is nearest the fixture's (within 8 twips) and compares the measured line height with `lineHeight()` of the model for those heights. Where the rule gives a length (`exact`, `atLeast` over a smaller run) the fixture's own number is compared.
- Not measured: trailing gaps (nothing follows them), the leading gap of a table cell, and the footnote and story containers of the `paragraph-spacing` flows. The LaTeX runner leaves the same ones out.
