# ADR 0041: The shell's command registry, string tables, people directory and core API of phase 1a

**Status:** proposed, 2026-11-06. Records the choices packet C made where the specification is silent while building the shell of phase 1a in `packages/ui` (UX-001, UX-003, UX-004, UX-006, UX-014, UX-016, UX-025, UX-026, UX-064). The project owner has not reviewed any of it. Visual and interaction design stays a designer's job (13 §13); nothing here is meant as the product's final look.

## Context

13 §4 gives one sample registry entry and says that `enabled` and `active` name queries on the document API; it gives no field for synonyms or for permissions, and its `label` is a literal although 13 §8 says every string is external (UX-003 notes). 05 §8.1 has no attribute for hiding the header, no event for presence or counts, and no return shape for `exec` (UX-005, UX-014 notes). 13 §5 leaves the result shape of `resolveUsers` open; S6 fixed it (G92, `packages/protocol/src/ports/host.ts`). UX-026 does not say whether a person with several sessions appears once. UX-064 does not say which locales ship. The element (`packages/element`) and the core (`packages/engine`) are built in parallel with the shell, so the interface between them, `packages/ui/src/core-api.ts`, had to grow without breaking either.

## Decision

### 1. Command entries (13 §4; UX-003)

An entry has the fields of 13 §4 with these changes:

- `id` has the form `area.name` (`format.bold`); the registry refuses any other form, a duplicate identifier or alias, an unknown query name, a label that is not a string key and an entry without a capability, with an error that names the entry. Nothing is overwritten.
- `label` is a string key (`command.format.bold`), resolved from the string tables at display time.
- `capability` names the parity-profile row the command delivers (UX-001 criterion 3).
- `changesContent` marks commands that change the document; they need `edit` or `suggest` in the scope of the selection (UX-004; suggestion mode turns the edit into a suggestion).
- `feature` hides a command whose backend feature is not announced (05 §1 rule 4, §8.3), for example the header's comments (`comments`) and catch-up (`history`) buttons.
- `aliases` keep the spike's names (`bold`, `insertFootnote`, `outline`) working in `exec` and on `data-command`, so the element's spike tests keep passing; `data-command-id` carries the registry identifier.
- Synonyms for command search (UX-011, phase 2) are not added yet.

The groups of phase 1a are `edit`, `format`, `insert`, `page`, `view`, and `header` for the commands the header shows. The grouping is this product's own (13 §3) and provisional.

### 2. Evaluation, publication and `exec`

- The registry evaluates states, and nothing else does: each named query at most once per evaluation, through query sources, the core's first (`CoreApi.query`). A core without `query` (the spike core) is answered from its views where they carry the answer (marks, access); an unanswered query leaves the command enabled, and running it reports `no-effect`.
- Inputs (selection, access, features, panel, revision, the shell's pane state) mark the states dirty. One evaluation runs per frame at most: the first change in a frame is published in a microtask, a later one in the next frame. Only changed commands are published, and `onStateChange` lists their identifiers, from which the element raises `de-command-state` (`bindCommandStateEvent`).
- `exec(id, args)` and `state(id)` evaluate at the moment of the call. `exec` returns `{ ran, reason }`, where `reason` is `unknown`, `unannounced`, `no-access`, `not-applicable` or `no-effect`. This shape is proposed for PRO to confirm (UX-005, PRO-085 open question).
- In phase 1a the editing core binds the keyboard shortcuts; entry `keys` are published as `aria-keyshortcuts` only. UX-013 moves the bindings to the registry and the shortcut table.

### 3. Permissions (UX-004; 07 §4, §7)

The core reports the effective access at the selection as `{ scope, caps, limit }`. A content command without `edit` or `suggest` there is disabled and keeps focus (`aria-disabled`), with a reason from `limit`: the role, a restricted region, an approved region, someone else's lease, a locked or archived document, a workflow, a region not yet listed, or hidden content (ADR 0019). When the access changes while the scope stays the same, the change came from the permissions, not from the caret, and the shell announces it in its polite live region.

### 4. Shell layout and keyboard

- The compact toolbar is one row and one tab stop (WAI-ARIA toolbar pattern); arrow keys follow the reading direction; Escape returns to the editing surface. Commands that do not fit move, in order, into a "More" menu button (menu pattern).
- The header holds a `<slot name="title">` (the host's own element, so the editor never fetches or edits a title), the save and connection state, the presence region, and the header group's commands. A proposed `header` setting (`default` or `none`) hides it; the element would reflect it from an attribute, which 05 §8.1 does not have yet (UX-014 gap, for PRO). While the header is hidden, the save state moves to the status bar.
- The save state and the connection state are words with a shape beside them, never colour alone.

### 5. People (UX-025, UX-026)

- `resolveUsers` has the S6 shape. Identifiers asked for in one task are sent once, unique, in batches of at most 100; answers, including "unknown", are cached for the shell's lifetime; a failure is retried after 1, 5 and then every 30 seconds. These values are defaults chosen here, not targets from the spec.
- Until the host answers, a person shows the name the service reported, then the neutral label "Collaborator". Names are text; an avatar address is used only as an image source and only when it is `https:`, `http:`, `blob:` or `data:image/`.
- The header shows one entry per person (a person with several sessions once, active when any session is); idle people have a dashed outline and "idle" in their name. Only the sessions in the core's presence view appear: the core applies the reader's projection (ADR 0019).

### 6. Strings (UX-064; 13 §8)

- One table per locale, keyed by string key. The source is British English (`en-GB`) and is the only table in the initial bundle; others load on demand. A BCP 47 tag is matched exactly, then by language and script, then by language, then the default. Plurals use `Intl.PluralRules`, numbers `Intl.NumberFormat`.
- Which locales ship is the owner's question (UX-064 notes). Phase 1a ships the source table and two pseudo-locales for testing: `en-XA` (accented, about 40 percent longer, bracketed) and `ar-XB` (right to left).
- Host replacements are keyed by string key (`Strings.setOverrides`), the mechanism UX-063 builds on; the element has no property for them yet (05 §8.1 gap, for PRO).
- CI fails on a user-visible literal in a component and on physical-direction CSS (`test/source-checks.test.ts`).

### 7. Styles

The shell's styles are `@docedit/ui/styles/shell.css`, adopted by the element after its own sheet in the one shared constructable stylesheet (02 §3; FE-014). Public `--de-` properties are read once on `.de-shell` into internal `--_de-` tokens with defaults, so a host sets them on the element or any ancestor (FE-018). Lengths are in em, so the host page's root font size does not leak in. The shell sets `dir` on `.de-shell` from the interface locale, which outranks the element's `direction` reset; the page keeps the document's direction.

### 8. The parity profile (UX-001)

The profile's source is `packages/ui/src/parity/profile.ts`; `pnpm --filter @docedit/ui generate` writes `spec/parity/parity-profile.json` and `.md`. Phases are derived from the delivering stories. The generator and `test/parity.test.ts` fail when an item of 13 §2 is uncovered or in two tiers, a story does not exist, a non-goal names a delivering story, the set of non-goals changes without an updated decision record, a built-in command names a capability with no row, or a row names another product's design. Two rows come from outside 13 §2: basic editing (02 §5.2) and sharing (13 §5).

### 9. Additions to `core-api.ts`

All optional, so the engine's `EditorCore` still satisfies `CoreApi`: `query(name)`, `queryNames`, `revision`, `access` (`AccessSummary`), `status` (`StatusSummary`, the `de-status` detail), `presence` (`PresencePeer[]`), `features`, `counts` (`ShellCounts`), `direction`, `setLabels(CoreLabels)`. New types: `Capability`, `AccessLimit`, `AccessSummary`, `ConnectionState`, `SyncState`, `StatusSummary`, `PresencePeer`, `ShellCounts`, `CoreLabels`, `CoreQueryName`, `HeaderPaneName`, `UserInfo`, `ResolveUsers`. `PanelInfo.label` stays for the spike; the shell names panels by `kind` from its tables.

## Consequences

Good:
- One registry instance serves the toolbar, the header and the element's `exec` and `queryCommand`; later surfaces (full toolbar, menus, search, access keys, extensions) only read it.
- The shell shows nothing the core cannot back: without a status, presence or features view it shows no save state, no presence region and no optional button.
- Every visible string can be replaced, and the pseudo-locales catch hard-coded or clipped text in CI.

Bad:
- Until the core implements `query`, `access` and `revision`, undo and redo look enabled when there is nothing to undo, and permissions are not reflected.
- The registry's `exec` result is a proposal that PRO may change.
- Measuring the toolbar to decide what fits needs layout; a host that never lays the element out shows every command.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Literal labels in entries, translated by a lookup | 13 §8: all strings external; a literal invites drift |
| The core evaluates command states | The registry names the queries and is shared by every surface; FE-026 keeps the queries in the core and the evaluation in one place |
| Wrapping toolbar rows instead of a "More" menu | UX-006 asks for a single row |
| One avatar per session | Shows the same person several times; the spec leaves it open, so the simpler reading for users is taken |
| Defaults on `:host` | A host's value on an ancestor would be shadowed (FE-018 criterion 4) |

## Revisit when

PRO defines the header attribute, the events for presence and counts, the property for string replacements and the `exec` result; UX-013 moves the shortcut bindings into the registry; a designer replaces the provisional layout; the owner decides which locales ship.
