# Spike S10: text kernel in TypeScript or in Rust compiled to WebAssembly

**Status:** spike result, 2026-11-06, SPK-023; not reviewed by the project owner.

## Question

S5 chose to measure text from the font files ([S5 report](2026-11-06-s5-text-measurement.md)). Where should the page view's text kernel end, and in which language (ADR 0016 decision 3; Rust and WebAssembly assessment §4)? There are two options:

1. HarfBuzz's own WebAssembly build (harfbuzzjs) for shaping alone, with Unicode segmentation and first-fit line breaking in TypeScript.
2. One Rust module compiled to WebAssembly for shaping (HarfRust), UAX #14 segmentation, first-fit line breaking (02 §9.3) and TeX-pattern hyphenation.

ADR 0016 takes Rust only if it shows a material gain in time, determinism or maintenance.

## Answer

**HarfBuzz's own WebAssembly build for shaping, with segmentation and first-fit line breaking in TypeScript. Do not add the Rust module.**

Both prototypes ran in a layout worker behind one interface on the shared corpus (§3):

1. **They give the same result everywhere.** Both kernels produced the same line breaks and line widths, to the thousandth of a point, on every paragraph of `pages-100` (1,584 paragraphs, 3,630 lines) and `pages-1000` (15,088 paragraphs, 36,239 lines). The results were identical in Chromium, Edge, Firefox, WebKit and Node.js. Determinism is no reason to choose Rust.
2. **Both are far inside the budget.** The budget is 4 ms at the median and 12.5 ms at the 95th percentile per keystroke (§2). On the reference profile, re-breaking the edited paragraph took 0.015 ms (TypeScript) and 0.020 to 0.025 ms (Rust) at the median, and 0.26 to 0.31 ms and 0.21 to 0.27 ms at the 95th percentile, over three passes. The round trip through the worker was at most 0.41 ms at the 95th percentile.
3. **Neither is clearly faster.** A cold pass over 1,000 pages took 199 to 317 ms (TypeScript) and 183 to 326 ms (Rust) in Chromium, with the machine 42 % to 97 % busy with other work, so the ranges overlap. Rust's warm pass was faster in two of three passes, and its 95th percentile per keystroke was steadier in Firefox and WebKit. Every figure is two orders of magnitude inside the budget.
4. **Rust costs more to ship and to keep.**
   - It is a larger download: 422,858 bytes with gzip, against 197,592 for harfbuzzjs with the TypeScript kernel (2.1 times).
   - It needs a second toolchain: Cargo, the `wasm32-unknown-unknown` target, and a host C linker for the procedural macros. On the development machine the MSVC linker had to be named by hand.
   - It brings 21 more crates to audit, and a language the roadmap does not list (risk 13).

ADR 0016 decision 3 takes Rust only for a material gain in time, determinism or maintenance. S10 found none, so condition C-RUST of the WASM epic does not hold.

- **The boundary.** The layout core calls the kernel once per dirty paragraph (`breakParagraph`: text, runs and width in; lines out), beside the S7 measurement interface for advances and caret positions. Only shaping crosses into WebAssembly, once per piece of text not yet in a JavaScript cache keyed by face, text and font epoch.
- **The fallback when the host blocks WebAssembly.** In Chromium, Edge and WebKit, the same TypeScript kernel runs over a canvas `measureText` shaper (S5 §3.1). In Firefox the element stays in the web view and says why. The kernel catches a refused compile itself, since WebKit does not report it (S2).

## 1. What was built (kept, not throwaway)

| Part | Where |
|---|---|
| The kernel interface: the S7 measurement interface (`TextMeasurer`: `advance`, `advances`, `lineMetrics`) plus `breakParagraph` (text, runs and width in; lines out) | `packages/perf/src/kernel/types.ts` |
| Prototype 1: harfbuzzjs 1.6.1 shaping, `linebreak` 1.1.0 (UAX #14), first-fit in TypeScript, a segment-width cache keyed by face and text | `src/kernel/ts-kernel.ts`, `src/kernel/first-fit.ts`, `src/shapers/harfbuzz.ts` |
| Prototype 2: one Rust crate with HarfRust 0.15.0, `unicode-linebreak` 0.1.5 (Unicode 15.0), the same first-fit rule, `hypher` 0.1.8 with English patterns only, and the cache inside the module; a plain C ABI, no `wasm-bindgen`, no unsafe blocks | `wasm/text-kernel/`, `src/kernel/rust-kernel.ts`, `src/shapers/harfrust.ts` |
| Shared: vertical metrics from the font's own tables (so both kernels' `lineMetrics` agree), corpus paragraphs as kernel input | `src/kernel/metrics.ts`, `src/kernel/paragraphs.ts` |
| A layout worker holding one kernel, and a page that drives it as a page view would | `src/browser/kernel-worker.ts`, `src/browser/s10-page.ts`, `pages/s10.html` |
| The spec (reference profile and the four engines, digests compared with Node.js), the size measurement, Node.js tests | `e2e/s10.spec.ts`, `scripts/kernel-sizes.ts`, `scripts/build-wasm.ts`, `test/kernel.test.ts` |

## 2. The budget, written down before measuring

00 §9 gives a keystroke 16 ms at the median and 50 ms at the 95th percentile, from key to paint. In the page view a keystroke passes four stages that share that time:

1. the input bridge and the model;
2. the text kernel, which re-measures and re-breaks the dirty paragraph;
3. pagination, which reflows positions forward;
4. the painter.

With no evidence to weigh them otherwise, S10 gives each stage an equal share. **The kernel may use a quarter of each target: 4 ms at the median and 12.5 ms at the 95th percentile per keystroke, round trip to the worker included.** This is S10's allocation, not a figure from the spec; FE-088 and FE-089 may move it. 13 §9 gives no time for background pagination of 1,000 pages ("usable to 1,000 pages with virtualisation"), so that is reported without a target.

## 3. Evidence

Reference machine and profile of [ADR 0037](../adr/0037-reference-machine-and-throttling-profile.md) (Intel Core i9-10900KF, Windows 11, Playwright 1.65's Chromium 158.0.8127.18 at CPU throttling rate 1); Edge 156.0.4314.58, Firefox 159.0 and WebKit 27.2 for the comparison across engines; Node.js 22.18; corpus version 2. Other agents' work kept 41 % to 99 % of the machine's processors busy during these runs, recorded per result as `machineBusy`; times are therefore given as the range over passes. Commands, from the repository root:

```
node packages/perf/scripts/build-wasm.ts
pnpm exec playwright test -c packages/perf/playwright.config.ts s10 --project=reference --project=chromium --project=msedge --project=firefox --project=webkit
pnpm exec playwright test -c packages/perf/playwright.config.ts s10 --project=reference   (twice more)
node packages/perf/scripts/kernel-sizes.ts
pnpm exec vitest run --project node packages/perf
```

Results: `packages/perf/test-results/s10/` (`<project>-<kernel>.json`, `node.json`, `sizes.json`, and `runs/1` to `runs/3` for the three reference passes) and `wasm/bin/build.json`.

### 3.1 Per keystroke in `pages-100`, in the layout worker (budget: 4 ms median, 12.5 ms 95th percentile)

300 keystrokes per run, each inserting a letter into one paragraph and re-breaking only that paragraph after the document had been opened (cache filled). Every tenth keystroke went to the longest paragraph (5,216 characters). "Kernel" is the time inside the worker; "round trip" includes posting the paragraph and receiving the lines.

| Reference profile, three passes | TypeScript kernel | Rust kernel | Rust kernel, hyphenation on |
|---|---|---|---|
| Kernel, median (ms) | 0.015 / 0.015 / 0.015 | 0.025 / 0.020 / 0.025 | 0.030 / 0.015 / 0.015 |
| Kernel, 95th percentile (ms) | 0.260 / 0.310 / 0.265 | 0.270 / 0.210 / 0.210 | 0.455 / 0.225 / 0.220 |
| Round trip, 95th percentile (ms) | 0.335 / 0.410 / 0.335 | 0.405 / 0.295 / 0.305 | 0.590 / 0.295 / 0.300 |
| Longest paragraph, kernel, 95th percentile (ms) | 0.355 / 0.560 / 0.285 | 0.390 / 0.365 / 0.355 | 0.550 / 0.245 / 0.365 |
| Machine busy | 53 % / 76 % / 61 % | 97 % / 70 % / 42 % | 96 % / 52 % / 41 % |

Across engines (one run each, machine 84 % to 99 % busy), the kernel's 95th percentile per keystroke was:

| Kernel | Chromium | Edge | Firefox | WebKit |
|---|---:|---:|---:|---:|
| TypeScript | 0.285 ms | 0.610 ms | 0.900 ms | 0.780 ms |
| Rust | 0.390 ms | 0.375 ms | 0.380 ms | 0.420 ms |

### 3.2 Background pagination of `pages-1000` and opening `pages-100`

`pages-1000` was broken in full with an empty cache, posted in batches of 200 paragraphs, then once more with the cache filled. 13 §9 sets no time for this.

| Reference profile, three passes | TypeScript kernel | Rust kernel | Rust, hyphenation on |
|---|---|---|---|
| Cold pass, kernel time (ms) | 198.8 / 316.8 / 259.6 | 326.3 / 261.9 / 182.5 | 351.2 / 216.1 / 214.2 |
| Cold pass with messages (ms) | 264.0 / 417.1 / 343.9 | 441.4 / 353.7 / 248.0 | 467.5 / 287.6 / 282.4 |
| Longest batch of 200 paragraphs (ms) | 10.7 / 18.7 / 15.7 | 25.2 / 25.0 / 15.6 | 29.2 / 17.5 / 22.6 |
| Warm pass (ms) | 127.2 / 168.4 / 138.4 | 144.7 / 120.0 / 86.4 | 228.9 / 121.5 / 101.5 |
| Opening `pages-100`, cold (ms) | 21.0 / 37.7 / 29.4 | 54.5 / 36.3 / 29.6 | 69.3 / 33.5 / 29.8 |
| Lines | 36,239 | 36,239 | 36,074 |
| Distinct pieces in the cache | 8,796 | 8,796 | 9,463 |

Across engines the cold pass took 264 to 410 ms (TypeScript) and 303 to 356 ms (Rust). Hyphenation removed 165 of 36,239 lines.

A batch of 200 paragraphs held the worker for up to 29 ms. A keystroke arriving meanwhile waits behind it, so FE-089's time slices should be smaller than that (§6).

### 3.3 Cold start, size and memory

| | TypeScript kernel | Rust kernel |
|---|---|---|
| Start in the worker (ms; reference passes) | 14.3 to 23.0 (harfbuzzjs import, including about 6 ms to instantiate) | 12.3 to 27.8 (fetch 6.4 to 19.3, compile 5.6 to 8.9, instantiate 0.16 to 0.41) |
| Loading the eleven font files into the kernel (ms) | 125 to 184 | 109 to 189 |
| JavaScript, bytes raw / gzip 9 / Brotli 11 | 68,335 / 23,310 / 20,672 | 9,692 / 3,014 / 2,625 |
| WebAssembly, bytes raw / gzip 9 / Brotli 11 | 426,620 / 174,282 / 142,327 | 1,171,586 / 419,844 / 327,467 (`opt-level = 3`; 1,020,358 / 368,149 / 290,059 at `"z"`; no `wasm-opt`) |
| Total download, gzip 9 / Brotli 11 | 197,592 / 162,999 | 422,858 / 330,092 |
| WebAssembly linear memory after the fonts / after 1,000 pages (bytes) | 10,616,832 / 10,616,832 (the cache is in the JavaScript heap, not measured here) | 12,124,160 / 12,713,984 (cache included) |

- **How the sizes were measured.** They come from `scripts/kernel-sizes.ts`, which builds one minified bundle per kernel with Vite (an application build, so that the WebAssembly stays a file).
- **Fonts dominate the start-up.** Both kernels hold a copy of the 10.4 MB of font files.

### 3.4 Determinism

The digests of every paragraph's breaks and widths (`linesKey`) were:

- `pages-100`: `1ff685de5d42…`, for both kernels, in Chromium, Edge, Firefox, WebKit and Node.js;
- `pages-1000`: `b14196b99d30…`, likewise.

`test/kernel.test.ts` checks the agreement in Node.js on `pages-20`: identical breaks, widths within 0.01 pt, lines that cover each paragraph and fit except unbreakable pieces, and hyphenation only when asked. The two kernels agree although their UAX #14 implementations come from different projects (`linebreak` 1.1.0 and `unicode-linebreak` 0.1.5 for Unicode 15.0) and their shapers are different code (S5 §3.5).

### 3.5 Engineering cost

| | TypeScript kernel | Rust kernel |
|---|---|---|
| Own code, non-blank lines | 238 TypeScript (kernel, first-fit, shaper wrapper) | 432 Rust and Cargo manifest, 203 TypeScript (loader and wrapper), 205 TypeScript build and licence scripts |
| Shared code | 179 lines (interface, metrics, paragraphs) | the same |
| Dependencies that ship | `harfbuzzjs`, `linebreak`, `unicode-trie`, `pako`, `tiny-inflate`, `base64-js` (MIT; licence gate passes; HarfBuzz's own notice to add) | 13 crates (MIT, Apache-2.0, Zlib, Unicode-3.0; every dual licence recorded as the MIT option), 8 more as build tools; English hyphenation patterns with their notice |
| Build | none beyond the application's Vite build | Rust 1.85 or later with `wasm32-unknown-unknown` and a host linker: two clean builds of both variants took 49.4 s and 96.4 s on the development machine under different load (crates already downloaded; `scripts/build-wasm.ts`, the second recorded in `wasm/bin/build.json`), an incremental one about 1.5 s |
| CI | none new | a Rust job: toolchain, target, `cargo` registry access, `scripts/build-wasm.ts` and its crate licence check, and a check that the committed module matches the source |
| Skills | TypeScript only | Rust, Cargo, WebAssembly linking and a hand-written C ABI (roadmap §8 lists none of these) |

## 4. Choices made where the spec is silent

| Point | Choice | Where |
|---|---|---|
| The kernel's boundary | One call per paragraph, with the S7 measurement interface beside it for advances and caret positions | `src/kernel/types.ts` |
| Paragraph input | Text inlines joined; a line break is U+2028 (mandatory in UAX #14), a tab a space, boxes left out; runs split where the face or the script class changes (CJK text takes the CJK face, as a browser's fallback would); width of the column or cell less the indents; the first-line indent ignored | `src/kernel/paragraphs.ts` |
| First-fit details | Trailing spaces hang; a piece wider than the line on an empty line overflows (no emergency break inside a word); the end of the text is a mandatory break, which `linebreak` 1.1.0 does not mark and UAX #14 rule LB3 does | `src/kernel/first-fit.ts`, `wasm/text-kernel/src/lib.rs` |
| Hyphenation | Rust kernel only, English patterns, words of five or more letters, the last hyphenation point whose prefix and hyphen still fit; off unless asked (02 §9.3) | `lib.rs` |
| Cache | Per kernel, keyed by face and text, in font units (sizes scale afterwards); emptied for a cold start. A production cache also needs the font epoch (02 §9.3) | both kernels |
| Typing simulation | A letter inserted at a pseudo-random place in a pseudo-random `pages-100` paragraph (a fixed sequence), every tenth keystroke into the longest paragraph; only the changed paragraph is posted (02 §9.5) | `src/browser/s10-page.ts` |

## 5. Not covered, and why

- **The rest of the page view.** Pagination, painting and the input bridge are not measured; their shares of the budget are assumed (§2).
- **The corpus's vocabulary.** The corpus is generated from short word lists: `pages-100` has only 2,902 distinct pieces of text per face. Real documents have more, so they miss the segment cache more often, and cold passes cost more than here.
- **Korean.** Korean text is shaped with the CJK face's missing glyph (no Hangul face is in the manifest, S5 §3.0). That is enough to measure time, not widths.
- **Edge cases of breaking.** Hyphenation in other languages, the Unicode version of `linebreak` 1.1.0, emergency breaks, bidirectional text and complex scripts are not covered.
- **Real fallback paths.** Instantiating under a blocking content security policy was S2's work. Here the fallback is only named.
- **Optimised Rust builds.** `wasm-opt` was not available; the Rust module's size could shrink with it.

## 6. Recommendation

1. **Kernel.** Use harfbuzzjs as the page view's only WebAssembly, with UAX #14 and first-fit line breaking in TypeScript: the `ts-kernel` prototype. It becomes FE-079, FE-080 and FE-081 in the layout core forked in S7, with `linebreak` as the borrow list planned. WASM-002 and the other stories of condition C-RUST do not start.
2. **Boundary.** `breakParagraph` per dirty paragraph inside the layout worker, plus the S7 `TextMeasurer` for advances and caret positions. The cache key adds the font epoch (02 §6, §9.3).
3. **Fallback.** A canvas-backed shaper behind the same interface in Chromium, Edge and WebKit. In Firefox, the web view with a message (S5). Detect a refused compile in the kernel.
4. **Background pagination.** Slice it so that a keystroke never waits behind a batch: 200 paragraphs held the worker for up to 29 ms here, so FE-089 should post smaller batches or yield between paragraphs.
5. **Hyphenation.** If wanted later (02 §9.3: off by default), add it in TypeScript, after the per-language pattern audit of the borrow list (§11), rather than moving to Rust for it.
6. **When to revisit Rust.** Only by ADR 0016 decision 4: a page-view budget missed on the reference machine, with a profile that shows shaping or segmentation. Or when phase 4's bidirectional text and complex scripts need ICU4X's data.
7. **Ship HarfBuzz's own licence notice** with `harfbuzz.wasm` (borrow list §2).

ADR 0016 is updated with this result ("Result of S10").
