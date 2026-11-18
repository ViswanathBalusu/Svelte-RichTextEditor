# ADR 0385: Rendering block suggestion marks (lane w1, FE-044)

Status: superseded by owner decision 92 (2026-11-15), which chose option 2 of ADR 0302: the block state is the `suggest` attribute, no element is drawn around a block, and the `display: contents` rule and the `de-suggest-wrap` class this file describes were removed on 2026-11-18. Kept as the record of why option 1 could not give a block without an element. Its text below is the state before the change.

## Context

A block that carries a suggestion node mark (`ins`, `del` or `fmt` on a paragraph, a table row or a table) is drawn by `prosemirror-view` inside the element of the mark. The view calls `syncToMarks(child.marks)` for every child, and it does so for block children too. A mark's `toDOM` must give an element, and a custom mark view (`nodeViews[markName]`) must give a `dom` as well: neither can give no element. This was checked in `prosemirror-view` 1.42.9 (`MarkViewDesc.create`, `ViewTreeUpdater.syncToMarks`).

Left as it was, an `<ins>` sat inside `<tbody>` around a `<tr>`. The browser then built anonymous table boxes around it and the row was not aligned with the others.

## Default taken

Option 1 of ADR 0302 in its only possible form, and no other change to the stored form:

- The suggestion marks stay node marks. The CDM, the authority and the validator are unchanged.
- `toDOM(mark, inline)` of `ins`, `del` and `fmt` (`packages/engine/src/schema.ts`) gives a block mark (`inline` false) the class `de-suggest-wrap`.
- The stylesheet gives `.de-suggest-wrap` `display: contents` (`packages/element/src/styles/element.css`). The element has no box, so the block is laid out as a child of its parent. A suggested row stays in line with the others.
- The cue is a node decoration on the block, as before (`suggestion-decorations.ts`): the kind as a line (underline, strike-through, overline), a bar in the margin whose style is the kind (solid, dashed, dotted) on a paragraph, and the author's colour and line style as the custom properties `--de-tone` and `--de-tone-style`. The cells of a suggested row or table take the line, colour and style, because a row has no text of its own.

## What this does not do

The element is still in the DOM. A strict reading of "never as wrapper elements around blocks" is therefore not met, and FE-044 criterion 4 and FE-045 criterion 1 stay unticked. It is met in the sense that matters for layout and drawing: the element has no box, and the cue is a decoration.

## Decision needed

Which of these the owner wants:

1. Accept the reading above (an element with no box counts as no wrapper), and tick the two criteria.
2. Move the block state to a node attribute (option 2 of ADR 0302). This removes the element, and it changes the CDM and the validator.
3. Reword the two criteria to say what is built: block suggestions are node marks drawn by a node decoration, and the element around them has no layout box.

## Tests

- `packages/engine/src/view/fe-045-block-suggestions.universal.test.ts` (Chromium, Firefox, WebKit): the element has `display: contents`, the rows and cells of a table with a suggested insertion and a suggested deletion stay aligned, and the kinds and authors are told apart on paragraphs and on the cells of rows.
- `packages/engine/src/view/suggestion-rows.universal.test.ts` stays `it.fails`: it asserts that no element is added, which is not the case.
