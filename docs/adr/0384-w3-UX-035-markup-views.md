# 0384 UX-035: the markup views as built

**Status:** proposed (2026-11-17, lane w3). Owner decision 169 (`docs/owner-decisions-2026-11-15.md`) settles the four definitions as built (ADR 0233, decision 4). This record gives the drawing, the commands and the words for assistive technology, and changes one default that ADR 0132 took.

## Context

13 §5 names four markup views and does not define them. ADR 0132 (engine) took a default in which `none` drew no decoration at all, so deleted text stayed in the text with no cue. ADR 0233 (UX) read `none` as the text as if every suggestion were accepted, and the criterion of UX-035 says the same ("`none` shows the text as if every suggestion were accepted; `original` ... rejected; `simple` ... a marker where changes exist"). The two defaults disagreed, and no view could be chosen in the product.

## Decision (proposed)

- The views follow the criterion's words. `none`: deleted runs and blocks are hidden and nothing is drawn on the rest. `original`: inserted runs and blocks are hidden and deleted ones are drawn plain. `simple`: the accepted text, with a bar in the margin of each changed run or block, and a bar where a deleted run or block was. `all`: every change with its line (underline, strike-through, overline) and the author's tone.
- The engine core holds the view (`markupView`, `setMarkupView`), `all` until it is set. It is a setting of the reader. It applies no transaction.
- The shell offers four commands, `review.markup.all`, `.simple`, `.none` and `.original`, in the registry. They are not on the toolbar (as the modes are not). They are reached by command search (with synonyms) and by `exec`.
- For assistive technology each decorated change carries `data-suggestion-label`, for example "Inserted by Ada Lovelace", set by the shell from the people directory (neutral "Collaborator" until the host answers). The stylesheet draws it out of sight before the change, so the accessibility tree has the words and the visible cue stays the line and the tone. No view draws the words in `none`.
- A formatting change in `original` keeps the class `de-suggest-before` but nothing draws the previous value. Drawing it needs the previous attributes of the mark as styles and is not built.

## Consequences

- The engine tests of FE-046 that said `none` draws nothing are changed to the new rule.
- Table rows and tables hidden by a view leave no bar (a row has no height to take away). FE-046's note that a row `ins` mark is not drawn by the view is a separate, older defect.
- If the owner defines the views differently, the rules are in `src/suggestion-markup.ts` and `element.css`; the shell does not change.
