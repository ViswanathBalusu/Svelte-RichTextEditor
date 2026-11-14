# Rust and WebAssembly assessment, 2026-11-06

**Question.** Does any part of the product need Rust, compiled to WebAssembly or native, to meet its performance targets?

**Answer.** Not in phases 0 to 2. Every budget in those phases is dominated by the DOM, the network, PostgreSQL or TeX, and WebAssembly speeds up none of them. The one place where WebAssembly becomes necessary is the text kernel of the page view (phase 3, gated): if spike S5 chooses to measure text from the font files, the editor needs a HarfBuzz-compatible shaper, which exists only as C++ or Rust compiled to WebAssembly. Whether line breaking, hyphenation and Unicode segmentation then join the shaper in one Rust module is a measured decision (new spike S10). The decision is recorded in [ADR 0016](../adr/0016-rust-wasm-compute-kernels.md) and the work is in [WASM-rust-kernels.md](../stories/WASM-rust-kernels.md).

This note uses only facts already in the specification, plus the sources in section 7. Every number is a target from the spec, not a measurement.

## 1. What WebAssembly can and cannot speed up

- **It can** speed up pure computation over data already in memory: shaping, segmentation, line breaking, hyphenation, diffing, parsing.
- **It cannot** speed up DOM work (ProseMirror's view, style recalculation, the browser's own layout and paint), waits on the network or the database, or the TeX compile.
- **The boundary has a cost.** Text and structures are copied into the module's linear memory. A kernel pays off only when each call does a lot of work: a paragraph or a block, never a character.
- **Determinism is the other benefit.** A WebAssembly module computes the same result in every browser and in Node.js. Canvas text measurement does not (02 §9.3; review finding F9), which is why collaborators can see different page breaks between compiles (ADR 0005).

## 2. What WebAssembly costs this product

| Cost | Why it matters here |
|---|---|
| Content security policy | Compiling WebAssembly under a policy that restricts scripts needs `'wasm-unsafe-eval'` in `script-src`. Spike S2's exit criterion is a page with no unsafe keywords. A worker created from a `blob:` URL inherits the page's policy; a same-origin worker takes the policy delivered with its own script. Every WebAssembly feature must therefore be optional, loaded on demand and able to degrade, and S2 must test both ways of loading a worker, including in Safari |
| Bundle budget | At most 300 KB compressed for the first interactive editor (13 §9). Modules must be lazy chunks and never inlined as base64 |
| No threads | WebAssembly threads need `SharedArrayBuffer`, which needs the host page to be cross-origin isolated. An embeddable component cannot demand that of its host, so each module runs single-threaded in its own worker |
| Memory | Shaping from font files keeps a second copy of each font face in linear memory, because the browser keeps its own for painting. Small for Latin faces; large for CJK faces. The budget is 300 MB for a 100-page document (13 §9) |
| A second language | Roadmap §8 lists the skills the project needs; Rust is not among them, and risk 13 is a single maintainer or a very small team. Rust brings Cargo, wasm-bindgen, wasm-opt, a second dependency tree to audit and a second set of licences to check |
| Serving | `WebAssembly.instantiateStreaming` needs the `application/wasm` media type; hosts whose CDN serves another type need the ArrayBuffer fallback |

## 3. Hot paths

| # | Path | Runs in | Budget or fact (spec) | Bound by | Would WebAssembly help? | Verdict |
|---|---|---|---|---|---|---|
| 1 | Typing in the web view | Main thread | 16 ms median, 50 ms 95th percentile, up to 100 pages (00 §9) | ProseMirror's view and browser layout | No | TypeScript |
| 2 | Long documents in the web view | Main thread | Usable to 300 pages (13 §9); the whole document is mounted (02 §13) | DOM size | No | TypeScript |
| 3 | Sync client: rebase on remote commits, rebuild on acknowledgement | Main thread | Inside the typing budget | Short step lists | No | TypeScript |
| 4 | Authority: rebase, apply, invariants, outcome check | Room event loop | A typical commit costs well under 1 ms of CPU; storage latency dominates (04 §12) | PostgreSQL | No. The outcome check finds changed scopes by ProseMirror's shared-subtree identity (07 §5.1), and step semantics are pinned to one library release (04 §4). A port would be a second implementation of the very semantics the conformance kit exists to pin | TypeScript |
| 5 | Field rules | Editor, authority, authority service | One pass inside the commit's budget (12 §5.2) | Small | No. ADR 0012 requires one shared implementation | TypeScript |
| 6 | Protocol envelope | Both ends | JSON text frames (05 §4) | Native `JSON.parse` | No | TypeScript |
| 7 | Checkpoints: canonical JSON, SHA-256, Zstandard | Worker threads (06 §2.2) | Off the event loop | Native hashing and compression | Unlikely | TypeScript; revisit only if a budget is missed |
| 8 | Log replay for content reads and old versions | Worker threads | Cold open 500 ms at the 95th percentile for a CDM under 1 MB (00 §9) | ProseMirror step application | Not without porting ProseMirror | TypeScript |
| 9 | Comparing versions | Worker threads; cached by sequence pair (08 §6) | No budget stated | `prosemirror-changeset`, or a block-aligned word diff | Possibly, for very large documents | TypeScript; a diff kernel only if a budget is set and missed |
| 10 | CDM to LaTeX | Export service | 20 pages to PDF in 10 s at the 95th percentile (00 §9) | The compile: about 1.4 s for one page before tagging, roughly three times slower with tagging (09 §8) | No | TypeScript |
| 11 | TeX in the browser | | | | Already rejected: tens of megabytes, full recompiles, licence obligations (ADR 0007; 09 §15) | Not pursued |
| 12 | DOCX import | Import worker (10 §3.5) | No budget stated | Unzip and XML parsing | Possibly, for very large files | A borrowed library first (roadmap principle 3) |
| 13 | PDF preview | Sandboxed cross-origin frame (09 §9.3) | | PDF.js, which already ships optional WebAssembly decoders | Nothing to build | Record its behaviour under strict policies in S2 |
| 14 | Text measurement for the page view | Layout worker or main thread | Typing budget; the page view to 1,000 pages with virtualisation (13 §9) | `measureText` calls, or shaping | If S5 chooses font files: yes, necessarily. HarfBuzz is C++ with an official WebAssembly build, and has a maintained Rust port. JavaScript shapers exist but do not reproduce HarfBuzz, while LuaLaTeX can shape with HarfBuzz (09 §8) | WebAssembly required in that case |
| 15 | Line breaking, hyphenation, segmentation for the page view | Layout worker | Incremental relayout inside the typing budget (02 §9.5) | Per-paragraph computation | Possibly | Spike S10 decides |
| 16 | Pagination, tables, footnotes | Layout worker | | Block heights and keep rules | Little | TypeScript |
| 17 | Bidirectional text and complex scripts in the page view (phase 4) | Layout worker | | Unicode algorithms with large data tables | Yes: mature Rust implementations exist (ICU4X) | In the kernel, if the kernel exists |
| 18 | Divergence check on the client (`sync.check`) | Browser | Inside the typing budget whenever it runs (04 §13) | Canonical serialisation of the whole document, up to 16 MiB, then SHA-256 | No. The document is a JavaScript object graph; getting it into a module costs as much as serialising it | TypeScript, run in idle time or a worker, with native SHA-256 |
| 19 | Pattern matching in field rules | Editor, authority, authority service | Inside the commit's budget; values at most 4 KiB (12 §3.6, §5.2) | A matcher for the restricted subset that guarantees linear time | No. Fill-mode participants must be able to work where the host blocks WebAssembly, and one implementation must run in all three places (ADR 0012) | TypeScript: a small automaton over the restricted subset |
| 20 | Math gate on the commit path | Authority, converter, editor | Inside the commit's budget; `latex` at most 4,000 characters (03 §8) | KaTeX's strict parser (09 §6.3) | No. The gate must accept exactly what the editor's KaTeX renders, so it runs the same KaTeX | TypeScript (KaTeX) |
| 21 | Recomputing each connection's `access` object after a grant change | Room | Not stated | Regions times connections; up to 500 regions | No | TypeScript; send deltas if it shows in profiles (05 §12) |

## 4. Recommendations

1. **Phases 0 to 2: TypeScript only.** Nothing on the editing, sync, permission, rules, history, protocol or export path is written in Rust. The spec's own analysis already places the heavy server work in worker threads (04 §12; 06 §1), which is the right first answer to a missed budget.
2. **Phase 0: widen three spikes and add one.**
   - S2 records what WebAssembly needs from a host's policy, for a `blob:` worker and for a same-origin worker, in every supported browser, and how the PDF panel behaves when WebAssembly is blocked.
   - S5 adds two candidates beside canvas: HarfBuzz's own WebAssembly build (harfbuzzjs) and HarfRust compiled to WebAssembly. It reports compressed size, compile and instantiate time, memory with Latin and CJK faces, and whether results are identical across browsers and Node.js.
   - S7 adds Rust layout code to its candidates (Typst's layout crates, Parley, cosmic-text) and records how each candidate shapes text. The research found that Eigenpal's core already shapes with HarfBuzz.
   - **S10, new:** once S5 has chosen, decide the kernel boundary. Either the shaper alone in WebAssembly with line breaking in TypeScript, or one Rust module for shaping, segmentation, line breaking and hyphenation. Benchmarks on the shared corpus decide: kernel time per keystroke on a 100-page document, background pagination to 1,000 pages, cold start, compressed size, memory and determinism.
3. **Phase 3, only if the gate says yes and S10 recommends it:** a Rust text kernel compiled to WebAssembly, behind the injected measurement interface that 02 §9.1 already requires. The layout engine, pagination and the layout tree stay in TypeScript. One instance runs in the layout worker; the same artefact runs in Node.js for the layout tests of 02 §14. Without WebAssembly, the page view falls back to canvas measurement if S5 found it acceptable, or the element stays in the web view and says why.
4. **The escalation rule for everything else:** a Rust kernel is considered only when a stated budget is missed on the reference machine after algorithmic fixes and moving work to a worker, and the profile shows pure computation, not DOM, I/O or allocation. That applies to comparison (path 9), DOCX import (path 12) and checkpointing (path 7).
5. **Rust for reasons other than speed, not scheduled:**
   - *Memory-safe decoders in the asset and import workers.* Decoder exploits are a listed threat (10 §3.5). Native Rust decoders would shrink that attack surface. This is a security question for SEC, not a WebAssembly one.
   - *The authority service as a WebAssembly component* that non-JavaScript backends embed in-process instead of calling over the network. It is a portability question for phase 4, worth raising only when a partner builds a second backend (05 §9 and §10; roadmap §7).
   - *If assumption A1 flips to offline-first*, Rust CRDT engines that run in the browser and natively on the server become relevant. A1 flipping is a rewrite either way (00 §5).

## 5. A door this opens, not recommended now

09 §7 says rebuilding TeX's paragraph and page builders in the browser is not attempted, and 02 §9.3 uses first-fit line breaking with hyphenation off. Rust crates that already implement Knuth and Plass's line breaking and TeX-pattern hyphenation (for example in Typst), combined with HarfBuzz shaping on the same font files as the LuaLaTeX workers, would make a TeX-compatible paragraph builder smaller than it was when the spec was written. For it to help, the house class would also have to select luaotfload's HarfBuzz renderer, and the spec's position would have to be reopened. This is noted as a question for the end of phase 3, not as work.

## 6. Candidate components

The names and licences below are a starting point for the borrow list (SPK-026), which verifies them. The crates without C or system dependencies are the easiest to compile to WebAssembly; S5 and S10 confirm each build.

| Need | Rust | Not Rust | Notes |
|---|---|---|---|
| Shaping | HarfRust, the HarfBuzz project's Rust port (MIT). It grew out of rustybuzz, which is archived; its README states parity with HarfBuzz 13.0.0 and speed within about 25 percent of HarfBuzz on common fonts | harfbuzzjs, HarfBuzz's official WebAssembly build | Either needs WebAssembly. HarfRust has no system font loading, which suits fonts fetched from the manifest |
| Font tables | read-fonts and skrifa (Fontations) | | Used by HarfRust |
| Line-break opportunities, grapheme clusters | ICU4X segmenter (Unicode licence), unicode-linebreak, unicode-segmentation | The `linebreak` npm package | 02 §9.3 already needs a bundled UAX #14 implementation. ICU4X also covers Thai, Lao, Khmer and Burmese with dictionary data |
| Hyphenation | hypher, from the Typst project (code MIT or Apache-2.0) | Hyphenopoly | Pattern files carry their own licences (hypher lists LPPL, MPL, MIT and BSD-3), so every language is audited separately |
| Bidirectional text | ICU4X, unicode-bidi | bidi-js | Phase 4 |
| Layout cores | Typst's layout crates (Apache-2.0), Parley, cosmic-text | Eigenpal's core (Apache-2.0, shapes with HarfBuzz), canvas-editor and Docen (MIT) | S7 already plans to fork rather than adopt as-is |

## 7. Sources

- [HarfRust 0.8.0 README](https://docs.rs/crate/harfrust/0.8.0/source/README.md) and [rustybuzz on docs.rs](https://docs.rs/crate/rustybuzz/latest), consulted 2026-11-06.
- [hypher README](https://docs.rs/crate/hypher/0.1.7/source/README.md), consulted 2026-11-06.
- Dedicated workers take their content security policy from their own response, while `blob:` workers inherit the creator's: [Mozilla bug 1735696](https://bugzilla.mozilla.org/show_bug.cgi?id=1735696) and the [WebKit test for blob workers](https://webkit.googlesource.com/WebKit/+/3bf57fadf639c01ffe36559ca9ad8c63a8334a99/LayoutTests/http/tests/security/contentSecurityPolicy/worker-blob-inherits-csp-blocks-eval.html). A report that Safari refuses `blob:` workers under a restrictive policy came from a third-party wiki and is unconfirmed; S2 tests it.
- The specification itself: 00 §9, 02 §9 and §13, 04 §4 and §12, 05 §4, §9 and §10, 06 §1 and §2, 07 §5, 08 §6, 09 §7 and §8, 10 §3.5, 12 §5, 13 §9, ADR 0005, ADR 0007, ADR 0012, and the research summary of 2026-09-18 (which found that Nutrient's proprietary editor uses a WebAssembly layout engine and that Eigenpal shapes with HarfBuzz).
- Rows 18 to 21 come from computations the story writers listed while drafting the backlog, checked against 03 §8, 04 §13, 05 §12, 09 §6.3, 12 §3.6 and §5.2.
