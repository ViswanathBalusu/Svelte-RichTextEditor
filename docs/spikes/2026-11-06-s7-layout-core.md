# Spike S7: adopt, fork or build the layout core

**Status:** spike result, 2026-11-06, SPK-020; not reviewed by the project owner.

## Question

Can an existing permissively licensed layout core be driven from CDM flow blocks, so that the project does not write a layout engine it could fork (11 §2, S7; 02 §9.1; ADR 0005; ADR 0016)? The candidates are Eigenpal's Apache-2.0 core, canvas-editor and Docen (research summary §1), and the Rust candidates of ADR 0016: Typst's layout crates, Parley and cosmic-text.

## Answer

**Fork.** Fork the block and flow layers of Docen's layout core (`@docen/layout`, MIT) into `@docedit/layout`, and write the text layer under them ourselves: segmentation, line packing and measurement behind the injected interface. Do not adopt or fork Eigenpal's core; use it as a reference design. The Rust candidates are text kernels for S10 (SPK-023), not page-layout cores.

The main reasons, with the evidence in sections 3 and 4:

1. **Both leading candidates can be driven from CDM flow blocks.** The prototype lays out five documents with each candidate, and every body paragraph's lines cover its CDM range without gap or overlap.
2. **Docen's input already is the flow-block shape of 02 §9.1.** Its `LayoutDoc` holds paragraphs and tables with resolved formatting in pixels, so its adapter is a unit conversion. Eigenpal's layout reads only its own OOXML tree, parsed from DOCX bytes. Driving it from CDM meant writing a WordprocessingML projection of every document, and a live page view would have to keep a second document model in step with every edit.
3. **Docen's measurement cannot be injected, but the gap is small and well defined.** Horizontal advances come from a canvas context that its vendored `@docen/pretext` creates at module level. Bold CJK widths are corrected from a hidden DOM span, and line fitting depends on a user-agent sniff. The prototype shows the effect: with a deterministic stub, one line of one document differs between Node.js, Chromium and Firefox. A fork replaces this layer; it is the same layer S10 must decide anyway.
4. **Eigenpal is the better engine but not a usable base.** Its measurement is injected through `TextMeasurer` and `TextShaper`, and its trees were identical in Node.js and three browsers. It is also the more complete engine: footnote reflow with continuation, column balancing, incremental sessions, hit testing and the caret. Against that:
   - its npm package ships only minified bundles, with no source maps;
   - its source sits in a repository that was re-created in July 2026, beside directories under an evaluation licence (borrow list §9.1);
   - it is OOXML-shaped throughout;
   - on the same documents it was 13 to 25 times slower than Docen with the same stub measurers (§3.4).
5. **Docen is small, readable and fast.** It is 2,630 lines of unminified ESM, with the TypeScript source and tests on GitHub under MIT. On this machine it laid out 100 pages in about 0.35 s from cold.

The fork is a head start, not a finished engine. The work it leaves is listed in §5.2, story by story.

## 1. What was built (kept, not throwaway)

| Part | Where |
|---|---|
| Injected measurement interface (`advance`, optional per-unit `advances`, `lineMetrics`), two deterministic stubs (fixed width; a synthetic table of advances), a cache keyed by font, size, text and font epoch, and a call counter | `packages/layout/src/measure.ts` |
| CDM to engine-neutral flow blocks, in points, with CDM offsets on every inline: the cascade of 03 §6, numbering labels as literal text (03 §7), footnotes, tables, figures, contents entries, regions, sections and their page setups, header and footer stories | `packages/layout/src/flow.ts` |
| The project's layout tree (02 §9.2): pages, fragments, lines and table rows, each with block identifier and CDM offsets; freezing, a stable serialisation and digest, a summary, and a coverage check | `packages/layout/src/tree.ts` |
| Candidate 1 adapter: flow blocks to Docen's `LayoutDoc`, the measurement bridge, and Docen's result back to the tree | `packages/layout/src/docen.ts` |
| Candidate 2 adapter: flow blocks to a WordprocessingML package with an offset map, Eigenpal's `TextMeasurer` bridged to ours, and Eigenpal's records back to the tree | `packages/layout/src/ooxml.ts`, `zip.ts`, `eigenpal.ts` |
| Tests | `src/flow.test.ts`, `src/layout.universal.test.ts`, `src/canvas.universal.test.ts`, `test/benchmark.test.ts` |

The package is universal: lib ES2023 with no ambient types, and no DOM or Node.js API in `src/` (FND-004); dependency-cruiser reports no violation. Text is encoded through `@docedit/model`'s platform helper. The candidates are dependencies of this spike package only: `@docen/layout` 0.7.0, `@docen/pretext` 0.7.0 and `@docx-editor.dev/core` 2.35.0, all exact. When FE-076 starts they are removed, or Eigenpal is kept as a test-only reference (§6).

## 2. The candidates on paper

Registry data from `npm view` and the crates.io API, repository data from the GitHub REST API, all on 2026-11-06. Licence texts were read from the npm tarballs; the borrow list (SPK-026) checked the repositories' licence files. "Maintenance" uses the borrow list's definitions.

| Candidate | Version (released) | Licence | Maintenance and provenance | What it is | Fit as the layout core |
|---|---|---|---|---|---|
| Eigenpal `@docx-editor.dev/core` | 2.35.0 (2026-11-05) | Apache-2.0 (tarball `LICENSE`, "Copyright 2026 EigenPal Inc."); repository `NOASSERTION` because of the licence scope notice | Active and fast-moving: first published 2026-07-16, six minor releases from 2.30.0 (2026-10-14) to 2.35.0, plus canaries. One npm maintainer. Repository re-created on 2026-07-20 (identifier 1306326204) with rewritten history; licence MIT, then Apache-2.0, then Apache-2.0 with four directories under the EigenPal Pro Evaluation License (borrow list §9.1) | A DOCX editor engine: OOXML parse and serialise, a canonical OOXML tree, DOM-free layout (`./layout`, `./export`), a DOM painter (`./output`) | Prototyped. Excellent engine, wrong input model, minified only (§3, §4.2) |
| Docen `@docen/layout` with `@docen/pretext` | 0.7.0 (2026-09-07) | MIT, both (tarball `LICENSE`; pretext also credits `@chenglou/pretext` 0.0.8, MIT) | Early. Four releases since 0.6.0 (2026-08-30). Repository `DemoMacro/docen` created 2025-10-25, last push 2026-10-29, 69 stars, 4 open issues, no tags. One author wrote 918 of the repository's commits; one other contributor wrote 18 | Pure-TypeScript block layout (paragraphs, tables) and a paginator, for Docen's canvas editor | Prototyped. Right input model, measurement not injectable (§3, §4.1) |
| canvas-editor `@hufe921/canvas-editor` | 1.1.0 (2026-11-06) | MIT | Active since 2021-11; 5,259 stars, 22 open issues; one author wrote 1,418 commits | A canvas or SVG rich-text editor over a flat list of character elements | Paper only (below) |
| Typst `typst-layout` | 0.15.1 (2026-07-17) | Apache-2.0 | Active: Typst project, 57,017 stars, 1,336 open issues | Typst's layout, bound to `typst-library` (content, styles, introspection) and `comemo` memoisation | Paper only (below) |
| Parley | 0.12.0 (2026-10-09) | Apache-2.0 OR MIT | Active: Linebender, 775 stars, 120 open issues | Paragraph text layout: shaping, segmentation, bidi, line breaking, alignment | Paper only: a text kernel for S10 |
| cosmic-text | 0.19.0 (2026-04-22) | MIT OR Apache-2.0 | Slow by release (6.5 months), active by commit (2026-10-27): System76, 2,186 stars, 126 open issues | Text buffers with shaping, wrapping, font fallback and an editor | Paper only: a text kernel for S10 |

No copyleft project was a candidate, and none was read for this spike. SuperDoc and ONLYOFFICE (AGPL-3.0) appear only in the research summary's description; no code was opened or copied (risk 10).

### 2.1 How each candidate shapes and measures text, and whether measurement can be injected (02 §9.1)

| Candidate | Shaping and measurement | Injectable? |
|---|---|---|
| Eigenpal | Through two injected interfaces: `TextMeasurer` (`measure(text, style)` and `lineMetrics(style)` required; optional `caretAdvances`, `inkBounds`, `textOutline`) and `TextShaper`. The real implementations shape with HarfBuzz (`harfbuzzjs` 1.6.1, `dist/harfbuzz.wasm` of 426,620 bytes) or measure with canvas (`tryCreateCanvasMeasurer`). Segmentation uses `Intl.Segmenter` (word and grapheme granularity) with kinsoku rules; no UAX #14 table was found in the bundles (their `LineBreak` names are Word's kinsoku settings) | **Yes.** The prototype passes the project's measurer through a 30-line bridge (`bridgeMeasurer`) |
| Docen | Vertical metrics through an injected `FontMetrics` (`normalRatio` only). Horizontal advances from `@docen/pretext`, which calls `measureText` on a canvas context it creates on first use from `OffscreenCanvas` or `document` and caches at module level. Pretext also corrects bold CJK and emoji widths from hidden DOM spans, and sets its line-fit tolerance and three breaking rules from a user-agent sniff (`getEngineProfile`). Segmentation is `Intl.Segmenter` (word granularity) plus pretext's own rules. The README names UAX #14 (`linebreak.js`), but release 0.7.0 imports no such package. No shaping: "advances run slightly wide" without ligatures | **No.** Docen's own tests fake the canvas (`packages/layout/test/fake-canvas.ts` in its repository). The prototype does the same with a forwarding `OffscreenCanvas` installed through `globalThis` (`docen.ts`) |
| canvas-editor | Canvas `measureText` through a `TextMeasurer` class that wraps a `CanvasRenderingContext2D`. `LayoutEngine.computeRowList` creates a DOM canvas itself (`document.createElement("canvas")`) and takes the editor's whole `Draw` object as its context | **No**, without a fork of `Draw` and `LayoutEngine` |
| Typst | Shapes from the font files with rustybuzz 0.20 (archived; borrow list §10), reads fonts with ttf-parser, segments with ICU4X (`icu_segmenter`), breaks paragraphs with Knuth and Plass, hyphenates with hypher | **No.** Measurement is the engine's own reading of font files |
| Parley | Shapes with HarfRust 0.12 through `parley_engine`, reads fonts with skrifa, segments with ICU4X, finds fonts with fontique (system fonts or registered bytes) | **No**: it *is* a measurement and line-breaking kernel |
| cosmic-text | Shapes with HarfRust 0.5, finds fonts with fontdb, breaks lines with `unicode-linebreak`, orders bidi text with `unicode-bidi`; rasterises with swash (optional) | **No**: also a kernel |

### 2.2 How each maps from CDM flow blocks

- **Eigenpal.** Not directly. `layoutSemanticDocument(part, revision, options)` takes an `OoxmlPart`, a typed tree of WordprocessingML nodes. The public ways in are DOCX bytes (`openDocumentForExport`, `openHeadlessDocument`) or a live view of that tree that is edited through Eigenpal's own tree operations. The prototype therefore writes each flow document as a package (`ooxml.ts`: direct formatting, literal numbering labels, sections, headers and footers, footnotes, tables with vertical merges, one shared picture) and maps the results back. Eigenpal names paragraphs by structural path (`/word/document.xml#0.0.7`) and lines by UTF-16 ranges; the projection keeps an offset map. In none of the ten cases of the universal test, in any environment, did Eigenpal report an unknown paragraph or a range beyond the map. The projection is 8 to 30 ms per document, but a live page view would mirror every edit into an OOXML tree: a second document model next to the one ProseMirror edits.
- **Docen.** Directly. `LayoutDoc` blocks are paragraphs (inline text runs with resolved styles, tabs, breaks, pictures, note references, page fields; spacing, indents, tab stops, keep rules), tables (grid, spans, insets, header rows, `cantSplit`), page and column breaks and placeholders. Sections carry page geometry, columns, header and footer insets and footnote definitions. Two gaps: the input has no block identifiers, and the output gives a line's content as whitespace-collapsed text per inline item rather than offsets. The adapter recovers identity through the inline arrays, which Docen passes through unchanged, and recomputes CDM offsets from the painted text (`consume`, `offsetAt` in `docen.ts`). A fork carries identifiers and offsets natively.
- **canvas-editor.** Through a flat array of per-character `IElement` records with nested tables. There are headers, footers and page numbers, but no footnotes, keep rules, widow control or page sections with their own size. The mapping would flatten the CDM and lose the block structure the layout tree needs (02 §9.2). Read for ideas: canvas caret, hit testing and input-method handling.
- **Typst.** By generating Typst content, then reading positioned frames back. That adopts Typst's document model, styling and pagination rules; it would be a second typesetter beside LaTeX (ADR 0007). It is the reference for a TeX-like paragraph builder (assessment §5), not a layout core for this editor.
- **Parley and cosmic-text.** Paragraph by paragraph only: no pages, tables, footnotes or sections. They fit under the forked core as the text kernel S10 evaluates (§6).

## 3. Prototype evidence

Run from the repository root. In PowerShell, put pnpm on the path first (CLAUDE.md).

| Command | What it runs |
|---|---|
| `pnpm exec vitest run --project node packages/layout` | Flow conversion tests and the universal layout tests in Node.js |
| `pnpm exec vitest run --project browser packages/layout` | The universal tests again in Chromium 158, Firefox 159 and WebKit 27.2 (Playwright builds, through Vitest's browser mode), plus the browser measurer test |
| `$env:DOCEDIT_S7_BENCH='1'; pnpm exec vitest run --project node packages/layout/test/benchmark.test.ts` | The timings of §3.4; writes `packages/layout/test-results/s7-benchmark.json` |

Documents: the example of 03 §12 and the kitchen sink from `packages/model/fixtures`, and `pages-1`, `form-fields` and `pages-20` from the shared corpus (`@docedit/corpus` version 1, fingerprint `528ab574`), loaded with `loadDocument`, which checks each document against the manifest's hash. `pages-100` is used for timings only.

### 3.1 Driven from CDM flow blocks, with stub measurers

Every case passes the coverage check: every body paragraph has lines, in order, covering its CDM range without gap or overlap, across pages. Every case is also deterministic (two runs give the same digest) and the tree is frozen.

| Document | Docen, fixed stub | Eigenpal, fixed stub | Docen, table stub | Eigenpal, table stub |
|---|---|---|---|---|
| Example of 03 §12 | 1 page, 3 lines | 1, 3 | 1, 3 | 1, 3 |
| Kitchen sink (two sections) | 2, 13 | 2, 13 | 2, 13 | 2, 13 |
| `pages-1` | 1, 33 | 1, 33 | 1, 32 | 1, 32 |
| `form-fields` | 1, 29 | 1, 29 | 1, 27 | 1, 27 |
| `pages-20` (manifest estimate: 22 pages) | 18, 966 | 17, 1,026 | 19, 919 | 19, 971 |

With identical measurement the two engines agree on small documents and differ by about 6 % in line count on `pages-20`. On page 1 of `pages-1`, the first eight blocks start within 0.1 pt of each other in the two engines; from the table on, Eigenpal's blocks sit about 10 pt lower. The differences come from Word-like details each engine settles its own way: whitespace collapsing, the size of superscript note marks, spacing collapse and keep rules. Neither follows the house LaTeX class; both follow Word.

### 3.2 The same results in every environment

The universal test compares each result with the one recorded in Node.js 22.18. **Eigenpal produced identical trees, digest for digest, in Node.js, Chromium, Firefox and WebKit, for all ten cases. Docen did so for nine.** The tenth is `pages-20` with the table stub. The page and line counts are equal, but the line holding the bold Japanese heading 「日本語の見出し」 is 132.0 pt wide in Node.js, 126.6 pt in Chromium and 130.1 pt in Firefox. Pretext measures 「消」 wider than one em (the stub makes bold text 6 % wider), so in a browser it measures a hidden DOM span in the browser's own fallback font and subtracts the difference from every CJK glyph. No injected measurer reaches that code. The test marks this case as environment-dependent (`layout.universal.test.ts`).

### 3.3 With a browser measurer

`canvas.universal.test.ts` injects a measurer built on canvas `measureText`. It uses `OffscreenCanvas`, or a DOM canvas in WebKit's Windows build, which has no `OffscreenCanvas`; the test types it structurally, without the DOM library. It runs twice: with every family replaced by one font file loaded through `FontFace` (KaTeX Main Regular, MIT, from the installed `katex` package), and with the document's own families, which these browsers do not have. Results for `pages-20` (pages / lines):

| Run | Chromium 158 | Firefox 159 | WebKit 27.2 |
|---|---|---|---|
| Docen, injected canvas measurer, one font file | 19 / 909 | 19 / 914 | 19 / 909 |
| Eigenpal, injected canvas measurer, one font file | 18 / 958 | 18 / 959 | 18 / 958 |
| Docen, injected, document families (system fallback) | 17 / 884 | 17 / 883 | 17 / 884 |
| Eigenpal, injected, document families | 17 / 934 | 17 / 933 | 17 / 934 |
| Docen measuring with its own canvas path | 19 / 884 | 19 / 883 | 19 / 884 |

So both engines take a browser measurer through the injected interface, and canvas measurement is not identical across browsers even with one font file: Firefox differs by five lines (Docen) and one line (Eigenpal). This is input for S5 (SPK-018), not a finding about the cores. For `pages-1`, Eigenpal's trees were identical in all three browsers with both font set-ups, while Docen's differed per browser. Docen's own canvas path makes 19 pages instead of 17 with the same lines, because it then uses a fixed line-height ratio rather than the measurer's metrics.

### 3.4 Time and measurement calls

Development machine, not the reference machine of 13 §9: Intel Core i9-10900KF, 20 logical processors, 128 GiB, Windows 11, Node.js 22.18. Other agents' builds and tests were running on it at the same time, so the figures are indicative; the method is in the test and in the result file. Each pass is one adapter call after one warm-up pass. For Docen that covers conversion to `LayoutDoc`, layout and mapping back; for Eigenpal, the OOXML projection and ZIP, parse, layout and mapping back. The conversion from CDM to flow blocks is not included. Fixed stub; the table stub gives the same picture.

| Document | Docen, cold caches (median of 5) | Docen, warm module caches | Eigenpal (median of 3 for 20 pages; one pass for 100) | Eigenpal with `cachingMeasurer` |
|---|---|---|---|---|
| `pages-20` (18 or 17 pages) | 105 ms | 30 ms | 1,821 ms | 2,083 ms |
| `pages-100` (74 pages) | 348 ms | 103 ms | 5,508 ms | 5,635 ms |

| Document | Docen: calls to `advance` (code units) | Eigenpal: calls (code units) | Eigenpal: cache misses with `cachingMeasurer` |
|---|---|---|---|
| `pages-20` | 2,866 (11,065) | 541,504 (1,757,914) | 2,973 (18,166) |
| `pages-100` | 4,697 (20,912) | 1,528,778 (4,626,193) | 5,601 (40,542) |

- Eigenpal calls the measurer about 530 times per laid-out line, about three code units at a time, and leaves caching to the measurer. With a cache its misses fall to Docen's level, but its time does not, so its cost is its own layout work. A one-off split on the same machine, under heavier load, gave: projection 8 to 30 ms, parse 125 to 517 ms, layout the rest.
- Docen caches prepared paragraphs and segment widths at module level, keyed by the CSS font string alone. A second measurer in the same process is therefore served the first one's widths. The adapter tags every family with the measurer's identifier to avoid that, and the benchmark gives each cold pass a new identifier.
- In the browsers (§3.3) the same gap holds with canvas measurement: on `pages-20`, Docen took 196 to 247 ms and Eigenpal 3,364 to 5,883 ms.
- Not measured: incremental relayout after an edit (FE-088), which Eigenpal supports through its layout sessions and Docen does not have.

## 4. Findings about the candidates

### 4.1 Docen (`@docen/layout` 0.7.0, `@docen/pretext` 0.7.0)

1. **No horizontal measurement seam.** Pretext's `getMeasureContext()` creates and keeps one canvas context; it throws when neither `OffscreenCanvas` nor `document` exists.
2. **DOM probes.** Bold CJK and emoji widths are corrected from hidden DOM spans (pretext `measurement.ts`), and `browserFontMetrics` and `baselineShareOf` use DOM spans and a DOM canvas. These make layout depend on the browser's fonts even with an injected measurer (§3.2).
3. **Browser-dependent rules.** `getEngineProfile()` reads `navigator.userAgent` and changes the line-fit tolerance (1/64 px in Safari, 0.005 px elsewhere) and three breaking rules.
4. **Caches keyed by CSS font string** (`preparedCache`, `segmentMetricCaches`), with no measurer or font epoch in the key (§3.4).
5. **Segmentation by `Intl.Segmenter`**, whose results follow each engine's ICU data, not the bundled UAX #14 that 02 §9.3 and FE-080 require.
6. **Whitespace collapses** as in CSS `white-space: normal`. TeX also collapses runs of spaces; Word and the web view's ProseMirror keep them. This needs a decision (§7).
7. **Missing rules.** Footnotes are placed greedily on the page of their reference and never continue onto the next page (FE-084 criterion 3). Columns are never balanced (FE-085). A continuous section with a different page size takes the previous section's geometry. There is no dirty-block relayout (FE-088) and no decimal tab (laid out as a right tab).
8. **No block identifiers or document offsets** in input or output (§2.2).
9. **Painter assumptions.** Baselines follow LeaferJS's text formula, and some features exist for Chinese Word documents only (document grid, kinsoku compression, two-lines-in-one).

### 4.2 Eigenpal (`@docx-editor.dev/core` 2.35.0)

1. **OOXML is the only input** (§2.2). Property readers take `OoxmlNode` throughout (`readNumPr`, the drawing and projection tokens), so a fork could not swap the input layer without rewriting most of the cascade.
2. **Minified distribution.** The 30 ESM files (4,063,054 bytes) are 348 lines in all, with no source maps. The `./layout` entry reaches 7 files and 2,534,579 bytes, which include the OOXML parser and serialiser, and imports `fast-xml-parser` and `fflate`. The `./export` entry also reaches Node.js built-ins (`fs`, `path`, `url`) through dynamic imports, which the browser runs did not take. Forking needs the repository's source, which raises the provenance questions of borrow list §9.1 and legal note §7.
3. **API churn.** Six minor versions in three weeks, and a 190 KB declaration file for `./layout` alone.
4. **Speed** (§3.4).
5. **Strengths worth copying as designs.**
   - Measurement and shaping are injected separately.
   - Fixed-point rounding of font units (`FixedPoint`, `roundFontUnitToFixedPoint`) keeps results stable.
   - Layout sessions keep per-block cache keys and flow checkpoints, so a pass that changes nothing returns the previous pages by identity.
   - Footnote reserves are found by bounded reflow (`MAX_NOTE_REFLOW_ATTEMPTS`), with a named fallback.
   - Column balancing remembers its limit.
   - The records carry hit testing, caret and selection geometry.

   The layout records are precisely documented in the declaration files. Apache-2.0 allows reuse with notice, subject to counsel on provenance.

### 4.3 Defects the prototype found in itself and fixed

- Docen line offsets did not include a leading bookmark or numbering label; the first line now owns everything before its first printed inline.
- Captions of figures were not collected, so a list of figures had no entries; an empty list now keeps a "No entries found." line, as Word's does.
- Eigenpal's body records turned out to share one coordinate space (the page content box), not to nest; found by comparing positions with Docen on the same pages.

## 5. Recommendation

### 5.1 Fork Docen's block and flow layers; build the text layer

- **Fork** Docen's `layout-doc` types, `block/` (paragraph and table layout) and `flow/` (pagination) from the MIT TypeScript source in `DemoMacro/docen`. The repository has no tags, so pin by commit: the head on 2026-11-06 was `1890b15aae03`, newer than npm 0.7.0. Record the commit, the licence text and the author line in `NOTICE`, and bring Docen's own tests with the code.
- **Do not fork pretext.** Replace it with the project's text layer: a bundled UAX #14 implementation (`linebreak`, MIT, as 02 §9.3 and the borrow list already plan), first-fit packing over the injected `TextMeasurer` (02 §9.3), and caches keyed by font alias, size, text and font epoch. Remove the DOM probes and the user-agent sniff. This removes every cause of §3.2 and is exactly the boundary S10 decides (§6).
- **Change the types** so that flow blocks carry CDM block identifiers and offsets and the result is the layout tree of `tree.ts` (FE-077, FE-078). The prototype's `toFlow` becomes FE-077's converter once the cascade and the numbering algorithm live in `packages/model` (03 §6, §7).
- **Add what is missing**, using Eigenpal's published design as the reference where it has one: footnote placement by iteration with continuation, column balancing, incremental relayout from the first dirty block, background pagination in time slices, and reconciliation pins from `layout.json` (02 §9.7). Docen already has the per-page generator that time slicing needs (`layoutSectionsIncremental`).
- **Keep Eigenpal out of the product.** Neither adopt nor fork it. As a test-only reference it could answer the question that SPK-013 adds for Word files under A2: how far imported documents paginate from Word's rules. That use needs the licence gate's provenance check (FND-011) and counsel's view on the repository (legal note §7) first.

Why not adopt Eigenpal through the projection, which works? It would make the page view depend on a second document model, kept in step with every edit, from a minified single-vendor package whose licence changed twice this year, at a measured speed far from the 13 §9 page-view targets. Why not build from scratch? Docen's paginator already covers most of 02 §9.4, in a few thousand lines the project can own, with input types that match 02 §9.1. Building would rewrite that and gain only what the fork changes anyway.

### 5.2 Which FE stories each option satisfies or replaces

"Fork" is the recommendation above. "Adopt E." is Eigenpal used as a dependency through the OOXML projection. "Build" means writing everything.

| Story | Fork Docen's block and flow layers | Adopt Eigenpal | Build |
|---|---|---|---|
| FE-075 worker decision | Unchanged; the forked core is DOM-free once the text layer is replaced | Runs in Node.js and on the main thread; worker not tried | Unchanged |
| FE-076 API with injected providers | Built on the prototype's `measure.ts`, `flow.ts` and `tree.ts`; the break-opportunity provider and line breaker become the new text layer | Partly given (`TextMeasurer`, `TextShaper`); break opportunities not injectable (`Intl.Segmenter`) | Built |
| FE-077 flow blocks | Docen's types plus identifiers and offsets; `toFlow` is the start | Replaced by a CDM-to-OOXML projection per pass, overlapping the DOCX writers of 09 §11 and ADR 0017 | Built |
| FE-078 layout tree | Added in the fork (the adapter shows the mapping) | Given as Eigenpal's records, in OOXML coordinates; an adapter maps them | Built |
| FE-079 measurement and cache | Built (the missing seam) | Given | Built |
| FE-080 UAX #14 | Built (`linebreak`) | Not given; still needed | Built |
| FE-081 first-fit | Built in the new text layer; Docen's packing rules are the reference | Given, with Word's rules | Built |
| FE-082 breaks, keeps, widows | Given (keep chains, keep lines, widow control, page break before, page and section breaks); termination criteria to test | Given | Built |
| FE-083 tables across pages | Given (header rows repeated, `cantSplit`, rows taller than a page split) | Given | Built |
| FE-084 footnotes | Partly: greedy placement; iteration and continuation to build | Given (bounded reflow, continuation) | Built |
| FE-085 columns | Partly: flow through columns; balancing to build | Given, with balancing | Built |
| FE-086 page sections | Mostly; mixed geometry on one page degrades | Given | Built |
| FE-087 headers and footers | Given as insets by variant; placement as in the adapter | Given | Built |
| FE-088 incremental relayout | Built | Given (sessions, checkpoints), but only through the OOXML mirror | Built |
| FE-089 background pagination | Docen's per-page generator is the basis | Given (prefix passes, a scheduler) | Built |
| FE-090 to FE-093 painter and overlay | Not covered (Docen paints to canvas with LeaferJS) | Eigenpal has a DOM painter (`./output`), not evaluated | Built |
| FE-094 tests in CI | Docen's tests plus this package's | Ours only | Ours |
| FE-096, FE-097 caret and movement | Built from the tree | Given (hit testing, caret, selection), in OOXML coordinates | Built |
| FE-100 reconciliation with the PDF | Built | Not given | Built |

## 6. For S10 (SPK-023): the text-kernel boundary

- **The interface is enough for both cores.** `advance(font, text)` and `lineMetrics(font)` served both engines; `advances(font, text)` per code unit is offered for caret placement. Eigenpal also accepts `caretAdvances`, but its layout never called it. A WebAssembly kernel can sit behind this interface (ADR 0016 rule 2).
- **Call granularity decides the boundary cost.** Per laid-out line, Docen made about 3 calls and Eigenpal about 530, at 3 to 4 code units per call (§3.4). A kernel reached once per segment pays a JavaScript-to-WebAssembly crossing each time. So either the kernel takes a whole paragraph (runs and fonts in; breaks and per-line advances out), or a JavaScript cache sits in front of it: with `cachingMeasurer`, Eigenpal's calls fell to about 3,000 misses per 20 pages.
- **Determinism must be owned by the kernel.** With a deterministic measurer Eigenpal's trees were identical in Node.js and three browsers; Docen's were not, because of DOM probes (§3.2). Canvas measurement differed between browsers even with one font file (§3.3). Whatever S10 chooses must not read the DOM, sniff the browser, or depend on `Intl.Segmenter`, whose results follow each engine's ICU data.
- **Caches need the measurer's identity.** Docen's module caches keyed by CSS font string served stale widths when the measurer changed (§3.4). Key by font alias, size, text and font epoch, as 02 §9.3 says, plus the kernel's identity.
- **Where line breaking lives is open, and the fork allows either answer.** Option 1: a shaper-only kernel (harfbuzzjs) with UAX #14 and first-fit in TypeScript; the forked core's paragraph layout calls them. Option 2: one Rust module for segmentation, breaking and shaping, for which Parley (HarfRust, ICU4X, fontique) and cosmic-text (HarfRust, `unicode-linebreak`, fontdb) are the candidates. Both work per paragraph and need fonts registered from the manifest's bytes, not found on the system.
- **TypeScript layout is not the bottleneck at these sizes.** Docen laid out 100 pages in about 0.35 s from cold on this machine with a stub measurer. S10's measurements of background pagination of 1,000 pages and kernel time per keystroke (13 §9) still have to be taken on the reference machine.

## 7. Choices made, and questions for other stories

| Point | Choice in the prototype | Who decides |
|---|---|---|
| 03 §6 steps 1 and 4 both name the paragraph style chain when the style is `Normal` | Step 1 applies the default paragraph style; step 4 the paragraph's own chain up to it, so a table style overrides `Normal` in tables, as in Word | CDM: the model's cascade (CDM-041, CDM-043) |
| Numbering indentation versus paragraph-style indentation | 03 §6 order taken literally: the style chain overrides the numbering level, so `ListParagraph` flattens nested bullet indents. Word and Eigenpal apply the numbering indent after the style | CDM |
| Collapsing runs of spaces | Each engine's own behaviour (Docen collapses, Eigenpal keeps) | CDM and EXP: the web view keeps spaces, TeX collapses them |
| `contextualSpacing` | Zero gap when either of two same-style neighbours sets it | CDM fixtures (03 §7) |
| Field values before layout knows them | Cached text, else a one-digit stand-in for page fields | FE-087 and FE-100 |
| Inline and display equations | The LaTeX source as an unbreakable stand-in; display equations two lines high | FE-069 (KaTeX measures them) |
| Decimal tabs | Right tabs in Docen; passed through in the projection to Eigenpal | FE-081 |
| `differentOddEven` | Per page setup in CDM, document-wide in Word (`evenAndOddHeaders`); the projection turns it on for the whole document if any setup has it | CDM and EXP (DOCX writer) |

For the licence gate (FND-011):

- `@docen/layout` and `@docen/pretext` are MIT.
- `@chenglou/pretext`'s repository licence is `NOASSERTION` on GitHub. The borrow list notes a BSD-3-Clause text for an unidentified part. The recommended fork drops pretext, but if any of its code is kept, that part must be identified first.
- `@docx-editor.dev/core` and its dependencies are in the workspace for this spike only. These are `harfbuzzjs`, `bidi-js`, `fast-xml-parser`, `fflate`, `utif2` (MIT) and `emf-converter` 2.0.2 (Apache-2.0); the licences of the last two were checked here, not in the borrow list.

## 8. Criteria of SPK-020

| Criterion | Where it is met |
|---|---|
| Provenance, licence and maintenance recorded for every candidate, including Eigenpal's re-created repository | §2 table, with registry, repository and tarball checks; the tarballs' SHA-1 values match the registry (`e911d4bf…` for `@docx-editor.dev/core` 2.35.0, `c96d9996…` for `@docen/layout`, `10643a09…` for `@docen/pretext`, `ef0760cb…` for canvas-editor) |
| At least the leading candidate driven from CDM flow blocks in a prototype; the others on paper with reasons | Both leading candidates prototyped (§1, §3); canvas-editor, Typst, Parley and cosmic-text on paper (§2) |
| How each candidate shapes and measures text, and whether measurement can be injected | §2.1, and the injection exercised in §3.1 to §3.3 |
| Copyleft projects read for ideas only | None was a candidate or was opened (§2) |
| Recommendation adopt, fork or build, with evidence | §5: fork |

## Sources

All consulted on 2026-11-06.

- npm registry, `npm view` and `npm pack` (no install scripts run) for `@docx-editor.dev/core` 2.35.0, `@docen/layout` 0.7.0, `@docen/pretext` 0.7.0, `@docen/core`, `@docen/editor`, `@docen/docx`, `docen`, `@hufe921/canvas-editor` 1.1.0, `emf-converter`, `utif2`, `harfbuzzjs`, `bidi-js`, `linebreak`. Tarballs were unpacked into a scratch directory and read, never executed from there. They ran only as workspace dependencies installed through `scripts/pnpm-locked.ps1`.
- crates.io API for `typst-layout`, `typst`, `parley`, `parley_engine`, `parlance`, `fontique`, `cosmic-text`, `swash`, `harfrust`, including dependency lists.
- GitHub REST API for `eigenpal/docx-editor`, `DemoMacro/docen` (also its `packages/layout` listing, contributors and head commit), `Hufe921/canvas-editor`, `typst/typst`, `linebender/parley`, `pop-os/cosmic-text`, `chenglou/pretext`, `foliojs/linebreak`; Docen's `LICENSE` from `raw.githubusercontent.com`. Eigenpal's repository was not cloned and its Pro directories were not opened.
- The borrow list (2026-11-06) §2, §9 and §10; the Rust and WebAssembly assessment §4 to §6; the research summary §1 and §3; the legal note §7.
- The specification: 02 §9; 03 §2, §4, §6, §7; 09 §7; 11 §2, §9; 13 §9; ADR 0005, 0007, 0016, 0017.
