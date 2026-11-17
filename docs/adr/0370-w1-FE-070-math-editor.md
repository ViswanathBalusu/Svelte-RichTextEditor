# ADR 0370: The math editor dialog (FE-070)

**Status:** proposed, 2026-11-17. Prepared by lane w1 (epics FE, CDM, WASM). The spec leaves these points open; the choices below are the defaults taken to build the story, not owner decisions.

## Context

FE-070 asks for an editor for equations that loads on demand, honours the limits and the math gate, works under a strict policy, can be used by keyboard and opens read-only where the person may not change the equation. 02 §2 and 01 §7 name MathLive for editing. FE-136 (insert) is a separate story, so this record covers editing an existing equation only.

## Choices

1. **A dialog with two fields.** The shell shows `MathEditorDialog.svelte` (ui) with the visual field and the equation's LaTeX as text. Both edit one source. The visual field is mounted through the `MathEditorService` port; `packages/element/src/math-field.ts` is the only code that imports MathLive, so the chunk and the custom elements `math-field`, `math-span` and `math-div` appear with the first use. If the field cannot load (offline, a policy that refuses `docedit-math`), the source field still works.
2. **How the editor is opened.** A double click on an equation, or Enter while it is selected, asks the core for it (`equationRequest`); the shell opens the dialog. Enter needs keyboard focus on the editing surface, which a read-only view does not take (FE-103 is the story for keyboard access to a read-only view), so a viewer opens the dialog by double click. No toolbar or menu command was added: that belongs to FE-136.
3. **Virtual keyboard and menus off.** MathLive writes the markup of its menus and of the virtual keyboard with `innerHTML` assignments that bypass `createHTML` (S2 report, MathLive section). They would break Trusted Types, so the field runs with `mathVirtualKeyboardPolicy: 'manual'` and no menu items. A touch user types in the source field or on the device's own keyboard.
4. **Escape.** MathLive keeps Escape for its own modes. The field takes Escape first (capture phase on its host) and closes the dialog. The shell's own Escape handling ignores a key pressed inside a dialog; before this story it consumed Escape while the mini toolbar was shown, which kept a native dialog from closing.
5. **Confirmation waits for the service.** `confirmEquation` makes the one commit and waits for the commit to settle. A rejection (`invalid_op`, the math gate of 09 §6.3) arrives as the sync client's `report` event and takes the change back; the dialog shows the service's message and keeps the input. The wait is limited to 15 seconds; after that the commit stays queued and the dialog closes (`confirmed: false`). The 15 seconds is a default taken here, not a measured or specified figure.
6. **Selection after a rejection.** A rejection with the action `reload` replaces the document and the selection. When the dialog closes, the shell selects the equation again and focuses the editing surface, so that focus returns to the equation.
7. **Suggestion mode.** `setEquationLatex` is a block-only command: it is refused in suggestion mode with the reason `suggestion` (as FE-070's own Notes expected), and the dialog opens read-only with that reason. Whether an equation should be editable as a suggestion is still open.
8. **A mock for the math gate.** `MockServiceOptions.mathGate` (backend-mock) passes a gate to the rooms, as the document service does with the converter's gate. Absent, nothing changes. The embed page of the element tests uses the converter's `mathGateReason`.

## Not measured

The size of the lazy chunks is from the library build report of 2026-11-17 on the author's machine (`math-field` 1.3 kB, MathLive 1,007.8 kB before compression). No latency of the editor was measured.
