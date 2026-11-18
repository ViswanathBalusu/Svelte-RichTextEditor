# Review of the extension sandbox (UX-060)

**Date:** 2026-11-18. **Reviewer:** the developer agent of lane w3, which extended the sandbox with its panel in this round. **Status:** a first reading by an agent, not the sign-off the release needs. UX-060 criterion 6 asks for a security review before the feature ships; it stays open until a named person has read this record, the code and the tests, and signed it. Nothing here is an owner decision.

**Threat reviewed:** a third-party extension of tier 2 (13 §7.2; ADR 0393) that is hostile. It wants the host page's DOM, the editor's shadow root, the tokens and storage of the host, the network, the user's rights, and it wants to carry out what it may read.

## What was read

- `packages/ui/src/extensions/sandbox-frame.ts` (the iframe, the channel), `sandbox-protocol.ts` (schema, method table, access), `sandbox-runtime.ts` (the script in the frame), `sandbox-extension.ts` (the entry), `panes/SandboxPane.svelte` (the panel).
- The tests: `packages/ui/test/ux-060-sandbox-protocol.test.ts`, `ux-060-sandbox-panel.test.ts`, `packages/element/test/ux-060-sandbox-guards.test.ts`, and the browser specs `packages/ui/e2e/ux-060-sandbox-frame.spec.ts` and `ux-060-sandbox-panel.spec.ts`.

## Controls and what shows each

| Threat | Control | Shown by |
|---|---|---|
| Reach the host DOM, shadow root, `window`, cookies, storage, IndexedDB | `sandbox="allow-scripts"` and no other token: an opaque origin | `ux-060-sandbox-frame.spec.ts`, first test, Chromium, Firefox and WebKit |
| Navigate or open the top page, pop-ups, forms | no `allow-top-navigation`, `allow-popups` or `allow-forms` | same test |
| Network | the frame page is served with `default-src 'none'; script-src 'self' <entry origins>` | same test (`fetch` blocked, no request reached the server) |
| Carry what it read out by navigating its own frame to another origin | the host page's `frame-src` | `ux-060-sandbox-frame.spec.ts`, "cannot carry what it read out of the frame by navigating the frame itself": the request did not reach a second origin (all three browsers) |
| Forged messages from another window | the host registers no `window` message listener; the channel is one private `MessageChannel` | spec: a forged `postMessage` to the parent is ignored |
| Calls beyond what it declared | the bridge refuses writes for `write: none`, writes outside suggestion mode for `suggest` | `ux-060-sandbox-protocol.test.ts` (11 tests, one property run of 300) and the frame spec |
| Writes that bypass the rights of the user | the bridge hands each write to the same `ExtensionDocumentApi` as tier 1, whose guards are those of typing | `ux-060-sandbox-guards.test.ts`: the real core, a read-only scope, a locked document, suggestion mode, a stale range |
| Keys that move focus out of a frame, or trap it | the frame forwards only F6 and Escape; the shell takes the step from its own key table | `ux-060-sandbox-panel.spec.ts` and `ux-060-sandbox-panel.test.ts` |

## Findings

1. **The frame-src and the frame page header are the host's to set.** The sandbox attribute is set by the code. The `default-src 'none'` of the frame page and the `frame-src` of the embedding page are headers the host serves. If the host serves the frame page without its header, the extension keeps the opaque origin but gets the network of the default policy. If the embedding page allows `frame-src` for other origins, the self-navigation of the finding above is possible. Both belong in the integration guide's policy table (UX-090), which does not list them yet. Open.
2. **No limit on the rate or size of messages from a frame.** An extension can send many requests or large arguments. The document API bounds the ranges an extension may hold (`maxRanges`), but nothing bounds the messages. A hostile extension can slow the host's main thread. Proposed: a budget per second and a size limit in the bridge, both set by the host like the hook queue (ADR 0136). Open, not built.
3. **An extension reads everything its user may view.** `read: view` is the whole viewable document. The network is closed, so the data cannot leave by the frame, but the user who installs the extension gives it their view of the document. The install step of the host should say so. Open (a wording matter for UX-059's install dialog).
4. **The runtime and frame page must ship with the element.** `sandbox-runtime.js` and `sandbox-frame.html` are built here by the tests with Vite's library mode and are not in the element's build yet. A host cannot use tier 2 until they are. Open (a build change for the main session).
5. **Browsers differ in what a sandboxed frame can still do.** The specs ran in Chromium, Firefox and WebKit on Windows 11 on 2026-11-18. Other versions and platforms are not covered.

## Supply-chain exception (10 §3.8)

The editor bundle loads no code from a third-party origin at run time. A sandboxed extension is the one exception, on these terms:

- The code is the extension's `entry` script, which the host lists in `script-src` of the frame page. Nothing else is loaded into the frame.
- The code runs only in the frame, with an opaque origin, no network and no handle on the host (the table above). It never runs in the page or in the element's shadow root.
- The host chooses which extensions are installed. The editor installs none by itself.
- Its reach into the document is what the user may view, and its writes are what the user may do, through the guards of typing (UX-053), within the `write` level it declared (ADR 0393).
- The release's software bill of materials lists the editor's own packages. It does not list an extension's code, which is the host's to review and to pin by URL or hash.

## Sign-off

Reviewer (named person): _open_. Date: _open_. Findings 1 to 4 to be answered or accepted in writing.
