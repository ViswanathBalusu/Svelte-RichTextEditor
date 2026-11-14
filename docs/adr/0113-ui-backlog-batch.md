# ADR 0113: UI backlog batch, round 1

**Status:** proposed, 2026-11-13. Written by the packet U agent for `packages/ui`.

## Context

Packet U (PLAN-1b, the shell) runs in `packages/ui` beside other agents. This round worked on three stories whose remaining criteria can be met inside that package and tested in Node.js:

- UX-015 Mode switcher (criteria 1 and 5 ticked)
- PRM-026 Show which regions I can edit (criteria 2 and 5 ticked)
- FRW-078 Review required and invalid fields in a summary (no criterion ticked; tests added)

The browser runs (`packages/ui/e2e`) and the element and core tests were not run in this round. Nothing here claims them.

## Decisions taken in this round (spec defaults, not owner decisions)

1. **Modes offered.** `shell/modes.ts` offers `review` where the user has `suggest` or `edit` anywhere, and refuses `review` under the document limits `locked`, `archived` and `workflow`. This follows UX-015 criterion 1 and 5 as written. The default of 07 section 7 is kept: a user with only `suggest` at the selection gets `edit` unavailable with reason `suggestOnly`.
2. **Regions described.** `shell/regions.ts` describes a region the reader may not see only as hidden, with no names, as ADR 0019 requires. Names come from `nameOf`, which the shell builds from `resolveUsers`.

## Open question for the owner

**Fill summary count (FRW-078 criteria 1 and 4).** Criterion 1 lists every required-and-empty field and every invalid field. Criterion 4 says the list's count matches the bar's "n of m". The bar counts required fields only (FRW-076 criterion 2). So an invalid optional field appears in the list and not in the bar, and the two counts differ by one for each such field. The current code (`shell/fill.ts`) follows criterion 1. Options:

- (a) keep the list as it is and change criterion 4 to say the bar counts required fields and the list also shows invalid optional fields;
- (b) list only required fields, so that criterion 4 holds and criterion 1 is narrowed.

The spec default is not clear, so the code keeps option (a)'s behaviour and the test pins it. The owner decides. Criterion 4 of FRW-078 stays unticked until then.

## Not done in this round, and why

- FE-007 criteria 3 and 4 belong to `packages/element`, not `packages/ui`.
- PRM-026 criterion 1 (shading) is drawn by the core. The shell's part, the labels, is tested.
- UX-015 criterion 3 (the editor stays in suggestion mode) is the core's behaviour (07 section 7).
- UX-014 criteria 4 and 5 and UX-016 criteria 3 to 6 need the element's attributes and events (PRO) and the journal (FE-008, FE-009).

## Round 2 (2026-11-13): PRM-027, UX-061, UX-013

Three further stories were worked in `packages/ui` with Node.js tests only. Each criterion ticked is one the tests check against what the shell does, not against the browser.

- PRM-027 criteria 3 and 4 ticked (`test/navigation.test.ts`). The command's state follows the core's `hasNextEditableRegion` answer, and a permission change updates it. Criteria 1 and 2 stay open: the toolbar and keyboard run are browser tests, and where the caret lands is the core's.
- UX-061 criterion 3 ticked (`test/theme.test.ts`). The contrast of the text and control token pairs is computed from the defaults in `src/styles/shell.css`, for each theme. No value needed changing. Criterion 1 stays open for the binding at load and the browser's preference.
- UX-013 criterion 2 ticked (`test/shortcut-alternatives.test.ts`). Every browser conflict the table resolves with a key the shell binds is answered by the registry with the same command, on both platform forms. Criterion 1 stays open because Firefox's list was not read (`SOURCES.firefox` is null).

**Decision taken with the spec default.** A conflict resolved by "alternative" may use another key of the same row as its alternative (the rule `build.ts` already applies, for example Shift-Mod-z for redo on macOS). The test follows that rule. The spec does not state it; it is recorded here for the owner to confirm.

**Open question for the owner (unchanged from round 1).** FRW-078 criterion 4 and criterion 1 disagree for an invalid optional field. The owner decides between the two options above.

## Consequences

- No root configuration, no other package, and no commit were changed.
- Dependencies: none added.

## Round 2 (packet U, 2026-11-13)

Written by the packet U agent for `packages/ui`, second round. Round 1 is above. Every decision here is the spec's default or the shell's own proposal, and waits for the owner's review.

### Decisions taken in round 2

- **Insert palette (FRW-072).** `shell/fields.ts` decides what the palette offers: the kinds of the release (the five of phase 1b, the signing kinds with `sign`, the formula with `rules`), and one reason for all kinds when none can be inserted. The order of the reasons is: no `edit` in the selection's access (`reason.query.noEdit`), a document that is locked, archived or in a workflow, the field limit of 2,000 (12 section 3.6, I15) when the shell knows the count, then the core's own reason (`subeditor`, `limit`, `structure`, `none`). A core that does not offer `canInsertField` leaves the palette absent. Proposed; the core's answer and its reason codes are the engine's.
- **Role icons (FRW-074).** The spec stores no icon on a `role_def`. The shell derives the icon from the role's place in the document's role list, over eight fixed names (`roleIcon`), so the first eight roles have distinct icons. Proposed default; the owner decides between this and a stored icon.
- **Role markers (FRW-077).** A field's marker says whether it is the participant's (`mine`), another role's (`other`) or unassigned (`none`), and whether it is read-only (not theirs, or the participant is not active). The accessible name carries the label and the role. A field with no assignee shows no role, whatever the core sent with it. The role's name, colour and order come from the core through `FillField.role` (new optional member, `FieldRoleInfo`); the participant's roles through `FillSummary.roles`.
- **Pane capabilities (UX-019).** A pane descriptor may name a capability. When the caller gives no list, the check reads the capabilities at the selection (`CoreApi.access`). No built-in pane declares one yet. The fill pane's selection in a body paragraph carries no `fill`, so declaring it needs the owner's view of who sees the fill pane.
- **Navigation pane.** The registry's descriptor for the navigation pane (UX-020) is `outline`. The name is kept; the story's word "navigation" maps to it.

### Open questions found in round 2

1. **Markers of other roles need every field.** `FillSummary.fields` lists only the participant's own fields. FRW-077 needs the fields of other roles too, so the engine has to list them, or the shell needs a second view. Sent to the engine as needsFromOthers.
2. **Limit of `maxLength`.** The spec does not say whether `validation.maxLength` counts characters, code points or UTF-16 units. The native input's `maxlength` counts UTF-16 units. A value check by code points would disagree for characters outside the Basic Multilingual Plane. Not decided here; FRW-079 is not worked in round 2.
3. **Date pattern of `format`.** 12 section 3.2 names a date pattern without a syntax. Not decided here.

### Not built in round 2

The palette component and its command (FRW-072 criteria 1 and 5), the marker rendering (FRW-077 criterion 1), the role manager (FRW-074), the pane host's opening code and focus (UX-019 criteria 2, 3, 5 and 6) and the element's form controls. Each is named in its story's Notes.

## Round 3 (packet U, 2026-11-13)

Written by the packet U agent for `packages/ui`, third round. Earlier rounds are above. Every decision here is the spec's default or the shell's own choice, and waits for the owner's review.

### Fixed first (review of round 2)

- **Four browser tests in `e2e/regions.spec.ts` failed in Chromium.** The components were right in all four; the tests were wrong. (1) The policy fieldset was asserted with `toBeDisabled`, which Playwright does not apply to a fieldset; the test now asserts the two radios, which are disabled. (2) The search for "le" matched only the group, because "Ada Lovelace" has no "le"; the search is now "l", which matches the user and the group. (3) A refused export request counts as a request but starts no job, so the job that runs is `job2`, not `job1`; the test now waits for the cancel control (shown while a job runs) before it reports the job's result. (4) The diagnostic's severity word and its message are two elements, so the text reads "Warning A tab ..."; the test accepts the layout's spacing and does not require a colon. Result: `pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/regions.spec.ts --project=chromium`, 16 passed. Firefox and WebKit were not run.
- FRW-077 criterion 1 and FRW-072 criteria 1 and 5 stay open, as the review said: they need the engine and the core.

### Stories ticked in round 3 (Chromium run, and the element's unit tests)

- UX-016 criterion 3 (`de-status` with `connection` and `sync`): element tests, which were already in place.
- PRM-035 criteria 2, 3 and 4 (search through `searchPrincipals`, save with `If-Match`, reload on `precondition_failed`).
- PRM-036 criterion 5 (the plain-words policy explanations).

### Open questions found in round 3

1. **Colon after a severity word.** The export dialog shows the severity ("Warning", "Error", "Note") and the message as two elements. The spec asks for the severity in text (UX-101). Whether a colon or a separator belongs between them is a design choice, not decided here.
2. **Expiry of a grant.** The permissions pane shows each grant's expiry, but no test checks it (PRM-035 criterion 1). A test needs a grant with `expiresAt` in the harness.

### Not done in round 3

PRM-033, PRM-034 and PRM-036 criteria 1 and 3 need the core's commands and the authority's refusals. UX-003 criterion 4 stays open: the element does not yet bind `bindCommandStateEvent` (packages/element/src/events.ts only mentions `de-command-state`). FRW-073 (properties panel) has no panel component yet.

## Round 4 (packet U, 2026-11-13)

Written by the packet U agent for `packages/ui`, fourth round. Earlier rounds are above. The browser runs were made in Chromium only (`pnpm exec playwright test -c packages/ui/playwright.config.ts ... --project=chromium`); Firefox and WebKit were not run, and nothing here claims them.

### What changed in the code

- `src/shell/landmarks.ts`: the ordering and the stepping are now pure functions over any node type (`orderLandmarks`, `indexHolding`, `stepLandmark`). `landmarksIn` and `nextLandmark` keep their signatures and behaviour; `App.svelte` is unchanged.
- `src/shell/status.ts` (new): `languageAt(mark, documentDefault)` decides which language the status bar shows at the caret. `StatusBar.svelte` uses it and keeps the same words. Decision taken with the spec default: a blank or whitespace-only `lang` mark counts as no mark, so the document's language shows instead. Before this round a whitespace-only mark was shown as a language.
- No other source file changed. No dependency was added. No root configuration, other package or commit was touched.

### Tests added

- `test/landmarks.test.ts` (new, 11 tests): the order of the landmarks (property test on the kept document order), skipping of hidden and unknown entries, stepping and wrapping in both directions, and the table's keys for Windows and Linux and for Apple platforms.
- `test/status.test.ts` (new, 5 tests): the language source (property tests), and the language command's state for a view-only user and an editing user. The command is built with `shellCommands1b` and a recording-free host stub, because it is a shell command and not a core one.
- `test/theme.test.ts`: one test added, "gives every pair a higher ratio in the high-contrast theme than in light and dark" (UX-062 criterion 2). It passes with the values in `src/styles/shell.css`; no value changed.

### Browser runs (Chromium, 2026-11-13)

- `e2e/shell.spec.ts` (15 tests, all passed): the landmark tests and the status bar tests.
- `e2e/panes.spec.ts` (12 tests, all passed): the pane host, the navigation pane, the styles pane and recovered edits.
- Ticks in the stories cite these runs by test name. Each criterion ticked is one the named test checks; the story Notes say which criteria stay open and why.

### Stories ticked in round 4

- UX-062 criterion 2 (Node).
- UX-023 criteria 1, 3 and 5 (Chromium and Node). Criteria 2 and 4 stay open (collapsed pane not tested; role not asserted).
- UX-018 criteria 2, 3, 4 and 5 (Chromium and Node). Criteria 1 and 6 stay open.
- UX-020 criterion 4 (Chromium).
- UX-019 criteria 3, 5 and 6 (Chromium). Criterion 2 stays open (the loading state is not checked).
- UX-017 criteria 1, 3 and 5 (Chromium). Criteria 2, 4 and 6 stay open.
- UX-022 criterion 1 (Chromium).

### Open questions found in round 4 (for the owner)

1. **Collapsed panes and landmarks (UX-023 criterion 2).** The story says a pane that is "closed or collapsed" is skipped. The browser test covers a closed pane (none is open, so none is listed) but no collapsed one; the owner should say whether a collapsed pane is a state the shell has, so that a test can check it.
2. **Role of each landmark (UX-023 criterion 4).** The browser test checks the accessible name of each `data-landmark` element and not its role. The landmarks are `header`, `toolbar`, `main`-like `page`, `pane` and `status`; the spec does not map them to ARIA roles. Proposed default: keep the element's implicit role and assert it in a later test.
3. **Loading state of a pane (UX-019 criterion 2).** The test shows that the pane's code is requested on first opening. The spec says a loading state is "announced". Whether the announcement is a live region or the pane's own status is not decided here.
4. **Count of recovered edits (UX-017 criterion 2).** The `de-recovered-edits` event carries `{ count }`; the shell's test reads the status message, not the attribute. Both should agree, but the owner should confirm which one is the contract.

### Not done in round 4, and why

- FRW-076 (guided bar), FRW-078 criteria 1 to 3 and FRW-079: the browser tests for the fill mode are not in `e2e/` yet. Writing them is a new browser test, not a tick, and was left for a later round.
- UX-002 criterion 1: the parity profile has no status (shipped, partial, planned, not planned) derived from the stories; `src/parity/build.ts` does not compute one. This is a gap in the generator, which is in `packages/ui`, but it needs an owner decision on how the status maps from story states before it is built.
- UX-020 criterion 2 (typing latency with headings changing) and UX-018 criterion 1 (typing latency): the budgets belong to UX-072 and need the reference machine (FND-007).

## Round 5 (packet U, 2026-11-13)

Written by the packet U agent for `packages/ui`, fifth round. Earlier rounds are above. The decisions here are the spec's default or the shell's own choice, and wait for the owner's review. Node.js tests only; no browser run was made in this round.

### Stories ticked in round 5

- UX-008 Context menu, criteria 3 and 4 (`test/context-menu.test.ts`). The menu's list is the offered commands that name one of its targets, a disabled command carries its reason, and an extension item appears on its declared target. Criteria 1, 2 and 5 stay open (the component's opening and keys; the proofing port, UX-041, is not built).
- UX-039 Share button, criterion 3 (`test/share-and-painter.test.ts`). The share command asks the host and opens no pane.
- UX-009 Format painter, criterion 3 (`test/share-and-painter.test.ts`). In a scope the user may not change, applying the painter is refused with `no-access`, the core's `pasteFormat` is not called and the selection does not move.

### Decisions taken in round 5 (spec defaults)

- **Share for a viewer.** The share command has `changesContent: false`, so the registry leaves it enabled for a user with `view` only. The spec does not say who sees the button (UX-039 notes). The shell's reading is that sharing changes no content, so UX-004 does not apply to it. Proposed; the owner decides whether the button hides for viewers.
- **Painter in a suggest-only scope.** `format.applyFormat` keeps `changesContent: true`, so the shell lets a user with `suggest` but not `edit` through. The core decides whether the result is a formatting suggestion (UX-009 criterion 2). Not claimed here.

### Not met in round 5, and why

- PRM-030 criterion 2 (commands that change styles, numbering, page setup, headers or footers are disabled for a region-only editor). The shell has no command that changes a style definition, numbering, page setup or a header's content. `page.header` only opens the header panel (`changesContent: false`), and the edits inside pass the core's region guard. There is nothing to disable yet; the criterion waits for those commands.
- PRM-034 criterion 5 (an operation the user lacks rights for is disabled with its reason). The region commands in the shell are `insert.region` (enabled by the core's `canMarkRegion`) and none for rename, remove, move, split or merge. Whether `canMarkRegion` requires `structure` is the core's and was not checked here.
- UX-039 criteria 1, 2 and 4 (the `de-share-request` event, the host's dialog and focus, the accessible name and keyboard use) belong to the element and the component.
- FE-007 criterion 3 (`readonly`) stays with `packages/element`, as recorded in round 1.

### Consequences

- No root configuration, no other package, no dependency and no commit were changed.
- Tests: `pnpm vitest run packages/ui`, 236 passed (21 files), including this round's two new files.

## Round 6 (packet U and packet C, 2026-11-13)

Stories worked on: FRW-078 (criterion 1 ticked), UX-007 (criteria 1 and 3 ticked), UX-014 (criterion 4 ticked, the one about hiding the header). New files: `test/toolbar-groups.test.ts`, `test/header-free.test.ts`; `test/fill.test.ts` extended. Changed: `src/shell/toolbar-groups.ts` (`toolbarGroups` now orders the groups in task order, then the contextual ones, whatever the input order; the full toolbar already passed them sorted).

Decisions recorded here, not made silently:

- UX-014 criterion 4 is ticked on the registry alone. The `header` setting that hides the header is not built (the embedding attribute is open with PRO), so the test shows that the commands work with no Header component, not a browser run with the header hidden.
- UX-005 criteria 4 and 5 were not ticked. The element's `exec` and `queryCommand` forward to the core (`packages/element/src/doc-editor.ts`), not to the shell's `registry.exec`, and the element does not raise `de-command-state` yet, so the registry tests do not show what a host sees.
- UX-003 criterion 2 was not ticked: its Notes wait for the element to raise `de-command-state` from the shared registry (B2).
- FRW-078 criterion 3 (the live status and its announcement) and criterion 4 (the open question above) stay open. Criterion 1 is ticked on the list and reason tests, not on a browser run of FillPane.
- UX-007 criterion 2 stays open: the logic of which contextual group is offered is tested, but the focus that must not move is the component's.

Tests: `pnpm vitest run packages/ui`, 245 passed (22 files) before the header test was added; 249 with it. `svelte-check` on `tsconfig.test.json` and `tsconfig.json`: 0 errors. No browser run, no Podman, no PostgreSQL. No dependency, root configuration or other package was changed.

## Round 7 (packet U, 2026-11-13)

Written by the packet U agent for `packages/ui`. Earlier rounds are above. Status proposed; the spec defaults and the shell's own choices wait for the owner's review.

### Work done in round 7

- UX-002 criterion 1 ticked. `packages/ui/src/parity/status.ts` gives each profile row one of shipped, partial, planned (with its earliest phase) or not planned, from the criteria of its delivering stories (`parseCriteria` reads them from the epic files). `phaseRank` and `PHASES` are now exported from `parity/build.ts`. Tests: `packages/ui/test/parity-status.test.ts`.
- FRW-073: the panel's gate is built as plain functions in `packages/ui/src/shell/field-properties.ts` (`validateFieldDraft`, `fieldPatch`, `fieldPanelReadOnly`). Tests: `packages/ui/test/field-properties.test.ts`. No criterion ticked: the panel, the reasons on screen and the commit through the core are not built.
- Scoped checks: `pnpm vitest run packages/ui` (25 files, 275 tests passed); `tsc --noEmit` on `packages/ui/tsconfig.json` and `tsconfig.test.json` showed no error in the new or changed files. Browser and e2e runs were not run.

### Decisions taken in round 7 (spec defaults or the shell's proposal, for the owner to confirm)

1. **A row with a gap is never shipped.** UX-002 says a shipped row must show the capability, not its appearance. The shell reads "shipped" as: every delivering story fully ticked and no `gap` stated on the row. A row with a gap and complete stories shows partial. Proposed.
2. **A row whose stories are all unknown is not planned.** A story the progress does not know counts for nothing; the report names it as a problem. Proposed.
3. **Empty keys are refused in the field gate (FRW-073).** The spec gives no key grammar (CDM-002 may decide one). The gate refuses only an empty key and a key already used by another field.
4. **Validation limits in the field gate.** `min` and `max` are decimal strings; `minLength` and `maxLength` are non-negative safe integers; `min` above `max` (or the length pair) is refused. `pattern` and `preset` are not checked yet. `format` is not checked, because 12 section 3.2 names its members without fixing them.
5. **Read-only panel.** Without `edit`, or while the workflow is `sent` or `in_progress`, the panel is read-only (FRW-073 criterion 4 as written). Other workflow states leave it editable for a user with `edit`.

### Open questions found in round 7

- UX-002 criterion 2 (a shipped row links to an automated test) and criterion 3 (a port or reference extension named for each "through ports and extensions" row) need fields the profile does not carry. The owner or the release work decides where that data lives.
- FRW-073: what the panel does with a value when `kind` changes, or when an option that is the current value is removed, is still open (12 section 3.2, the story's Notes).

### Not built in round 7

The release job that calls `parityReport` and writes it with the release notes (FND-012); the panel component and its keyboard and announcement behaviour (FRW-073 criteria 1, 2 on screen, 3 and 5); error text keys in `i18n/en-GB.ts` for the field problems.

## Round 8 (packets U and C, 2026-11-13)

**Status:** proposed. Records a shell-side gate for marking a region (PRM-033).

- Decision taken by the shell, spec default kept: `insert.region` is refused in the shell before the core is asked when the document-level `permissions.caps` lacks `structure` (reason `structure`), when the body or scope access lacks `edit` (reason `noEdit`), or when a sub-editor is open (reason `subeditor`). The core's answer still decides everything else. The core's `limit` reason code is shown with the shell string `regionLimit`.
- Open: whether the core should also refuse these cases itself (it does in the fake core only through `canMarkRegion`). The gate only narrows what the shell offers; it never allows what the core refuses.
- Not decided here: the nested-selection check and the forced-commit `invalid_op` path, which belong to the core and the server.

## Round 1 of this run (2026-11-13): UX-013 criterion 5 ticked, open items recorded

Lane: the `packages/ui` developer for the packet U backlog. Scoped checks only: `pnpm vitest run packages/ui` (42 files, 426 tests passed). No browser, container or other package was run.

- UX-013 criterion 5 (an extension's colliding `keys` are reported and neither binding is replaced) is ticked on `packages/ui/test/extension-commands.test.ts`. It is the registry's behaviour, so no code changed.
- Not picked, because the remaining criteria need the DOM, a browser run, the element or the core: UX-019 (criterion 2, the loading state), UX-023 (2 and 4), UX-039 (1, the element dispatches the event), UX-009, UX-016, UX-064, FRW-073 (the properties panel component is not built; `shell/field-properties.ts` is the gate only), FRW-078 (2, 3 and 5 need FillPane in a browser), PRM-027 (1, toolbar and keyboard run), PRM-030 (2, no definition command exists in the shell), PRM-031 (1 needs the owner's decision in ADR 0138; the shell does not switch mode).

Points for the owner and the main session, not decided here:

- `packages/ui/test/share-and-painter.test.ts` labels two of its tests "criterion 3" (UX-039 and UX-009). Those tests cover different criteria from the ones the labels name (UX-039 criterion 3 is the accessible name; UX-009 criterion 3 is the keyboard). The labels should be corrected by the owner of the file; the test bodies are not changed here.
- FRW-077 criterion 1 is noted as open for the engine (the core must list every field). Its Evidence line says the browser test already shows the visible role name, colour, icon and read-only state. The two statements disagree; the owner should decide which holds before ticking.
- UX-002 criteria 2 and 3 need a profile field that names the automated test of a shipped row and the port or reference extension of a "through ports and extensions" row. That is a profile content decision (owner or PRO/FND), so it is not made here.

## Round 3 (packet U, 2026-11-13)

Picked from the ui packet's stories (UX-experience.md, PRM-026 to PRM-036, FRW-072 to FRW-079, FE-007), skipping those handled in earlier rounds. Few remaining criteria in these stories can be met inside `packages/ui`. Most need the element, the core, the server or a browser run.

Ticked:

- PRM-036 criteria 1 and 3. Criterion 1 by `packages/authority/test/region-policy.test.ts` (4 passed on 2026-11-13: the commit sets `restricted`, the connected editor gets `perm.changed` with `view` and `comment`); criterion 3 by the same file (a user without `manage` gets `drop`, no write) and the disabled control in `packages/ui/e2e/regions.spec.ts` (Chromium run of 2026-11-13). The authority test belongs to another packet; it was run here only, not changed.

Checked and left open, with the reason in the story Notes:

- UX-003 criterion 4: the registry raises `de-command-state` (`packages/ui/test/registry.test.ts`), but `packages/element/src` never calls `bindCommandStateEvent`. Needed from packet B2.
- FRW-072 criterion 1 (the core inserts the field with a fresh key), FRW-079 (field node views are the engine's), FRW-076 criterion 2 (the bar's controls are not tested in a browser), FRW-078 criteria 2, 3 and 5 (FillPane in a browser; criterion 4 conflicts with criterion 1, see round 2 notes).
- PRM-026 criteria 1, 3 and 4 (shading and icon rendering are the core's and the CSS's; no browser run).
- PRM-032 criteria 1 to 4 (the list is the core's and the server's); criterion 5 is about the list the core builds.
- PRM-033 criteria 2 to 4 (the nested and limit answers and the refused forced commit come from the core and the server).
- PRM-035 criteria 1, 5, 6 and 7 (expiry shown but untested, live update and keyboard run need the browser; roles are marked by CSS `data-role` shapes, and the criterion asks for an icon).
- FRW-074 criteria 1, 2, 3 and 5 (the roles manager is not built).
- FRW-077 criterion 1: the open question from round 2 stays open. The owner should decide before ticking.
- FE-007: all criteria are ticked, but its Notes still say criteria 3 and 4 are open. The text is out of date; not changed here, as it belongs to the element's packet.

Not run: Playwright and the browser specs (no browser run here), the whole-repository checks.

## Round 4, packet U (ui, 2026-11-13)

Ticked:

- UX-007 criterion 4 (the view group offers only the views the core lists, so `print` waits for the core). Rule `layoutViews` in `packages/ui/src/commands/builtin.ts`, used by `App.svelte`; `packages/ui/test/layout-views.test.ts` (6 tests passed, Node.js). Rendering not run in a browser.

Reviewed and left open, reason in each story's Notes or here:

- UX-008 criterion 2 (menu keys and focus return): the key handling is in `ContextMenu.svelte`, and a browser run is needed for focus. Not refactored in this round.
- UX-015 criteria 2, 4 and 6: the mode change reaches the core and the host, which are not built here.
- UX-017 criteria 4 and 6: the journal recovery needs FE-008; the arrival announcement is FE-107.
- UX-018 criteria 1 and 6: the non-delaying count and the extension and classification items need a browser run.
- UX-022, UX-101, UX-102, UX-103, UX-068, UX-069: the criteria need the core, the server, a browser or a CI report that is not built.
- PRM-026, PRM-033 criterion 2, PRM-035: the criteria depend on the core's answers or on rendering, as already recorded.
- FRW-072 criteria 1 and 5, FRW-074, FRW-075, FRW-079: the core, the roles manager, the preview and the field node views are not built, or the criterion needs a keyboard run.
- Parity profile (UX-002 criteria 2 and 3): the profile has no field naming the test or port that demonstrates a row. Owner or PRO/FND decision, not made here.

Not run: the Playwright browser specs; the whole-repository checks. The scoped `pnpm vitest run packages/ui` gave 543 passed and 1 failed, in `test/forced-colors.test.ts` (UX-062, a file another agent was writing in the same tree; not touched here). `tsc --noEmit -p packages/ui` passed.
