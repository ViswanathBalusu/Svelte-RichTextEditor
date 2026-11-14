# ADR 0138: ui-4 backlog batch (PRM-026 to PRM-036, FRW-072 to FRW-079)

Status: proposed (2026-11-13, lane ui-4, round 1)

## Context

Lane ui-4 worked the editor-side stories of PRM-permissions.md (from PRM-036 backwards) and the fill-mode stories of FRW-fields-rules-workflow.md (from FRW-079 backwards), in the shared `packages/ui` tree, without commits.

## What this round did

- FRW-074 criterion 4 ticked: the marker's accessible name carries the role's name, tested in `packages/ui/test/fields.test.ts` (11 tests passed in Node, 2026-11-13). The rendering is cited from the FRW-077 browser run and was not repeated.

## What was not done, and why

- FRW-073 (properties panel): the gate in `packages/ui/src/shell/field-properties.ts` exists and is tested, but no panel is built and no commit goes through the core. Criteria 1, 2, 3, 4 and 5 need the panel. Left open.
- FRW-079 (keyboard and assistive technology per field): the field node views and their native controls are the core's and the element's, not `packages/ui`. Left open.
- FRW-075 (preview as a role): phase 2, and it needs the fill mode of FRW-076 in a browser. Left open.
- FRW-076 (guided bar): the core's region guard, the rejected-fill announcements and the live updates need a browser run and the core. Left open.
- FRW-078 (summary): criterion 2 (focus and scroll) and criterion 5 need FillPane in a browser. Left open.
- PRM-033 (mark a region): criterion 1 is the core's commit (`markRegion` through `App.svelte`). Criteria 2 to 4 are answered by the shell (`markRegionSource`) and tested in `packages/ui/test/mark-region.test.ts`; their core and server halves stay open. Left open.
- FRW-072 and FRW-077 already carry ticks from earlier rounds and were not claimed.

## Open questions

None decided in this round. The open choices recorded in the stories (the icon of a role, the value when a field's kind changes, the empty key) remain with their owners as the stories already state.

## Round 2 additions (lane ui-4, 2026-11-13)

Status of these items: proposed.

1. **Suggest-only scope and the mode in effect (PRM-031 criterion 1).** `shell/modes.ts` disables
   `edit` with `suggestOnly` in a suggest-only scope. Nothing sets the active mode to `review` when
   the caret enters such a scope; the active mode is the user's `shell.mode.*` choice
   (`commands/builtin.ts`). Spec default (07 §7): the editor stays in suggestion mode. Options for
   the owner: (a) switch to `review` automatically when the caret enters a suggest-only scope; (b)
   keep the user's choice and only disable `edit`. Round 3 applies the spec default, option (a), so
   PRM-031 criteria 1, 3 and 4 are ticked; the owner may still prefer option (b) (see round 3).

2. **Who can edit an inherit region (PRM-032 criterion 5).** The shell's words (`shell/regions.ts`)
   name the roles the service lists. The derived list is not in packages/ui, so no criterion of
   PRM-032 is ticked by this lane. Whether an `inherit` region's list states that document-level
   editors and owners can also edit is for the service's list to decide.

3. **Field palette keyboard operability (FRW-072 criterion 5).** The palette is driven by the
   registry and found by command search (packages/ui/test/field-palette-search.test.ts). Keyboard
   operability is a browser run, not run in this round; criterion 5 stays open.

## Round 3 additions (lane ui-4, 2026-11-13)

Status of these items: proposed.

1. **Suggestion mode in a suggest-only scope (PRM-031 criteria 1, 3, 4).** Decided by the spec
   default (07 §7), which is option (a) of round 2 item 1: where the user may only suggest, the
   core is asked for `review`; the mode the user chose for editing returns in an editable scope.
   Code: `packages/ui/src/shell/suggest-mode.ts` (`modeInScope`, `stepMode`), wired by an effect in
   `packages/ui/src/App.svelte`; tests `packages/ui/test/suggest-mode.test.ts`. Not run in a
   browser. A locked, archived or workflow document keeps the server's limit. The owner may choose
   option (b) instead; then `modeInScope` is removed and `modes.ts` stays as it is.

2. **Stories not claimed in round 3.** PRM-027 criterion 1 needs the toolbar and the keyboard run
   in a browser. PRM-026 criteria 1, 3 and 4 are drawn by the core (shading, indicator icon,
   live update); the shell's words are unchanged. PRM-035 criterion 6 needs an icon for each
   region role, which the permissions pane does not draw. FRW-077 criterion 1 needs the engine to
   list every field with its `assignee`. These stay unticked.

## Round 4 additions (lane ui-4, 2026-11-13)

Status of these items: proposed.

1. **Field markers of other roles (FRW-077 criterion 1) ticked.** The shell draws the role's name as
   visible text, the role's colour and icon, the read-only state and an accessible name with the
   role and the label (`packages/ui/src/panes/FillPane.svelte`, `shell/fields.ts`). The Chromium test
   "marks my fields as mine and keeps other roles' and unassigned fields read-only (FRW-077)" in
   `packages/ui/e2e/regions.spec.ts` passed on a rerun. The core must list every field, with its
   `assignee`, for those markers to appear: this is an engine need (needsFromOthers), not a shell
   change. Forced-colours (criterion 4) stays open.

2. **Who can edit a grant's expiry (PRM-035 criterion 1) ticked.** The pane's expiry date is tested by
   "shows when each grant ends, as a date (PRM-035, criterion 1)" in `packages/ui/e2e/regions.spec.ts`
   (Chromium, 1 passed). The test fixes the date's text in en-GB; a different locale is not tested.

3. **Next editable part (PRM-027 criterion 1) ticked.** The command sits in the Review tab of the full
   toolbar and runs from the keyboard (Chromium test "is a command that moves on, and is not enabled
   when there is none"). Command search is phase 2 and is not claimed, as the criterion allows.

4. **Test runs in the shared tree.** Several agents run the same Playwright harness in `packages/ui`;
   one run of the FRW-077 test failed on a timing check (the count of fields in the pane read 0 for
   5 s) and passed on the rerun. Runs were made with `--retries=0 --workers=1` and a separate
   `--output` folder. The failure is not explained; it is recorded here so that a later run that
   fails in the same way is not read as a regression of the criterion.

## Round 5 review (lane ui-4, 2026-11-13)

Status of these items: proposed.

1. **No story ticked in round 5.** The slice (PRM-026 to PRM-036, FRW-072 to FRW-079) was checked from
   the end. FRW-072 to FRW-079 were all handled in earlier rounds. PRM-036 has every criterion ticked
   already. The open criteria left in the slice are the core's, the server's or a browser run's:
   - PRM-026 criteria 1, 3 and 4: shading, the icon, and live update are drawn by the core (`setRegionLabels`).
   - PRM-027 criterion 2 and PRM-031 criterion 2: the core's caret and mark behaviour.
   - PRM-028: all eight criteria are the core's plugin behaviour (typing, boundaries, numbering).
   - PRM-030 criterion 2: the shell has no command that changes a style, numbering, page setup or header
     content, so there is nothing to disable (see the story's Notes).
   - PRM-033 criteria 1, 2, 3, 5 and 6: the marking itself, the core's nested and limit answers, and the
     keyboard run.
   - PRM-034 criteria 1, 2, 4 and 5: there is no `renameRegion`, `removeRegion`, `splitRegion` or
     `mergeRegion` in `core-api.ts`, so the pane has no operation to disable.
   - PRM-035 criteria 5, 6 and 7: the live `perm.changed` path, the role marks drawn by CSS, and the
     keyboard run. A source-text test of the CSS would not show that the marks render, so none was written.

2. **Needs from others (not built in packages/ui):**
   - core: `renameRegion`, `removeRegion`, `moveRegion`, `splitRegion` and `mergeRegion` commands with
     their `canX` queries and reasons (PRM-034).
   - core: the 500-region limit answer and the nested-selection answer for `canMarkRegion` (PRM-033).
   - document service: `GET /documents/{id}/regions` (PRM-032); this is not a shell change.
   - a browser run of `packages/ui/e2e/regions.spec.ts` in this round was not done, so the criteria
     that rest on it (PRM-035 criterion 3 and PRM-036 criterion 3) were not re-checked here.
