# ADR 0131: Engine lane 2, FE-frontend authoring commands batch

Status: proposed

Date: 2026-11-13

## Context

Lane engine-2 takes the authoring commands of FE-frontend (FE-127 to FE-138 and FE-140) from the end of
the slice backwards. This round works FE-134 (captions and cross-references), FE-135 (breaks, section
breaks, columns, footnotes) and FE-136 (fields, a table of contents, symbols). Most of FE-138 (zoom) and
the view clauses of the three stories need a browser and are not built in `packages/engine` headless
tests. They stay unticked.

## Decisions taken by default (the spec leaves them open)

1. FE-134 (captions). A figure caption reads `Figure ` and then the number of a `seq` field named
   `Figure`. No separator or title text is added: the spec names no caption layout. Proposed default
   only; the owner may choose a different caption form.
2. FE-134 (cached text). `cached` is set when a caption or a reference is inserted. The spec does not say
   whether the editor writes `cached` again after each change. Writing it means a change to the
   committed document, which the sync design decides. Not decided here: `staleCaches` and
   `refreshCaches` exist, nothing calls them.
3. FE-135 (section breaks). The new `page_setup` is a copy of the caret section's page setup, under the
   identifier the caller gives. Its header and footer story references are cleared, because a story
   belongs to one page setup (03 §4.1). The spec does not state this. Proposed default.
4. FE-135 (breaks). A page or column break is refused in a table cell, a caption and a footnote (I10 as
   the CDM words it). A line break is allowed everywhere inline.
5. FE-135 (continuous breaks). A continuous break whose following page setup changes a margin from the
   section before it is reported by `sectionWarnings`. Showing the warning is the view's. The margins
   checked are the four page margins only.
6. FE-136 (title field). The CDM gives the `title` field no data source (recorded in the epic notes). The
   field keeps the title the caller passes, and `cached` is null when none is passed. Owner decision
   needed: which value the title field reads.
7. FE-136 (date field). The date takes the server instant (01 §8) and the workflow's zone (03 §7) as
   arguments, so the module reads no clock. It uses `dateFieldText` from the model, the shared computation.
8. FE-136 (table of contents). A new `toc` defaults to levels 1 to 3 and `of: headings`, the CDM's own
   defaults. The level and sequence rules are the CDM's.
9. FE-136 (fields by place). `page` and `pageCount` go in a header or footer story only, and `date` and
   `title` in body text only. The spec places the page-number field in the header (FE-057 criterion 3)
   and the date and title in the body; the refusal elsewhere is a reading, not a stated rule.

## Consequences

- New source: `packages/engine/src/breaks-sections.ts`, `packages/engine/src/fields-toc.ts`,
  `packages/engine/src/captions-refs.ts`.
- New tests: `packages/engine/test/breaks-sections.test.ts` (13 tests), `packages/engine/test/fields-toc.test.ts`
  (18 tests), `packages/engine/test/captions-refs.test.ts` (6 tests) and the fixture
  `packages/engine/test/layout-doc.ts`. All pass under `pnpm vitest run`. The scoped type-check of
  `packages/engine/tsconfig.test.json` is clean.
- Ticked: FE-135 criteria 1 and 3; FE-136 criterion 1. Nothing ticked for FE-134.
- Not wired: none of the new commands is in the core's command table (`packages/engine/src/core.ts` and
  `api.ts`). The main session decides the command names and the argument shape, as it did for the
  authoring commands of FE-133, FE-137 and FE-140. Until then the commands are reached through the
  exported functions only.
- Gaps left open, with the reason in each story's Notes: table captions and numbered equations (FE-134
  criterion 1); the cross-reference dialog (FE-134 criterion 2, UX); the editor's refresh of `cached`
  (FE-134 criteria 3 and 5, a sync decision); the I4 deletion handling (FE-134 criterion 4); the P2 right
  for section breaks (FE-135 criterion 2); the footnote numbering and panel opening (FE-135 criterion 4);
  the warning surface (FE-135 criterion 6); the title field's data source (FE-136 criterion 2); the
  toc entries in the view (FE-136 criterion 3); the font coverage flag (FE-136 criterion 4); the math
  editor (FE-136 criterion 5, FE-070).

## Round 3 (lane engine-2, 2026-11-13)

Stories worked: FE-131 (table styles and sorting), FE-132 (figure size and layout), FE-129 (indent
commands, criterion 4). Code: `packages/engine/src/table-style-sort.ts`, `figure-layout.ts`,
`paragraph-indent.ts`; tests in `packages/engine/test/table-style-sort.test.ts`,
`figure-layout.test.ts`, `paragraph-indent.test.ts`. The commands `setTableStyle`, `sortTableRows`,
`resizeFigure`, `setFigureLayout`, `increaseIndent` and `decreaseIndent` are registered in
`core.ts` and `api.ts` (`CommandName`, `CommandArgs`), and `CommandUnavailable` gained `unknown-style`,
`no-column`, `not-a-figure`, `bad-size`, `bad-placement` and `float-in-cell`.

Decisions taken here, not in the spec (for the owner to confirm; the spec's own default is not stated for
these points):

- Sorting: empty cells sort after every other cell in both directions; equal keys keep their order; text
  compares with a numeric-aware `en-GB` collator (so "9" comes before "10"). Sorting is refused in any
  table with a merged cell, which is stricter than FE-131 criterion 3 (merged cells that cross the sorted
  rows only).
- Table styles: the table stores the reference to a `kind: 'table'` style; the borders and shading that
  follow are the model's cascade, not checked here.
- Figures: a size is refused outside 1 to 31680 twips, not clamped; with the aspect ratio locked and both
  values given, the width is used and the height follows.
- Indent: the indent commands apply to list items too, as FE-129 criterion 4 says; Word moves a list item
  by its level instead. A decrease never goes below zero; a step past 31680 twips is unavailable.

Ticked: FE-131 criteria 2, 3 and 5; FE-132 criterion 3; FE-129 criterion 4. Not ticked: FE-131 criteria 1
(cascade and view) and 4 (suggest mode, phase 2); FE-132 criterion 2 (handles and dialog, UX), 4 (module
exists in FE-134's `captions-refs.ts`, not in the command table, owned by FE-134), 1, 5 and 6 (upload and
accessibility); FE-129 criteria 1, 2, 3, 5 and 6 (no command or view yet).

## Round 4 (lane engine-2, 2026-11-13)

Stories reviewed from the end of the slice: FE-138 (zoom), FE-130 (lists), FE-128 (characters), FE-127
(paragraph styles). No criterion was ticked in this round, because the open criteria need things that are
not in `packages/engine`:

- FE-138: all four criteria are the view's, the status bar's or the keyboard's. A Notes line says so.
- FE-130 criterion 3 (labels match the PDF) needs the PDF output; criterion 6 (list semantics in the DOM)
  needs the element's end-to-end test.
- FE-128 criterion 3 (proofing reads the `lang` mark) needs a proofing component, which is not built.
  Criterion 7 (`fmt` suggestions) needs suggestion mode (FE-041), which `mode.ts` lists as not built.
- FE-127: all six criteria were already ticked before this round.

No decision was taken here.
