# ADR 0417: Mounting the editable page view in `<doc-editor>` (FE-101, FE-098)

Status: proposed. The owner has not seen it. Lane w1, 2026-11-18. It builds on ADR 0380 (the input bridge, proposed) and on owner decisions 26 and 27 of docs/owner-decisions-2026-11-15.md.

## Context

`view="print"` fell back to the web view because `doc-editor.ts` passed `pageViewAvailable: false` to `selectView`. Nothing built the editable page view. The pieces were there: the layout engine (`packages/layout`), the painter and its page window (`packages/painter`), the caret and key logic of FE-096 and FE-097, the spike's bridge (ADR 0380) and the kernel loader (WASM-002 to WASM-006). Decision 26 settles that the page view is the full editable one.

## Decision (proposed)

1. **One core, two surfaces.** The page view is a lazy chunk (`packages/element/src/page-view/`, imported with `import()` by `DocEditor.#syncPageView` when `view="print"` is chosen). The web view's body stays mounted and is hidden with `display: none` while the page view shows, so the editing core, its selection, its history and the unconfirmed work are the same in both views. Switching is a toggle, not a remount.
2. **The page view has no ProseMirror.** It reads the document and the selection as block identifiers and offsets, and every change goes through `EditorCore.attachPageView` (`packages/engine/src/page-input.ts`, `view/web.ts`), which dispatches ProseMirror transactions through the core's own path. The guards, suggestion mode, the sync queue and the history see them as they see an edit in the web view. Keys that the web view binds (`Enter`, `Backspace`, `Delete`, `Tab`, `Mod-b` and the others of `coreKeys` and the base keymap) are run on the core's state through `press`.
3. **The bridge follows ADR 0380 items 1 to 3:** one single-line textarea holding the head's block around the caret (200 characters each side), moved and not rewritten during a composition, with each `input` event one text edit by common prefix and suffix. Movement and clicks come from the layout tree. EditContext is not used.
4. **Measurement on the page thread with canvas, for now.** The engine is synchronous and the kernel lives in a worker, so until the layout engine runs in the worker next to the kernel (02 §15) the page view measures with canvas `measureText`, the S5 fallback for Chromium, Edge and WebKit. The kernel is still started when `view="print"` is asked for (WASM-002 to WASM-004), and its faces and measurer are not read by the page view yet. In Firefox canvas measurement misses the tolerance (S5), so the page view is not offered there: `view="print"` shows the web view and a notice. This differs from S5's default (font files); owner decision 27 builds the kernel, and moving the layout into the worker is the follow-up that makes font-file measurement the default again.
5. **Line breaks: a placeholder rule.** FE-080 has not chosen the Unicode line breaking algorithm. The page view breaks after blanks, after a hyphen between letters and between ideographs (`providers.ts`). This is wrong for many scripts and is to be replaced by FE-080's provider.
6. **The painter paints runs.** `PaintSource.runs` and `measureRange` (optional, additive) let a line be painted in the faces the layout measured; without them the painter is as it was.
7. **Failure.** A throw from the first layout, a later layout or the painter is passed to `onError`; the element shows the web view again with the document as it is and raises a non-fatal `de-error` (`code: 'internal'`). It does not try the page view again for that document until `view` is set again.
8. **Where it is not offered:** touch devices (FE-113), Firefox (item 4), and when canvas is missing (a failure as in item 7).

## Not decided here

- The page height in the page, which is `--de-page-view-height` (default 75vh); a host that wants the view to fill its container sets it. Whether the element should size itself is a design question for UX.
- Painting tab stops exactly, numbering label tabs, justification of the caret position, find highlights, peers' carets, headers and footers being edited by clicking them in the pages, and form fields on the overlay (FE-093) are not built. They are listed in the FE-101 Notes.
- Whether the hidden web body should be unmounted after some time in the page view to save memory (FE-102).
- Whether the painted pages are `aria-hidden` and a hidden reflowing alternative is read instead (ADR 0380 item 4). Not built; no screen reader has run the page view.
