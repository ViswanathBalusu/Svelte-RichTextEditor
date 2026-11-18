# What a host must allow, per feature, and what the editor changes on the page

Lane FE-014-026, story FE-017. This is the part of the integration guide (UX-090 owns the guide as a
whole) that lists the Content Security Policy directives, the Trusted Types policy names and the
global side effects of `<doc-editor>`. The names are the working names of the project.

Sources: the spike S2 report (`docs/spikes/2026-11-06-s2-csp-trusted-types.md`, section 8), measured
in Chromium, Edge, Firefox and WebKit on 2026-11-06; and the element's source as read on 2026-11-13.
Where a case was not measured, the entry says so.

## Core (every host)

Needed for every page that shows the editor.

- `script-src`: the origin that serves the module and its lazy chunks. Neither `'unsafe-inline'` nor
  `'unsafe-eval'`.
- `style-src`: nothing inline. The component's CSS is one constructable stylesheet, shared by every
  instance. If the policy or the browser refuses constructable sheets, set `config.styleNonce` and
  allow that nonce in `style-src`; the component then uses its own `<style nonce>`. Measured: with the
  nonce, one `<style nonce>` and no violation; without it, the element's styles are blocked
  (`style-src-elem` is reported and the toolbar is laid out as plain blocks).
- `connect-src`: the origin of the backend the host connects to. Not measured in the spike.
- `require-trusted-types-for 'script'`: supported. The core creates no Trusted Types policy.
- Trusted Types names: none.
- Omit: nothing. This is the baseline.

## Paste

- `trusted-types docedit-paste`: the element reads clipboard HTML through this policy (FE-054,
  `packages/engine/src/view/paste-policy.ts`). It is created on the first paste of HTML. The element
  tries the page's `default` policy first, then `docedit-paste`.
- `trusted-types ProseMirrorClipboard` is created by ProseMirror's own paste path. A host that allows
  only `ProseMirrorClipboard` gets one `trusted-types` violation on the first HTML paste into the
  body, and then the plain text is pasted. Allow `docedit-paste` to avoid it.
- With neither `docedit-paste` nor a `default` policy allowed, the HTML is not read and the plain text
  is pasted; the paste never throws.
- Since FE-016 (2026-11-15) the element takes a paste into a footnote or story panel and a drop of
  HTML onto any surface too, and reads them under `docedit-paste` (`pasteThroughPolicy` and the
  `drop` handlers in `packages/engine/src/view/web.ts`). Measured in
  `packages/element/e2e/fe-016-paste-policy.spec.ts` with `trusted-types docedit-paste` alone: no
  Trusted Types violation in Chromium, Edge and WebKit. No surface of the element then needs
  `ProseMirrorClipboard`; only a caller of ProseMirror's own `pasteHTML` (the spike harness) does.
- The S2 GUIDE table (`packages/element/e2e/s2-features.spec.ts`) still lists
  `trusted-types docedit-paste ProseMirrorClipboard`, because its paste run drives ProseMirror's
  `pasteHTML` through the harness. Whether to stop publishing `ProseMirrorClipboard` is left to
  FE-017.
- Omit: if the host never pastes HTML. The editor still accepts plain text input.

## Panes (outline, footnote and header panels)

- No directive beyond the core. Measured: the outline pane under the strict baseline gives no
  violation.
- Omit: nothing.

## PDF viewer

The editor opens a PDF in one of two ways. The viewer frame is the production path; the in-page
panel was the S2 spike's path and is kept for the measurements.

Production (`packages/element/src/pdf/viewer-frame.ts`, a sandboxed iframe):
- `frame-src`: the origin of the viewer page. The frame has `referrerpolicy="no-referrer"`. Its
  sandbox is `allow-scripts` when the viewer is on the page's own origin and
  `allow-scripts allow-same-origin` when it is on another origin.
- The viewer page's own policy, when the host serves it: `script-src` for the viewer origin plus
  `'wasm-unsafe-eval'` for the WebAssembly decoders; `connect-src` for the viewer origin, since the
  worker fetches decoders, CMaps and standard fonts.
- With `frame-src` for the viewer's origin added to the strict baseline, the frame draws the PDF and
  the page reports no violation (`packages/element/e2e/pdf-viewer.spec.ts`, 'works under a strict
  host policy').
- Without `frame-src` for the viewer's origin (strict baseline, `frame-src 'none'`), the browser
  refuses the frame and the page reports one `frame-src` violation. The viewer never answers, so
  the open is refused with the error code `unavailable` ("the PDF viewer did not answer") when the
  ready timeout ends (15 s, `READY_TIMEOUT_MS`). The frame is then removed and the editor itself
  keeps working. Measured in Chromium, Edge, Firefox and WebKit on Windows 11 by
  `packages/element/e2e/fe-017-without-directives.spec.ts` (lane w1, 2026-11-15).
- Not measured: the viewer page's own policy with `'wasm-unsafe-eval'` left out.

In-page panel (`packages/element/src/features/pdf.ts`, measured in the spike):
- `trusted-types docedit-worker`: the component creates its worker through this policy, for
  same-origin or `blob:` URLs only.
- `worker-src`: the origin of `pdf.worker.mjs`; `script-src`: that origin.
- `connect-src`: where the PDF comes from when it is fetched by URL.
- Without `'wasm-unsafe-eval'` in the worker's own policy, the panel still works with the JavaScript
  decoders and approximated ICC colours; Chromium, Edge and Firefox send one report per refused
  module. `useWasm: false` avoids the reports.
- Without `docedit-worker` (strict baseline, no policy name allowed), the panel does not open the
  document: the policy creation is refused, the viewer reports `ok: false` with no pages, and the
  page reports one `trusted-types` violation (no worker report, because no worker starts). Measured
  in Chromium, Edge, Firefox and WebKit by `packages/element/e2e/fe-017-pdf-no-worker-policy.spec.ts`
  (lane V-FE-017-032, 2026-11-14). The production viewer frame is not measured here.

## Layout kernel (WebAssembly)

Lane w6, story WASM-002. Needed only when the page view is asked for (`view="print"`); the web and read
views fetch and compile no WebAssembly. Not measured against a hostile policy in all browsers: the
directive is S2's (section 6); the load itself is measured in `e2e/wasm-002-kernel-load.spec.ts`.

- File: `assets/docedit_layout_kernel_bg-<hash>.wasm`, next to the `chunks/` folder of the library
  build, found from the chunk's own URL (`new URL(…, import.meta.url)`). Never inlined as base64.
- `connect-src`: the origin that serves the component's files (the fetch).
- `script-src 'wasm-unsafe-eval'`: in the page's policy while the module is compiled on the page's
  thread. With a layout worker (WASM-004) it moves to the worker script's own response policy.
- Media type `application/wasm` lets the browser compile while the file downloads; any other type is
  read whole and compiled from the bytes.
- Trusted Types names: none. Global side effects: none.
- Events: `de-diagnostic` carries the load time or the failure code and, for a policy refusal, the
  directive to add.
- Omit: the directive, if you accept a degraded page view. Editing, saving, collaboration and the read view
  work without it (WASM-003; `e2e/wasm-003-blocked.spec.ts`). A refused compile is reported as
  `de-diagnostic` `load-failed` (`blocked_by_policy`, with the directive) and `degraded` (with the
  fallback: `canvas-measurement` in Chromium, Edge and WebKit, `web-view` in Firefox, where a message
  with buttons for the web view and the read view is shown).

## Math display (KaTeX)

- `font-src`: the origin of the KaTeX font files. The editor moves the `@font-face` rules of KaTeX to
  the document's font set (`document.fonts`), so the rule needs to allow the font origin.
- Trusted Types names: none.
- `style-src-attr`: not needed. The formulae are built by DOM construction, and a formula that
  fails to parse is shown as its source text. `\fcolorbox` writes style attributes and would need
  `style-src-attr 'unsafe-inline'`; the editor does not use KaTeX's own error markup.
- Omit: `font-src` only if the host never shows a formula.

## Math editor (MathLive)

- `trusted-types docedit-math`: MathLive's markup goes through this policy when the editor is opened
  with `useCreateHTML` (the default). The policy passes the markup unchanged; its safety rests on
  MathLive's escaping.
- `style-src-attr 'unsafe-inline'`: MathLive puts inline styles in its markup. This does not allow
  `<style>` elements. A host that cannot allow inline style attributes cannot use the math editor.
- `font-src`: the origin of MathLive's font files (the `fontsDirectory` option).
- Sounds: the editor sets MathLive's `soundsDirectory` to null, so it names no sound directory.
- The math editor's markup is not the only markup MathLive writes: ten of its `innerHTML`
  assignments (menus, the virtual keyboard's toolbar, static rendering) do not go through the policy.
  None was exercised in the spike; each would raise a Trusted Types violation when used.
  The editor (FE-070, `src/math-field.ts`) switches the virtual keyboard off (`mathVirtualKeyboardPolicy`
  is `manual`) and gives the field no menu items, so it does not reach those assignments; the person
  types, or uses the LaTeX source field of the dialog. The dialog's source field works without the
  visual field, so a host that never allows `docedit-math` can still change an equation's LaTeX
  there; the dialog then says the visual editor could not be loaded.
- The fonts of the field come from `config.katexFontsUrl`, the directory of the KaTeX files (the file
  names are MathLive's own). Without it MathLive is told to load none.
- Without `docedit-math` (strict baseline, no policy name allowed), the editor does not work: the
  policy cannot be created, MathLive's markup is never written, and the `math-field` element is on
  the page but empty (a few pixels wide) and takes no input. The page reports one `trusted-types`
  violation and sees an uncaught `TypeError` that names the policy. There is no fallback editor.
- With `docedit-math` but without `style-src-attr 'unsafe-inline'`, the field is drawn and takes
  input, and the page reports `style-src-attr` violations for the inline styles the browser
  refuses. How the formula looks without those styles was not judged.
- Both cases were measured in Chromium, Edge, Firefox and WebKit on Windows 11 by
  `packages/element/e2e/fe-017-without-directives.spec.ts` (lane w1, 2026-11-15).
- Omit: `trusted-types docedit-math` and `style-src-attr` only if the host never opens the math
  editor.

## Fonts

- `font-src`: the origin of the editor's font files. Font files are loaded with the FontFace API.
- Trusted Types names: none.
- Font registration (FE-061). Once the backend is connected, the session reads the backend's font
  manifest and adds one `FontFace` per file to the page's `document.fonts`
  (`packages/element/src/session.ts` calls `registerManifestFonts` in
  `packages/element/src/font-loader.ts`). This happens only when the backend has a `fonts` port.
- Each face is registered under an alias, never under the manifest's family name: `de-font-`
  followed by the file's SHA-256 hash (`FONT_ALIAS_PREFIX` in
  `packages/element/src/font-registration.ts`). A family the host defines therefore keeps its own
  faces. A second instance, or a second version of the editor, finds the alias already in the set
  and adds nothing.
- The faces stay in `document.fonts` after the element is removed; the editor does not delete them.
- A face is only registered: the browser fetches the file when text first uses the alias. That
  fetch is what `font-src` must allow. Measured: a manifest file on the page's own origin loads
  under the strict baseline (`font-src 'self'`) with no violation
  (`packages/element/e2e/s2-features.spec.ts`, 'fonts').
- The aliases are not applied to the math families (they keep their own names, see below).

## Global side effects visible to the host page

Everything below changes the host page. The module adds no rule to the host's stylesheets. The
element's own code adds two listeners to the page's `document` (listed first below); the PDF
viewer's listeners are in its own frame's document. The editing library adds one more:

- A `pointerdown` listener on the page's `document`, in the capture phase, added when the element
  connects or resumes and removed when it suspends or is removed (`packages/element/src/doc-editor.ts`).
  It only clears the element's focus memory; it changes nothing on the page.
- A `visibilitychange` listener on the page's `document`, added once the editor is watched and
  removed when the session closes (`packages/element/src/session.ts`). When the page is hidden it
  starts the journal flush (FE-011).
- An origin-wide IndexedDB database named `docedit-journal` (`JOURNAL_DB_NAME` in
  `packages/element/src/journal-idb.ts`), opened by the session for the local journal. It is shared by
  every page of the same origin that uses the element; it is not removed when the element is.
- A `selectionchange` listener on the page's `document`. ProseMirror (prosemirror-view 1.42.9,
  `connectSelection`) listens on `view.dom.ownerDocument`, which is the page's document even though
  the view sits in the element's shadow root. It is added when the view is mounted and removed when
  the view is destroyed. When the view hides the browser's selection (for example while a node is
  selected), it adds a second, short-lived `selectionchange` listener on the same document, which
  removes itself once the selection moves.
  A host that listens for `selectionchange` itself also sees the events the editor causes.
- The shell follows `prefers-color-scheme` through a `MediaQueryList` change listener
  (`packages/ui/src/shell/theme.ts`). This is not a listener on `document` or `window`.

The other global changes:

- The custom element `doc-editor`. It is defined when the module loads in a page that has custom
  elements (`packages/element/src/index.ts`); the registration result is `defined`, `same` or
  `other` (`packages/element/src/register.ts`).
- The custom elements `math-field`, `math-span` and `math-div`. MathLive registers them when its
  chunk loads, on the first use of the math editor. Nothing registers them at start.
- Font aliases on `document.fonts`: one face per file of the backend's font manifest, under the
  family `de-font-<sha-256 of the file>`, added once the backend is connected (see Fonts). They are
  not removed when the element is.
- Font families on `document.fonts`: the twelve `KaTeX_*` families, added by the math display and
  the math editor, under their own names. The hash aliases of FE-061 are not applied to them.
- `ShadowRoot.prototype.getSelection`: patched by ProseMirror only with `selectionShim: 'library'`,
  which the spike measured in Firefox and Safari. The default, `'instance'`, defines it on the
  editor's own root only. Firefox is the case a host must know about.
- Trusted Types policies named on the page: `docedit-worker`, `docedit-math`, `docedit-paste`, and `ProseMirrorClipboard`
  (created by prosemirror-view on the first HTML paste or drop it parses itself, see Paste). Each is created on first use, so a host that
  never uses the feature need not allow its name.
- `MathfieldElement.fontsDirectory` and `soundsDirectory` are set on MathLive's class (a
  module-level setting, not a page element).

Not audited: MathLive's own document-level changes beyond the tags and font families above (its menus
and virtual keyboard were not exercised in the spike).

## Browser minimums

The build targets these minimum versions (02 §12; `BROWSER_MINIMUMS` in `scripts/vite-configs.ts`).
Browsers below them are unsupported: the element is not tested in them and no behaviour is promised.

| Browser | Minimum | Reason |
|---|---|---|
| Chrome and Edge | 137 | First version with `Selection.getComposedRanges()`, the baseline for shadow-root selection |
| Firefox | 142 | The same, plus selection APIs that accept nodes in shadow trees (see the `getSelection` patch above) |
| Safari | 17 | `Selection.getComposedRanges()`, which ProseMirror uses there |

Mobile browsers are not a minimum: viewing is in phase 1 and light editing in the web view is in
phase 4. Input methods on iOS Safari inside shadow roots need separate work (FE-115).
