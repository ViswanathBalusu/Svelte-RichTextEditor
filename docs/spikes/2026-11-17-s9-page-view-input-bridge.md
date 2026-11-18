# Spike S9: the page view's input bridge and screen-reader plan

**Date:** 2026-11-17 (lane w9). **Story:** SPK-022. **Spec:** 11 §2 (S9), §9 risk 3; 02 §9.6, §10; ADR 0005. **Decision record:** [ADR 0380](../adr/0380-w9-SPK-022-page-view-input-bridge.md) (proposed).
**Why now:** the owner chose the full editable page view on 2026-11-17 ([decision 26](../owner-decisions-2026-11-15.md)); SPK-013 says S9 runs before any page-view input work.

## 1. Results in short

- A bridge prototype exists and runs on the project's own pieces: a first-fit layout tree (`@docedit/layout`), the painter (`paintTree`, `paintSelection`) and the layout tree's hit test and movement functions. The bridge is a one-line `<textarea>` in an open shadow root. It holds the text of the current block around the caret, placed so that its caret is on the painted caret. Each `input` event becomes one text step on the document; the pages are laid out and painted again.
- The bridge caret and the painted caret were at the same place (within 0.04 CSS px, tolerance 1.5) in Chromium, Edge, Firefox and WebKit, at seven positions on three pages, after typing a line that wrapped, and during an open composition in Chromium and Edge.
- Movement by line, page, Home, End, Ctrl+Home, Ctrl+End, left and right, and a click, come from the layout tree and the block order. The same functions run in Node.js with no DOM (`test/s9-bridge.test.ts`). The bridge never sees those keys.
- Japanese, Chinese, Korean and a dead key reach the document in Chromium and Edge (open compositions through the DevTools protocol), and committed compositions in Firefox. WebKit cannot be driven. **No operating-system input-method window was seen**, so the first criterion of SPK-022 is not met.
- EditContext is present in Chromium and Edge 158 and absent in Firefox 159 and WebKit 27.2. In Chromium it reports the composition, the text range it replaces and the committed text, and it takes the bounds of the control and the selection. It would be a second input pipeline and is not needed for the first release (ADR 0380).
- `window.find` on the painted pages finds each painted match once in every engine that can see into the page. In Chromium and Edge it also finds the bridge's copy of the current block, so a term in the current block is found twice, in the opacity-hidden bridge and in a clipped one. This is a finding against the bridge design; section 6 lists the options.
- **Not done:** a screen reader on any platform, an operating-system input method, the browser's find bar, Safari, Android and iOS keyboards. The plan for screen readers (section 5) is written but untested.

## 2. What was built

| Path | What |
|---|---|
| `packages/perf/src/s9/doc.ts` | The stand-in document: blocks of text and a text step; `diffStep` turns a before and after text into one step |
| `packages/perf/src/s9/bridge.ts` | `projectBlock` (a window of the block around the caret) and `BridgeSession` (the bridge's text and caret to document steps; a composition is a series of steps) |
| `packages/perf/src/s9/navigate.ts` | `navigate`: Up, Down, PageUp, PageDown, Home, End, Left, Right, Ctrl+Home, Ctrl+End, from `moveVertical`, `movePage`, `lineBounds` of `@docedit/layout` and the block order |
| `packages/perf/src/s9/layout.ts` | A first-fit layout of the spike document into the layout tree. Only for the prototype |
| `packages/perf/src/browser/s9-page.ts`, `pages/s9.html` | The page: shadow root, painter, caret, bridge, hit test, and the probes for EditContext and `window.find` |
| `packages/perf/e2e/s9.spec.ts` | The matrix below; results in `packages/perf/test-results/s9/<project>.json` (not committed) |
| `packages/perf/test/s9-bridge.test.ts` | 13 Node.js tests, one a fast-check property: any series of edits of the bridge text leaves the block equal to the bridge text |

The prototype does not do: Enter (a new block), Backspace and Delete across the edge of the window or the block, selections made with Shift, remote commits arriving during a composition (S1 found that Chromium duplicates the composing text when the text node under a composition changes, and defers such commits; the same deferral applies here, in the layer that owns the bridge), and anything but body paragraphs.

## 3. How it was run

Windows 11 Pro 10.0.26300, Intel Core i9-10900KF (20 logical processors), 128 GB; Node.js 22.18.0; Playwright 1.65.0; Chromium and Edge 158.0.8127.18, Firefox 159.0, WebKit 27.2 (Playwright's Windows build, not Safari). These are current versions, not the minimum versions of 02 §12. Run of 2026-11-17: `DOCEDIT_PERF_PORT=4829 pnpm exec playwright test -c packages/perf/playwright.config.ts s9 --project=<name>` for each of `chromium`, `msedge`, `firefox`, `webkit`: 7 tests passed in each. Node.js: `pnpm exec vitest run --project node packages/perf/test/s9-bridge.test.ts`, 13 passed.

## 4. Results

### 4.1 Composition and the bridge's place (criterion 1, partly)

| | Chromium, Edge | Firefox | WebKit |
|---|---|---|---|
| Driver | `Input.imeSetComposition` (open composition with updates), `Input.insertText` (commit), `Input.dispatchKeyEvent` (dead key) | `keyboard.insertText`: a composition committed in one step | `keyboard.insertText`, `keyboard.type`: plain text |
| Japanese `k`, `か`, `かn`, `かな` then `仮名` | passes | one-step only | not drivable |
| Chinese `n`, `ni`, `nihao` then `你好` | passes | one-step only | not drivable |
| Korean `ㅎ`, `하`, `한` then `한` | passes | one-step only | not drivable |
| Dead key then `é` | passes | one-step `é` | not drivable |
| Painted text shows the composing text while it is open | yes | not testable | not testable |
| Bridge caret on painted caret during the composition | 0 px apart | n/a | n/a |
| Bridge caret on painted caret after, in the same place as typing | yes | yes | yes |
| Largest distance, 7 positions, across 3 pages and after typing a wrapping line | 0.03 px | 0.00005 px | 0.03 px |

The distance is from the bridge's caret to the painted caret box. The bridge's caret is found by the browser's own width of the text before it in a mirror element, so it checks the placement the bridge computes with canvas widths. It does not show where an input-method window opens: on Windows that is the operating system's, and the DevTools protocol bypasses it (as S1 recorded). The criterion needs a person with Microsoft IME, Pinyin and Korean IME, Kotoeri, and Gboard, in each browser (section 7).

How the bridge stays still: it is never given a new value while a composition is open (`BridgeSession.isComposing`); it is only moved. It is projected again (a new value, a new caret) when the caret moves by a key or a click, which cannot happen during a composition because those keys are not handled while one is open.

### 4.2 Navigation from the layout tree (criterion 2)

`navigate` takes the layout tree, the document's block order and a goal x, and returns a position. It has no DOM argument and the Node.js tests run it with none: down through four paragraphs and three pages to the last line and back up to the first with the goal x of the first move kept; Home and End on a wrapped line stay on that line; PageDown lands on the next page at the height of the caret; left and right cross blocks, an empty block included; a click is `hitTest`. In the browsers (`e2e/s9.spec.ts`, movement test): after each of Home, End, ArrowDown twice, PageDown, PageUp, ArrowUp, Ctrl+End, Ctrl+Home the bridge was projected again and its caret was on the painted caret; the text did not change. The functions are `FE-096` and `FE-097`'s, so FE-098 needs no new movement code, only this wiring.

### 4.3 EditContext (criterion 4)

Feature test in the page, then, in Chromium and Edge, a `div` with an `EditContext` focused and driven with the same DevTools commands.

| | Chromium, Edge 158 | Firefox 159 | WebKit 27.2 |
|---|---|---|---|
| `'EditContext' in window` | yes | no | no |

Events for `か`, `かな`, commit `仮名`, in the order they came: `compositionstart`; `textupdate` (`か`, range 2 to 2); `textformatupdate`; `characterboundsupdate`; `textupdate` (`かな`, range 2 to 3); `textformatupdate`; `characterboundsupdate`; `textupdate` (`仮名`, range 2 to 4); `textformatupdate`; `compositionend`. The `EditContext`'s own text ended as `ab仮名`. `updateControlBounds` and `updateSelectionBounds` were accepted; the browser asks for character bounds (`characterboundsupdate`) while composing, which is how a page that uses it tells the browser where the composed characters are.

What it would change: no hidden element, no placing of one; the page would give the browser the text, selection and bounds, and take `textupdate`. What stands against it now: it is a second input pipeline beside the one the web view's ProseMirror uses (02 §9.6), two of the four supported engines lack it, so the textarea bridge stays as the path for those anyway, and no result here shows a screen reader or an input method using it. It is evaluated, not adopted: ADR 0380 keeps it as an option to revisit once Firefox and WebKit ship it. The ADR 0005 condition (EditContext in all supported browsers) is not met.

### 4.4 Find (criterion 5, partly)

`window.find` called repeatedly for `omicron`, which occurs 8 times in the painted pages and twice in the current block, with the caret in that block. This is the page's own find, not the browser's find bar, which Playwright cannot drive; the results show what the page's text offers to a search, not what the bar does with it.

| Mount | Chromium, Edge | Firefox | WebKit |
|---|---|---|---|
| Open shadow root, bridge hidden with `opacity: 0` | 10: 8 painted, 2 in the bridge | 8 painted, 0 in the bridge | 0 (does not search the shadow root) |
| Light DOM, `opacity: 0` | 10: 8 painted, 2 in the bridge | 8, 0 | 10: 8 painted, 2 in the bridge |
| Light DOM, `clip-path: inset(50%)` | 10: 8, 2 | 8, 0 | 10: 8, 2 |

So: the painted lines are real text and are found (the point of ADR 0005), once each. A bridge holding the current block gives a second hit for every term in that block in Chromium, Edge and WebKit. WebKit's `window.find` does not search the shadow root at all; whether Safari's find bar does must be checked in Safari.

## 5. Screen-reader plan (criterion 3, written, not tested)

This is a plan. No screen reader was run.

**What is read.** The painted pages are real text in absolutely positioned line boxes, so a screen reader that browses the page reads lines, not paragraphs, and in fixed-width pages with no landmarks. The plan gives the page view a parallel, visually hidden, reflowing text alternative of the document (the web view's read-only rendering, 02 §10) in the same shadow root, and sets the painted pages `aria-hidden="true"`. A reader browsing finds paragraphs, headings and lists with their ARIA list semantics (02 §10). The text alternative is the only content that the reader reads, so a term is not read twice.

**How editing works.** The bridge is the one editable element, labelled "Text input for the page", with `aria-multiline` off and a live-region announcement of the current line, block style and position ("Heading 1, line 3 of 5") on each move, written by the layout tree's knowledge of the line. Keys that move the caret are the layout tree's (section 4.2), so after a move the bridge's text is the new block; the announcement is made by the page and not left to the textarea, which would read only its own one block. Selection extents are announced by the same live region. Escape and Ctrl+F6 leave the editing surface (02 §10).

**What the plan costs.** The text alternative duplicates the document in the DOM (a rendered document twice; the read model must be updated on each commit); it would be built from the read view, so the story is FE-099's to cut. The screen-reader mode (browse or focus) switches in NVDA and JAWS change which keys reach the page, so the bridge must keep focus in the mode where keys pass through, which is a thing to test.

**To test, on each platform.** Windows: NVDA 2025 or later and JAWS in Chrome, Edge and Firefox. macOS: VoiceOver in Safari and Chrome. Linux: Orca in Firefox. Android: TalkBack in Chrome. iOS: VoiceOver in Safari. For each: read by paragraph, read the current line after a move, type and hear the character echo, hear a composition (Japanese), select by word, and find the heading by the heading shortcut. The record is what was read and what the keys did. Only Windows and the screen readers installed on this machine could be tried, and none was.

## 6. Findings that change the design

1. **The bridge is found by find.** Chromium, Edge and WebKit find the text of the bridge as well as the painted line. Options, none tested yet: (a) accept the doubles for the current block only; (b) project a window as small as the word or two around the caret, so that a term is rarely in it; (c) have the page handle find itself (a find command in the toolbar that searches the document model and scrolls to the match, and leave the browser's find bar for the web view); (d) `inert` and similar hiding make the element unfocusable and so unusable for input. Recommendation: (c) for the page view in any case, since only mounted pages are in the DOM (02 §9.5) and the browser's find cannot find text on pages that are not painted; (a) for the rest.
2. **WebKit's `window.find` does not see into the shadow root.** If Safari's find bar behaves the same, the browser's find does nothing on the page view in Safari. (c) covers it.
3. **The bridge's `input` events are one step per event.** A composition is a series of steps each replacing the last. That is correct for a single user but writes a commit for every update to the sync client unless steps are kept local until `compositionend`. FE-033 (the stand-in remote path) already holds unconfirmed steps; the choice is the owner of FE-098's.
4. **A window of the block, not the block.** `projectBlock`'s radius (200 characters here) bounds the element's size. Backspace at the window's edge needs a character of context; FE-098 must keep one before and one after the caret.

## 7. Not run

- [ ] Operating-system input methods, with the candidate window position: Microsoft IME (Japanese), Microsoft Pinyin and Korean IME in Chrome, Edge and Firefox on Windows; Kotoeri, Pinyin and 2-Set Korean in Safari 17 and Chrome on macOS.
- [ ] Android (Gboard, Samsung Keyboard) and iOS keyboards: autocorrect, swipe, dictation, in the bridge.
- [ ] Safari 17 and later (WebKit on Windows is not Safari), and the minimum versions of 02 §12.
- [ ] A screen reader on each platform (section 5).
- [ ] The browser's find bar in each browser, in headed mode.
- [ ] Remote commits arriving while a composition is open, with the bridge.
- [ ] Enter, Backspace across blocks, Shift selection, a table cell, a footnote or header story as the current block.

## 8. Acceptance criteria of SPK-022

| Criterion | State |
|---|---|
| 1. Bridge prototype; input-method windows at the caret in every supported browser | Prototype built and driven; caret placement shown; windows not seen. Open |
| 2. Navigation from the layout tree, not the DOM | Met (section 4.2) |
| 3. Screen-reader plan tested with one screen reader per platform | Plan written; no screen reader run. Open |
| 4. EditContext evaluated, not assumed | Met (section 4.3) |
| 5. Find-in-page behaviour recorded | `window.find` recorded; the find bar not driven. Open |
