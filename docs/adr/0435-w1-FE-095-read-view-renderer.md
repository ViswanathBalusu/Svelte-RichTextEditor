# ADR 0435: How `view="read"` chooses between the typeset PDF and the painted pages

Status: proposed (lane w1, 2026-11-26, FE-095)

## Context

02 §7 says the `read` view is "first the typeset PDF; later the project's own read-only paginated
painter". Owner decision 26 builds the page view and names FE-095 among its stories. The element
already shows the typeset PDF for `view="read"` (FE-072, ticked and tested), with the export's
diagnostics. The spec does not say how the product tells the two apart (FE-095 Notes, Open questions).

## Decision (proposed)

1. The PDF read view stays the default for `view="read"`. It is the typeset result, and a diagnostic
   in it opens the editor at its block (FE-072).
2. A host asks for the painted pages with `config.readPages: true`. A `config` key is used, not a new
   attribute, so that 05 §8.1 and the generated embedding reference do not change.
3. With the switch, `view="read"` runs the element's one core in mode `view` and mounts the page view
   in its read-only form: no input bridge, no caret, no key or pointer handler. The web view's
   surface stays mounted behind it, hidden, as for `view="print"`.
4. The label is "Reading layout" (`VIEW_STRINGS.read`). The control that shows the accessible web
   layout (FE-099 criterion 4) is offered here too; the web view it shows is still in mode `view`, so
   a reader cannot edit through it.
5. Where the browser cannot offer the page view (Firefox, spike S5; touch devices), the PDF read
   view or the web view is shown as before.

## Consequences

- A host that wants one reading experience everywhere leaves the switch off. A host that wants the
  quick, offline-capable pages sets it.
- Whether the painted pages replace the PDF as the default later is the owner's call.
