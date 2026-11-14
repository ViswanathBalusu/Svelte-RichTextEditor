# Spike S5: how to measure text for the page view

**Status:** spike result, 2026-11-06, SPK-018; not reviewed by the project owner.

## Question

Should the page view's layout engine measure text with canvas `measureText`, or compute advances from the font files with a shaper compiled to WebAssembly (11 §2, S5; 02 §6, §9.3; ADR 0005; ADR 0016)? ADR 0016 widened the spike to two shapers: HarfBuzz's own WebAssembly build (harfbuzzjs) and HarfRust compiled to WebAssembly. The test is 02 §9.3's: painted line widths must match computed widths within half a pixel, per browser.

## Answer

**Measure from the font files.** On 2,361 corpus lines in the manifest's fonts:

1. **HarfBuzz's widths match painted text in all four engines for Latin text.** The largest difference on any Latin line was 0.297 px in Chromium and Edge, 0.260 px in Firefox and 0.001 px in WebKit (§3.2). Each engine's painted width is HarfBuzz's advances with its own rounding: exact in WebKit, rounded per glyph to 1/60 px in Firefox (Gecko's app units), and mostly rounded to 1/64 px in Blink (§3.3).
2. **Canvas fails the half-pixel test in Firefox.** In Chromium, Edge and WebKit, canvas matches painted text within 0.08 px for Latin lines. In Firefox only 40.6 % of lines are within 0.5 px (median 1.08 px, maximum 3.18 px), and the error depends on the font size (§3.1). Canvas also gives different widths in different engines, which is review finding F9.
3. **Both shapers give identical results everywhere.** The digests of every glyph, cluster and advance are equal in Chromium, Edge, Firefox, WebKit and Node.js, and HarfRust equals harfbuzzjs glyph for glyph on every line (§3.5).
4. **The painter renders the shaper's ligatures and kerning.** On the 1,434 lines whose width the fonts' ligatures and kerning change (median −1.79 px), painted DOM text changes by nearly the same amount in each engine (median −1.77 to −1.79 px), and every Latin line stays within 0.5 px of the shaper (§3.4).

The exception is **CJK text** (28 lines here). The painted text there follows engine-specific rules that neither canvas nor HarfBuzz applies by default: Chromium trims the spacing of adjacent full-width punctuation (fixed with `text-spacing-trim: space-all`), while Firefox and WebKit differ by up to 3.52 px and 1.61 px (§3.2). CJK in the page view needs its own plan, as 02 §11 already says.

**Fallback when the host blocks WebAssembly** (S2: compiling needs `'wasm-unsafe-eval'` in the policy of the compiling context, and WebKit refuses without reporting, so the kernel must catch the failure itself):

- In Chromium, Edge and WebKit, use canvas measurement. It matched painted Latin text within 0.08 px.
- In Firefox, the element stays in the web view and says why. Canvas there misses the tolerance on most lines.

Which shaper, and where line breaking lives, is S10's question (SPK-023; [S10 report](2026-11-06-s10-text-kernel.md)).

## What was built (kept, not throwaway)

| Part | Where |
|---|---|
| Font manifest: eleven OFL files copied from the TeX Live 2025 installation (Noto Serif, Noto Sans and Noto Sans Mono 2.004 to 2.006; Harano Aji Gothic 20231009), each with name, version, licence, licence text and SHA-256, checked against `licences/policy.json` | `packages/perf/fonts/`, `scripts/fonts.ts`, `src/fonts.ts` |
| Sample lines: corpus text cut by a fixed rule into segments of one face and size, itemised by script class | `src/lines.ts` |
| The two shapers behind one interface, with the module's compile, instantiate and memory exposed | `src/shapers/harfbuzz.ts` (harfbuzzjs 1.6.1), `src/shapers/harfrust.ts`, `src/shapers/types.ts` |
| A Rust crate with HarfRust 0.15.0 and a plain C ABI, built for `wasm32-unknown-unknown` in two variants (shaper only for S5, full kernel for S10); a licence check of its crates against the same policy | `wasm/text-kernel/`, `wasm/bin/`, `scripts/build-wasm.ts`, `scripts/cargo-licences.ts` |
| The measurement page: canvas, painted line boxes in four CSS variants, both shapers, compile and memory | `pages/s5.html`, `src/browser/s5-page.ts`, `src/s5.ts` |
| The spec, per engine, and the analysis of rounding | `e2e/s5.spec.ts`, `scripts/s5-quantisation.ts` |
| Node.js tests: the shapers agree glyph for glyph, apply and switch off ligatures and kerning, cover the CJK lines | `test/shapers.test.ts`, `test/fonts.test.ts` |

## Evidence

Development machine (the reference machine of [ADR 0037](../adr/0037-reference-machine-and-throttling-profile.md)): Intel Core i9-10900KF, 128 GiB, Windows 11 Pro 10.0.26300. Other agents' builds and tests kept the machine busy during the two runs: the operating system's counters gave 34 % to 94 % of all 20 logical processors busy, recorded in each result as `machineBusy`. Widths do not depend on load; times do. Commands run from the repository root (PowerShell, pnpm on the path):

```
node packages/perf/scripts/fonts.ts
node packages/perf/scripts/build-wasm.ts
pnpm exec playwright test -c packages/perf/playwright.config.ts s5 --project=chromium --project=msedge --project=firefox --project=webkit
node packages/perf/scripts/s5-quantisation.ts
node packages/perf/scripts/kernel-sizes.ts
pnpm exec vitest run --project node packages/perf
```

Results: `packages/perf/test-results/s5/<engine>.json`, `s5/lines/<engine>.json` (every line's widths), `s5/quantisation.json`, `s10/sizes.json` and `wasm/bin/build.json`. Engines: Chromium 158.0.8127.18, Firefox 159.0 and WebKit 27.2 (Playwright 1.65's builds), and the installed Microsoft Edge 156.0.4314.58. Corpus version 2 (fingerprint `dd2dac5a`), stamped in every result.

### 3.0 Lines and fonts

- **Lines.** All of `pages-20` and the first 1,500 lines of `pages-100`: 2,400 lines, 2,361 kept (2,333 Latin, 28 CJK). Lines of at most 90 characters cut at a space, or 38 characters of CJK text; a line keeps its runs' faces and sizes (10 to 21.3 px).
- **Dropped lines.** 39 lines were dropped because a character is not in its face: the list bullets ◦ and ▪, which Noto Serif lacks, and simplified Chinese characters that Harano Aji Gothic, a Japanese face, lacks. Korean lines are left out entirely.
- **Fonts.** The corpus families themselves: Noto Serif, Noto Sans and Noto Sans Mono (5,673,284 bytes for the ten Latin files). For CJK, Harano Aji Gothic Regular (4,723,208 bytes), a Source Han Sans derivative and the only CJK OFL face on the machine.
- **Refused font.** NanumGothic 3.020, installed in Windows, was refused: its `name` table states "NHN Corporation", not the OFL.
- **How a line is painted.** In its own box with `white-space: pre`, one span per segment, as 02 §9.3 describes the painter; the width is the box's `getBoundingClientRect().width`.
- **How a line is computed.** Canvas: the sum of `measureText` over the segments, on a DOM canvas in the same font faces. Shapers: the sum of the segments' advances, scaled from font units.

### 3.1 Canvas against painted text

Difference canvas − painted, CSS and canvas both at their defaults, in CSS pixels:

| Engine | Median abs. | 95th percentile abs. | Maximum abs. | Lines within 0.5 px | Latin lines: maximum |
|---|---:|---:|---:|---:|---:|
| Chromium 158 | 0.007 | 0.027 | 1.612 | 99.66 % | 0.080 |
| Edge 156 | 0.007 | 0.027 | 1.612 | 99.66 % | 0.080 |
| Firefox 159 | 1.083 | 1.567 | 3.183 | 40.58 % | 3.183 |
| WebKit 27.2 | 0.000 | 0.000 | 1.614 | 99.79 % | 0.000 |

- **Firefox.** The error follows the font size: none at 12 px, a median of −1.45 px at 14.667 px (11 pt), +0.18 px at 13.333 px (10 pt) and +1.13 px at 18.667 px (14 pt). No per-glyph rounding of HarfBuzz's advances that the analysis tried reproduces it, so the cause is not established.
- **Kerning and ligature controls.** Every engine has `fontKerning` and `textRendering` on the 2D context, but canvas has no ligature control. With kerning and ligatures off in CSS, canvas at its defaults is 0.69 px off at the median in Chromium. `optimizeSpeed` makes WebKit's canvas match unkerned, unligatured text exactly (maximum 0.001 px); in Chromium it does not (median 0.30 px).
- **No OffscreenCanvas in WebKit.** WebKit's Windows build has no `OffscreenCanvas`.

### 3.2 HarfBuzz against painted text

Difference harfbuzzjs − painted, default features and default CSS:

| Engine | Median abs. | 95th percentile abs. | Maximum abs. | Lines within 0.5 px | Latin lines: maximum | CJK lines: maximum |
|---|---:|---:|---:|---:|---:|---:|
| Chromium 158 | 0.137 | 0.281 | 7.581 | 99.92 % | 0.297 | 7.581 |
| Edge 156 | 0.137 | 0.281 | 7.581 | 99.92 % | 0.297 | 7.581 |
| Firefox 159 | 0.047 | 0.166 | 3.520 | 99.36 % | 0.260 | 3.520 |
| WebKit 27.2 | 0.000 | 0.001 | 1.613 | 99.79 % | 0.001 | 1.613 |

Every line over 0.5 px is a CJK line.

- **Chromium and Edge.** The two lines at 7.6 px contain 「…」や『…』; Chromium's default `text-spacing-trim: normal` narrows that punctuation. With `text-spacing-trim: space-all` on the painter, every line is within 0.5 px (maximum 0.297 px, CJK maximum 0.252 px).
- **Firefox.** With kerning and ligatures off on both sides, every line is within 0.5 px (maximum 0.273 px; CJK 0.011 px). So Firefox does not apply the CJK face's kerning by default, and HarfBuzz does. Naming kerning and ligatures explicitly (`font-kerning: normal; font-variant-ligatures: common-ligatures contextual`) makes Firefox's CJK lines up to 60 px narrower than HarfBuzz; the painter must not set that.
- **WebKit.** Painted CJK lines are up to 1.61 px wider than both canvas and HarfBuzz, which agree with each other.
- **Latin text.** Naming kerning and ligatures explicitly changes nothing for Latin text in any engine.

### 3.3 Why Latin text agrees: each engine's rounding of HarfBuzz's advances

`scripts/s5-quantisation.ts` recomputes each Latin line from harfbuzzjs's advances, rounded per glyph to a step, and compares the result with the painted width:

| Engine | Exact advances: median / maximum | Rounded to 1/64 px | Rounded to 1/60 px |
|---|---|---|---|
| Chromium 158 | 0.138 / 0.297 | 0.031 / 0.250 | 0.183 / 0.508 |
| Firefox 159 | 0.046 / 0.260 | 0.163 / 0.470 | 0.0003 / 0.0003 |
| WebKit 27.2 | 0.0003 / 0.0010 | 0.096 / 0.303 | 0.047 / 0.260 |

- **WebKit** paints HarfBuzz's advances unrounded.
- **Firefox** rounds each glyph's advance to 1/60 px, and that reproduces its painted widths to 0.0003 px.
- **Blink** behaves mostly like rounding to 1/64 px. The rest is not explained here.

The Blink offset depends on the size: lines at 14.667 px are about 0.25 px narrower than HarfBuzz, while lines at 13.333 px agree. On a line much wider than A4's text width it could pass 0.5 px. A kernel that must hold the tolerance in Blink on wide pages can apply the 1/64 px rounding when it sums.

### 3.4 Ligatures and kerning

On the 1,434 lines whose width changes when kerning and ligatures are turned off in the shaper:

| | Chromium and Edge | Firefox | WebKit |
|---|---:|---:|---:|
| Median shaper effect (default − off), px | −1.789 | −1.789 | −1.789 |
| Median painter effect (CSS default − CSS off), px | −1.781 | −1.767 | −1.789 |
| Lines within 0.5 px of the shaper | 99.86 % | 98.95 % | 99.65 % |

The lines over 0.5 px are CJK lines (§3.2). `test/shapers.test.ts` checks the mechanism in Node.js: "fi" is one glyph with ligatures and two without, and "AV" is narrower with kerning, in both shapers.

### 3.5 The two WebAssembly shapers

| | harfbuzzjs 1.6.1 (HarfBuzz 14.4.0) | HarfRust 0.15.0, shaper-only module |
|---|---|---|
| WebAssembly file, bytes (gzip level 9 / Brotli 11) | 426,620 (174,282 / 142,327) | 1,094,813 (376,958 / 291,012) at `opt-level = 3`; 943,827 (325,211 / 256,542) at `opt-level = "z"`; no `wasm-opt` |
| Compile from bytes, first of 5 runs, ms, two runs: Chromium / Edge / Firefox / WebKit | 0.97 and 0.77 / 6.78 and 1.13 / 3.86 and 6.70 / 13.78 and 14.20 | 1.44 and 1.42 / 2.32 and 2.63 / 5.92 and 9.94 / 9.38 and 6.14 |
| Instantiate, ms (Chromium, both runs) | 0.21 to 0.37 | 0.13 and 0.20 |
| Import of the module in the page (fetch, compile, instantiate, set-up), ms, two runs: Chromium / Edge / Firefox / WebKit | 65.0 and 62.0 / 82.0 and 110.4 / 25.8 and 43.3 / 66.5 and 101.2 | not applicable: fetch 7.7 to 16.1 ms in the second run, then compile and instantiate as above |
| Linear memory: empty / after the ten Latin faces and 2,333 lines / after the CJK face and 28 lines, bytes | 262,144 / 6,881,280 / 12,779,520 | 1,179,648 / 7,274,496 / 12,058,624 |
| Shaping all 2,361 lines twice (defaults, then kerning and ligatures off), ms (Chromium, two runs) | 100 and 94 | 92 and 93 |
| Same digests in all four engines and Node.js | yes | yes |

- **Memory.** The memory figures are the same in every engine. Each module holds a copy of every face's file, which is the second copy ADR 0016 expects next to the browser's own: 5.7 MB for the Latin faces and 4.7 MB for the CJK face.
- **Compile times.** The compile times are small because the engines compile lazily or in the background. The cost of a first call lands in the first shaping calls and in the import time.
- **Load during the runs.** The two runs had the machine 34 % to 68 % and 55 % to 94 % busy, so the times are indicative. Widths, digests and memory were identical in both runs.

## Input from S4 (SPK-017)

The LaTeX spike reports that luaotfload's HarfBuzz mode gives the same line breaks as its node mode on the corpus. In HarfBuzz mode, though, ligatures come out of the PDF as presentation forms (U+FB01 for "fi"), which breaks a check that the extracted text equals the input.

- **For S5.** Choosing HarfBuzz in the editor does not oblige the house class to use HarfBuzz mode. The breaks were the same either way.
- **If the class does use HarfBuzz mode,** the editor and the typesetter shape with the same engine on the same files (02 §6; ADR 0016), and the PDF needs ActualText or a ToUnicode mapping for ligatures. That is an export and tagged-PDF question (EXP), not a measurement one.

## Choices made where the spec is silent

| Point | Choice | Where |
|---|---|---|
| Which fonts | The corpus's own families from TeX Live 2025, unmodified; Harano Aji Gothic for CJK; no Korean face (none on the machine with a licence the policy allows) | `scripts/fonts.ts`, fonts manifest |
| Which lines | A fixed cut of corpus text, independent of any measurer, so every engine measures the same strings; segments split where face, size or script class changes | `src/lines.ts` |
| What "painted width" is | The layout width of the line's box (`getBoundingClientRect`), which is where the painted glyphs end; ink overhang is not measured | `src/browser/s5-page.ts` |
| Shaping unit | One shaping call per segment, as the browsers shape each span separately | `src/s5.ts` |
| HarfRust's ABI | A plain C ABI with input and output buffers the module owns, no `wasm-bindgen`; the crate has no unsafe blocks, and the lint is allowed only for `#[no_mangle]` on the exports | `wasm/text-kernel/src/lib.rs` |

## Not covered, and why

- **Safari on macOS.** WebKit ran as Playwright's Windows build; Safari's text stack on macOS (Core Text) is not measured. The macOS job of CI is needed (as for FND-005).
- **Korean and simplified Chinese.** No OFL face on the machine covers them. CJK in general has only 28 lines here.
- **Other painting cases.** Zoom levels and device scale factors other than 1, justification, letter and word spacing, superscripts, variable fonts, emoji, bidirectional text and the system fallback fonts are not measured.
- **Production CSS.** The painter's production CSS is not measured; the variants measured are the four in `s5-page.ts`.
- **Painting with the shaper's own glyph positions.** Not tried, because the DOM painter paints text, not glyphs (ADR 0005).
- **Firefox's canvas error.** Its cause is not found.

## Recommendation

1. **Measurement.** Choose font-file measurement with a HarfBuzz-compatible shaper for the page view (ADR 0016 decision 3), on the manifest's files (02 §6). S10 decides between harfbuzzjs with breaking in TypeScript and one Rust module.
2. **The painter's CSS.** Keep the CSS defaults for kerning and ligatures, which match HarfBuzz's defaults in all four engines, and add `text-spacing-trim: space-all` for Blink. Do not name `font-variant-ligatures: contextual` or `font-kerning: normal`: they break Firefox's CJK.
3. **Tests.** Add the Latin half-pixel check of 02 §9.3 to FE-094 with this page's method. Track the Blink offset on wide pages and at other zoom levels.
4. **Fallback.** Without WebAssembly: canvas in Chromium, Edge and WebKit; the web view in Firefox.
5. **CJK.** Give CJK in the page view its own story (02 §11), starting from §3.2: punctuation trimming, kerning and Firefox's and WebKit's spacing.
6. **Supply chain.** Record HarfBuzz's own licence notice for `harfbuzz.wasm`, which the npm package lacks (borrow list §2), when it ships.
