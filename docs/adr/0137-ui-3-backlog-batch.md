# 0137. Backlog batch of lane ui-3 (round 1): decisions the spec leaves open

Status: proposed. Owner: the main session. Date: 2026-11-13.

## Context

Lane ui-3 worked on the end of the UX epic (UX-101 to UX-104). Three questions came up that the
spec does not settle. The spec's default, or the narrowest reading, was used and is listed here so
the owner can change it.

## Decisions

1. **Duplicate keys in an import are compared without regard to case.** BibTeX looks citations up
   without regard to case, so `Smith2001` and `smith2001` would collide in a citation. The import
   reports both and keeps the first spelling as the key. Owner may prefer exact comparison.

2. **A BibTeX field value is kept as written.** Macro names (such as a journal macro) are not
   expanded, and `#` concatenation is joined as text. Expansion needs the `@string` table of the
   file and belongs to the source pane's grammar step. A CSL-JSON value that is not text (for
   example an author list) is kept as its JSON text.

3. **UX-101 criterion 6 and UX-104 criterion 4 are ticked on source-level evidence.** No component
   test harness runs in this package, so the tests check the strings and the component source. A
   browser run is still needed before these criteria count as shown on screen. The Evidence lines
   say so.

## Consequences

- `packages/ui/src/shell/source-import.ts` is the import grammar for UX-103. The sources pane
  (UX-103 criteria 1, 2 and 4) and the citation index (CDM-052) are not built.
- The export dialog's diagnostic jump, progress feed and cancel (UX-101 criteria 2 to 4) need a
  running export and a browser run.

## Round 2 (2026-11-13): decisions for the accessibility checker and the fix list

The checker (UX-066) and its fix list (UX-067) are rules over a plain view of the document. The
spec leaves these points open (13 section 8; 09 section 13; the story Notes). The spec's default,
or the narrowest reading, was used.

4. **Contrast is checked at 4.5 to 1 for every text run, against the document's own colours.** The
   text colour is the run's colour (the default text colour when it has none), and the background is
   the run's highlight or, failing that, the page background. The view carries no size of type, so
   the 3 to 1 threshold for large text is not applied. A colour that is not hex (for example a
   name, or `auto` where the default applies) is not judged, so its run is not flagged. The owner
   may want a size in the view and the 3 to 1 threshold for large text.

5. **A heading is a paragraph whose style has an outline level from 1 to 9; the first heading is
   not compared.** The level is the heading level, as 03 section 4.1 defines `outlineLevel` (1 to 9
   or null; `Heading1` has 1). This corrects the first draft of this decision, which used Word's 0 to
   8 numbering. A document may therefore start at any level; a later heading may not go down more
   than one level at a time. The owner may prefer that the first heading must be level 1.

6. **Link text is non-descriptive when it is empty or one of a short generic list** (click here,
   here, link, this link, this, more, read more, learn more, go, click), compared in lower case
   without repeated spaces or trailing full stops. The model has no decorative mark for an image, so
   every image or figure without alternative text is flagged. Headers, footers and footnotes are
   checked only when the caller passes their blocks; the checker does not look for them itself.

7. **The fix names are the shell's identifiers, not registered commands.** An issue offers
   `picture.altText`, `table.headerRow`, `link.text`, `style.headingLevel` or `format.colour`. The
   commands behind them are not in the registry yet, so these names are proposals for the command
   registry (UX-003) and the field pane to adopt or rename.

## Round 2 consequences

- `packages/ui/src/shell/accessibility-check.ts` and `accessibility-fix.ts` hold the rules; the
  pane that lists the report, the caret movement and the export job's agreement (UX-066 criterion 3,
  UX-067 criteria 1, 4 and 5) are not built.
- `packages/ui/test/rtl-page-direction.test.ts` is a source check for UX-065 criterion 4 (the page
  takes the document direction). Like decision 3, it needs a browser run before it counts as shown.
- Explanations of the checker's issues are reasons and facts (the `detail` of each issue); the
  English text for them is not in `en-GB.ts` yet, and adding it is a change to a shared table
  (needsFromOthers for the main session).

## Round 3 (2026-11-13): decisions for the classification label and the on-demand panes

8. **A classification label is a view of `{ name }`, and the status bar shows the name as text.**
   UX-085 does not say what the label holds, and the spec does not say whether the label is a
   tenant's own set or free text. The shell takes the narrowest reading: the core gives one `name`
   (content, shown as written, trimmed and with white space collapsed), and an empty name shows
   nothing. The label's identifier, its set and who may set it stay open (the story's Notes). The
   owner may prefer an identifier with the name, or a colour from the tenant's set; a colour would
   need a text label beside it (UX-085 criterion 2).

9. **The static checks of UX-070 and UX-085 count as evidence, as decision 3 does.** Both ticks
   rest on the source and on pure functions, and a browser run or a network trace is still needed
   before they count as shown.

## Round 3 consequences

- `packages/ui/src/shell/classification.ts`, the optional `classification` view in
  `packages/ui/src/core-api.ts`, the status bar's text, and the `status.classification` string in
  `en-GB.ts` (a shared table; the only change there). The core and the backend do not provide the
  view yet.
- UX-102 (rulers) is not built. Its criteria need a paragraph format view and the paragraph
  commands (FE-129, FE-137), which the core does not offer, and a ruler component. A model without a
  caller was not written.
- UX-070 criterion 4: the dark and high-contrast themes are rules in `src/styles/shell.css`, which
  loads at start. Moving them on demand is a change to the shell's stylesheet, for the main session
  or a later round to decide.

## Round 6 (2026-11-13, lane ui-3): the frame budget and the shell's string overrides

10. **UX-072 criterion 4 is measured at the scheduler, and its wording is left open.** The
    property tests in packages/ui/test/ux-072-frame-publication.test.ts show that the frame
    scheduler runs at most one publication per task phase and per frame tick. They also show that a
    publication in a task phase followed by one in the next tick both land before the same paint.
    Whether that counts as "one interface update per animation frame" is the owner's reading. The
    spec default is the wording as written, so the criterion stays unticked. A fix would change
    packages/ui/src/commands/schedule.ts (not decided here).

11. **UX-063 criterion 2 is shown in the shell, and stays unticked for the element.** The harness
    passes host overrides to the string catalogue and reports unknown keys (packages/ui/e2e/string-overrides.spec.ts, 12 passed in three browsers). The element has no property for
    overrides (05 section 8.1), so a host of <doc-editor> cannot reach the path yet. The same gap
    holds UX-064 criterion 3. The property, and whether development-only reporting is on by
    default, are for the main session or the owner.

## Round 6 needsFromOthers

- packages/element: a property that passes host string overrides to the editor (the Strings
  overrides option), and the onUnknown report in development. This unblocks UX-063 criterion 2
  and UX-064 criterion 3.

## Round 7 (2026-11-13, lane ui-3): triage of the unclaimed stories of UX-061 to UX-090

Round 7 asked for three to five stories. Every unclaimed story in the slice was checked against
packages/ui. None can have a criterion ticked from inside that directory without inventing an API,
a measurement or a CI setting, so no criterion was ticked and no story was claimed.

- UX-069 (conformance report), UX-089 (administration console) and UX-090 (integration guide): Notes
  added. Each needs a published contract, a running release or a root configuration that is not in
  packages/ui.
- UX-074 (memory for a 100-page document): needs a measured figure by the harness method, and no
  figure may be invented.
- UX-076 to UX-082 and UX-084, UX-086 to UX-088: the administration API, search, hooks and exports are
  in services/document-service and the protocol, not in packages/ui.

Open question for the owner (not decided here): whether the administration console may be a second
Svelte entry inside packages/ui, built separately from the component bundle, or a new package.
The spec default is a separate package (13 section 10 says the console "uses only this API").
