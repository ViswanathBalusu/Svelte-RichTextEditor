# ADR 0426: Tab stops in the web view and the options of the paragraph dialog (FE-129)

**Status:** proposed, 2026-11-26 (lane w1, FE-129). Nothing here is the owner's decision. It follows ADR 0381, which left criteria 2 and 6 out.

## Context

FE-129 criterion 2 asks that tabs in the text advance to the paragraph's tab stops (03 §7.4). Criterion 6 asks that every option of the paragraph format is reachable from the keyboard in the paragraph dialog. The dialog (UX-102) had only the indents and the tab stops. The spec fixes the rule for a tab (03 §7.4) but not how the web view measures it, nor the units of the dialog's fields.

## Decisions proposed

1. **A paragraph with no tab stop of its own keeps the browser's tab.** The default stops and the stop of a hanging indent are drawn only for a paragraph that stores at least one stop. Reason: drawing them for every tab changes the look of every existing document, and the stops of a paragraph style are not drawn by this view either (ADR 0381, item 1). The rule of 03 §7.4 is implemented whole in `nextTabStop` and used as soon as a paragraph has a stop of its own.
2. **How a tab is drawn.** The element of the `tab` node becomes an inline block whose width is set through the CSSOM (never a `style` attribute, which a strict content security policy blocks), measured from left to right after each update of the view, when the width of the view changes and when the page's fonts have loaded. A CSS pixel is 15 twips (96 pixels to the inch). The origin is the left edge of the paragraph's margin box, which stands for the left margin of the page.
3. **Segments.** The text after a tab runs to the next tab, line break or the end of the paragraph. A segment that crosses a line end does not fit and starts at the current position (a tab of width 0). The decimal separator is a full stop (03 §7.4).
4. **Leaders** are repeating gradients along the baseline of the tab's box, in the text colour. They are an approximation of Word's leaders, not a measurement against them.
5. **Right-to-left paragraphs** keep the browser's tab (03 §7.4 says they measure the same way, which needs a mirrored origin that is not built).
6. **The class of the tab element is `de-doc-tab`, not `de-tab`.** The shell styles `.de-tab` for its tab strip (padding, border, minimum size) in the same shadow root, so a tab in the text was drawn as a bordered box. The old class is not used by any parser or export.
7. **The options of the dialog.** The core's view `paragraphFormat` gains `options`: alignment, spacing, line spacing and its rule, the five switches, borders, shading, with the CDM's default for a value the paragraph does not set, and `mixed`, the names of the options the selected paragraphs do not share. Spacing is typed in points; line spacing is typed in lines under the rule `multiple` and in points under `exact` and `atLeast`, and changing the rule converts the number with a line taken as 12 points (an approximation, not a measurement). A border's width is typed in points (stored in eighths) and its distance from the text in points (stored in twentieths). A colour is typed as `#RRGGBB`; a blank colour is the automatic one for a border and no shading for the fill. Each side that has a style other than `none` is stored; borders and shading are written whole when any of their fields changes from the first selected paragraph's values.
8. **Mixed values.** A text or choice field is blank when the paragraphs differ, and a blank field keeps each paragraph as it is (as the indents do). A switch in that state is shown as mixed and is written only once the author sets it.
9. **Suggestion mode** is unchanged from ADR 0381, item 7: the command writes the attributes directly.

## Consequences

- The paragraph dialog is taller. It scrolls inside the dialog part (`max-block-size` is set by the shell).
- The tab stops view reads the document's `settings.defaultTabStop` with the same helper the indent commands use.
- The `between` border is offered in the dialog and stored, but the web view does not draw it (ADR 0381, item 4).
