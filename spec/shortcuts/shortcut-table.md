# Shortcut table

Generated from `packages/ui/src/shortcuts/table.ts` and the built-in commands by `pnpm --filter @docedit/ui generate`; do not edit by hand. The machine-readable form is `shortcut-table.json` next to this file (13 §4; UX-013).

Keys are given for Windows and Linux, with the Apple form after the slash where it differs (`Mod` is Ctrl or Cmd). A browser column says what that browser’s published shortcut list says about the keys: a conflict and its meaning, “none listed” when the list was read and gives the keys no other meaning, or “not checked” when no list was read. An alternative is bound on every browser, so the documented alternative always works.

| Command or key | Conventional | This product | Alternative | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|---|---|---|
| `edit.undo` | Ctrl+Z / Cmd+Z | Ctrl+Z / Cmd+Z | none | none listed | none listed | not checked | none listed |
| `edit.redo` | Ctrl+Y / Cmd+Y, Ctrl+Shift+Z / Shift+Cmd+Z | Ctrl+Y / Cmd+Y, Ctrl+Shift+Z / Shift+Cmd+Z | none | Cmd+Y: “Open the History page in a new tab” (macOS); use the alternative | Cmd+Y: “Open History” (macOS); use the alternative | not checked | none listed |
| `edit.selectAll` | Ctrl+A / Cmd+A | Ctrl+A / Cmd+A | none | none listed | none listed | not checked | none listed |
| `format.bold` | Ctrl+B / Cmd+B | Ctrl+B / Cmd+B | none | none listed | none listed | not checked | none listed |
| `format.italic` | Ctrl+I / Cmd+I | Ctrl+I / Cmd+I | none | none listed | none listed | not checked | none listed |
| `format.painter` | Ctrl+Shift+C / Shift+Cmd+C | Ctrl+Shift+C / Shift+Cmd+C | Ctrl+Alt+Shift+C / Alt+Shift+Cmd+C | none listed | Shift+Cmd+C: “Open Developer tools” (macOS); use the alternative | not checked | none listed |
| `proofing.next` | Alt+F7 | Alt+F7 | none | none listed | none listed | not checked | none listed |
| `proofing.previous` | none | Alt+Shift+F7 | none | none listed | none listed | not checked | none listed |
| `view.commandSearch` | Alt+Q | Alt+Q | none | none listed | none listed | not checked | none listed |
| `view.find` | Ctrl+F / Cmd+F | Ctrl+F / Cmd+F | none | Ctrl+F: “Open the Find Bar to search the current page” (Windows, Linux); the editor takes it only inside the editor | Ctrl+F: “Open find on page” (Windows, Linux); the editor takes it only inside the editor | not checked | Cmd+F: “Search the current web page” (macOS); the editor takes it only inside the editor |
| `shell.nextLandmark` | Ctrl+F6 | Ctrl+F6 | Alt+F6 | Ctrl+F6: “Skip to web contents” (Windows, Linux); use the alternative | Ctrl+F6: “Move focus to the web content pane” (Windows, Linux); use the alternative | not checked | none listed |
| `shell.previousLandmark` | Ctrl+Shift+F6 | Ctrl+Shift+F6 | Alt+Shift+F6 | none listed | none listed | not checked | none listed |
| `shell.contextMenu` | Shift+F10, ContextMenu | Shift+F10, ContextMenu | none | none listed | Shift+F10: “Open context menu” (Windows, Linux); the editor takes it only inside the editor | not checked | none listed |
| `shell.miniToolbar` | none | Alt+F10 | none | none listed | none listed | not checked | none listed |
| `shell.applyFormat` | none | Enter | none | none listed | none listed | not checked | none listed |
| `shell.cancel` | none | Escape | none | none listed | none listed | not checked | none listed |

## Sources

- Chrome: https://support.google.com/chrome/answer/157179 (read 2026-11-06)
- Edge: https://support.microsoft.com/en-gb/microsoft-edge/keyboard-shortcuts-in-microsoft-edge-50d3edab-30d9-c7e4-21ce-37fe2713cfad (read 2026-11-06)
- Firefox: not checked; the published list could not be read.
- Safari: https://support.apple.com/en-gb/guide/safari/cpsh003/mac (read 2026-11-06)
