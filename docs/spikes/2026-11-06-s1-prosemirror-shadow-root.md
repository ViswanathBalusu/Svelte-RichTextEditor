# Spike S1: ProseMirror inside the open shadow root of `<doc-editor>`

**Date:** 2026-11-06. **Story:** SPK-014. **Spec:** 02 §2, §3, §5.2, §8, §12, §14; 03 §3, §4.4, §9, §13; ADR 0002, 0003, 0018.
**Prepares:** FE-004, FE-005, FE-006, FE-013, FE-030, FE-031, FE-032, FE-033, FE-034, FE-056, FE-057, FE-058, FE-066, FE-116, FE-117, FE-121, FE-122, FE-123; evidence for CDM-001.

Every result below comes from a test in this repository. The run that the counts come from is described in section 3; the measurements are listed per test in `packages/element/test-results/evidence/` after a run (not committed: it is under `test-results/`).

## 1. Results in short

- ProseMirror 1.42.9 edits correctly inside the element's open shadow root in Chromium, Edge, Firefox and WebKit: typing, keyboard and mouse selection, deletion, Enter, undo, select all, and two sub-editors (a footnote and a header) whose steps are mapped onto the one document.
- The schema rules of 03 hold in the browser and in Node.js. Definitions and stories are not rendered, cannot be selected, and are reached neither by "select all", nor by the start and end commands, nor by Backspace, nor by a DOM selection placed on their hidden wrappers. Null identifiers are filled in the same state update, and the first half of a split keeps its identifier (ADR 0018).
- Japanese, Chinese and Korean composition and dead keys pass in Chromium and Edge, driven through the DevTools protocol, in the body and in both sub-editors, with remote commits arriving while the composition is open, in two sync modes. Firefox can be driven only with compositions committed in one step; WebKit cannot be driven at all. Mobile keyboards were not run (section 6).
- **Finding 1.** A remote commit that inserts into the DOM text node holding an open composition makes Chromium and Edge keep the uncommitted text and start a new composition, so the text ends up twice (`…«R»か仮名` instead of `…«R»仮名`). The editing core now defers such commits until the composition ends; with the deferral every composition case passes.
- **Finding 2.** ProseMirror's shadow-root selection patch happens in WebKit as well as in Firefox (02 §8 names Firefox only). It defines `getSelection` on `ShadowRoot.prototype` for the whole host page. A per-instance method avoids it; the element uses that by default.
- **Finding 3.** `prosemirror-dropcursor` appends its element to the view's `offsetParent`. With the containment on `:host`, that is `<doc-editor>` itself, so the drop cursor landed unslotted, and invisible, in the host page's light DOM. A positioned page surface keeps it in the shadow root.
- **Footnote content model:** the evidence favours option B of 03 §13 (`paragraph+`, limited to one paragraph), with two follow-ups (section 5).

## 2. What was built (code meant to be kept)

| Path | What |
|---|---|
| `packages/engine/src/core.ts` | `EditorCore`: owns the editor state, mounts the body view and the sub-editor views, named commands, small read-only views for the interface (02 §4), the stand-in remote path and the composition deferral |
| `packages/engine/src/schema.ts` | The editing schema: `buildSchema` from `@docedit/model/prosemirror` with rendering hooks only (`toDOM`, `parseDOM`, `leafText`) for paragraphs and headings by style, regions with a visible title, text marks, footnotes, fields; definitions and stories render as empty hidden wrappers; no `style` attribute is ever produced; parse rules never read identifiers. Also the footnote option B definition (`definitionFor('paragraph')`) |
| `packages/engine/src/ids.ts` | The identifier plugin (03 §9; ADR 0018) |
| `packages/engine/src/body.ts` | `BodySelection` ("select all" limited to the body), body start and end commands, Backspace and Delete at the body edges, the body guard (selection hook and clamping), `initialSelection` |
| `packages/engine/src/subeditor.ts` | Sub-editors: an `EditorView` whose document is the footnote or story node; local steps are offset onto the main document, main changes are diffed back |
| `packages/engine/src/footnote.ts` | Footnote reference node view, numbering decorations (`data-n`, shown by CSS), insert command, option B's one-paragraph limit |
| `packages/engine/src/remote.ts` | Stand-in for the sync client of FE-033: unconfirmed steps, `map` and `rebase` application of remote commits |
| `packages/engine/src/view-support.ts` | CSSOM mark views (colour, size, family after a grammar check) and the shadow-root selection shim |
| `packages/engine/src/read-value.ts` | Read-only views with at most one notification per animation frame |
| `packages/engine/src/testing.ts`, `spike-document.ts` | Spike instrumentation driven by Playwright, and the spike document (03 §12 plus a header story, a footnote and a field) |
| `packages/engine/src/core.test.ts` | 16 Node.js tests (FE-121) |
| `packages/ui/src/App.svelte`, `live.ts`, `core-api.ts`, `panes/OutlinePane.svelte` | The shell for the spike. `ui` sees the core only through `CoreApi`; `live()` wraps a read-only view with `createSubscriber`; no `prosemirror-*` import (dependency-cruiser passes) |
| `packages/element/src/doc-editor.ts`, `index.ts` | The hand-written element: open root without `delegatesFocus`, properties captured before upgrade, `mount()` of the Svelte application in a microtask once connected and given a document, `connectedMoveCallback`, suspend one microtask after disconnect, destroy after the grace period (default 30 s) unless `keep-alive`, `destroy()` with `unmount`; registration with a version check; importable without a DOM |
| `packages/element/src/styles.ts`, `styles/element.css` | One shared constructable stylesheet; the nonce `<style>` fallback (spike S2) |
| `packages/element/demo/` | Demo pages, the Vite builds and a Node.js server (spike S2 describes it) |
| `packages/element/playwright.config.ts`, `packages/element/e2e/s1-*.spec.ts` | The S1 matrix (section 3) |

## 3. How it was tested

**Machine and browsers.** Windows 11 Pro 10.0.26300, Node.js 22.18.0, Playwright 1.65.0: Chromium 158.0.8127.18 (Playwright build), Microsoft Edge 156.0.4314.58 (installed, `msedge` channel), Firefox 159.0 (Playwright build), WebKit 27.2 (Playwright's Windows build). These are current versions, not the minimum versions of 02 §12 (Chrome and Edge 137, Firefox 142, Safari 17), and WebKit on Windows is not Safari.

**Libraries.** prosemirror-view 1.42.9, -state 1.4.4, -model 1.25.12, -transform 1.12.5, -commands 1.7.2, -history 1.5.1, -keymap 1.2.3, -gapcursor 1.4.1, -dropcursor 1.8.4; Svelte 5.57.3 compiled with `fragments: "tree"`; Vite 8.3.6.

**Commands.** `node demo/build.ts && node demo/serve.ts` (the Playwright web server does both), then `pnpm exec playwright test -c packages/element/playwright.config.ts`; unit tests with `vitest run --project node packages/engine`.

**Final run.** The counts per spec file are in the table below, from the last complete run of the suite (S1 and S2 together; S2 has its own report). One retry is allowed for browser launch failures; a test that passes only on retry is reported as flaky.

Run of 2026-11-06 at 15:40 UTC, 4 workers, 174.8 s in total: 632 passed, 0 failed, 0 flaky, 452 skipped. Per spec file:

| Spec | Chromium | Edge | Firefox | WebKit |
|---|---|---|---|---|
| `s1-shadow-root.spec.ts` | 9 passed | 9 passed | 9 passed | 9 passed |
| `s1-composition.spec.ts` | 120 passed, 81 skipped | 120 passed, 81 skipped | 108 passed, 93 skipped | 6 passed, 195 skipped |
| `s1-input-drivers.spec.ts` | 3 passed, 1 skipped | 3 passed, 1 skipped | 4 passed | 4 passed |
| `s1-getselection.spec.ts` | 2 passed | 2 passed | 2 passed | 2 passed |
| `s1-footnote-model.spec.ts` | 12 passed | 12 passed | 12 passed | 12 passed |
| `s2-*.spec.ts` (S2 report) | 43 passed | 43 passed | 43 passed | 43 passed |

Node.js: `packages/engine/src/core.test.ts`, 16 passed.

Skips are by design: the DevTools-protocol cases run only in Chromium and Edge, the one-step composition cases only in Firefox.

## 4. Results

### 4.1 Element and shadow root (`s1-shadow-root.spec.ts`)

- The shadow root is open, `delegatesFocus` is false, the Svelte shell is mounted into it with `mount()`, the body view's DOM is inside it and the light DOM has no children. Playwright's locators reach the editor without configuration. All four browsers.
- Removing the element and inserting it again in the same task keeps the same editing core (identity checked); the element is neither suspended nor remounted. Removed and left out, it is suspended after one microtask and unmounted after the grace period (300 ms in the test): the shadow root is then empty. With `keep-alive` it stays suspended past the grace period and resumes on reconnection. Listener re-attachment and the channel (FE-005) do not exist yet.

### 4.2 Typing, selection and deletion

Typing at the end of a paragraph, keyboard selection (Home, then Shift+ArrowRight six times) replaced by typing, Backspace, Delete, a mouse double-click that selects a word, and a selection across two paragraphs deleted with Delete (the paragraphs join): all pass in all four browsers. ProseMirror reads native selection changes on `selectionchange`, which browsers dispatch in a later task, so the tests wait for the model to catch up after a key press; Chromium and Edge showed the stale value when read at once.

### 4.3 Schema rules (03 §3, §9)

- **Definitions and stories.** `defs` and `story` render without a content hole: empty wrappers with `hidden` and `contenteditable="false"`; the header text does not appear in the body view. `NodeSelection.isSelectable` is false for `defs`, `story` and the definition nodes (Node.js).
- **Initial selection.** ProseMirror's default, `Selection.atStart(doc)`, lands in the first header story, which is hidden: typing would go there. The core starts at the body's first text position (Node.js test).
- **Select all.** `Mod-a` selects the body only (`BodySelection`, from the first to the last position inside `body`), also when the caret is inside a region. Deleting it leaves one empty paragraph; typing over it replaces the body; the definitions and the story are unchanged byte for byte. All four browsers and Node.js.
- **Start, end, arrows.** Ctrl+Home and Ctrl+End go to the first and last body positions; ArrowUp, ArrowLeft, Home and PageUp at the start and ArrowDown, ArrowRight, End and PageDown at the end leave the selection in the body. All four browsers.
- **Backspace at the first body position.** Without the core's binding, `prosemirror-commands`' `joinBackward` on an empty first body paragraph deletes it and puts the caret at the end of the header story (Node.js test on a plain state). The core consumes Backspace there, and Delete at the last body position. Nothing outside the body changes (browser tests).
- **DOM selection on hidden wrappers.** A DOM selection set by script at offset 0 of the editing surface, before the hidden `defs` wrapper, is clamped into the body by the view's selection hook (`createSelectionBetween`) and the body guard; typing goes into the body. All four browsers.
- **Identifiers.** `id` defaults to null for every node type that declares one. The plugin fills null identifiers in the same `state.apply` call as the change (an appended transaction, which history groups with the change), so no state that the view, the history or the queue sees has a null `id`. A split in the middle keeps the identifier in the first half; Enter at the start gives the fresh identifier to the new empty paragraph; Enter at the end gives it to the new paragraph; a pasted copy gets a fresh one, also when placed before the original; remote transactions are left alone; `validate()` reports no violation after each case (Node.js and all four browsers).

### 4.4 Composition and dead keys (`s1-composition.spec.ts`, `s1-input-drivers.spec.ts`)

What Playwright 1.65 can drive, per browser (recorded and asserted in `s1-input-drivers.spec.ts`):

| | Open composition with updates | One-step composition | Dead key |
|---|---|---|---|
| Chromium, Edge | Yes: DevTools `Input.imeSetComposition`, committed with `Input.insertText` | `Input.insertText` without an open composition inserts plain text | DevTools `Input.dispatchKeyEvent` (`key: "Dead"`, then the composed character); `keyboard.press('Dead')` throws `Unknown key: "Dead"` |
| Firefox | No: Juggler has no command (`Page.setComposition`, `Page.imeSetComposition` and `Input.imeSetComposition` are "not supported") | Yes: `keyboard.insertText` is implemented with `nsITextInputProcessor.commitCompositionWith`, which fires compositionstart, compositionupdate and compositionend. `keyboard.type` of a character outside the US layout does the same | No (`Unknown key: "Dead"`) |
| WebKit | No (`'Page.setComposition' was not found`; the `Input` domain does not exist on the page session) | No: `keyboard.insertText` inserts plain text | No (`Unknown key: "Dead"`) |

The cases: Japanese (`k`, `か`, `かn`, `かな`, committed as `仮名`), Chinese (`n` to `nihao`, committed as `你好`), Korean (two syllables composed one after the other, `한` and `국`), a Windows-style dead key (`key: "Dead"` with no text, then `é` as text) and a macOS-style one (`´` as marked text, committed as `é`). Each runs in the body, in the footnote sub-editor and in the header sub-editor. Remote variants: none; another paragraph after and before; the same paragraph before the caret; the same text node between earlier characters; the same paragraph exactly where the composition started; a new paragraph inserted before; and, in the sub-editors, a body paragraph and the footnote or header text itself. Each remote variant runs in `map` and `rebase` mode. A case passes when the final text is exactly the original text plus the committed text, the remote text appears once, the composition started and ended once per composed run (no cancellation), the remote commit arrived while `view.composing` was true, and `validate()` reports nothing.

Results with the deferral of section 4.5: every DevTools case passes in Chromium and Edge, every one-step case passes in Firefox, including the option B footnote cases (section 5). In WebKit only the keystroke case below can run.

A keystroke and a remote commit in the same frame (the remote commit applied from the `keydown` listener): the keystroke is neither lost nor reordered, in the body and both sub-editors, both modes, all four browsers.

### 4.5 Remote commits during composition: Finding 1 and the deferral

Without the deferral (the demo's `defer=0`), in Chromium and Edge, a remote insert into the text node that already holds the composition (between earlier characters of the composing paragraph, or exactly where the composition started) makes ProseMirror redraw that node; the browser drops the composition, the uncommitted text stays in the document, and the next update starts a new composition. Final text in the body: `Remote «R»target paragraph.か仮名`; in the footnote: `Foot«R»note textか仮名`; the same in both modes. The event log shows a second `compositionstart` without a `compositionend` before it. In the header, where the composition follows the page field, an insert right before the composition is safe: `Header text 1«R»仮名`. Inserts at the start of the composing paragraph were also safe without the deferral (they passed before the deferral existed). Reading prosemirror-view's `localCompositionInfo` explains both: ProseMirror keeps a composition's DOM node when it can find that node's whole text in the new content, or when the node is a new one it does not render itself (the header case, where the browser creates a text node after the field); an insert inside the node's text defeats the first condition. These cases are kept as tests that pin the behaviour (`without the deferral: …`): if they start failing, ProseMirror or Chromium changed.

The workaround, in `EditorCore.applyRemote`: while a composition is open, a remote commit that would change the block being composed (the body paragraph, or the whole footnote or story node of the open sub-editor) is deferred and applied in the task after `compositionend`; while one is deferred, later remote commits queue behind it so their order is kept. Deferred commits in `rebase` mode are rebuilt from the confirmed document as usual; in `map` mode they are mapped through the local changes made meanwhile. The tests assert that exactly the commits touching the composing block were deferred. The cost: a colleague's change to the paragraph being composed appears only when the composition ends (how long that is was not measured). The real sync client (SYN-017, SYN-018; FE-033, FE-034) must apply the same rule; this spike does not decide its algorithm. Not tested: a remote commit that deletes the paragraph being composed (FE-034 notes leave it open).

### 4.6 Sub-editors (FE-056)

The sub-editor's document is the footnote or story node. Local transactions are applied to its own state at once and forwarded to the main state with every step offset by the node's position (`StepMap.offset`); the identifier plugin, the pending-step tracker and the history of the main state see them as local edits. Every main state change is diffed against the sub-editor's document (`findDiffStart`, `findDiffEnd`, as in ProseMirror's footnote example) and the difference applied with `addToHistory: false`, so remote commits and identifier fills appear in it. The node is followed through every mapping and, if that fails, by identifier. In the browser: typing in the footnote and header panels updates the main document; a remote commit into the open footnote appears in the panel and typing continues after it (both models); composition and remote commits behave as in section 4.4. The sub-editors have no undo history of their own in the spike: whether the body and the sub-editors share one is open (FE-056 notes).

### 4.7 The `getSelection` patch and the host page (02 §8; `s1-getselection.spec.ts`)

prosemirror-view 1.42.9 finds its root in `EditorView.root`; when the root is a shadow root without `getSelection`, it runs `Object.getPrototypeOf(root).getSelection = () => root.ownerDocument.getSelection()`. Measured with a shadow root that belongs to the host page:

| | Before the editor | After, with ProseMirror's own behaviour | After, with the element's shim (default) |
|---|---|---|---|
| Chromium 158, Edge 156 | `ShadowRoot.prototype.getSelection` is native | unchanged, nothing patched | unchanged |
| Firefox 159, WebKit 27.2 | absent | `ShadowRoot.prototype` has an own, enumerable, non-native `getSelection`; the host page's own shadow root now has `getSelection()`, and it returns `document.getSelection()` | `ShadowRoot.prototype` untouched; the host's shadow root has no `getSelection`; only the editor's root has an own one |

Side effects of the patch on the host page: every shadow root in the document gains a `getSelection` method; host code or another library that detects the Chromium-only `shadowRoot.getSelection` takes its Chromium path in Firefox and Safari and receives the document's selection instead of a shadow-tree one; the function ignores the root it is called on; and the property is enumerable, so it shows up when the prototype is enumerated. The shim (`shimShadowSelection` in `view-support.ts`) defines the same function on the editor's own shadow root before ProseMirror looks, so the prototype is never touched; all S1 tests run with it. FE-117's list of side effects should keep the patch only for hosts that set `selectionShim: 'library'`.

### 4.8 The drop cursor

`prosemirror-dropcursor` 1.8.4 appends its element to `view.dom.offsetParent`. `:host { contain: content }` made `<doc-editor>` that offset parent, so the cursor was appended to the host element's light DOM, outside any slot: not rendered, and a node in the host's tree (recorded in Chromium before the fix: parent `doc-editor`, computed `position` empty). `.de-page { position: relative }` makes the page surface the offset parent; afterwards the cursor is inside the shadow root and rendered as `position: absolute` in all four browsers (`s2-styles.spec.ts`).

## 5. Footnote content model: evidence for CDM-001 (03 §13)

Both options were prototyped in the footnote sub-editor without changing `packages/model`: option A is the draft (`note_inline*`); option B is `paragraph+` (`definitionFor('paragraph')`) with the one-paragraph limit enforced by a `filterTransaction` in the sub-editor (`s1-footnote-model.spec.ts`, all four browsers, and the option B composition cases).

| Check | A: `note_inline*` | B: `paragraph+`, limit one |
|---|---|---|
| Typing, remote commit into the open footnote | Works | Works |
| Composition with remote commits (Chromium, Edge, Firefox) | Works with the deferral | Works with the deferral |
| Enter | Consumed by the core: nothing to split | Split refused by the limit: nothing happens |
| Shift+Enter at the end, then typing | **Wrong in every browser.** Chromium, Edge and WebKit put the typed text before the break (`Footnote text moreline two` + break); Firefox loses the break. The cause, from reading prosemirror-view: the sub-editor's root is the footnote itself, an inline node and so not a textblock, and ProseMirror adds its trailing-break workaround only to textblocks | Correct in every browser: text, break, `line two` |
| Pasting two paragraphs into the footnote | Flattened into one run (`Footnote textOneTwo`): the boundary is lost | Refused whole by the limit: nothing changes |
| Pasting content that contains a footnote into the footnote | The schema drops the nested footnote, including its text (`Footnote textxy`) | A footnote is created inside the footnote, and `model.validate()` does not refuse it: today I10's "no footnote inside a footnote" rests on the content expression `note_inline*` |
| Copy and paste of body text containing the footnote, through ProseMirror's HTML clipboard | The copy keeps its content | **The copy's content is lost:** `<span data-footnote><p>…</p></span>` inside `<p>` does not survive the HTML parser; the footnote is refilled empty and its text becomes a body paragraph |
| Identifiers | Only the footnote has an `id` | The footnote's paragraph has one too (I2); the main identifier plugin fills it, through the sub-editor's forwarded steps (inserting a new footnote: `validate()` passes) |
| Word files (A2, ADR 0017) | One paragraph only; a Word footnote with several paragraphs needs the preservation layer or flattening | Same in version 1 because of the limit; lifting the limit later needs no new CDM major version (03 §13) |

**Recommendation for CDM-001: option B**, `paragraph+` limited to one paragraph in version 1, because the editing defect of option A (the line break) is structural, not a browser bug: any fix for A gives the sub-editor a textblock to edit, which is what B is. B needs two things before `cdm: 1` is frozen, both owned elsewhere:

1. I10 must be enforced explicitly: `model.validate()` must refuse a footnote inside a footnote (and the guard must refuse to create one), since `paragraph`'s `inline*` admits it. An alternative that keeps I10 in the content expression is a dedicated paragraph-like type with `note_inline*` content; it was not prototyped and changes the "paragraph" in 03 §13, so it is only an option for CDM-001 to weigh.
2. Copying footnotes must not rely on HTML structure: the embedded CDM fragment of 02 §5.2 (FE-050, FE-051) carries them; the HTML serialisation of a footnote, which other applications read, needs its own shape (for example its paragraphs serialised as inline spans), decided in FE-050.

This is evidence and a recommendation; the decision belongs to CDM-001.

## 6. Not automated: manual checklist

None of these ran. They stay open for FE-123's scripted manual pass.

- [ ] Android, Chrome, Gboard: Japanese (romaji and kana), Chinese pinyin, Korean; autocorrect and suggestion replacement; swipe typing; Backspace through a composition; a remote commit during composition, in the body and in the footnote and header panels.
- [ ] Android, Chrome, Samsung Keyboard: the same.
- [ ] iOS 17 (the minimum of 02 §12) and current iOS, Safari: Japanese (romaji and kana), Chinese pinyin, Korean; QuickType replacement; dictation; the same remote cases. 02 §12 places light mobile editing in phase 4 (FE-114, FE-115).
- [ ] Desktop operating-system input methods, which the DevTools protocol bypasses: Microsoft IME Japanese, Microsoft Pinyin and Microsoft Korean IME in Chrome, Edge and Firefox on Windows; Kotoeri, Pinyin and 2-Set Korean in Safari 17 and Chrome on macOS; candidate window position at the caret inside the shadow root.
- [ ] Dead keys on real layouts: US-International on Windows and Option sequences on macOS, in every browser, including Firefox and Safari, which cannot be driven.
- [ ] Composition in WebKit or Safari with remote commits arriving (no driver exists).
- [ ] The minimum versions of 02 §12 (Chrome and Edge 137, Firefox 142, Safari 17), where the matrix ran only on current versions.

## 7. Failures found, with workarounds

| Failure | Where | Workaround (in the code) |
|---|---|---|
| A remote insert into the text node of an open composition duplicates the uncommitted text | Chromium, Edge (body and footnote) | Defer remote commits that change the composing block until `compositionend` (`EditorCore.applyRemote`; FE-034) |
| `Selection.atStart` puts the initial caret in the hidden header story | All (model behaviour) | `initialSelection` in the body |
| Backspace in an empty first body paragraph moves the caret into the header story | All (prosemirror-commands `joinBackward`) | `stopAtBodyEdge` bound before the base keymap |
| A DOM selection on the hidden wrappers selects outside the body | All | Body guard: `createSelectionBetween` and clamping in `appendTransaction` |
| ProseMirror patches `ShadowRoot.prototype.getSelection` for the whole page | Firefox, WebKit | Per-instance shim (`selectionShim: 'instance'`, the default) |
| The drop cursor lands in the host's light DOM, invisible | All (found in Chromium) | `.de-page { position: relative }` |
| Under option A, text typed after a line break at the end of a footnote goes before it, or the break is lost | All | Option B (section 5) |

## 8. Differences from the spec, and open questions

- **02 §8** says ProseMirror patches `ShadowRoot.prototype.getSelection` on Firefox. It does so wherever a shadow root has no `getSelection`: Firefox and WebKit (so Safari) here. FE-066 and FE-116 should say "Firefox and Safari".
- **02 §12** sets minimum versions; this matrix ran on current versions only, and on WebKit for Windows rather than Safari.
- **02 §5.2** says the fresh identifier on a split goes to the new empty part. A split in the middle has no empty part; the code follows ADR 0018 (the first half keeps it), which also matches 03 §9 at the start and end of a paragraph. "In the same transaction" is implemented as an appended transaction within the same state update.
- **The task brief** said the element unmounts on disconnect; the element follows 02 §2.1 instead (suspend after a microtask, destroy after the grace period unless `keep-alive`) and the tests check both halves.
- Kept as the spec's default, not decided: "select all" inside a region selects the whole body (02 §5.2; the conflict with 07 §7 is FE-032's open question).
- Open for their owners: whether sub-editors share the body's undo history (FE-056); what happens to a composition when a remote commit deletes its paragraph (FE-034); the footnote content model (CDM-001).

## 9. Acceptance criteria of SPK-014

| Criterion | Status |
|---|---|
| Composition, dead keys, Android and iOS keyboards on the minimum browsers pass, or failures are listed with workarounds | Not met. Chromium and Edge pass with the deferral (DevTools-driven), Firefox only with one-step commits, WebKit not drivable, mobile and operating-system input methods not run, minimum versions not run. Failures found are listed with workarounds (section 7) |
| Remote commits during composition lose or duplicate no text, in the main editor and the header and footnote sub-editors | Not met in full: met with the deferral in Chromium, Edge and (one-step) Firefox; not verified in WebKit or Safari, nor with real input methods |
| Definitions not selectable, select all limited to the body, identifiers default to null, footnote content model decided and written down | Partly met: the first three are tested in Node.js and all four browsers; the content model is written down with a recommendation, and the decision is CDM-001's |
| The side effect of the `getSelection` patch on the host page is documented | Met (section 4.7) |
| Results written up with the test matrix kept for the input matrix of 02 §14 | Met: this report and `packages/element/e2e/s1-*.spec.ts` |
