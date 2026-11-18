# ADR 0410: The origin check, its exceptions and two changes to the scanner (SEC-054)

Status: items 1 and 2 apply owner decisions 67 and 120. Items 3 and 4 are proposed. Lane w8, 2026-11-18.

## Context

`scripts/supply-chain/origin-check.ts` (ADR 0044 §6) scans the build output of the element for code or styles loaded from another origin. SEC-054 asks for it to pass on the current build, with the PDF.js paths and the sandboxed extensions as the only listed exceptions. A run of `pnpm origins:check` on 2026-11-18 on a fresh `packages/element` build found two things that were not exceptions: a MathLive message and a bundler stub.

## Decisions

1. **PDF.js (owner decision 67).** The two computed imports in the viewer frame (`workerSrc` and the `wasmUrl` decoders) are allowed, documented and checked. The two entries in `scripts/supply-chain/origin-exceptions.json` now cite the decision. They stay valid only while the viewer sets those addresses to its own files (`packages/element/src/pdf/viewer/main.ts`), and they expire on 2027-05-06 like any exception.
2. **Sandboxed extensions (owner decision 120).** A new rule, `computed-script`, finds a script element that is given an address that is not a string literal (`script.src = x`, `setAttribute('src', x)`). The only such place in the editor's code is the runtime inside the extension frame (`packages/ui/src/extensions/sandbox-runtime.ts`), and its exception is the one entry the spec foresees (10 §3.8). Any other computed script address fails the check.
3. **MathLive's message (proposed).** MathLive's bundle contains the address `https://esm.run/@cortex-js/compute-engine` in the text of a `console.error` call that tells a developer how to load the Compute Engine. The code reads the engine from `globalThis[Symbol.for('io.cortexjs.compute-engine')]` and imports nothing. The check cannot tell a message from a load, so it reports a public code service address. The exception is narrow: it names the package, the chunk prefix and the address (a new optional `detail` member of an exception), so another address in the same file still fails. It expires on 2027-05-18. The owner may instead ask for MathLive to be patched or for the message to be removed by the build.
4. **Import stubs (proposed).** The bundler writes entries such as `chunks/events-<hash>.js` with the text `import "./events-<hash>.js";` and no source map. `bundle.ts` found no package for them and the check failed with "no package explains this file". A script that holds nothing but static imports and re-exports of relative files is now attributed to the distributable, with the new method `import-stub`. A script with any other statement, or an import of another origin, is not a stub.

## Not decided here

- Whether the element's build should carry the sandbox runtime and the frame page (finding 4 of `docs/review/2026-11-18-ux-060-sandbox-review.md`). Until it does, the check meets the runtime only in a test that builds it (`scripts/supply-chain/origin-sandbox.test.ts`).
- The first interactive editor is over its size budget on this build (`budget 320.0 kB gzip: EXCEEDED`, FND-008). That is not a supply-chain finding and is not touched here.
