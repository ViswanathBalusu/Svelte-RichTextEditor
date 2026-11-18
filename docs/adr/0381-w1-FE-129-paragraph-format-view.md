# ADR 0381: How the web view draws a paragraph's own formatting (FE-129)

**Status:** proposed, 2026-11-18 (lane w1, FE-129). Nothing here is the owner's decision.

## Context

FE-129 asks that the values set with the paragraph format command are stored as integers and that the web view shows them (criterion 1), that keep rules are stated in the web view (criterion 3) and that borders and shading are stored and drawn (criterion 5). The spec fixes the units of the CDM (03 §1: twentieths of a point; `lineSpacing` under `multiple` in thousandths) but not how a continuous, reflowing view draws them.

## Decisions proposed

1. **Only a paragraph's own values are drawn.** The values that come from a paragraph style are not drawn by this view. The web view keeps its stylesheet's spacing for them. Reason: drawing the whole cascade would change the look of every paragraph in every document, and the style story (FE-127) owns that.
2. **Units.** A length in twips is drawn in points, as twips divided by 20. `indentLeft` and `indentRight` are the inline margins (so they follow the paragraph's direction), `indentFirstLine` is `text-indent`, and `spaceBefore` and `spaceAfter` are the block margins. The CDM's rule that the gap between two paragraphs is the larger of the two (03 §7) is not applied: CSS adds the margins of siblings by collapsing them, which gives the same result for block siblings.
3. **Line spacing.** `multiple` is a unitless `line-height` (thousandths of a line divided by 1000). `exact` is a length. `atLeast` is drawn as `max(1.2em, value)`, because CSS has no minimum line height; 1.2 is an approximation of the natural line height and not a measurement.
4. **Borders and shading.** `left` and `right` are physical sides, as in the CDM. A border's `space` (twentieths of a point) is drawn as padding on that side. The `between` border needs the neighbouring paragraph and is not drawn. Shading is a background colour. The widths and styles use the same reading as table borders (ADR 0365).
5. **How values reach the page.** Through the CSSOM in a node view, never as a `style` attribute, which a strict content security policy blocks. Every value is checked first, as in the table view (I11).
6. **Keep rules.** A continuous sheet has no pages, so keep with next, keep lines together and page break before are not drawn. A paragraph that carries one gets a `title` and a `data-de-layout` attribute: the title names the rules and says that they take effect in the PDF and the read view. Widow control is on by default, so only its switching off is reported. The wording is English text in the engine, as the notices of preserved content are; a catalogue key for it is the shell's story.
7. **Suggestion mode.** The command writes the attributes directly, as the indent commands do. Recording a paragraph format change as a suggestion is not decided; the spec allows suggestion marks on a paragraph for whole-paragraph steps only (owner decision 7 of 2026-11-15).

## Consequences

- The paragraph node view replaces the default rendering of every body paragraph. It builds the element from the schema's own `paragraphDOM`, so headings, alignment classes and direction are unchanged.
- Tab stops (criterion 2) and the paragraph dialog (criterion 6) are not part of this record.
