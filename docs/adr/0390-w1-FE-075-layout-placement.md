# ADR 0390: Where layout and text measurement run

Status: proposed (lane w1, 2026-11-18; second version). Story: FE-075. It replaces the proposals of
ADR 0205 §1 and ADR 0206 (FE-075) and is recorded in ADR 0005. The grounds are below. The owner has
not answered this question in so many words, so the owner may reverse it; reversing it changes no
API (see "If it is reversed").

## Context

02 §15 leaves open whether layout runs in a worker from the start or later. ADR 0206 proposed the
main thread first, with canvas measurement on the main thread, and said when to reconsider: "when
spike S5 has reported and when a per-frame cost of the tree crossing to the main thread has been
measured in a browser". Both conditions are now met:

- **S5 has reported** (docs/spikes/2026-11-06-s5-text-measurement.md). Measurement is from the font
  files with a shaper compiled to WebAssembly; canvas `measureText` is the fallback in Chromium,
  Edge and WebKit when WebAssembly is blocked. Canvas differs in Firefox.
- **Decision 27 of docs/owner-decisions-2026-11-15.md** builds the Rust WebAssembly module, and
  decision 26 builds the full editable page view. ADR 0016 decision 2 (kernels "run in a worker")
  and the S10 boundary (one call per dirty paragraph "in the layout worker") are what the WASM
  epic builds: WASM-004 is "a layout worker that hosts the kernel". The kernel is therefore in a
  worker whatever is decided here. Its calls are synchronous inside the layout of a paragraph, so a
  layout engine on the main thread would have to wait for the worker for every paragraph.
- **The tree crossing is measured** (criterion 3, below).
- The engine gives the same serialised tree on the main thread and in a worker, with no `document`
  or `window` there (`packages/layout/test/fe-076-worker.test.ts` in Node.js,
  `packages/layout/src/fe-076-browser-worker.universal.test.ts` in Chromium, Firefox and WebKit).

## Decision

1. **Layout runs in a worker from the start**, in the browser, in the worker that hosts the
   measurement kernel (WASM-004). The engine stays free of DOM and Node.js APIs, so Node.js tests
   and the main-thread fallback need no second code path.
2. **Text measurement runs in the same worker.** The shaper is the WebAssembly kernel (S5, decision
   27). Where WebAssembly is blocked, the canvas fallback uses `OffscreenCanvas` in the worker.
   WebKit's Windows build has no `OffscreenCanvas` (S5): there the fallback measures on the main
   thread, or the element stays in the web view, as ADR 0016 says for a blocked kernel. The worker
   measurer for the fallback is not built; the font aliases in the worker (FE-063) exist.
3. **The tree crosses as plain data**, by structured clone. A keystroke sends the changed pages
   (FE-089 sliced layout); the whole tree is sent for a first layout and for a change of fonts.
4. **Main-thread layout stays as a fallback** that runs the same engine, for hosts that block
   workers.

## Measurement of the crossing (FE-075 criterion 3)

`packages/layout/src/fe-075-tree-crossing.universal.test.ts` with its Worker
`fe-075-tree-worker.ts`. A Worker lays out a document of 181 pages (the criterion's target is up
to 100 pages) once; its layout tree is 870 000 bytes of JSON. On request it posts the whole tree,
one page, or nothing. A browser clones a message on the receiving thread, in the task that
dispatches it, so the main thread is held for the clone. The page runs a heartbeat of MessageChannel
tasks and records the longest gap between two ticks while one message is delivered. The gap with no
message is the baseline. Figures are milliseconds, the 50th and 95th percentile of 30 runs for a
page and `nothing`, and of 15 runs for the whole tree. Machine: the Windows 11 development machine
of the project, shared with other test runs, the last three runs of the test on 2026-11-18, headless
Chromium, Firefox and WebKit of the installed Playwright. It is not the reference machine of ADR
0037, so the figures show the order of magnitude and are not a measure of the target.

| | Nothing (baseline) | One page (a keystroke) | The whole tree |
|---|---|---|---|
| Chromium | 0.2, 95th 0.5 to 6 | 0.2, 95th 0.3 to 0.6 | 12 to 13, 95th 24 to 26 |
| Firefox | 1, 95th 1 to 8 | 1, 95th 1 to 11 | 15 to 16, 95th 18 to 28 |
| WebKit | not resolved | not resolved | not resolved |

In WebKit under automation the heartbeat itself runs at the rate of the display (the baseline gap is
27 to 31 ms), so no cost below that can be seen, and the test records `resolved: false`. The
figures for WebKit say nothing; they are not evidence that it is fast or slow.

Against the typing latency target of 00 §9 (keystroke to paint within 16 ms at the median and 50 ms
at the 95th percentile, up to 100 pages): the page that a keystroke sends holds the main thread
about 1 ms, so it fits the target in Chromium and Firefox. The whole tree of 181 pages holds it for
about a frame (12 to 16 ms at the median, up to 28 ms at the 95th percentile). That is the cost of a
first layout or of a change of fonts, not of a keystroke, and it is the reason to send slices.

Not measured: the layout time in the worker (S10 measured one paragraph's lines at most 0.41 ms at
the 95th percentile, reference profile), the time to paint, and the clone of the tree *to* the
worker (the worker lays out from the CDM, which is sent once and then as steps).

## If it is reversed

The owner may prefer the main thread first (ADR 0206's wording). The engine already runs there with
the same API, and the injected measurement providers are plain data in and out (FE-076), so the
move is a change of where the engine is constructed and of the kernel's host, not of the engine.

## Consequences

- ADR 0005 records the placement (FE-075 criterion 4).
- WASM-004 hosts the engine and the kernel in one worker; FE-089 sends slices.
- Open: the worker measurer of the canvas fallback (`OffscreenCanvas`) and its WebKit exception.
