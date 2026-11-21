# Shortcut table

Generated from `packages/ui/src/shortcuts/table.ts` and the built-in commands by `pnpm --filter @docedit/ui generate`; do not edit by hand. The machine-readable form is `shortcut-table.json` next to this file (13 §4; UX-013).

Keys are given for Windows and Linux, with the Apple form after the slash where it differs (`Mod` is Ctrl or Cmd). A browser column says what that browser’s published shortcut list says about the keys: a conflict and its meaning, “none listed” when the list was read and gives the keys no other meaning, or “not checked” when no list was read. An alternative is bound on every browser, so the documented alternative always works.

A conflict is a meaning the list gives a key while focus is in a web page, in the list’s own words. A meaning that holds only in the browser’s own interface (the address bar, a sidebar, the find bar, a menu) is not counted, and neither is a key the list gives the meaning the command has (Firefox lists Undo, Redo and Select All). After a conflict the cell says what to do: “use” names the keys bound as well, and “the editor takes it only inside the editor” means the key runs the command while focus is in the editor and keeps the browser’s meaning elsewhere. A browser may act on a key its list does not name; that is not recorded here.

| Command or key | Conventional | This product | Alternative | Chrome | Edge | Firefox | Safari |
|---|---|---|---|---|---|---|---|
| `edit.undo` | Ctrl+Z / Cmd+Z | Ctrl+Z / Cmd+Z | none | none listed | none listed | none listed | none listed |
| `edit.redo` | Ctrl+Y / Cmd+Y, Ctrl+Shift+Z / Shift+Cmd+Z | Ctrl+Y / Cmd+Y, Ctrl+Shift+Z / Shift+Cmd+Z | none | Cmd+Y: “Open the History page in a new tab” (macOS); use Shift+Cmd+Z | Cmd+Y: “Open History” (macOS); use Shift+Cmd+Z | none listed | none listed |
| `edit.selectAll` | Ctrl+A / Cmd+A | Ctrl+A / Cmd+A | none | none listed | none listed | none listed | none listed |
| `format.bold` | Ctrl+B / Cmd+B | Ctrl+B / Cmd+B | none | none listed | none listed | Ctrl+B / Cmd+B: “Bookmarks sidebar” (Windows, Linux, macOS); the editor takes it only inside the editor | none listed |
| `format.italic` | Ctrl+I / Cmd+I | Ctrl+I / Cmd+I | none | none listed | none listed | Ctrl+I / Cmd+I: “Page Info” (Windows, Linux, macOS); the editor takes it only inside the editor | none listed |
| `format.painter` | Ctrl+Shift+C / Shift+Cmd+C | Ctrl+Shift+C / Shift+Cmd+C | Ctrl+Alt+Shift+C / Alt+Shift+Cmd+C | none listed | Shift+Cmd+C: “Open Developer tools” (macOS); use Alt+Shift+Cmd+C | Ctrl+Shift+C: “Inspector” (Windows, Linux); use Ctrl+Alt+Shift+C | none listed |
| `proofing.next` | Alt+F7 | Alt+F7 | none | none listed | none listed | none listed | none listed |
| `proofing.previous` | none | Alt+Shift+F7 | none | none listed | none listed | none listed | none listed |
| `view.commandSearch` | Alt+Q | Alt+Q | none | none listed | none listed | none listed | none listed |
| `view.find` | Ctrl+F / Cmd+F | Ctrl+F / Cmd+F | none | Ctrl+F / Cmd+F: “Open the Find Bar to search the current page” (Windows, Linux, macOS); the editor takes it only inside the editor | Ctrl+F / Cmd+F: “Open find on page” (Windows, Linux, macOS); the editor takes it only inside the editor | Ctrl+F / Cmd+F: “Find in This Page” (Windows, Linux, macOS); the editor takes it only inside the editor | Cmd+F: “Search the current web page” (macOS); the editor takes it only inside the editor |
| `shell.nextLandmark` | Ctrl+F6 | Ctrl+F6 | Alt+F6 | Ctrl+F6: “Skip to web contents” (Windows, Linux); use Alt+F6 | Ctrl+F6: “Move focus to the web content pane” (Windows, Linux); use Alt+F6 | none listed | none listed |
| `shell.previousLandmark` | Ctrl+Shift+F6 | Ctrl+Shift+F6 | Alt+Shift+F6 | none listed | none listed | none listed | none listed |
| `shell.contextMenu` | Shift+F10, ContextMenu | Shift+F10, ContextMenu | none | none listed | Shift+F10: “Open context menu” (Windows, Linux); the editor takes it only inside the editor | Shift+F10: “Toggle Context Menu” (Windows, Linux); the editor takes it only inside the editor | none listed |
| `shell.miniToolbar` | none | Alt+F10 | none | none listed | none listed | none listed | none listed |
| `shell.applyFormat` | none | Enter | none | none listed | none listed | Enter: “Open Focused Bookmark or Link in Current Tab” (Windows, Linux, macOS); the editor takes it only inside the editor | none listed |
| `shell.cancel` | none | Escape | none | Escape: “Stop the page loading” (Windows, Linux, macOS); the editor takes it only inside the editor | Escape: “Stop loading page; close dialog or pop-up” (Windows, Linux); the editor takes it only inside the editor; Escape: “Exit full-screen mode; Stop loading page; close dialog or pop-up” (macOS); the editor takes it only inside the editor | Escape: “Stop; Stop Autoscroll Mode; Cancel Drag-and-Drop Operation” (Windows, Linux, macOS); the editor takes it only inside the editor | Escape: “Exit full-screen view; Close Reader” (macOS); the editor takes it only inside the editor |

## Sources

- Chrome: https://support.google.com/chrome/answer/157179 (read 2026-11-20)
- Edge: https://support.microsoft.com/en-gb/edge/keyboard-shortcuts-in-microsoft-edge (read 2026-11-20)
- Firefox: https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly (read 2026-11-20)
- Safari: https://support.apple.com/en-gb/guide/safari/cpsh003/mac (read 2026-11-20)
