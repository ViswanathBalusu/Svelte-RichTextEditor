# ADR 0410: A `de-diagnostic` event reports loads and degraded features (WASM-002, WASM-003)

Status: proposed. The owner has not seen it. Lane w6, 2026-11-18.

## Context

WASM-002 asks that "load time and load failures are reported through the component's diagnostic events". WASM-003 asks that "an event tells the host which feature degraded and which directive was missing". 05 §8.1 lists no diagnostic event, and `events.ts` has none. The embedding API's events are the host's only view of what the component does, and a content security policy that blocks a lazy feature is otherwise silent: WebKit sends no violation report for a refused WebAssembly compilation (spike S2, section 6).

## Decision (proposed)

1. One event, `de-diagnostic`, for every lazily loaded feature that can fail or degrade for a reason the host can fix. It is raised through `emit`, like the others: composed, bubbling, a frozen copy of the detail.
2. The detail is `{ feature, kind, ms, bytes, streaming, code, directive, fallback }` (`DiagnosticDetail` in `packages/element/src/events.ts`). `feature` is `layout-kernel` for now. `kind` is `loaded`, `load-failed` or `degraded`. `code` is one of `blocked_by_policy`, `fetch_failed`, `bad_module`, `abi_mismatch`, `chunk_failed`, `compile_failed`. `directive` names what the host adds, for example `script-src 'wasm-unsafe-eval'`. `fallback` says what the editor uses instead (`web-view`, `canvas-measurement`).
3. The detail has codes, counts and a directive name. It never has document text, a URL with a token, or the message of a browser error.
4. A later feature (the PDF panel's JavaScript fallback, for one) uses the same event with its own `feature` value, so the host listens once.

## Why one event and not one per feature

A host that wants to watch its policy would otherwise add a listener for each lazy feature, and the catalogue would grow with every feature. One event with a closed `kind` and `code` keeps the catalogue short.

## Not decided here

- Whether the event is part of the frozen 1.0 contract. The embedding API is at major 0; the event is listed with the others in the generated reference (`spec/embedding/`), and the owner's review of that list decides.
- The name. `de-diagnostic` is a working name, like every name in the project.
