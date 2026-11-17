# ADR 0367: Drawing paragraph borders and shading in the PDF

**Status:** proposed, 2026-11-15 (lane w2, EXP-020 criterion 2). Not decided by the owner.

## Context

03 §4.5 gives a paragraph `borders` (top, bottom, left, right, between) and `shading`. 09 §3.1 says paragraph styles are typeset from the cascade, and EXP-020 criterion 2 asks that borders and shading are drawn around and behind the paragraph. The house class did not draw either: `\DEshade` was an empty macro (ADR 0318, question 2). The spec does not say where the fill and the borders sit, how a bordered paragraph breaks across pages, or what the `between` border does.

The class loads no framing package (09 §3.1, tagging first), and a paragraph must still break across pages, so a box around the whole paragraph is not an option.

## Decision (proposed)

The drawing is done line by line in `docedit.lua`, in the `post_linebreak_filter` that already sets line heights. A paragraph's lines stack without glue, so one filled rectangle per line box gives a continuous fill.

1. **Shading** fills each line box from the left indent (or the first-line position when that is further left) to the right indent, over the line's full height and depth. Where a side has a border, the fill reaches the outer edge of that border.
2. **Borders.** The left and right borders are drawn on every line. The top border is drawn on the first line and the bottom border on the last. The first line grows by the top border's width and space, and the last line by the bottom border's, so the frame takes its own room and does not overprint the neighbours. Width and space are in twips, as table borders are; a border with no width is 8 twips wide and one with no colour is black. `double` is two lines one width apart; `dotted` and `dashed` use a dash pattern; `thick` is a solid line of its width.
3. **Page breaks.** A paragraph that breaks across pages keeps its fill and side borders on both pages; the top border is on the first page and the bottom border on the last. The box is open at the break.
4. **Tagging.** The drawing is one PDF literal per line, marked `/Artifact`. A tagged PDF with a shaded, bordered paragraph passes veraPDF for PDF/UA-2 (`exp-020-borders-shading.compile.test.ts`).
5. **Class release.** The class and its Lua module change, so the class version is 0.2.8 (ADR 0115).

## Open questions and the default taken

1. **The `between` border and joined boxes.** In Word, consecutive paragraphs with the same borders share one box, and `between` is the line drawn between them. Default taken: each paragraph is drawn on its own, with its own top and bottom border, and `between` is not drawn. The converter reports `paragraph_border_between` when `between` is set. The owner decides whether exports must join such paragraphs.
2. **Space before and after.** The fill and the borders cover the paragraph's lines, not its `spaceBefore` and `spaceAfter` gaps. Default taken as described; the spec does not say.
3. **Layout engine.** The first and last line of a bordered paragraph are taller in the PDF by the border and its space. Whether `packages/layout` adds the same room was not checked in this lane.
4. **Side borders and the margin.** A left or right border with its space is drawn outside the indent, so with a zero indent it is in the page margin, as in Word. No clamp is applied.

## Consequences

EXP-020 criterion 2 is met for a single paragraph and tested on a compiled PDF. The diagnostics `paragraph_shading` and `paragraph_borders` are gone. Three attributes are added to the class (`indr`, `shade`, `bord`).
