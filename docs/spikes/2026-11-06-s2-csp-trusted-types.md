# Spike S2: a strict content security policy and Trusted Types, including WebAssembly

**Date:** 2026-11-06. **Story:** SPK-015. **Spec:** 02 §2, §3; 09 §9.3; 10 §3.1; ADR 0002, ADR 0016.
**Prepares:** FE-002, FE-014, FE-015, FE-016, FE-017, FE-061, FE-069, FE-070, FE-071, FE-125; the WASM epic.

Every result below comes from a test in this repository (`packages/element/e2e/s2-*.spec.ts`), run in Chromium 158.0.8127.18, Edge 156.0.4314.58, Firefox 159.0 and WebKit 27.2 (Playwright's builds, Edge installed) on Windows 11 Pro 10.0.26300; section 2 has the method and the run. They are current versions, not the minimum versions of 02 §12, and WebKit on Windows is not Safari.

## 1. Results in short

- Under a strict baseline (no unsafe keyword, `require-trusted-types-for 'script'`, `trusted-types 'none'`), the web view (typing, formatting, undo, the footnote and header panels), a lazily loaded Svelte pane and KaTeX display raise no violation in any of the four browsers.
- Three features need a Trusted Types policy name: paste (`ProseMirrorClipboard`, ProseMirror's own), the PDF panel (`docedit-worker`, the component's) and the math editor (`docedit-math`, the component's). The math editor also needs `style-src-attr 'unsafe-inline'`, because MathLive's markup carries style attributes. With those additions every feature runs with no violation in all four browsers.
- `element.style.cssText` is not restricted by the policy in any of the four browsers: assignment and `+=` apply and report nothing. `setAttribute('style', …)` is blocked and reported. ProseMirror's two `cssText` writes (style decorations and the drop cursor) therefore work.
- The nonce-carrying `<style>` fallback renders like the adopted sheet and reports nothing; without the nonce in the policy it is blocked and reported.
- Compiled with `fragments: "tree"`, the component's Svelte creates no Trusted Types policy; it loads next to a host whose own Svelte 5 holds `svelte-trusted-html` under a restricted name list. The same component compiled with Svelte's default fails to load there.
- `'wasm-unsafe-eval'` is needed in the policy of the context that compiles: the page's for the page and for `blob:` workers, which inherit it; the worker script's own response policy for a same-origin worker, where the page's plays no part. WebKit treats `blob:` under `worker-src` like the others, but sends no report when it refuses a WebAssembly compilation.
- With WebAssembly blocked, the PDF panel still renders, through PDF.js's JavaScript fallbacks, with different colours for ICC-based content.
- Section 8 is the list of directives and policy names a host must allow, per feature, for the integration guide.

## 2. Method

**Pages and server.** `packages/element/demo/serve.ts`, a Node.js server, sends every policy as a response header, never a meta tag: `/pages/<page>.html?csp=<base64url>` sends that policy with the page (`{nonce}` becomes a fresh nonce, also written into the page; `{report}` the run's report endpoint); a script under `/vendor/` or `/wasm/` takes its own policy from `?wcsp=`, which is how a test decides the policy of a same-origin worker. It collects `report-uri` reports (`POST /csp-report`) and logs requests per run (`/r/<run>/` prefixes the URLs a library builds itself, such as PDF.js's WebAssembly files).

**Builds.** `demo/build.ts` makes three Vite 8 builds: the component with `fragments: "tree"` and the demo page scripts; the component alone with Svelte's default `fragments: "html"` (the control); and a host application with its own Svelte 5 and default options. Components have no style block and are compiled with `css: "external"`; the stylesheet is one CSS file loaded with `?inline`. `modulePreload` is off and `assetsInlineLimit` is 0, so fonts and other assets stay files.

**Collection.** The first script on every page records `securitypolicyviolation` events, which are composed, so violations inside the shadow root reach the document. The server's reports add what the page cannot see, notably workers. A run identifier is unique per test execution: early in the spike it was reused across executions of the same test, and in WebKit reports carrying an identifier were already on the server when a later execution with that identifier started, so they had arrived after the execution that caused them (section 9).

**The baseline policy** (`STRICT` in `e2e/s2-helpers.ts`): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'; report-uri …`. Every feature runs under it and under the baseline plus what section 8 lists for that feature.

**Environment issue.** On this machine a local filter answered Firefox and Edge with an empty `204` for the PDF fixture's bytes, whatever the content type (`application/pdf` and `application/octet-stream` alike), while Chromium and WebKit received the file and the server logged a normal request. The tests therefore fetch the PDF XOR-encoded, decode it in the page and pass PDF.js the bytes (`getDocument({ data })`); everything else PDF.js loads comes from the server as usual. An earlier run in Chromium and WebKit, before this change, opened the PDF by URL under the same page policy without a violation (`connect-src 'self'`); that record was overwritten.

**The final run.** `pnpm exec playwright test -c packages/element/playwright.config.ts`, 2026-11-06 at 15:40 UTC, 4 workers, one retry allowed: 632 tests passed (S1 and S2), 0 failed, 0 flaky. The S2 specs ran 43 tests in each of the four browsers, all passed: `s2-features` 16, `s2-wasm` 15, `s2-styles` 5, `s2-pdf` 4, `s2-svelte-host` 3. The measurements are written per test to `packages/element/test-results/evidence/` (not committed).

## 3. Results per feature (`s2-features.spec.ts`)

| Feature, loaded lazily | Under the strict baseline | Under the baseline plus the guide (section 8) |
|---|---|---|
| Web view: typing, bold, Enter, undo, footnote and header panels | No violation, all four browsers | No violation, all four |
| Paste through ProseMirror (`view.pasteHTML`) | `trusted-types` violation; `createPolicy("ProseMirrorClipboard")` throws and nothing is pasted, all four | No violation; the pasted text is in the document |
| A pane (the outline, a Svelte component in its own chunk) | No violation, all four | No violation |
| PDF panel (pdfjs-dist 6.5.438 and its worker) | `trusted-types` violation: the component cannot create `docedit-worker`, so the panel does not open, all four | No violation; page rendered with WebAssembly decoders (sampled colours in section 7) |
| Math display (KaTeX 0.19.1: three formulae) | No violation; 20 font faces registered and loaded, all four | No violation |
| Math editor (MathLive 0.111.4: a field opened and edited) | `trusted-types` violation (`docedit-math` refused); MathLive's call into the policy throws an uncaught `TypeError` and the edit does not apply (the value stays `x^2`), all four | No violation; value edited from `x^2` to `x^2+1` |

What needs inline styles in the math features (`math: what needs inline styles`):

| Case | Result, all four browsers |
|---|---|
| KaTeX `\fcolorbox{red}{yellow}{x}` and a KaTeX-rendered error (`throwOnError: false`) | `style-src-attr` violations: KaTeX writes a `style` attribute for the MathML border and for the error colour. The component's own path (`throwOnError: true`, the source as a plain-text placeholder, FE-069) raises none |
| MathLive with `docedit-math` but without `style-src-attr 'unsafe-inline'` | `style-src-attr` violations on opening a field (17 recorded in WebKit; in the others the record keeps the first 20) |
| MathLive with `docedit-math` and `style-src-attr 'unsafe-inline'` | No violation |
| MathLive without the `createHTML` hook | `require-trusted-types-for` violation and the edit does not apply (value stays `x^2`) |

## 4. Styles (`s2-styles.spec.ts`)

Probes under `default-src 'none'; script-src 'self'; style-src 'self' 'nonce-…'`, each in the document and in a shadow root, identical in all four browsers:

| Way of setting a style | Applied | Violation |
|---|---|---|
| `el.style.outlineColor = …`, `el.style.setProperty(…)` | Yes | None |
| `el.style.cssText = …` and `el.style.cssText += …` | Yes | None |
| `el.setAttribute('style', …)` | No | `style-src-attr` |
| A constructable `CSSStyleSheet` adopted by the document or the shadow root | Yes | None |
| `<style>` with the page's nonce | Yes | None |
| `<style>` without a nonce | No | `style-src-elem` |
| Canvas `ctx.filter = …` (PDF.js sets it) | Yes | None |

**ProseMirror's `cssText`.** prosemirror-view 1.42.9 appends a decoration's `style` attribute with `dom.style.cssText +=`: an inline decoration with `style: "outline-color: …"` applied, no violation. prosemirror-dropcursor 1.8.4 assigns `style.cssText` to its element: created and positioned (`position: absolute`), no violation, all four. Its other `cssText` writes (iOS list markers, the clipboard capture fallback for browsers without `clipboardData`, styles of pasted HTML in a detached document) are CSSOM writes too and were not exercised separately. The drop cursor first landed in the host's light DOM (S1 report, section 4.8); `.de-page { position: relative }` fixed it.

**Component styles.** Normal path: one adopted sheet, no `<style>` element, toolbar `display: flex`, region border 3px, no violation. Forced fallback with the nonce in the policy: one `<style nonce>` in the shadow root, no adopted sheet, the same computed values, no violation. Forced fallback without the nonce in the policy: the element is blocked (`style-src-elem` reported), toolbar `display: block`, region border 0px. In all four browsers. A visual regression comparison (FE-015) was not made; the check is on computed styles.

## 5. Trusted Types

**Svelte.** Svelte 5.57.3 creates `svelte-trusted-html` at module evaluation in `internal/client/dom/reconciler.js`, which the HTML-string template path imports. In the build compiled with `fragments: "tree"`, the Svelte chunk contains neither the policy name nor a `createPolicy` call (searched in the built files); in the control build it contains both; the host build contains both. On `svelte-host.html` (`s2-svelte-host.spec.ts`), with `trusted-types svelte-trusted-html docedit-worker docedit-math ProseMirrorClipboard` and no `'allow-duplicates'`:

| Component build | Result, all four browsers |
|---|---|
| `fragments: "tree"` | Loads and mounts next to the host's Svelte; the host keeps working; no violation, no error |
| `fragments: "html"` (control) | Does not load. Chromium and Edge: `Policy with name "svelte-trusted-html" already exists`; WebKit: the same in its wording; Firefox: `Content-Security-Policy blocked creating policy named 'svelte-trusted-html'` |
| Control, host policy with `'allow-duplicates'` | Loads |

Both copies of Svelte are on that page, which covers "a second copy of Svelte" (FE-016) for the tree build.

**ProseMirror paste.** prosemirror-view parses pasted HTML with `innerHTML` in a detached document through `trustedTypes.defaultPolicy` if the page has one, otherwise through a policy it creates on first use, `ProseMirrorClipboard` (from its source; the default-policy branch was not tested). FE-016 asks for a project-owned name on the paste path: that needs the paste handler of FE-054 to intercept `paste` before ProseMirror (`handleDOMEvents.paste`) and parse under a project policy. Not prototyped.

**PDF.js's worker.** `new Worker(url)` is a script-URL sink. When PDF.js creates the worker itself (`GlobalWorkerOptions.workerSrc`), the constructor throws, PDF.js catches it, logs `Setting up fake worker` and runs its worker code on the main thread; a `require-trusted-types-for` violation is reported, in all four browsers. The component creates the worker itself through `docedit-worker` (same-origin or `blob:` URLs only) and hands it to PDF.js as `GlobalWorkerOptions.workerPort`.

**MathLive.** Its markup goes through `MathfieldElement.createHTML`, which the component points at `docedit-math`. The policy passes the markup unchanged, so its safety rests on MathLive's own escaping of the LaTeX it renders; a sanitiser behind the policy would be defence in depth (SEC). By reading mathlive.mjs 0.111.4, ten `innerHTML` assignments do not go through `createHTML` (menus, the virtual keyboard's toolbar, static rendering); none was exercised, and they would raise Trusted Types violations when used.

## 6. WebAssembly in workers (`s2-wasm.spec.ts`; ADR 0016)

A 41-byte module exporting `add` is compiled and instantiated; the worker records its own `securitypolicyviolation` events and the server records reports. Identical outcome in Chromium, Edge, Firefox and WebKit:

| Where the module is compiled | Page policy | Worker script's own policy | Compiles |
|---|---|---|---|
| The page | without `'wasm-unsafe-eval'` | – | No |
| The page | with | – | Yes |
| `blob:` worker | without | (inherits the page's) | No |
| `blob:` worker | with | (inherits the page's) | Yes |
| Same-origin worker | with or without | none sent | Yes |
| Same-origin worker | with or without | `script-src 'self'` | No |
| Same-origin worker | with or without | `script-src 'self' 'wasm-unsafe-eval'` | Yes |

So `'wasm-unsafe-eval'` belongs in the page's policy for the page and for `blob:` workers, and in the worker script's response policy for a same-origin worker; it is never needed in both. A same-origin worker served without a policy is not restricted at all.

`blob:` workers and `worker-src`, the same in all four, WebKit included: `worker-src 'self'` blocks a `blob:` worker; `worker-src blob:` allows it; with no `worker-src`, `child-src blob:` allows it even when `script-src` lacks `blob:`, and otherwise `script-src` decides (`'self'` blocks, `'self' blob:` allows). That is the fallback order of CSP Level 3 (`worker-src`, then `child-src`, then `script-src`). A blocked `blob:` worker is reported as `worker-src` in every browser.

Reporting differs: Chromium, Edge and Firefox report a refused compilation (`script-src`, blocked `wasm-eval`) from the page and from workers; WebKit refuses it but sends no report. Firefox also reports its own favicon request when `img-src` does not allow it.

## 7. The PDF panel when WebAssembly is blocked (`s2-pdf.spec.ts`)

The fixture (`demo/pdf-fixture.ts`) has a rectangle filled in an ICC-based CMYK colour space, CMYK 0, 1, 1, 0, with the profile PDF.js ships (converted by `qcms_bg.wasm`, or by PDF.js's own DeviceCMYK conversion), a 16 by 16 black CCITT Group 4 image (`jbig2.wasm`, or `jbig2_nowasm_fallback.js`) and a line of Helvetica. PDF.js uses its WebAssembly ICC transform only when it sets `useWorkerFetch`, which needs `cMapUrl`, `standardFontDataUrl` and `wasmUrl` on the same origin; the panel passes all three. The page policy is the baseline plus `trusted-types docedit-worker`.

| Case | Files fetched | Sampled fill (RGB) | Image | Violations |
|---|---|---|---|---|
| Worker policy with `'wasm-unsafe-eval'` | `pdf.worker.mjs`, `jbig2.wasm`, `qcms_bg.wasm` | 236, 31, 37 | Black | None, all four |
| Worker policy without it | the same, then `jbig2_nowasm_fallback.js` | 255, 46, 23 | Black | Worker `script-src` (`wasm-eval`) from Chromium, Edge and Firefox; none from WebKit |
| `useWasm: false` | `pdf.worker.mjs`, `jbig2_nowasm_fallback.js` | 255, 46, 23 | Black | None, all four |
| PDF.js creates its worker under Trusted Types | the same as blocked, on the main thread | 255, 46, 23 | Black | `require-trusted-types-for` (the worker), and page `script-src` (`wasm-eval`) except in WebKit |

So with WebAssembly blocked the panel still renders: image decoding falls back to JavaScript, loaded with a dynamic import inside the worker (the worker's `script-src` must allow the PDF.js directory), and ICC-based colours fall back to PDF.js's DeviceCMYK approximation, which looks different (the two fills above). A host that blocks WebAssembly and does not want the reports can set `useWasm: false`. The JPEG 2000 decoder (`openjpeg.wasm`) has the same fallback structure in pdfjs-dist 6.5.438 but the fixture has no such image, so it was not exercised.

## 8. For the integration guide: what a host must allow, per feature

Names are the working names of the project. Measured with the browsers of section 2.

**Every host (the editor itself: web view, panes, the footnote and header panels).**
- `script-src`: the origin that serves the module and its lazy chunks. Neither `'unsafe-inline'` nor `'unsafe-eval'`.
- `style-src`: nothing inline. The component's CSS is one constructable stylesheet, shared by every instance. If a host's policy or browser refuses constructable sheets, give the component a nonce (`config.styleNonce`) and allow it in `style-src`; the component then uses its own `<style nonce>`.
- `require-trusted-types-for 'script'`: supported; the editor itself creates no policy.
- Global side effects: the `doc-editor` element name; nothing else on the page. With the default shadow-root selection shim, ProseMirror does not patch `ShadowRoot.prototype.getSelection`; with `selectionShim: 'library'` it does, in Firefox and Safari (S1 report, section 4.7).

**Paste.** `trusted-types ProseMirrorClipboard` (or a `default` policy, which ProseMirror uses first). Without it, paste fails.

**Math display (KaTeX).** `font-src`: the origin of the KaTeX font files. The component renders formulae by DOM construction and needs no inline style; `\fcolorbox` (and KaTeX's own error rendering, which the component does not use) write style attributes and would need `style-src-attr 'unsafe-inline'`, so the math gate (EXP) should refuse them or the guide must list that. Side effect: twelve font families named `KaTeX_*` are added to `document.fonts`, unaliased until FE-061.

**Math editor (MathLive).** `trusted-types docedit-math`; `style-src-attr 'unsafe-inline'` (inline styles in MathLive's markup; this does not allow `<style>` elements); `font-src`: the origin of MathLive's fonts. Side effects: the custom element names `math-field`, `math-span` and `math-div`; twelve `KaTeX_*` font families on `document.fonts`. A host that cannot allow inline style attributes cannot use the math editor.

**PDF panel (PDF.js).**
- Page: `trusted-types docedit-worker`; `worker-src`: the origin of `pdf.worker.mjs`; `script-src`: that origin; `connect-src`: where the PDF comes from when it is fetched by URL.
- The worker script's own response policy, if the host serves one: `script-src` the PDF.js origin, plus `'wasm-unsafe-eval'` for the WebAssembly decoders; `connect-src` the PDF.js origin (the worker fetches the decoders, CMaps and standard fonts). Without `'wasm-unsafe-eval'` the panel still works, with JavaScript decoders and approximated ICC colours, and Chromium, Edge and Firefox send a report per refused module; `useWasm: false` avoids both. A worker script served without a policy is unrestricted.
- Production puts the viewer in a sandboxed cross-origin frame (09 §9.3, rule 7; FE-071): the host then needs `frame-src` for the viewer's origin, and the lines above apply to the frame's own policy. Not built or tested in this spike.

**WebAssembly kernels (ADR 0016, later).** In a same-origin worker, the worker script's response policy needs `'wasm-unsafe-eval'` and the host page needs nothing; in a `blob:` worker, the page's `script-src` needs `'wasm-unsafe-eval'` and `worker-src` needs `blob:`. Same-origin workers with their own policy therefore keep `'wasm-unsafe-eval'` out of host pages. WebKit does not report a refused compilation, so the kernel must detect the failure itself and use its fallback (ADR 0016, decision 2).

**A host that uses Svelte 5.** Its own Svelte needs `svelte-trusted-html`; the component adds no Svelte policy, so no `'allow-duplicates'` is needed.

**Policy names the project publishes (FE-017):**

| Name | Kind | Created by | When |
|---|---|---|---|
| `docedit-worker` | `createScriptURL` (same-origin or `blob:` only) | the component | first use of a worker (the PDF panel) |
| `docedit-math` | `createHTML` (MathLive's markup, unchanged) | the component | first use of the math editor |
| `ProseMirrorClipboard` | `createHTML` (pasted HTML) | prosemirror-view | first paste ProseMirror parses itself |
| `docedit-paste` | `createHTML` (clipboard HTML, parsed by `DOMParser` only) | the component (engine paste view) | first HTML paste into the body |

The `docedit-paste` row was added on 2026-11-14 for FE-054 (`packages/engine/src/view/paste-policy.ts`); this spike did not run it. Since then the body's paste no longer goes through ProseMirror's parse, so `ProseMirrorClipboard` is needed only for a paste into a footnote or story panel and for a drop of HTML. The S2 GUIDE table now requires `trusted-types docedit-paste ProseMirrorClipboard` for paste.

## 9. Not covered, and open points

- The sandboxed cross-origin frame for the PDF viewer (FE-071) and the production library build (FE-002: library mode inlines assets, while the worker and the WebAssembly files must stay files).
- A project-owned policy name for paste (FE-016, FE-054) and the `default` policy route.
- The fonts' hash aliases (FE-061): KaTeX's and MathLive's families are registered under their own names.
- MathLive's menus and virtual keyboard, and the ten `innerHTML` assignments that bypass `createHTML`.
- An unexplained WebKit report. While run identifiers were still reused, two WebKit PDF tests found `style-src-elem` reports (blocked `inline`, no source file or line) under their identifier, and once WebKit's console showed "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive" during the PDF panel, also without a location. No DOM event accompanied them. Probes ruled out PDF.js's style paths, the canvas font and filter, `FontFace` from data and from a URL, and Playwright's own scripts. With unique run identifiers it did not recur in three repeated runs of the 43 S2 tests in WebKit (129 executions, no retries) nor in the final run. FE-125 should keep report endpoints unique per run and watch for it.
- The minimum versions of 02 §12, and Safari itself.

## 10. Acceptance criteria of SPK-015

| Criterion | Status |
|---|---|
| Strict page: web view, panes, PDF panel and math editor show no violation, or each is listed with its feature | Met (section 3) |
| A host that uses Svelte 5 and restricts names loads the component compiled with `fragments: "tree"` without throwing | Met in all four browsers (section 5) |
| ProseMirror's `style.cssText` behaviour recorded; the nonce `<style>` fallback verified | Met (section 4) |
| Where `'wasm-unsafe-eval'` must appear for `blob:` and same-origin workers, in each supported browser, and Safari's treatment of `blob:` workers | Recorded for Chromium, Edge, Firefox and WebKit 27.2 on Windows (section 6); Safari itself and the minimum versions were not run, so not ticked |
| The PDF panel's behaviour when WebAssembly is blocked | Met (section 7) |
| Directives and policy names per feature written for the integration guide | Met (section 8) |
