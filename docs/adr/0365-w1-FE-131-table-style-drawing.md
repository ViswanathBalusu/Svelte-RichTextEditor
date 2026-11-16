# 0365: How the web view draws a table style (lane w1, FE-131)

- Status: proposed
- Date: 2026-11-15
- Story: FE-131 criterion 1

## Context

FE-131 criterion 1 asks that a table's borders and shading follow its table style unless overridden. The model's cascade (`resolveTableFormat`) gives the table's borders and the header row shading. The specification (03 §4.1, §4.3, §4.5) and the attribute table (`spec/cdm/cdm-1.attributes.md`) leave these points open:

1. The unit of a border `width` (an integer from 0 to 240) is not stated.
2. The width of a border that has a `style` and no `width` is not stated.
3. How `thick` differs from `single` on screen is not stated.
4. What a border without a `color` (null) draws in is not stated.
5. `bandedRows` is a boolean and no colour for the bands is defined.
6. What "overridden" covers is not listed.

## Decision (proposed; the owner or the model's maintainers may change it)

1. A border `width` is in eighths of a point, the unit Word uses for a border size. The corpus values (4, 8, 12, 24) read as half a point to three points under it.
2. A border without a width draws at half a point (4 eighths).
3. `thick` draws as a solid line at its width; `single` as solid, `double`, `dotted` and `dashed` as the CSS lines of the same names; `none` removes the border on that side.
4. A border without a colour takes the colour of the text (`currentcolor`).
5. `bandedRows` draws nothing in the web view until the model names the band colour.
6. Overrides, from weakest to strongest: the table style chain (`basedOn`, the most specific style last); `borders` set on the table itself, which replace the style's borders as a whole value (CDM-028, as the cascade already does); `borders` set on a cell, which replace one side of that cell; `shading` set on a cell, which replaces the header row shading in that cell. The outer sides of the table's borders draw on the outer edges of the grid, and `insideH` and `insideV` on the edges between cells.

7. Sorting under suggestion mode (FE-131 criterion 4) is unavailable: `queryCommand('sortTableRows')` answers `reason: 'suggestion'` and `run` refuses with that reason and changes nothing, as merging and splitting cells do (FE-045 criterion 5). The criterion allows this or a reordering proposed as whole-row suggestions. The recommendation of PRM-062 (ADR 0146, proposed) supports whole-row suggestions, but a move of a row is not a suggestion kind it defines (a deleted row and an inserted row with the same identifier would break I1), so the unavailable branch is the default taken until the owner settles PRM-062.

The values are drawn in the web view only (`packages/engine/src/view/table-style-view.ts`), through the CSSOM and never as a `style` attribute, and nothing is written into the document. The header and footer panels are not covered.

## Consequences

- The page view (layout and painter) and the exports must use the same unit and the same order of overrides when they draw table borders; none of them reads the unit yet (searched on 2026-11-15).
- If the owner settles another unit, only `borderCss` changes.
