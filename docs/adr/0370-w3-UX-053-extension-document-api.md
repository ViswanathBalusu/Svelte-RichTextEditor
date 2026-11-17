# ADR 0370: The extension document API as built (UX-053)

Status: proposed (lane w3, 2026-11-17). Builds on part B of ADR 0234, which is itself proposed. Nothing here is decided by the owner.

## Context

UX-053 asks for a range-based API with events, with the same guards as typing and no ProseMirror type. ADR 0234 part B recommends the operations and the rule "ranges are mapped for reads and checked for writes". It leaves several details open. The code is `packages/engine/src/extension-api.ts` (the implementation), `extension-api-types.ts` (the types) and `DocumentCore.extensionApi(options)`. The ui carries the same types in `packages/ui/src/extensions/document-api.ts`, because `ui` does not depend on the engine.

## Decisions proposed

1. **A range is a handle, not a position.** `range(from, to)` holds a span and returns `{ id, from, to }`. A write names the handle; the numbers an extension sends back are ignored. A forged or released handle gives `invalid`.
2. **Stale means touched.** A handle is `stale` when any step changed content inside it (an insertion strictly inside, or a deletion or replacement overlapping it; for an empty range, a change at its point). A write through a stale or detached handle, or one whose text differs from the text when it was made, gives `conflict` and changes nothing. A change before or after the span only moves it. This is stricter than 0234 B2, which names a `seq`: the check is on the content, not on a version number, so it also holds between local steps that have no `seq` yet.
3. **Failure reasons.** `permission_denied` (scope not editable, or the document locked; before anything reaches the guards), `conflict`, `invalid`, `unsupported` (the fragment needs features the document does not list), `refused` (the guards or suggestion mode refused). 0234 B1 names `permission_denied` and `conflict`; the other three are added here.
4. **Writes use the core's dispatch.** `replaceRange`, `deleteRange` and `setMark` build a transaction and give it to `dispatchTransaction`, so suggestion mode records them as suggestions and the guards apply as for typing. `insertBlocks` shares `insertContent`'s code with a held range in place of the selection. `setMark` refuses `ins`, `del`, `fmt` and `preserved`.
5. **Origin of the commit is not changed.** The extension client hint of 0234 B1 needs a change to 04 and the owner's word. Writes go out with the origin of a local edit until it is decided.
6. **Events are coalesced and delivered later.** The transaction only marks that a change happened. A scheduler the caller gives (`later`; the shell passes `afterPaint`) runs one delivery, which compares the document with the one at the previous delivery, only for the kinds somebody subscribed to. A block added and deleted before one delivery is reported as neither. `origin` is `local`, `remote` or `both`. The queue is bounded by construction: one flag and one baseline per kind, not one entry per change.
7. **`maxRanges` is a required option.** The spec gives no number. The shell passes it from the host's `documentApi` property; the harness values in tests are test values. Without it the shell gives extensions no document API.
8. **Reports.** A handler that throws is reported as a non-fatal extension report with the new reason `handler-failed`, and the other handlers still run.
9. **Hidden content.** Reads and events leave out any block, text, mark, suggestion or thread in a scope the reader may not view (ADR 0019).
10. **Block identity.** A "block" is any node with an `id` attribute that is a block, outside the definitions. A container is reported as changed when anything inside it changed.

## Not decided

- Whether the origin of an extension's commit is a new hint (point 5).
- The deprecation window and the manifest fields (0234 B3, B4).
- The number for `maxRanges` and the cost of the comparison on a large document: no measurement was taken.

## Consequences

Tier 2 (UX-060) can wrap the same functions. The API is a promise only once 0234 is accepted (UX-049 criterion 5).
