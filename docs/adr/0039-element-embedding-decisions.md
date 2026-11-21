# ADR 0039: Element and embedding API decisions the specification leaves open

**Status:** proposed, 2026-11-06. Written while building the production `<doc-editor>` element (`packages/element`; PLAN-1a packet B2: FE-001 to FE-004, FE-007, FE-013, FE-014, FE-016, FE-018, FE-021, FE-022, FE-025, FE-071, FE-122; PRO-074 to PRO-076, PRO-080, PRO-087, PRO-088). Where 02 §2, §3 and 05 §8 are silent, the code follows the readings below. Accepted, 2026-11-15: decision 18 of [owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md) settles §3 (the CSS stays a string in the editor's chunks and no stylesheet file is built), and decision 220 accepts ADRs 0030 to 0052 as proposed. The budget of §2 is 320,000 bytes since decision 32.

## Context

02 §2 and §2.1 fix the element's lifecycle and 05 §8.1 its attributes, properties, methods and events, but not how a version collision is recognised, what counts as the initial chunk, how the CSS file reaches the shadow root, how often `de-change` fires, what `de-auth-required` carries, what `destroy()` does to a backend the host passed, or where the PDF viewer's frame document comes from. ADR 0040 (the DEP client) and ADR 0041 (the shell's seam) cover the neighbouring packages.

## Decisions (proposed)

### 1. Versions and registration (FE-001)

- `DocEditorElement.version` is the embedding API version (05 §8), `0.1`: MAJOR.MINOR like DEP, major 0 because the contract is not frozen. It is separate from the protocol version (DEP 1.0).
- `DocEditorElement.release` is the package version. A class already registered under the name is "this element" when it is this class, a subclass of it, or a class with the same `version` and `release`; then nothing happens. Anything else gets one `console.warn` naming both (`embedding API 0.1, release 0.0.0`) and keeps its definition.
- `defineDocEditor(name?, registry?)` registers the class; a registry accepts a constructor once, so when the class already has a name there, a subclass is defined, which behaves the same. Hosts use it for another tag name or a scoped registry.

### 2. What loads when (FE-002; 13 §9)

- The entry (`doc-editor.js`) holds the element, its loading sequence and its events: it imports no editor code, so importing it on a server evaluates nothing of the editor and reads no browser global (only `'HTMLElement' in globalThis` and `'customElements' in globalThis`).
- The editor chunk (engine, shell, Svelte, styles) loads with the first document; the DEP client (`@docedit/backend-dep`) loads only for `endpoint`; panes, the PDF viewer's controller and its frame load when opened.
- "The initial chunk" of FE-002 is measured as the first interactive editor: the entry, the editor chunk and their static imports, and with the DEP client for an endpoint. Compressed size is gzip at level 9, counted against 300,000 bytes; Brotli is reported too (`scripts/bundle-report.ts`, `dist/lib/bundle-report.json`).

### 3. The stylesheet (FE-002, FE-014)

The element's CSS and the shell's (`@docedit/ui/styles/shell.css`) are bundled as one string, loaded once into one constructable sheet that every instance adopts. That is the path spike S2 verified under a strict policy: no request, so no `connect-src` or `style-src` entry. The build therefore emits no separate CSS file: a file would need a `fetch` (and `connect-src` for the module's origin) or CSS module scripts, which not every supported browser has. The owner settled this on 2026-11-15 (decision 18): the CSS stays a string, FE-002's first criterion and 02 §2 are reworded, and the library build fails if it emits a stylesheet file for the component (`structureOf` in `packages/element/scripts/bundle-report.ts`). In the build the string is in `chunks/styles-<hash>.js`, which the editor chunk imports statically, so it loads with the first document. Revisit if a separate file is wanted for caching or auditing.

### 4. Loading and the token source (FE-003; PRO-074, PRO-075)

- Loading starts in a microtask once the element is connected, has `doc-id`, and has `backend` or both `endpoint` and `getToken`. `getToken` without `endpoint` waits without an error, since a framework may set the endpoint later.
- A load is identified by the document and the backend object (or the endpoint). A new `getToken` function does not reload, because frameworks pass a new function on every render; the token source always calls the current property, with `{ docId }`. When a load failed, setting `getToken` again retries it.
- With `backend`, `endpoint` is ignored and the DEP client is never loaded (PRO-090).

### 5. Errors and events (PRO-075, PRO-087, PRO-088; FE-007)

- A failure that ends a load raises `de-error` with `fatal: true` and a message prefixed with the step (`loading: …`). A refused or failing token raises `de-auth-required` with `{ docId, code }` instead, not both; it carries no token. During a live session a server close raises `de-error`, fatal for `forbidden`.
- `de-change` raises the latest confirmed `seq` at most once per 500 ms (a provisional default, not a measurement). `de-status` is raised at most once per animation frame, and in the next task while the page is hidden, where there are no frames.
- `de-permission-change` is raised once per access revision: from the channel the element opened, and from the core's view after the core reopened a channel itself (B1's sync client). Every `detail` is a frozen deep copy.
- `de-recovered-edits { count }` is raised when the core's count of set-aside work changes.

### 6. Lifecycle (FE-004, FE-006; PRO-076)

- `destroy()` unmounts the shell, destroys the core, closes the channel and closes the backend, also one the host passed (PRO-090 asks `backend.close()` once). It cancels a load already scheduled. Nothing more is raised; connecting the element again, or calling `load()`, starts afresh.
- The grace period is `config.graceMs` (default 30,000 ms, 02 §2.1). `keep-alive` added while suspended cancels the timer; removed while suspended, it starts it.
- `load(docId)` sets `doc-id`; `load()` or `load(current)` reloads.

### 7. Attributes into the shell (FE-003)

`toolbar` and `locale` reach the mounted shell through ui's `SettingsStore` without a remount; `mode`, `view` and `theme` stay on the attribute until PRO-077 and PRO-079. The element adds no reflecting properties of its own.

### 8. Keyboard (FE-021, FE-025)

The editing views handle their keys. For focus elsewhere inside the editor (toolbar, panes), one listener on the shadow root, attached with `on` from `svelte/events`, routes Mod-B, Mod-I, Mod-Z, Shift-Mod-Z and Mod-Y to the core's commands, deciding from the event's composed path; form fields and editable elements keep their own keys. The core sees a key first (it is deeper in the tree); the listener skips cancelled events. The command registry's key bindings (UX-013) replace the table.

Order-sensitive handlers (FE-025), attached with `on`: `keydown`, `beforeinput`, `compositionstart`, `compositionupdate`, `compositionend`, `paste`, `drop`. The list is `ORDER_SENSITIVE_EVENTS` in `packages/element/src/shortcuts.ts`; a change to it changes this line in the same commit, and `packages/element/test/order-sensitive.test.ts` fails when they differ.

### 9. The PDF viewer's frame (FE-071; 09 §9.3 rule 7)

- The frame document is `viewer/pdf-viewer.html` of the build, with PDF.js, its worker and the data PDF.js fetches. Its default URL is next to the module; `config.pdfViewerUrl` points at a copy on another origin, which is the recommended deployment.
- Served from another origin the frame gets `sandbox="allow-scripts allow-same-origin"`: it keeps that origin, so PDF.js has its worker. Served from the host page's origin it gets `allow-scripts` only: an opaque origin, PDF.js on the frame's main thread, and the viewer's files need `Access-Control-Allow-Origin`. No other sandbox flag is ever set.
- The element hands the frame a `MessagePort` in one `connect` message; everything else goes over it. The frame receives the PDF (a signed URL or the bytes) and its strings, never the token. It draws one page at a time, with no annotation or form layer and no scripting. The frame's response policy, set where it is served, has no `'unsafe-eval'` (`demo/serve.ts` shows one).
- The element waits 15 seconds (provisional) for the frame to answer before reporting it unavailable.

### 10. `config` and the directory (PRO-080, PRO-081)

- `config` is read for `styleNonce`, `graceMs`, `pdfViewerUrl` and `selectionShim`; `footnoteModel`, `deferRemoteWhileComposing` and `forceStyleFallback` exist for spike evidence only. Other keys are ignored; the getter returns what the host set.
- Names go through ui's `PeopleDirectory`, whose resolver calls the element's current `resolveUsers`. `searchPrincipals` is kept until the grants dialog and mentions use it.

## Consequences

The embedding contract of 05 §8.1 is the element's whole public surface, plus `release`, `defineDocEditor` and `EVENT_NAMES`; the spike hooks moved to `src/testing.ts`, which only the demo build imports. A host that serves the viewer from its own origin gets isolation without a worker.

## Open questions

- Settled: the build does not ship the CSS as a separate file (decision 3; owner decision 18).
- Whether `destroy()` should leave a backend the host passed open; PRO-090 says close it.
