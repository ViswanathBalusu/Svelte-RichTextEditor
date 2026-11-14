# 0108. Engine backlog batch: presence mapping and open questions from the engine packet

**Status:** proposed (2026-11-13). Written by the engine developer in the backlog batch, round 1, for the stories of `packages/engine` (SYN-036, SYN-028, FE-121). Not reviewed by the owner.

## Context

The stories SYN-017 to SYN-023 were already ticked when this round started and were checked against their tests, not changed. SYN-036 criteria 2 to 4 (a receiver maps a peer's positions, holds an update from a later seq, and drops one older than its retained history) were not built. They are now built in `packages/engine/src/presence.ts`, with the sync client reporting each confirmed change through a new optional `confirmed` field of `Transition` (`packages/engine/src/sync/state.ts`). SYN-028 criterion 1 is checked against `test/session.test.ts`. FE-121 was checked and left as it was.

## Open questions and the default taken

1. **How long a receiver keeps the mapping history (SYN-036 criterion 4).** 04 §11 says "retained mapping history" and does not give a length. The code keeps the last `DEFAULT_MAPPING_HISTORY` confirmed commits (256) and drops an update older than the oldest kept commit. The number is a proposed default, not a measurement; the option `historyCommits` overrides it. Question for the owner: the length, or a time limit instead.

2. **What a receiver does with peers' positions at a reset or reload (SYN-036).** A replacement of the confirmed document has no steps to map through. The code clears the placed positions of all peers and starts the history again, so peers appear again only when they send a new update. The spec does not say this. Default taken: clear.

3. **Where the receiver draws a peer (SYN-036 criterion 5).** The placed positions are in the receiver's confirmed document. `PresenceClient.refresh` maps them forward through the receiver's own unconfirmed steps before it checks them against the visible document. The caret drawing itself is the element's (FE) and is not built.

4. **Expected `seq` of an acknowledged commit in the stream (SYN-028 criterion 5).** Not decided here. The `accepted` path of the resume is not tested yet, so SYN-028 criterion 5 stays unticked.

## Consequences

- `Transition` has a new optional field `confirmed`. Existing transitions that do not move the confirmed `seq` do not carry it.
- `PresenceClient` takes an optional `historyCommits`. Its public shape otherwise does not change.

## Round 2 (2026-11-13): find and replace, and undo evidence

Written by the engine developer in backlog batch round 2, for FE-059, FE-060 and FE-049. Not reviewed by the owner.

### Open questions and the default taken

1. **Match options of FE-059 (case, whole word).** The spec does not give a default. The code matches case-sensitively, as a plain substring, in the body only. Proposed default: case-sensitive, so that offsets stay exact. Question for the owner: case-insensitive and whole-word options, and whether headers, footers and footnotes are searched (the code searches neither).
2. **Matches that span an inline node that is not text (a field, a placeholder).** The node counts as one character that no plain query contains, so a match never spans it. The spec does not say; this is the default taken.
3. **Suggestion mode for Replace all (FE-060 criterion 5).** Not built (FE-041 is phase 2). The code replaces directly. The Open questions of 02 decide it; it is not decided here.
4. **Undo and the origin of its commits (FE-049 criterion 2).** Not tested. The keys call the ProseMirror commands directly (FE-049 criterion 7 is not met). Left open for the next round.

### Consequences

- `DocumentApi` has new members: `findState`, `findText`, `findNext`, `findPrevious`, `clearFind`, `findResults`, `replaceCurrent`, `replaceAll`, with the types `FindState`, `FindResult` and `ReplaceReport`. The highlights are not drawn by the core; the view (`view/web.ts`, the element) draws them from `findResults` and is not built here.
- The core recomputes the matches whenever the document changes, so remote changes update the count. This is a full pass over the body per change, which is not measured; FE-118 and FE-119 have not been measured against it.
- A replace that the guard refuses is reported as skipped, and the guard's own refusal notice is recorded.
- FE-052: `pastePlainText(text)` is in the document API. Each line after the first is a split of the paragraph at the caret; the identifier plugin gives the copies fresh identifiers. The engine does not choose between `text/plain` and `text/html`; that is the element's.
- FE-049: criteria 1 and 3 are ticked on the evidence of `test/undo-rebase.test.ts`, which predates this round (SYN-022). Its file header names the story.

## Round 3 (2026-11-13): selection through rebuilds, and trimmed deletion

Written by the engine developer in backlog batch round 3, for FE-035 and FE-037. Not reviewed by the owner.

### Open questions and the default taken

1. **What a trimmed deletion does with paragraphs it empties (FE-037).** 07 §7 says the editable parts are removed and does not say whether the paragraphs around protected content are joined. The code removes only text inside each textblock of an editable scope and joins nothing, so paragraphs that the deletion empties stay, and no region or paragraph boundary is removed (criterion 5). Default taken: keep the paragraphs. Question for the owner: whether an emptied editable paragraph should be removed when the selection covers it wholly.

2. **Which keys trim a deletion (FE-037).** The code trims Backspace and Delete with a non-empty selection. Cut is not built (no Cut command in the core, FE-050). Default taken: trimming on the two keys only, until Cut exists.

3. **Find matches as decorations (FE-035 criterion 3).** The core recomputes find matches from the document after each change and does not map them. The story's test ('a recomputation from scratch finds no difference') is what the code does. Default taken: recompute.

### Consequences

- `EditorCore` has a new read view `trimmed`, and `DocumentApi` lists it. `n` counts the trimmed deletions in this core.
- Backspace and Delete try the trimmed deletion before the body and region edge commands, so a selection with no protected scope behaves as before.

## Round 4 (2026-11-13): content operations, the editing mode, and the selection after a drop

Written by the engine developer in backlog batch round 4, for FE-027, FE-029 and FE-035 (criterion 2). Not reviewed by the owner.

### Open questions and the default taken

1. **The shape of a CDM fragment (FE-027).** 05 §8.1 says "CDM fragments" and does not give their JSON. Default taken (`CdmFragment` in `src/api.ts`): the selected blocks as CDM JSON, the open depths of the two ends, the `style_def` nodes the blocks use with their `basedOn` and `next` chains, and the document's `requires` list. Question for the owner: whether a fragment should carry only the features its content uses, and whether `settings` should travel with it.

2. **A fragment that needs a style the user may not add to the definitions (FE-027).** Inserting a block whose style the document does not define changes the definitions and the document node, which 07 §4 and §7 protect. Default taken: the insertion is refused with `refusal: 'scope'`, and nothing changes. The alternative is to drop the unknown style to the default. Question for the owner.

3. **Which features the document must list (FE-027 criterion 4).** Default taken: every feature the fragment lists must appear in the document's `requires`; a feature the document does not list is `unsupported`, never added silently.

4. **The effective mode (FE-029).** The access gives the user's capabilities across all scopes, not only the document (a region editor has no document-level `edit`). Default taken: the mode is `edit` when any scope or the document grants `edit`, `review` when only `suggest` is granted, and `view` otherwise. `fill` needs the `fill` capability, otherwise `view`.

5. **What `view` and `fill` lock (FE-029 criteria 2 and 6).** Default taken: every local change is refused, through the guard's `read-only` reason, and the editing surface follows `readOnly`. The save state and the access summary still follow the connection and the server's rejections only, so unconfirmed work is never shown as saved when it is not. Question for the owner: whether `view` should show the save state `readonly`.

6. **Field values in fill mode (FE-029 criterion 6).** FRW-076 and FRW-079 decide what a fill participant may change; until they are built, `fill` changes nothing. The core does not admit field values in this mode.

7. **Suggestion mode in `review` (FE-029 criterion 3, FE-027 criterion 2).** Not built (FE-041, phase 2). `review` is the effective mode only; no change becomes a suggestion yet. FE-027 criterion 2 names suggestion mode "when it applies", and the guard path it uses is the one typing uses, so it is ticked on that reading.

8. **A content insertion across scopes (FE-027).** Default taken: when the selection touches a scope the user may not change at either end, the whole insertion is refused. Unlike a deletion (FE-037), an insertion is not trimmed.

### Consequences

- `DocumentApi` has new members: `mode` (a read view of `ModeState`), `setMode`, `getSelectionContent` and `insertContent`, with the types `EditMode`, `ModeState`, `CdmFragment`, `CdmJsonNode` and `InsertResult`. `EditorCore` inherits them; the element and the shell do not use them yet.
- `CoreConfig` has an optional `mode`, which defaults to `edit`. `readOnly` is now true in `view` and `fill` as well as after a `read_only` rejection; the web view's `editable` follows it.
- `src/content.ts` and `src/mode.ts` are new. The style insertion point is after the last style definition of `defs`.
- Tests: `test/content.test.ts` (FE-027), `test/mode.test.ts` (FE-029), `test/selection-drop.test.ts` (FE-035 criterion 2). The whole engine package passes in Node.js: 208 tests on 2026-11-13, on three reruns after one earlier run in which a test failed that was not identified. The browser runs of the element suite were not run.

## Round 5 (2026-11-13): the clipboard (FE-050, FE-051, FE-052)

Written by the engine developer in backlog batch round 5, for FE-050, FE-051 and FE-052. Not reviewed by the owner.

### Open questions and the default taken

1. **Cut in a locked scope (FE-050 criterion 2).** The spec does not say whether a cut that the guard refuses still writes the copy. Default taken: write the copy (reading is allowed), delete nothing, and record the refusal.
2. **A paste refused for one definition (FE-051 criterion 4).** The spec says no definition is added. Default taken: refuse the whole paste, body text included, rather than paste the text without the definition.
3. **Regions and section breaks in a pasted fragment (FE-051 criterion 5).** Default taken: inside a region, drop `region` and `section_break` nodes and keep the text of a dropped region's children. Outside a region they are kept.
4. **Foreign preserved attributes (SR-C2, FE-051 Notes).** Not decided. A foreign fragment still keeps its preserved attributes, marks and atoms; this round strips only bookmarks (`anchor`) and the nodes in criterion 5.
5. **Numbering definitions in a copy (FE-050 criterion 3).** Not built. The copy follows the style closure only; a block's `numbering` attribute is not followed to its `numbering_def`.

### Consequences

- New module `packages/engine/src/clipboard.ts`: the clipboard payload (`text/html` with the fragment as an encoded attribute, and `text/plain`), reading a fragment back, and the choice between fragment, text and nothing.
- `DocumentApi` has `copySelection`, `cutSelection` and `pasteFromClipboard`. The element passes the browser's clipboard data to them; the element is not built.
- The HTML written by a copy is checked as a string (`test/clipboard.test.ts`). A paste into a real browser is not run (FE-122).

## Round 6 (2026-11-13): table structure, and the clipboard under no-copy

Written by the engine developer in backlog batch round 6, for FE-040 and FE-055. Status proposed. Not reviewed by the owner.

### Open questions and the default taken

1. **Table commands on tables with merged cells (FE-040 criteria 1 and 3).** The spec does not say how a row or column is inserted or deleted through spans. Default taken: the commands work on regular tables only (one cell per grid column, no span), and are unavailable elsewhere. Merge and split are not built, so criterion 3 stays open. Question for the owner: whether spans should be carried through row and column operations, or refused with a reason.

2. **Column width of a new column and default width of a new table (FE-040).** The spec gives no figure. Default taken: a new column copies the width of the column it is inserted beside; `insertTable(grid, rows)` takes the grid from the caller and invents no width. Question for the owner, with UX, for the default table size.

3. **Deleting a table that is the only block of its container (FE-040).** Default taken: it is replaced by one empty paragraph, because a body or a region needs a block. Otherwise the table is removed.

4. **Header rows under row operations (FE-040, I6).** Default taken: a row inserted among the header rows is a header row, and deleting a header row lowers `headerRows` by one, so that the header block stays at the top.

5. **Tab and Shift+Tab (FE-040 criterion 5).** Default taken: Tab moves to the next cell in document order and Shift+Tab to the previous one; past the last or first cell, the key falls through to the browser. Question for the owner: whether Tab should leave the table at its last cell.

6. **Copy and cut under `no-copy` (FE-055).** Default taken: a refused copy returns null and writes nothing; the refusal is recorded with the new reason `no-copy` (and `no-print` is added to `RefusalReason` for the print path, which the core does not run yet). A cut under `no-copy` deletes nothing. An empty selection is not a refused copy. Question for the owner: whether a refused copy should also clear the native clipboard.

### Consequences

- The table commands are ProseMirror commands in `src/table.ts`, exported from `headless.ts`. They are not members of `CommandName`, so `exec` and `queryCommand` do not run them yet. Adding them to the registry and to the menu is a change in the protocol and UI packages, not made here.
- `RefusalReason` has two new values, `no-copy` and `no-print`. A package that switches on `RefusalReason` exhaustively must handle them.
- Tab and Shift+Tab are bound in `coreKeys`, before the base keymap.

## Round 7 (2026-11-13): footnote blockers, header and footer variants, and the web view's links

Written by the engine developer in backlog batch round 7, for FE-058 (criterion 4), FE-057 (criteria 2 and 3) and FE-067 (criteria 1 and 2). Not reviewed by the owner.

### Open questions and the default taken

1. **Which containers refuse page and column breaks (FE-058 criterion 4, FE-057).** The story names a footnote, and the CDM's I10 also forbids page and column breaks in a table cell and in a caption (`NO_PAGE_BREAK_CONTAINERS`). The code refuses a table and a page or column break in a footnote (in the document through the guard, and in the footnote panel through `noBlockersInNote`). It does not yet refuse a page or column break in a cell or a caption, because no story in this packet covers those commands. Default taken: the footnote only, with the cell and caption cases recorded as a gap. Question for the owner: none beyond the CDM rule.

2. **Who supplies the identifier of a new header or footer story (FE-057 criterion 2).** The story says the story is created but not how its identifier is chosen. Default taken: `createVariantStory` takes the identifier from the caller (16 URL-safe characters, I2), so the module does not generate random values; the view or the host chooses it through the platform helpers.

3. **Where a page-number field command lives (FE-057 criterion 3).** Default taken: `insertPageNumber` is exported from `src/header-footer.ts`, is not in the core's command registry (the registry is UX's, 13 §4), and refuses outside a header or footer story. The panel calls it.

4. **Whether a link with an unlisted scheme is shown as text (FE-067 criterion 2).** The schema already renders such a link as an `a` element without `href`, so it is not clickable. Default taken: keep that rendering; the story asks only that it is not clickable.

### Consequences

- `guard.ts` refuses a replace step that inserts a table or a page or column break inside a footnote, with reason `invariant`.
- `footnote.ts` exports `noBlockersInNote`, the footnote panel's counterpart.
- `src/header-footer.ts` is new: `variantsInUse`, `storyOfVariant`, `createVariantStory` and `insertPageNumber`.
- No `DocumentApi` or element member was added; the panel's wiring is the view's and is not built.

## Round 8 (2026-11-13): reconnect and resume, and the stream's live signal

Written by the engine developer in backlog batch round 8, for SYN-028 (criteria 2, 3 and 5 ticked; criteria 4 and 6 left open), SYN-036 (criterion 5 left open) and FE-121 (no criterion changed). Not reviewed by the owner.

### Open questions and the default taken

1. **Reading missed commits over REST for `catchUp: "page"` (SYN-028 criterion 4).** The story asks for `GET /documents/{id}/commits`. No port member of `@docedit/protocol` reads that route, so the session reloads the content at the head instead (ADR 0038, the fallback already in `src/sync/session.ts`). Default taken: keep the reload; criterion 4 stays unticked. Question for the owner: whether the port should gain a commits-page member, or whether the reload is the accepted design for 1b.

2. **A host crash and restart during an edit (SYN-028 criterion 6).** `@docedit/backend-mock` has no way to crash and restart a room host while a client is in flight. Default taken: the criterion stays unticked until the conformance kit's fault-injection hooks (BE-079) exist. No measurement is claimed.

3. **Going live at the head as well as at `sync.caughtUp` (SYN-028 criterion 3).** The story says the client goes live after `sync.caughtUp`. The session also goes live when the confirmed seq reaches the head, which an existing test pins (`test/session.test.ts`). Default taken: keep both; a real room sends `sync.caughtUp` at the head, so the two agree. The new test in `test/sync-resume.test.ts` checks the `live` signal on its own.

4. **Receiver caret at unconfirmed text (SYN-036 criterion 5).** The receiver's mapped positions are confirmed positions, so they never fall inside text the receiver lacks (`test/presence-positions.test.ts`). Drawing the caret is the element's. Default taken: criterion 5 stays unticked.

5. **View layer as a separate package (FE-121 criterion 1).** Unchanged from round 1: the headless entry `@docedit/engine/headless` is a separate entry point, not a separate package. Splitting packages is the main session's call. Criterion 3 (suggestion mode and the journal) stays open.

### Consequences

- New test file `packages/engine/test/sync-resume.test.ts` (4 tests) over a scripted channel. No source file changed in this round.
