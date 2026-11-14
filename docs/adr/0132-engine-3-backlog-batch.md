# ADR 0132: Engine lane 3, FE-frontend editing core batch

Status: proposed

Date: 2026-11-13

## Context

Lane engine-3 takes the stories of FE-frontend phase 1b and 2 from FE-040 to FE-070, working from the
end of the slice backwards. Most stories in that range need a browser, the DOM, the FontFace API or a
worker (FE-061 to FE-064, FE-065 to FE-067, FE-069, FE-070, the web view). They are not built in
`packages/engine` headless tests and stay unticked.

Two stories in the range have headless parts that can be tested in Node.js. A third, FE-055, was found
already under work by another lane (`packages/engine/test/restrictions.test.ts` and the `no-copy`
branch of `copySelection`), so this lane left it alone.

## Decisions

1. FE-058 (footnotes in a panel). Ticked criteria 2 and 5 only. The footnote content model is the one
   CDM-001 chose (option B: `paragraph+`, one paragraph in version 1), so the story no longer waits for
   an open decision. The sub-editor refusal of a table, a page break and a column break is not built:
   `packages/engine/src/footnote.ts` has no filter for them. Proposed default: a filter that refuses
   `table` and the `page` and `column` break kinds inside a footnote document, in the same form as
   `noNestedFootnote()`. Not decided here; criterion 4 stays unticked until it exists.
2. FE-048 (comment ranges). A client-side range holder, `packages/engine/src/comment-ranges.ts`, maps
   ranges with the authority's own `mapRanges` (SYN-001). No criterion ticked: the decorations and the
   keyboard reach belong to the view, and comparison with the service's ranges needs the backend-mock
   Room. Proposed default for a detached thread: a range that collapses stays detached even when text is
   typed at its position (the authority's `mapRanges` already gives that result; the client follows it).
3. FE-055 (no-copy). Left to the lane that holds it. No change from this lane.

## Consequences

- Headless tests added: `packages/engine/test/footnote-panel.test.ts` (3 tests) and
  `packages/engine/test/comment-ranges.test.ts` (5 tests). Both pass under `pnpm vitest run`.
- Source added: `packages/engine/src/comment-ranges.ts`. No existing source file changed by this lane.
- Gap left open: the footnote sub-editor filter for tables and page or column breaks (FE-058 criterion 4).
- Gap left open: a service comparison for comment ranges (FE-048 criterion 2), needing the backend-mock
  Room wired into the test.

## Round 2 (lane engine-3, FE-040 to FE-070, the editing core side)

Status: proposed. Stories worked: FE-070, FE-056, FE-053 (from the end of the slice). FE-058, FE-048 and
FE-055 are left as the earlier rounds left them.

### Decisions taken by default (the spec leaves them open)

4. FE-070 (equations). The source limit is 4,000 Unicode code points (I7, `cdm1.ts`, counted as the
   CDM grammar counts). The nesting limit of 50 is the one the story names for the math gate. The spec
   does not give the measure. Default taken: the deepest brace group, where `\{` and `\}` are escaped
   and not counted, and `\\` does not escape the brace after it (`packages/engine/src/equation-commands.ts`).
   Owner check: the math gate of 09 §6.3 should state the measure; the default may be replaced by it.
5. FE-053 (pictures). The engine takes an assets port as an interface and does not choose the picture
   types or the SVG rule. The asset service decides which pictures it accepts (10 §3.1). Default: an
   upload that the port refuses inserts nothing and returns its message.
6. FE-053 (position locked during an upload). The position is checked before the upload and again when
   it completes. If it is locked at completion, the document is unchanged, and the uploaded asset stays in
   quarantine. Removing an orphaned asset is the asset service's job; no default is given for that job.
7. FE-056 (sub-editors). The pure parts of the sub-editor move to `packages/engine/src/subeditor-sync.ts`
   (`forwardToMain`, `replaceInner`, `locate`, and the metadata keys and `SubEditorTarget`). `subeditor.ts`
   re-exports them, so existing imports are unchanged. The class still mounts the view; the view is not
   run in Node.js.

### Consequences

- New source: `packages/engine/src/equation-commands.ts`, `packages/engine/src/subeditor-sync.ts`,
  `packages/engine/src/image-paste.ts`.
- Changed source: `packages/engine/src/subeditor.ts` (the logic moved to `subeditor-sync.ts`; the
  behaviour is the same; `header-footer`, `footnote-panel` and `subeditor-sync` tests pass).
- New tests: `packages/engine/test/equation-commands.test.ts` (12 tests), `packages/engine/test/subeditor-sync.test.ts`
  (7 tests), `packages/engine/test/image-paste.test.ts` (6 tests). All pass under `pnpm vitest run`.
- Not wired: the core has no `exec` name for the equation command, no core method for the picture paste,
  and `pasteFromClipboard` does not take files. These need the main session's decision on the core's
  command surface (a change to `core.ts` and `api.ts`, outside this lane's file list).
- Gap left open: the two-user convergence in one footer (FE-056 criterion 4) needs two sessions over the
  backend-mock Room. The rights of a user who cannot change stories (FE-056 criterion 6) are not checked
  by `openStory`.

## Round: FE-059 highlights, FE-060 counts, picture paste browser test (2026-11-13)

Status: proposed. Decisions taken here, each by the spec default or by inference, for the owner to confirm:

- Find highlights are decorations computed from the document and the find state on each draw (indDecorations, packages/engine/src/search-highlight.ts), not stored in the document or in the plugin state. The classes are de-find-match and de-find-current; the element's style sheet must style them (element lane).
- The body view redraws its highlights when the find state changes, through a subscription on the core's indState (packages/engine/src/view/web.ts, mountBody).
- Match options (case, whole word) and searching of headers, footers and footnotes stay as in ADR 0108: case-sensitive, body only. Not decided here.
- The page-boundary check in web-reflow.universal.test.ts looks for classes containing de-page or page-break. The naming is inferred; the element may use other names.

Tests added this round: \packages/engine/test/search-highlight.test.ts\, \packages/engine/test/replace-all-counts.test.ts\ (Node.js); \packages/engine/src/view/find-highlight.universal.test.ts\, \packages/engine/src/view/paste-picture.universal.test.ts\, \packages/engine/src/view/web-reflow.universal.test.ts\ (Chromium, \DOCEDIT_BROWSERS=chromium\, passed; Firefox and WebKit not run).

Also (FE-059 criterion 2): a find navigation scrolls the current highlight into view in the web view, through a flag set by the core's find commands in \iew/web.ts\; the core's \#stepFind\ also asks ProseMirror to scroll (\scrollIntoView\). The focus-less case is the one the web view handles, since ProseMirror scrolls only from the DOM selection. Proposed; the element may prefer another scroll margin (\lock: 'nearest'\ is used).


## Engine-3 round, suggestion mode and suggestion edits (FE-041 to FE-043)

**Status:** proposed. Defaults taken where the spec is silent; the owner may change them.

1. **Document setting 	rackChanges: everyone (FE-041 criterion 3).** Suggestion mode is on for every user who may edit or suggest in the scope. It is locked for a user without manage; a user with manage may switch it off. The spec says "until a user with manage switches the setting off" and does not say what a user with only suggest sees: the rule keeps them on by their rights.
2. **Deleting the author's own insertion (FE-042 criterion 3, Open questions).** The text is removed outright, as P4 allows. Where the text also carries another user's ins, the author's deletion is recorded as del instead, so that another user's inserted text is never removed by this user.
3. **Formatting text that carries an ins (FE-043).** The mt mark is applied to every text run in the range, including inserted text. The spec does not say otherwise.
4. **Suggestion identifiers.** The builders take the identifier from the caller and do not check uniqueness; the authority checks it on commit (P4).

Files: packages/engine/src/suggestion-mode.ts, packages/engine/src/suggestion-edit.ts; tests packages/engine/test/suggestion-mode.test.ts, packages/engine/test/suggestion-edit.test.ts.

### Fix round 4: suggestion mode wired into the core (2026-11-13)

**Status:** proposed. The builders and the rule are now called by `DocumentCore`. Defaults taken:

5. **Where the change is recorded.** `DocumentCore.dispatchTransaction` rebuilds every local change
   through `recordAsSuggestion` (`suggestion-edit.ts`) when suggestion mode is on in a scope the change
   touches (the scopes come from `scopeDiff`, as the guard finds them). So typing in the view, the
   core's own text commands and the formatting commands all take one path. Remote work, the core's own
   additions, undo and redo, and accept or reject (FE-047) pass unchanged.
6. **What cannot be recorded is refused.** A change that is not text typed, deleted or replaced inside
   one paragraph, or a change of character formatting (splitting or joining paragraphs, a paste of
   several paragraphs, Replace all over several matches), is refused with the new refusal reason
   `suggestion`, so that suggestion mode never makes a direct change. Block suggestions are FE-044.
7. **The user the marks name.** `AttachOptions.user` (the element passes `welcome.user.id`) or
   `CoreConfig.user`. Without one, a change suggestion mode would record is refused, since the
   authority requires every mark to name the submitting user (03 §5).
8. **Identifiers.** From the core's own source (`CoreConfig.generateId`, else `nodeId`). Typing next to
   the user's own `ins`, or deleting next to their own `del`, reuses that mark, so that a typed word is
   one suggestion, not one per keystroke.
9. **Formatting.** Only runs whose formatting changes get an `fmt`. A run that already carries the
   user's own `fmt` keeps it, so that its `before` still records the formatting before any of the
   user's changes; a second `fmt` of the same user would leave the authority's rejection order-dependent.
10. **The read-only view.** `DocumentCore.suggestion` (`SuggestionModeInfo`: `on`, `locked`, `reason`,
    `scope`) reports suggestion mode at the selection's start, and follows the mode, the access, the
    caret and `settings.trackChanges` (also when a remote commit changes it).
11. **The caret after a recorded deletion.** Backspace leaves the caret before the deleted text; a
    forward deletion leaves it after the text, as the text stays in the document.

Not handled: input-method composition (FE-042 criterion 6) is recorded keystroke by keystroke as the
view dispatches it; whether the browser's composition survives the redraw is not tested.

## Merge and split of table cells (FE-040 criterion 3, round 6)

Status: proposed. Owner decision not taken; the spec default is the one below. Code: `packages/engine/src/table-span.ts`; tests: `packages/engine/test/table-span.test.ts`.

1. **Content of merged cells.** The spec does not say what happens to the content of the cells a merge removes. The default taken: the non-empty blocks of the merged cells are appended to the top-left cell in reading order; an empty cell (one empty paragraph) contributes nothing. This is the usual word-processor rule.
2. **A row with no cell.** A merge that would leave a row with no cell is refused (`empty-row`), because the table schema needs at least one cell in each row. The alternative (a row kept with a spanned-only layout) is not allowed by the schema.
3. **Rectangles that cut a span.** A rectangle that holds part of a cell which starts outside it is refused (`span-crosses`); the rectangle must hold whole cells.
4. **Split.** The split cell keeps its content and identifier; every other slot it covered gets an empty cell, identified by the identifier plugin in the same transaction.
5. **Not wired.** The commands are not entries of the core's `CommandName` table; wiring them is a change to `api.ts` and `core.ts` that the element's registry (UX-003) depends on, so it is left to the main session.

## Round 7 (lane engine-3, FE-044 criterion 3 and FE-047 criterion 4)

Status: proposed. Stories worked from the end of FE-040 to FE-070: FE-044 (block formatting), FE-047 (block marks on resolve). Defaults taken where the spec is silent:

1. **Block formatting attributes (FE-044 criterion 3).** Only `style`, `align` and `numbering` of a paragraph may change under a block suggestion; the list level is the `level` of `numbering`, and the paragraph has no `list` attribute (round 7 named `list`; fix round 7 corrected it). Any other attribute, the identifier above all (I2), is refused, so the core records a `suggestion` refusal. The `fmt` node mark's `before` is `{ attrs: { ... } }` with the previous values of the attributes the change alters (CDM-040). Code: `packages/engine/src/suggestion-block.ts`, called from `recordAsSuggestion` in `suggestion-edit.ts`. Test: `packages/engine/test/fe-044-block-format.test.ts`.
2. **One block `fmt` per user (FE-044).** A second change by the same user replaces that user's `fmt` mark and keeps the first `before`; a change of another attribute is added to `before`. Two users keep two marks (CDM `ins`, `del` and `fmt` exclude nothing).
3. **Removed blocks take their contents (FE-047 criterion 4).** A block removed by an accepted `del` or a rejected `ins` takes its inner suggestion marks with it. They are counted once in `handled` and the text pass does not handle them. A block inside a removed block is not handled on its own. Code: `packages/engine/src/suggestion-resolve-block.ts`, called from `resolveSuggestions`. Test: `packages/engine/test/fe-047-block-resolve.test.ts`.
4. **Several block `fmt` marks (FE-047).** With several `fmt` marks on one block, the last one in the block's mark order gives `before` on a rejection, as the text pass does for text (`recordedMarks`). Owner check: the order of two users' changes is not recorded in the mark; the spec does not give one.
5. **Only whole blocks (FE-047).** A block is resolved only when it lies wholly inside the resolve range, so a selection that only overlaps a paragraph does not change its block marks.

Not done: FE-044 criteria 1 and 2 (paragraphs added or deleted as a whole) need a paragraph-level insertion and deletion that the recorder can tell apart from a split or a join, which the spec leaves open. FE-044 criterion 4 is the view's, and criterion 5 needs `queryCommand` to report the command unavailable. The core's dispatch of the block change and the authority's commit of block node marks are not run by these tests.

## Round 8 (lane engine-3, FE-045 and FE-046)

Status: proposed. Stories worked from the end of FE-040 to FE-070: FE-046 (criterion 4, the markup views) and FE-045 (rows and tables as suggestions). Defaults taken where the spec is silent:

1. **Deleting one's own insertion (FE-045 criterion 2).** A row or table that the same user inserted is removed outright when that user deletes it, as FE-042 does for text. Another user's insertion is marked `del` on top of its `ins`. Code: `packages/engine/src/suggestion-table.ts`.
2. **A row or table already marked deleted (FE-045).** A second deletion is refused with the `suggestion` reason, so the mark is not doubled.
3. **Header rows (FE-045).** A row inserted as a suggestion is not counted as a header row, so the header block keeps its size; the ordinary command counts it. The spec does not say which.
4. **Column suggestions (FE-045 criterion 5, open question 12).** Inserting or deleting a column is refused with the `suggestion` reason, which the core reports through `queryCommand`. Merging and splitting cells are refused by the same route as any change that cannot be recorded. `CommandUnavailable` gains `suggestion` in `packages/engine/src/api.ts`.
5. **Inserting a whole table as a suggestion (FE-045 criterion 3).** Not routed: `insertTable` is not a row or table operation of `table.ts`, so it is left open. Owner check: whether the insertion command should join the suggestion route.
6. **Markup views (FE-046 criterion 4).** The spec names the four views (13 §3) and does not say what each shows. The default: `all` shows every suggestion with a class per kind; `simple` shows the text as if every suggestion were accepted (a deletion hidden, an insertion or formatting change cued); `original` shows it as if every suggestion were rejected (an insertion hidden, a deletion restored, a formatting change at its earlier value); `none` shows nothing. The hidden and cued classes need the stylesheet, which the view owns. Code: `packages/engine/src/suggestion-markup.ts`, read through `DocumentCore.markupDecorations`. Owner check: the meaning of `simple` and `original`.
7. **Node decorations for block marks (FE-045 criterion 1, FE-046).** A block mark gives a node decoration that adds no wrapper element. No view plugin draws it yet, so the decoration is built and tested but not shown in the editing surface.

Tests: `packages/engine/test/fe-045-table-suggest.test.ts` (10 tests), `packages/engine/test/fe-046-markup-views.test.ts` (7 tests). Both pass under `pnpm vitest run`; the existing table and suggestion tests (`table.test.ts`, `fe-041-043-suggestion-core.test.ts`, `suggestion-mode.test.ts`, `fe-044-block-format.test.ts`, `fe-042-051-paste-suggestion.test.ts`, `table-span.test.ts`, `restrictions.test.ts`) still pass.
