# ADR 0427: The citation command, its dialog and the name of a citation (FE-140)

**Status:** proposed, 2026-11-26 (lane w1, FE-140). Nothing here is the owner's decision.

## Context

FE-140 criterion 1 asks for a command that inserts a citation of chosen sources with an optional prefix, suffix and locator, available from the command registry and the keyboard. Criterion 3 asks that the sources a citation names are announced when the caret reaches it. The core command `insertCitation` existed; the shell had a per-source "Cite" button in the sources pane (UX-103) but no command and no way to cite several sources with their parts.

## Decisions proposed

1. **The command `insert.citation`** is in the registry, group `insert`, capability `citations`, backed by the core's named command `insertCitation` (`runNamed`, declared in `commandNames`). It is offered when the core gives a sources service. It opens the citation dialog. Like the cross-reference command it has no `enabled` query: where the region guard refuses, the command runs, the core refuses, and the shell announces "The citation could not be inserted here." The core's own refusal is tested (`authoring-commands.test.ts`).
2. **The dialog** lists the document's sources as check boxes in the order of the sources; the order of citing is the order in which the boxes are ticked. A ticked source reveals a prefix, a locator and a suffix field. The mode (`normal`, `narrative`, `suppressAuthor`) is a select. At most 32 sources, the CDM's limit. The locator label (`label` of an item, such as chapter) is not offered: a locator is taken as a page, and the field is free text.
3. **The keyboard.** No dedicated key is bound. The command is reached from the keyboard through command search (Alt+Q), which lists every registry command, and through the toolbar and menus. Reason: a key in the shortcut table needs the four browsers' published lists read for conflicts (UX-013), which is not done here. A choice of key is the owner's or UX-013's.
4. **The accessible name of a citation** is the `aria-label` of its `note` element and is set by a view plugin after each update of the document: the sources in the document's citation style (the entry text of `bibliography.ts`, so the name follows the PDF's style as far as that module does), each with its prefix, locator and suffix, joined with semicolons. A source the document does not define keeps its identifier. It is not a live announcement: a screen reader reads the name when the caret reaches the note, as it reads any element with a name. No screen reader product was run.

## Consequences

- The schema's own label (`Citation: ` and the identifiers, `schema.ts`) stays as the name until the plugin has run, and for a rendering with no view (a copy to the clipboard).
- A change of a source's title renames the citations that cite it, because the plugin runs on every change of the document.
