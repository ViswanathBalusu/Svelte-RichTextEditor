# 02 Frontend

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Informative, except the embedding contract, which is normative in [05 Protocol](05-protocol.md), section 8.

## 1. Scope

This document covers the `<doc-editor>` element: packaging, Shadow DOM, the Svelte user interface, the editing core, and the stages of the view. The shell, commands, panes, assistance ports and extension model are in [13](13-experience-extensibility.md); fields and fill mode are in [12](12-fields-rules-workflow.md). Decisions are recorded in [ADR 0002](../adr/0002-single-custom-element-svelte-mount.md), [ADR 0003](../adr/0003-prosemirror-core-behind-own-api.md) and [ADR 0005](../adr/0005-own-layout-engine-dom-painter.md).

## 2. Packaging

- The element is one hand-written class that extends `HTMLElement`. It is not produced by Svelte's `customElement` compiler option. That option creates the inner component one microtask after the element connects and destroys it one microtask after it disconnects, which would throw away editor state whenever a host framework moves the element.
- There are no nested custom elements of our own inside the editor. Inner pieces are ordinary Svelte components. Third-party pieces that register global custom elements (the math editor does) are loaded on demand and their tag names are documented, because they are visible to the host page.
- The distributable is an ECMAScript module built with Vite in library mode, with lazily loaded chunks for the PDF viewer, its worker, the math editor and the panes. The initial chunk has a size budget (13, section 9). The component CSS is not a separate stylesheet file: it is a string in the script chunks the editor loads with its first document, and is adopted into a constructable stylesheet (section 3; owner decision 18 of 2026-11-15, [ADR 0039](../adr/0039-element-embedding-decisions.md) §3).
- The module guards its use of `HTMLElement`, so importing it on a server does nothing. The element renders only in a browser.
- Importing the module registers `doc-editor` unless the name is taken. If it is taken by a different version of this class, the module logs a clear warning naming both versions; it never silently binds a host to an older class. The class is also exported so a host can register it under another name or in a scoped registry.

### 2.1 Lifecycle

| Callback | Behaviour |
|---|---|
| `constructor` | Attaches the shadow root and captures properties that were set before the element was upgraded, so that a framework which assigns `getToken` before the class is defined does not lose it |
| `connectedCallback` | First time: mounts the Svelte application and creates the editing core. Later times: re-attaches global listeners and resumes |
| Start of loading | Happens in a microtask once a document identifier and a token source (`getToken` or `backend`) are both present, whatever order the host set them in |
| `connectedMoveCallback` | Where the browser supports moving an element without disconnecting it, nothing happens |
| `disconnectedCallback` | Waits one microtask. If the element is still disconnected, it suspends: removes its own listeners on `document` and `window`, stops its observers and workers, and closes the socket. Two kinds of listener stay on `document` until the editor is destroyed, because neither library can take them off and put them back: the editing library's `selectionchange` listener and the UI framework's delegated-event handlers (owner decision 181 of 2026-11-15). After a grace period (default 30 seconds) it destroys itself, unless the `keep-alive` attribute is present. Garbage collection is never relied on, because workers, channels and timers keep an editor reachable |
| `attributeChangedCallback` | Reflects attributes into the application |
| `destroy()` | Unmounts Svelte, destroys the editing core, releases everything |

### 2.2 Not losing work

Unconfirmed commits and recovered edits are written to a journal in IndexedDB, keyed by commit identifier, before they are sent. If a tab closes or crashes, the next visit resubmits them with the same identifiers, which the deduplication rule makes safe (04, G4). The journal is flushed on `visibilitychange`, which is the last event browsers reliably deliver; `pagehide` is not reliable, especially on mobile, and a WebSocket cannot complete a send during it. `flush({ timeoutMs })` resolves when everything is confirmed and rejects at the timeout while the work stays in the journal. The save indicator has four states tied to this: saved, saving, unsaved (in the journal only), and read-only.

## 3. Shadow root

- The root is created with `mode: "open"` and without `delegatesFocus`. An open root is required by ProseMirror's focus handling and by testing tools. Focus is managed explicitly so that a click on the page surface focuses the editing surface and not the first toolbar button.
- **Styles.** Component CSS is compiled outside the components (Svelte's `css: "external"`), bundled as one string, loaded once into a constructable `CSSStyleSheet`, and attached with `adoptedStyleSheets`, so all instances share it. No stylesheet file is fetched, so a host needs no `style-src` or `connect-src` entry for it. Constructable stylesheets and assignments to individual `element.style` properties are not restricted by a content security policy in practice. Assigning `style.cssText` is disputed, and ProseMirror's view does it, so spike S2 must cover every dependency. Svelte's injected-style mode sets no nonce, so the fallback for browsers or policies where constructable stylesheets fail is a `<style>` element the component creates itself with a nonce from `config`.
- **Trusted Types.** Svelte 5 normally builds templates through `innerHTML` and creates its own Trusted Types policy when its module loads; a second Svelte on the page, or a host policy list that does not name it, makes that throw. The component is compiled with Svelte's `fragments: "tree"` option (5.33 or later), which builds DOM without HTML strings. ProseMirror's paste parser uses `innerHTML` under its own policy name. The math editor may need inline styles. The project publishes the exact policy names and directives a host must allow, per feature.
- **Theming.** Hosts style the component through custom properties with the prefix `--de-` (colours, fonts, radii, spacing, page background) and through parts: `header`, `toolbar`, `ruler`, `page`, `sidebar`, `statusbar`, `dialog`. Nothing else crosses the boundary. System colours are used under `forced-colors`, including for the custom caret and selection.
- **Overlays.** Menus, tooltips and dialogs live inside the shadow root and use the Popover API where available, with Floating UI for positioning. CSS anchor positioning is not relied on because cross-tree behaviour differs between browsers.
- **Fonts.** `@font-face` rules inside a shadow root are ignored by browsers, so the component registers fonts on the document with the FontFace API. That registry is global to the host page. To avoid overriding the host's fonts, or another version's, each font file is registered under an alias derived from its hash, and the editor maps a document's font family to the alias. Workers register the same aliases on their own font set. See section 6.
- **Keyboard.** Shortcuts are handled only when the event's composed path starts inside the editor, so they never fire while focus is in the host page.
- **Events.** Every event leaving the component is dispatched with `composed: true`.

## 4. Svelte integration

- The application is mounted with `mount(App, { target: shadowRoot, props })` and removed with `unmount`.
- The editing core is plain TypeScript and owns all document state. Svelte components never hold the document or the editor state in deep reactive state. The core exposes small read-only views (selection summary, active marks, current style, permissions, connection status, command state); components subscribe to them through `createSubscriber`, and any snapshot they keep is `$state.raw`.
- A transaction in the core produces at most one user-interface update per animation frame.
- Handlers whose order relative to the editing core matters are attached with `on` from `svelte/events`, not with delegated event attributes.

The inventory of the user interface (header, toolbar, panes, status bar, modes) is in 13, section 3.

## 5. Editing core

### 5.1 Document API

The user interface, extensions and host code change a document only through the document API: named commands from the command registry (13, section 4), queries (`activeMarks`, `selectionScope`, `canEdit(scope)`, `outline()`, `queryCommand`), and content operations (`getSelectionContent`, `insertContent`). ProseMirror types do not appear in this API. This boundary is what lets the core be replaced later.

### 5.2 Building blocks

| Part | Responsibility |
|---|---|
| Schema | A ProseMirror schema generated from the CDM definition in `packages/model`, published as a normative artifact. `id` attributes default to null, because ProseMirror cannot create or fill nodes that have required attributes. `defs` and `story` nodes are isolating, not selectable and closed to the gap cursor |
| Sync client | The client algorithm of 04: the confirmed document, one in-flight commit, rebase on remote commits, rebuilds on acknowledgement and rejection, the journal |
| Identifier plugin | Sets missing identifiers in the same transaction; on a split, the fresh identifier goes to the new empty part |
| Body-scoped commands | "Select all", movement to the start and end, and joining at the first paragraph are limited to the body, so that they never reach definitions or stories |
| Region guard | Filters out local transactions that touch a scope the user cannot change; clamps selections at region boundaries through the view's selection hook, because isolating nodes stop joins but not selections; keeps a body paragraph after every region |
| Suggestion mode | Turns edits into `ins`, `del` and `fmt` marks when the user has `suggest` but not `edit`, when review mode is on, or when the document requires it. Block suggestions are drawn as decorations. Table commands are the project's own, because the standard ones know nothing about suggestions; version 1 supports suggesting whole rows and cell content |
| Comment ranges | Decorations for the ranges the document service reports, mapped through every local and remote step |
| History | Selective undo and redo of the user's own changes, rebased over remote commits |
| Clipboard | Copy writes HTML that carries the CDM fragment inside it, plus plain text, because custom clipboard formats work in one browser family only. Paste prefers the embedded fragment, then HTML through the sanitiser and the Word and Google Docs cleaners, then plain text. Pasted images become asset uploads. Bookmarks and foreign identifiers are stripped |
| Sub-editors | Headers, footers and footnotes are edited in their own small editor states whose steps are mapped onto the one document, with collaboration and input methods working inside them |
| Find and replace | Skips locked scopes on "replace all" and reports how many matches it skipped |

## 6. Fonts

- The font manifest (`GET /fonts`) lists families, styles, file URLs, hashes and licences. The editor and the LaTeX workers load the same files, which is a precondition for matching layout.
- The default set contains only fonts whose licences allow bundling and server use (for example Noto Serif, Noto Sans, Noto Sans Mono, STIX Two). Fonts under the Open Font License with reserved names are not subsetted under their own name. Tenants can add fonts they are licensed to use.
- For imported DOCX files the manifest maps common proprietary families to metric-compatible open ones (Calibri to Carlito, Cambria to Caladea, Arial, Times New Roman and Courier New to the Liberation families). Aptos has no open metric-compatible substitute, so documents that use it reflow.
- Layout waits for the fonts it needs. A later font load advances a font epoch that invalidates measurement caches.
- On-screen math uses KaTeX's fonts while the PDF uses an OpenType math font. Equation sizes therefore differ slightly between screen and PDF; section 9.7 explains how page breaks are reconciled.

## 7. View strategy

The element has three views, selected with the `view` attribute. They are delivered in stages so that every other requirement can be proven before the most expensive part begins.

| View | What it is | When |
|---|---|---|
| `web` | A visible `prosemirror-view` in the shadow root: a continuous, reflowing sheet. Native caret, selection, input methods, spellcheck and accessibility. It is a permanent view, not a stopgap: it is the accessible reflow layout, the touch layout, and the fallback if the page view misbehaves | Phase 1 |
| `read` | Read-only pages. First the typeset PDF; later the project's own read-only paginated painter, which needs the layout engine but not the input work, and is also used for old versions and page counts | Phase 2 with the typeset PDF; the own painter in phase 3, if the gate at the end of phase 2 allows it (11, sections 5 and 6) |
| `print` | Editable pages: own layout engine and DOM painter, with margins, headers and footers in place | Phase 3, if the evidence of phase 2 supports it (11) |

In the `web` view the product must not pretend to show pages. It is presented as "Web layout", and the PDF preview and the `read` view show real pages. Page guides in the web view are optional and are exact only at block starts reported by a compile; between compiles, and inside long paragraphs, they drift, because a continuous sheet cannot account for header and footnote space, keep rules or the typesetter's line breaks.

## 8. Web view

The web view relies on ProseMirror's support for editing inside a shadow root. ProseMirror reads the selection through `Selection.getComposedRanges()` on Safari, and on Firefox it patches `ShadowRoot.prototype.getSelection`, which is a side effect visible to the host page; both set the minimum browser versions in section 12. Headers, footers and footnotes are edited in panels through the sub-editors of section 5.2. Form fields are node views that contain native controls.

## 9. Page view

### 9.1 Pipeline

```
CDM document ──► flow blocks ──► measure ──► break lines ──► paginate ──► layout tree ──► painter
                       ▲                                                     │
                 resolved formatting                                 hit testing, caret,
                 and layout semantics (03)                           selection, scrolling
```

The layout engine is plain TypeScript with no DOM dependency, so it can run in a worker and in Node.js for tests. Its only browser dependency is text measurement, which is injected. Before any of it is written, spike S7 evaluates driving an existing permissively licensed layout core from CDM flow blocks (11).

### 9.2 Layout tree

Immutable. Pages contain fragments; fragments contain lines or table rows; every node records the block identifier and the document offsets it covers. Fragments of one block can sit on several pages.

### 9.3 Measurement and line breaking

- Text is measured with a canvas `measureText` context. Canvas offers no control over ligatures in any browser and no control over kerning in Safari, so the painter's CSS is pinned to whatever canvas does by default; it is not the other way round. Spike S5 measures the differences and also evaluates computing advances from the font files with HarfBuzz compiled to WebAssembly, which is deterministic across browsers and is what one comparable open-source editor does.
- Measurements are cached by font alias, size, text and font epoch.
- The kernel's measurement (ADR 0016; WASM-006) shapes a run in a face from the manifest's file, given the face's alias, a size in twentieths of a point, a language and the painter's OpenType features. It answers with an advance for each UTF-16 code unit, in whole units of 1/1280 pt, which is 64 to the twentieth of a point. An advance is the font's value scaled to the size and rounded half up in integer arithmetic, so it is the same in every runtime. The advance of a cluster is on its first code unit; the other units of the cluster and the second unit of a surrogate pair are 0; the units sum to the run's width. The kernel's cache is keyed by alias, the epoch at which the face was loaded, size, language, features and text.
- Break opportunities come from a bundled implementation of the Unicode line breaking algorithm, because `Intl.Segmenter` has no line granularity.
- The kernel's segmentation (ADR 0016; WASM-007) is that implementation for the page view. Line-break opportunities follow UAX #14 of Unicode 15.0.0 (`unicode-linebreak` 0.1.5, with the kernel's corrections for numbers, for opening brackets of East Asian width and for unassigned pictographs), and every case of the Unicode test file of that version passes; the file follows the number rules of example 7 in section 8.2 of UAX #14. Grapheme clusters, which the caret and deletion of 9.6 step by, follow UAX #29 of Unicode 17.0.0 (`unicode-segmentation` 1.13.3), and every case of its test file passes. Offsets are UTF-16 code units of the block's text. An opportunity is the offset after the break; the one after a hard line break and the one at the end of the text are mandatory. No rule of a language is applied, and no break is found inside text of the class SA (Thai, Lao, Khmer), which needs a dictionary (11).
- Line breaking is first-fit (greedy). Hyphenation is off by default.
- The painter places each line in its own box with `white-space: pre` so the browser never re-wraps what the engine decided. Justification is applied as computed word spacing, which stretches only ordinary and no-break spaces and excludes trailing spaces and tabs.
- A test harness in continuous integration asserts that painted line widths match computed widths within half a pixel, per browser.

### 9.4 Pagination

Rules implemented, in priority order: explicit page and section breaks; `pageBreakBefore`; `keepNext` chains; `keepLines`; widow and orphan control; table rows that split across pages with repeated header rows and `cantSplit`; footnotes placed by iterating until the page content is stable; columns and column balancing; page sections with their own size and orientation. Floating objects with text wrap are out of scope (03, section 13).

### 9.5 Incremental layout and virtualisation

- An edit marks its block dirty. The engine re-measures dirty blocks, then re-paginates forward from the first affected page until the positions of following blocks stop changing.
- Layout work is coalesced into one pass per animation frame. Long documents are paginated in the background in time slices, using estimated heights for pages not yet computed.
- The painter mounts only the visible pages and a small overscan window. Blocks whose layout did not change are not repainted.
- The painter has an interactive overlay layer from the start, so that form fields, signature buttons and other controls on a page can be focused and clicked.

### 9.6 Caret, selection and input

- Hit testing, caret geometry, selection rectangles, and movement by line, page, Home and End are computed from the layout tree, not from the DOM.
- Input arrives through a hidden editable element. The first draft of this spec gave that element three jobs at once: holding the whole document for screen readers, sitting at the caret for input-method windows, and handling all keys. Those conflict: a view that renders the whole document cannot also be a small box at the caret, its line wrapping differs from the painted lines, and browser find-in-page would find every match twice. The design is therefore an open question for spike S9 (11): the bridge as a small projection of the current block, story or footnote with its steps mapped onto the document; navigation driven from the layout tree; and a separate, tested plan for screen readers.
- The EditContext API would be a second input pipeline, since `prosemirror-view` has no support for it. As of 2026-09 it ships in Chrome and Edge, is being built in Firefox, and WebKit has announced no plan. It is an option to evaluate in S9, not an assumption.

### 9.7 Reconciling with the typeset result

The compile reports where lines and pages really broke (09, section 7). When page-break reconciliation is switched on (level L1 of 09, section 7: opt-in per tenant, from phase 3; 06, section 10), the layout engine adopts the typesetter's breaks for paragraphs that have not been edited since, and uses its own for the rest. If the content between two reported page starts does not fit the editor's page, the page is allowed to overflow slightly; beyond a small tolerance the editor drops that pin and marks the page as estimated until the next compile.

### 9.8 Printing

Printing prints the typeset PDF. The component does not try to print painted pages: page rules from inside a shadow root are either ignored or alter the host page's print job, and most pages are not mounted.

## 10. Accessibility

The targets are WCAG 2.2 level AA for the interface and ATAG 2.0 for authoring (13, section 8). What that needs from the frontend:

- Full keyboard operation with visible focus. Tab has meanings inside the editor (indent, next cell, next field), so there are documented ways out: Escape leaves the editing surface and Ctrl+F6 cycles the landmarks (header, toolbar, page, panes, status bar).
- Every drag has a dialog or keyboard alternative: rulers, table and image resizing, moving blocks. Controls meet the target-size criterion. Focus is never hidden behind sticky bars.
- Numbered paragraphs are exposed with list semantics through ARIA, since the model has no list nodes.
- The web view is the reflowing layout for users who zoom; fixed-width pages cannot meet the reflow criterion.
- Live regions announce saving, rejection of an edit, and arrivals and departures of collaborators.
- ARIA references cannot cross a shadow boundary, so labelled controls and their labels live in the same root.
- In the page view, what screen readers read and edit is decided by spike S9.
- Images need alternative text before an accessible PDF can be produced; the accessibility checker prompts for it.

## 11. Internationalisation

Interface strings are external and the interface uses logical CSS properties so that it can be mirrored. Content support starts with left-to-right scripts; `dir` exists in the model from the start. Bidirectional text, complex-script shaping checks and East Asian line-breaking rules in the page view need their own plan; the web view inherits the browser's handling on screen, and LuaLaTeX handles these scripts in the PDF. Touch devices use the web view, with the visual viewport API to keep the caret above the on-screen keyboard.

## 12. Browser support

| Browser | Minimum | Reason |
|---|---|---|
| Chrome and Edge | 137 | First version with `Selection.getComposedRanges()`, the project's baseline for shadow-root selection |
| Firefox | 142 | The same, plus selection APIs that accept nodes in shadow trees |
| Safari | 17 | `Selection.getComposedRanges()`, which ProseMirror uses there |
| Mobile browsers | Viewing in phase 1; light editing in the web view in phase 4 | Input methods on iOS Safari inside shadow roots need separate work |

## 13. Performance

Budgets are in 13, section 9. Techniques: state outside reactive proxies; one interface update per frame; measurement caches; incremental pagination; page virtualisation; lazy chunks; work moved to workers. Known pressure points are documents beyond a few hundred pages in the web view (the whole document is mounted), table layout, and whatever the input bridge turns out to need.

## 14. Testing

- Unit tests for the model, the authority, the rules, the sync client and the layout engine run in Node.js without a browser.
- Playwright drives the element in all supported browsers; its locators pierce open shadow roots.
- An input matrix covers composition input for Japanese, Chinese and Korean, dead keys, and Android and iOS keyboards, with remote commits arriving during composition, in the main editor and in sub-editors.
- Host matrix: React, Angular, Vue, SvelteKit and plain HTML pages, including lazy loading of the bundle, server-side rendering, route changes that remove and re-add the element, two instances on one page, and a host that itself uses Svelte 5.
- Layout regression tests compare layout trees and painted line widths against stored results per browser.
- Accessibility checks run with axe and with manual screen-reader passes.
- A strict content security policy page and a Trusted Types page are part of the matrix.

## 15. Open issues

- The input bridge and the screen-reader plan for the page view (spike S9).
- Native spellcheck is lost in the page view, and a Word-style context menu hides it in the web view too. The proofing port (13, section 6.1) is the answer in both.
- Grammar and password-manager browser extensions behave inconsistently with editors inside shadow roots. This needs a compatibility list, not a design change.
- Whether layout runs in a worker from the start or is moved there later. For the page view's text kernel this is settled: it runs in a worker of its own from the start, one for each editor instance (ADR 0016; WASM-004). The layout engine itself is not moved by that.
- Touch selection handles and mobile editing in the page view.
