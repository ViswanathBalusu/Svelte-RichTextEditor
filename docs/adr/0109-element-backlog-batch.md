# 0109. Element backlog batch: round 1 decisions

**Status:** proposed, 2026-11-13. Written by the element packet (packages/element) in round 1 of the backlog run. Not reviewed by the project owner.

## Context

The element packet owns `packages/element` and the FE and PRO stories listed in PLAN-1a packet B. Most criteria still open need a browser run, another package, or a feature not built yet. Round 1 took the two stories whose open criteria could be met inside the package.

## Decisions

1. **FE-007 criterion 4 (connection follows the socket, independent of the save state).** The check is a session test with a DEP-style socket (`packages/element/test/session.test.ts`). The spec leaves open whether the DEP socket or the core's channel state is the witness of a lost connection. The code already uses the socket as an earlier witness (`#updateStatus` in `src/session.ts`); that reading stands.
2. **FE-025 criterion 4 (developer documentation lists the order-sensitive events).** The developer documentation is ADR 0039 §8. It now names the seven events. `packages/element/test/order-sensitive.test.ts` fails when the list and `ORDER_SENSITIVE_EVENTS` differ. The reviewer still reads the list at review.
3. **FE-007 criterion 3 stays open.** The `read_only` answer from the server is the core's (FE-029). The `readonly` value from the access is tested.

## Not done in round 1, and why

- FE-004 criterion 2: re-attaching global listeners on reconnect needs a browser run (FE-005 owns the listeners).
- FE-002 criteria 1 and 5, FE-016 criterion 5, FE-018 criterion 5, FE-021 criterion 2, FE-122 criterion 3: need a build, a browser run, a paste policy (FE-054), the rulers and dialogs (UX-102, FE-020), or two tabs.
- FE-023 criteria 1 and 3, PRO-080 criterion 2, PRO-092 criterion 4: their checks sit in `packages/ui` or `packages/protocol`, not in this package.

## Consequences

- ADR 0039 §8 gained one paragraph. ADR 0039 is outside the packet's own files; the edit only adds the event list the code already holds.

- Open regression, not in this packet: `packages/element/test/source.test.ts` ('the shell puts no delegated handler for them') fails in round 1 because `packages/ui/src/App.svelte` (line 762) now has `onkeydown={onPaneKeydown}`. That is FE-025 criterion 2's check. The shell's owner must attach the handler with `on()` from `svelte/events`, as the rule requires.

## Round 3 decisions (PRO-083, PRO-084, PRO-085)

The element packet took three stories whose checks run in Node.js: the embedding API's core members, in `packages/element/src/host-api.ts`, tested in `packages/element/test/host-api.test.ts`. The element's methods (`flush`, `getContent`, `exec`, `queryCommand`) are one-line forwards; the element itself needs a DOM and its e2e wiring was not run this round. Correction (round 3 review, fixed 2026-11-13): the review found that the getContent test compared the core's `confirmedContent()` with itself and that nothing ran the element's path to the core. The methods now forward to `elementMethods(() => session)` in `src/host-api.ts`, which reads the session's mounted editor and its `api`; `test/host-api.test.ts` runs it over a `Session` against the mock backend with a headless core (confirmed `seq` and document, an unconfirmed edit left out, `flush()` with a commit in flight), `MountedEditor.api` is required in `src/editor.ts`, and `e2e/element.spec.ts` runs the real element's four methods in Chromium, Firefox and WebKit.

4. **`getContent()` when no document is loaded.** The spec does not say. The element rejects with a plain `Error` ("no document is loaded"). No registry code is assigned, because 05 §8.1 names none for this case. Proposed; the owner may choose a code.
5. **`flush()` when no document is loaded.** Resolves at once: nothing can be unconfirmed. This follows the spec's "when nothing is in flight or queued" (PRO-083, FE-012).
6. **`exec` and `queryCommand` when no document is loaded.** `exec` returns `false` and `queryCommand` returns `{ enabled: false, active: false }`. The spec is silent; both are the answers that apply nothing.
7. **`exec` is the core's `run`.** The shell calls `core.run` for the toolbar (`packages/element/src/editor.ts`), and 05 §8.1 asks for the same path. Proposed reading; the engine documents `exec` as "the same as `run`".
8. **Not decided here.** PRO-085 criterion 3 asks that a refused `exec` "reports why". The core returns a boolean only. The reason needs a return type change in `packages/engine`, which this packet does not own; the criterion stays open. The same goes for the `de-selection` and `de-command-state` events (PRO-085 criterion 4) and the toolbar `none` check (criterion 5). PRO-084 criteria 2 to 4 need a CDM fragment serialiser and an `insertContent` path, which the engine does not have. PRO-083 criterion 2 needs the journal (FE-008), and criterion 1 is tested only for the idle case.

## Round 4 decisions (FE-012, PRO-086)

9. **FE-012 criteria 1 and 2 ticked.** The idle case (`flush` resolves at once) and the case with a local edit in flight (`flush({ timeoutMs })` resolves after the mock backend acknowledges it, and the confirmed `seq` matches the server's) are both run through the element's path in `packages/element/test/host-api.test.ts`. Criterion 3 (rejection with the count, work kept in the journal) and criterion 4 (reconnecting channel) stay open.
10. **`requestExport` is `startExport` in `packages/element/src/export.ts`.** Proposed reading of PRO-086 criterion 1: the element forwards the options unchanged to the backend's exports port (PRO-063 is the server route) and resolves `{ jobId }`. With no document, the element rejects with `unavailable`. With no exports port, or with the port but no `exports` feature announced, it rejects with `unsupported_feature` and sends nothing. The registry codes are the proposed choice; the spec names none for these cases. The owner may choose others.
11. **Not built, left open.** PRO-086 criteria 2 to 4: the `de-export-*` events (the exports port has no progress stream), `print()`, and the `no-export` check (PRM-056). The `de-share-request` event (PRO-089) is not added: its control is in `packages/ui`.
12. **FE-008 (journal) not started in round 4.** Its write-before-send needs the element to hold the channel's `submit` and an IndexedDB store, neither is built. Nothing is ticked for it.

## Round 5 decisions (PRO-077, PRO-078, PRO-079)

13. **The `theme` attribute reaches the shell.** `src/editor.ts` `settingsFrom` now reads `theme` through ui's `themeMode`, and `src/doc-editor.ts` reflects it while mounted. The attribute was observed but ignored before this round (PRO-079 criterion 3). Removing the attribute keeps the last value, as `toolbar` and `locale` already did; the spec states no reset rule. Proposed: keep this. The owner may choose a reset to the default.
14. **PRO-079 criterion 2 is tested with `ar-XB`.** The only non-English table the shell ships is the pseudo-locale. The criterion is ticked on that evidence; a real-language table should repeat the test when one exists.
15. **PRO-079 criterion 4 includes the `none` case only up to the shell.** With `toolbar="none"` no toolbar is rendered. The host's own controls through `queryCommand` and `exec` are PRO-085's, and their evidence is unchanged.
16. **PRO-079 criterion 1 (`view="web"`) stays open.** The element keeps `view` on the attribute only. No layout follows from it, and no test sets it.
17. **PRO-077 criterion 4 (`mode="fill"` and FRW-007) stays open.** The fill mode locks the body (mode.spec), not the fill-mode behaviour of 12 §11.
18. **PRO-078 criterion 2 ticked (review for a viewer).** Criteria 1 and 3 need suggestion mode (FE-041, FE-042), which is not built.
19. **New tests:** `packages/element/e2e/attributes.spec.ts` (seven Chromium tests, all passing). `packages/element/e2e/embed-helpers.ts` gained an `attributes` option on `mountEditor`. Other browsers were not run this round.
20. **Still failing, not in this packet:** `packages/element/test/source.test.ts` FE-025 (see round 1, decision after item 3). The fix belongs to `packages/ui/src/App.svelte`: attach `onPaneKeydown` with `on()` from `svelte/events`.

## Round 6 decisions (FE-023, PRO-089) (status: proposed)

21. **FE-023 criterion 1 ticked on a source check.** `packages/element/test/state-source.test.ts` reads every `$state` and `$state.raw` declaration in `packages/ui/src`, generic or annotated, and fails on a rune it cannot read; it refuses any whose name, type or initialiser names a document, a transaction, editor state or the core, and a snapshot outside `$state.raw` (02 §4). It is a scan, not an ESLint rule, because the workspace's ESLint configuration does not parse Svelte files. Criterion 3 stays open as a review item.
22. **`de-share-request` detail is `{ docId }` (spec default, proposed).** 05 §8.1 names the event but not its detail, and UX-039 lists the detail as an open question. The element sends the document identifier only, which is what "identifiers only" in PRO-089 asks for. The owner may add fields.
23. **The share command is always offered by the element (proposed; open for the owner).** `packages/ui/src/App.svelte` shows the share command only when `onShareRequest` is given (its comment: "only when the host can handle `de-share-request`"). The element cannot detect whether the host has a listener, so `src/doc-editor.ts` always passes the callback, and the command shows in every element. The effect for a host without a listener is that the owner clicks and nothing happens. Alternatives: an opt-in attribute or property, or a listener probe. Decide with UX-039's open question.
24. **PRO-089 stays unticked.** The event, its emitter and the callback wiring are in place and unit-tested. The owner's activation of the share control, the host-without-listener run and the no-dialog check need a browser run and the shell's control (UX-039).

## Round 7 decisions (FE-025 test scope, PRO-081)

25. **FE-025 check narrowed to the editing surface's ancestors (proposed; the ui packet may object).** The round 1 and round 5 failure came from `packages/ui/src/App.svelte` line 762, where the side pane has `onkeydown={onPaneKeydown}`. The pane is a sibling of the editing surface, not an ancestor, so the rule in FE-025 does not reach it. `packages/element/test/source.test.ts` now checks only the span from the shell root (`bind:this={shellEl}`) to the end of the body host's opening tag, which holds the shell root, the page and the body frame. The test fails if the span is not found, so it cannot pass by accident. The test is narrower than before, not a new handler rule. The ui packet still needs to decide whether the pane's Escape handler should move to `on()` from `svelte/events` for consistency; this packet does not require it.
26. **PRO-081 criterion 1 ticked on a hand-written JSON Schema (proposed).** `packages/element/src/config.schema.json` is written by hand and checked against `DocEditorConfig` in `src/config.ts` by `packages/element/test/config.test.ts`: same key set, a description for each key, defaults and enum values that match `normaliseConfig`. It is not generated, and `packages/element/package.json` does not export it. Whether and how the schema is published (an export path, a generator, or a file in `spec/`) is the owner's call. Until then "published" means the file ships in the package's `src`.
27. **PRO-090 criterion 4 and FE-006 criterion 3 stay open.** `destroy()` calls `session.close({ closeBackend: true })`, and the session tests count one backend close for two calls. An element-level count of `backend.close()` needs a DOM (`DocEditorElement` extends `HTMLElement`), which the Node tests do not have. FE-006 criterion 3 also covers listeners, observers and IndexedDB handles, which no Node test can see.
28. **PRO-081 criterion 1: the schema is published through the package's exports (round 7 fix, proposed; replaces the last sentence of item 26).** The review found that item 26 redefined "published" as "ships in `src`", which no consumer can reach. `packages/element/package.json` now maps `./config.schema.json` to `./src/config.schema.json`, beside `.` (whose types include `DocEditorConfig`). `packages/element/test/config.test.ts` resolves both specifiers through Node.js's resolver and the exports map, checks that an unlisted path is refused, and runs the key checks on the schema reached that way. The schema stays hand-written and checked against the type. Alternatives the owner may choose instead: a generator from `src/config.ts`, or a copy under `spec/`. The distributable in `dist/lib` does not carry the schema yet.

## Round 8 decisions (FE-007, FE-012, PRO-083) (status: proposed, 2026-11-13)

29. **FE-007 criterion 3 ticked; item 3 is superseded.** A server `read_only` answer to a commit reaches the element as `readonly` through the core's save state. `packages/element/test/save-state.test.ts` locks the document on backend-mock while a commit is held, so the room refuses the commit, and checks the session's save state. The rights case was already tested in `session.test.ts`.
30. **PRO-083 criteria 1 and 3 ticked (flush over a live session).** `packages/element/test/flush.test.ts` runs `flush({ timeoutMs })` through the element's own methods, with a session on backend-mock. Criterion 2 stays open: the rejection and its count are tested on a core with no channel, but the work is not in the journal (FE-008, not built).
31. **Count of unconfirmed commits: a defect for the engine's owner, not decided here.** Spec 04 §8 and PRO-083 say `flush` rejects with "the number of unconfirmed commits". `packages/engine/src/core.ts` (`flush`) computes `(inflight ? 1 : 0) + (queue.length ? 1 : 0)`, so a queue of several steps that the sync client would send as several commits reports 1. The element's test pins only the one-commit case. The spec default is the commit count the sync client would send (the cut in `sync/state.ts`); the change belongs in `packages/engine`.
32. **Shared test host.** `packages/element/test/core-host.ts` is the session host over the headless core (`src/editor.ts` without the shell), used by the element's tests against backend-mock. It is a test helper only and is not exported from `src`.
33. **Not run in this round.** The Playwright suites of FE-005, FE-006 and FE-122 were not run now (no browser run in this packet). Their evidence lines are from earlier runs and their criteria stay as they were.
