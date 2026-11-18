# ADR 0016: TypeScript everywhere; Rust compiled to WebAssembly only for measured compute kernels

**Status:** proposed, 2026-11-06. S5 and S10 reported on 2026-11-06: measure from the font files, with HarfBuzz's own WebAssembly build as the only WebAssembly and line breaking in TypeScript (see "Result of S10").

## Context

The owner asked whether parts of the product should be written in Rust and compiled to WebAssembly for performance. The specification chose TypeScript across the component and the reference service so that both share the document model, the authority and the rules (01 §7). The assessment of 2026-11-06 ([research note](../research/2026-11-06-rust-wasm-assessment.md)) went through every path with a latency or throughput target and found:

- In phases 0 to 2 every budget is dominated by the DOM, the network, PostgreSQL or the TeX compile. A typical commit costs well under a millisecond of CPU (04 §12). WebAssembly speeds up none of those.
- The authority's permission check relies on ProseMirror sharing unchanged subtrees between versions (07 §5.1), and the step semantics are pinned to one library release (04 §4). A Rust authority would be a second implementation of exactly what the conformance kit exists to pin.
- The page view (phase 3, gated) needs text measurement. Canvas measurement differs between browsers and gives no control over ligatures, nor over kerning in Safari (02 §9.3). Measuring from the font files, which spike S5 evaluates, needs a HarfBuzz-compatible shaper, and that exists only as C++ or Rust compiled to WebAssembly.
- WebAssembly has costs specific to an embedded component: `'wasm-unsafe-eval'` in the host's content security policy, lazy chunks to respect the 300 KB budget, no threads unless the host page is cross-origin isolated, a second copy of font data in memory, and a second language for what may be a very small team (roadmap §8, risk 13).

## Decision

1. All product code in phases 0 to 2 is TypeScript. Nothing on the editing, sync, permission, rules, history, protocol or export path is written in Rust.
2. WebAssembly is allowed only for compute kernels behind an interface that already exists in the spec, first the text-measurement interface the layout engine receives by injection (02 §9.1). Each kernel is loaded on demand, runs in a worker, has a TypeScript or canvas fallback or a defined degraded mode when WebAssembly is blocked, and runs unchanged in Node.js for tests.
3. Which kernel, and in which language, is decided by evidence. S5 chooses between canvas and font-file measurement. If font files win, the new spike S10 decides between HarfBuzz's own WebAssembly build with line breaking in TypeScript, and one Rust module (HarfRust, Unicode segmentation, line breaking, hyphenation). The Rust option is taken only if S10 shows a material gain in time, determinism or maintenance.
4. Elsewhere, a Rust kernel is considered only when a stated budget is missed on the reference machine after algorithmic fixes and moving the work to a worker, and the profile shows pure computation.
5. Rust crates follow the same supply-chain and licence rules as npm packages: a licence allow-list, advisory checks, a software bill of materials, and no unsafe code in the project's own crates.

## Consequences

Good:
- One language for everything that must agree between client and server: model, authority, rules.
- The page view can measure text identically in every browser and in Node.js, so collaborators see the same breaks between compiles, and the editor can shape with HarfBuzz on the same font files the LuaLaTeX workers use (02 §6; 09 §8).
- Mature Unicode and shaping implementations are reused instead of written.
- A host with a strict policy loses at most the page view's preferred measurement path, never editing.

Bad:
- If S10 chooses Rust, the project gains a second toolchain, a second dependency tree and a skill the roadmap does not list.
- Font data is held twice in memory in the page view.
- Hosts that want the page view at its best must allow `'wasm-unsafe-eval'`, which some security teams resist.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Rust for the authority, compiled to WebAssembly for the client and native for the server | Duplicates ProseMirror's step semantics, which the client still runs in TypeScript; loses structural sharing in the outcome check; the commit path is storage-bound anyway |
| Native Rust addons in the Node.js service for hot paths | No CPU-bound hot path exists in phases 1 and 2; copying documents across the addon boundary would cost more than the work |
| TeX compiled to WebAssembly for in-browser previews | Rejected in ADR 0007: tens of megabytes, full recompiles, licence obligations |
| Canvas measurement only, with no WebAssembly anywhere | Remains the outcome if S5 finds canvas good enough; it keeps per-browser differences and the lack of ligature and kerning control |
| harfbuzzjs only, with no Rust | A valid S10 outcome when only the shaper needs to be native code |

## Result of S10 (2026-11-06)

**S5** chose measurement from the font files ([S5 report](../spikes/2026-11-06-s5-text-measurement.md)):

- HarfBuzz's widths matched painted Latin text within 0.30 px in Chromium, Edge, Firefox and WebKit.
- Canvas did not in Firefox.
- harfbuzzjs and HarfRust gave identical glyphs in every engine and in Node.js.

**S10** built both kernels of decision 3 behind one interface: the S7 measurement interface plus one call per paragraph ([S10 report](../spikes/2026-11-06-s10-text-kernel.md)). It measured them in a layout worker on the reference machine of ADR 0037:

- **Kernel.** harfbuzzjs for shaping, with UAX #14 segmentation and first-fit line breaking in TypeScript.
  - Both kernels gave identical line breaks and widths on `pages-100` and `pages-1000`, in the four engines and in Node.js.
  - Both stayed far inside the budget S10 set before measuring (4 ms at the median and 12.5 ms at the 95th percentile per keystroke).
  - The Rust module showed no material gain in time, determinism or maintenance, which decision 3 requires. It is a larger download (2.1 times compressed), and it brings a second toolchain and 21 crates.
- **Boundary.** One call per dirty paragraph in the layout worker, beside the S7 measurement interface. Only shaping crosses into WebAssembly, once per piece of text missing from a JavaScript cache keyed by face, text and font epoch.
- **Fallback when WebAssembly is blocked.** Canvas measurement behind the same shaper interface in Chromium, Edge and WebKit. In Firefox, the element stays in the web view and says why (S5). The kernel detects a refused compile itself, since WebKit does not report it (S2).
- **Conditions of the WASM epic.** C-WASM holds if the page view goes ahead. C-RUST does not hold.

## Decision of the owner (2026-11-15, decision 27)

The owner chose to build the Rust WebAssembly module, which overrides the S10 recommendation above, knowing its measured cost (2.1 times the download, a second toolchain, 21 crates). C-RUST holds, so the 16 stories of the WASM epic may start ([owner-decisions-2026-11-15.md](../owner-decisions-2026-11-15.md)). Decision 3 above is therefore answered by the owner and not by S10's measurement. WASM-001 builds the toolchain: the Rust workspace is `crates/` (pinned toolchain 1.89.0, `crates/Containerfile` for Podman, `crates/Cargo.lock`), and the npm package is `packages/layout-kernel`.

## Revisit when

- S5 or S10 reports (done, 2026-11-06; see "Result of S10").
- A stated budget in 00 §9 or 13 §9 is missed and the profile shows pure computation.
- Assumption A1 changes to offline-first editing.
- A partner wants to build a backend in another language and asks for the authority in-process (05 §9 and §10).
