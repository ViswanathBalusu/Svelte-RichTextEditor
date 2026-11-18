# 0380 SPK-022 (S9): the page view's input bridge

**Status:** proposed (2026-11-17, lane w9). The design below is what the spike supports. The owner has not been asked, and S9's input-method and screen-reader checks have not been made (report section 7), so FE-098 may start on it but not close on it.

## Context

02 §9.6 leaves the input bridge of the page view open for spike S9. The owner chose the full editable page view on 2026-11-17 (decision 26), so S9 runs before any page-view input work (SPK-013). The spike ([report](../spikes/2026-11-17-s9-page-view-input-bridge.md)) built a prototype and measured what a headless run can.

## Decision (proposed)

1. **The bridge is a small projection of the current block.** One single-line editable element (a textarea in the prototype) in the same open shadow root, holding a window of the current block around the caret (a few hundred characters at most, always at least one character of context each side), placed so that its caret is on the painted caret. It is moved, never rewritten, while a composition is open. Its `input` events become text steps on the document through `diffStep`; a composition is a series of steps.
2. **Movement and clicks do not go through the bridge.** Up, Down, PageUp, PageDown, Home, End and clicks are computed from the layout tree (`@docedit/layout`, FE-096 and FE-097) and the bridge is projected again. Left and Right follow the block order.
3. **EditContext is not used in the first release.** It is in Chromium and Edge only (Firefox 159 and WebKit 27.2 have none), so the textarea bridge is needed regardless, and a second pipeline doubles the input matrix. Revisit when both Firefox and WebKit ship it (this is the condition ADR 0005 already names).
4. **Screen readers read a hidden, reflowing text alternative, and the painted pages are `aria-hidden`.** The bridge is the one editable element, with a live region announcing line and block on each move. This is a plan; no screen reader has run it.
5. **Find is the page's own command in the page view.** Only mounted pages are in the DOM, WebKit's `window.find` did not search the shadow root, and Chromium and Edge find the bridge's copy of the current block as well as the painted line. The browser's find bar stays available and finds painted text; it is not relied on.

## Other options

- A bridge that holds the whole document (the first draft of 02 §9.6): rejected there; find would hit every match twice and the wrapping differs from the painted lines.
- EditContext only: lacks two supported engines.
- Painting into a canvas: loses real text, selection by assistive technology and the browser's find (ADR 0005).

## Consequences

- FE-098 and FE-099 build on `packages/perf/src/s9/` (`bridge.ts`, `navigate.ts`) and `src/browser/s9-page.ts`. The prototype's first-fit layout (`layout.ts`) is for the spike only.
- 02 §9.6 and §10 should say that the bridge is a window of the block, that EditContext is deferred, and that find is the page's own in the page view, once the owner accepts this.
- SPK-022 criteria 1, 3 and 5 stay open until a person runs the checks in report section 7.
