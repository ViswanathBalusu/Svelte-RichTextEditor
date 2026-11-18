# ADR 0390: Where layout and text measurement run

Status: proposed (lane w1, 2026-11-18). Story: FE-075. Updates the proposals of ADR 0205 §1 and
ADR 0206 (FE-075).

## Context

02 §15 leaves open whether layout runs in a worker from the start or later. The earlier proposals
(ADR 0205, ADR 0206) chose the main thread first because spike S5 had no result in the repository
and no worker measurement existed. Since then:

- Spike S5 (docs/spikes/2026-11-06-s5-text-measurement.md) is in the repository. Its answer is to
  measure from the font files with a shaper compiled to WebAssembly, with canvas `measureText` as
  the fallback in Chromium, Edge and WebKit when the host blocks WebAssembly.
- Spike S10 (docs/spikes/2026-11-06-s10-text-kernel.md) ran both kernels inside a layout worker.
  Its measured round trip through the worker was at most 0.41 ms at the 95th percentile per
  keystroke (reference profile, three passes), and 200 paragraphs held the worker for up to 29 ms.
- Owner decision 27 (docs/owner-decisions-2026-11-15.md) builds the Rust WebAssembly module, which
  overrides S10's recommendation of harfbuzzjs. S10's boundary, `breakParagraph` per dirty
  paragraph inside the layout worker, was drawn for either kernel.
- `packages/layout/test/fe-076-worker.test.ts` (Node.js `worker_threads`) and
  `packages/layout/src/fe-076-browser-worker.universal.test.ts` (Chromium, Firefox, WebKit) show
  that the engine gives the same serialised tree on the main thread and in a worker, with no
  `document` or `window` there.

## Proposal

1. **Layout runs in a worker from the start**, in the browser. The engine stays free of DOM and
   Node.js APIs, so Node.js tests and the main-thread fallback need no second code path.
2. **Text measurement runs in the same worker**, with the WebAssembly shaper (S5, decision 27).
   The canvas fallback uses `OffscreenCanvas` in the worker. WebKit's Windows build has no
   `OffscreenCanvas` (S5), so there the fallback measures on the main thread, or the element
   stays in the web view. This is the one place where the proposal needs work that is not built:
   the font aliases registered in the worker (FE-063) exist, and a worker measurer for the shaper
   does not.
3. **The tree crosses as plain data**, by structured clone, in slices (FE-089 sliced layout), so a
   keystroke never waits behind a batch.
4. **Main-thread layout stays as a fallback** that runs the same engine, for hosts that block
   workers.

## What is not measured

FE-075 criterion 3 asks for the cost per animation frame of the layout tree crossing to the main
thread, against the typing latency target. S10 measured the round trip of one paragraph's lines,
not the tree of a page. No measurement of the whole tree exists, so the cost is not known and this
proposal does not claim one. It is the condition for accepting item 1.

## Consequences

- If the owner accepts item 1, ADR 0005 is updated (FE-075 criterion 4) and FE-075 criterion 1 is
  met. If the owner prefers the main thread first, ADR 0206 stands and the engine already allows
  the later move.
- The owner's word is needed on item 1. Nothing in decisions 26, 27 or 220 states it.
