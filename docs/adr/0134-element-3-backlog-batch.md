# 0134. Element backlog batch: open questions from the frontend stories (element-3)

**Status:** proposed (2026-11-13). Written by the element developer (lane element-3) in the backlog batch, round 1, for the frontend stories FE-055, FE-068 and FE-073. Not reviewed by the owner.

## Context

The lane worked from the end of the FE phase 2 slice (FE-072 to FE-073 and the phase 2 element stories). Stories whose criteria need a browser, a container, a running viewer, the engine's copy handlers or a decision were left unticked, with the reason in their Notes. This note lists the points that need a decision, with the default the code takes.

## Open questions and the default taken

1. **Printing when the access is not yet known (FE-073, FE-055).** `printTypesetPdf` (packages/element/src/print.ts) refuses only when the access lists `no-print`. When no access is known yet (`null`), it prints. Default taken: the spec does not say, so the code does not refuse. Question: should printing wait for the first access, or refuse until it is known? The owner decides.

2. **Export events for printing (FE-073, criterion 4).** The catalogue (05 §8.1) names `de-export-*` events, but `src/events.ts` does not declare them yet (the export story PRO-086 leaves them open). Default taken: a failed or refused export raises `de-error` only. Question: which export events the host sees, and their detail, belong to PRO-086; the element adds them when PRO-086 defines them.

3. **Printing path through the viewer (FE-073, criteria 1 and 2).** The print path that puts the PDF into the viewer frame and calls the frame's `print` is not built. `printTypesetPdf` takes it as the injected `printPdf` function. Default taken: the element never sends painted pages or the shadow DOM to the printer, because it sends only the signed URL of the typeset PDF. Question: whether the viewer prints its own frame (a `print` message on the existing channel, 09 §9.3 rule 7) or the host prints the URL. A browser run is needed to tick the criteria.

4. **Refusal of `no-print` reported to the shell (FE-055, criterion 3).** The refusal is returned to the caller as `{ status: 'refused', reason: 'no-print' }`. Default taken: no `de-error` is raised for it, because a restriction is not a failure. Question: UX-040 decides how the shell tells the person; whether the core also raises an event for it is open.

5. **Guides after an edit since the compile's `seq` (FE-068, criterion 4; open question 28).** `pageGuideBlockIds` takes the layout as given and does not compare its `seq` with the document. Default taken: none; the function returns the starts of the last compile. Question: hide the guides after an edit, or keep them and say they are from an earlier compile.

6. **Guide configuration key (FE-068, criterion 1).** The `config` switch for page guides is not added to `src/config.ts` in this round, because `test/config.test.ts` checks the exact set of keys. Question: whether PRO-081 adds the key (default: off, 02 §7) and then the element reads it.

## Evidence of the decisions in code

- `packages/element/src/print.ts`, `packages/element/test/print.test.ts`, `packages/element/test/print-styles.test.ts`.
- `packages/element/src/page-guides.ts`, `packages/element/test/page-guides.test.ts`.
- `docs/stories/FE-frontend.md`: stories FE-055, FE-068, FE-073 (Evidence and Notes).

## Round 2 (element-3): FE-072 read view

7. **The `seq` of the read view's typeset PDF (FE-072).** `openReadView` (packages/element/src/read-view.ts) starts the export without a `seq`, so the server uses the head when the request is accepted (PRO-063, 09 §9.1). Default taken: the head, because the spec states no `seq` for the read view (FE-072 Open questions). Question: whether the read view shows the last compile or the current head, and whether it says which.

8. **Labelling and the editing surface of the read view (FE-072, criteria 1 and 5).** The label is in `READ_VIEW_STRINGS` (read-view.ts) and is not yet placed in the shell. Default taken: the element does not mount the editing surface when `view="read"` is wired in a later round; the mounting is not built. Question: UX-019 decides whether the read view lives in the pane host or replaces the editor.

Round 2 ticked no criterion. The read view's rendering and its browser run are not built (see FE-072 Notes).
