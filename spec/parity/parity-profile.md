# Parity profile

Version 2, 2026-11-06. Generated from `packages/ui/src/parity/profile.ts` by `pnpm --filter @docedit/ui generate`; do not edit by hand. The source of the tiers is [13 §2](../../docs/spec/13-experience-extensibility.md); the machine-readable form is `parity-profile.json` next to this file.

Parity is judged by what a user can do, never by how a screen looks (13 §1). Each row states a capability in this product's words, the phase in which its last delivering story is planned, and those stories. A non-goal is delivered by nothing; changing the non-goals needs an owner decision recorded in PRODUCT.md and 13 §2 in the same change set.

## Built in

| Capability | What a user can do | Phase | Stories | Spec |
|---|---|---|---|---|
| toolbar | Reach every command from a toolbar, either one compact row or a full layout with commands grouped by task, by pointer or keyboard. | 1a to 1b | UX-006 (1a), UX-007 (1b) | 13 §2, §3, §4 |
| command-search | Find a command by typing its name or a synonym, and run it, within their rights. | 2 | UX-011 (2) | 13 §2, §4 |
| access-keys | Run commands from the keyboard through access keys. | 2 | UX-012 (2) | 13 §2, §4 |
| context-menu | Open a menu of the commands that apply to the selection or to the object under the pointer. | 1b | UX-008 (1b) | 13 §2, §4 |
| format-painter | Copy the formatting of one place and apply it to another. | 1b | UX-009 (1b) | 13 §2 |
| mini-toolbar | Format a selection from a small set of commands offered next to it. | 2 | UX-010 (2) | 13 §2, §4 |
| styles | See the styles of the document, see which one is in effect at the caret, and apply one to the selection. | 1a to 1b | FE-127 (1a), UX-022 (1b) | 13 §2; 03 §4 |
| navigation-pane | Move through the document by its headings and by search results, and by page thumbnails once real pages exist. | 1b to 3 | UX-020 (1b), UX-021 (3) | 13 §2, §3 |
| rulers | See and change indents, tab stops and margins on rulers, or with the keyboard or a dialog instead. | 2 | UX-102 (2) | 13 §2; 02 §3, §10 |
| zoom | Change the scale of the content without changing the document. | 1b | FE-138 (1b) | 13 §2, §3 |
| status-bar | See word and page counts, language, connection and save state and zoom at a glance. | 1b | UX-018 (1b) | 13 §2, §3 |
| modes | Switch between editing, reviewing with suggestions, viewing and filling in fields, within their rights. | 1b to 2 | FE-029 (1b), FRW-069 (1b), PRO-077 (1b), UX-015 (1b), FE-041 (2) | 13 §2, §3; 05 §8.1 |
| themes | Work in a light, a dark or a high-contrast theme, and with the system forced colours. | 1b | UX-061 (1b), UX-062 (1b) | 13 §2, §8 |
| character-and-paragraph-formatting | Format characters (font, size, bold, italic and other effects) and paragraphs (alignment, indents, spacing). | 1b | FE-128 (1b), FE-129 (1b) | 13 §2; 03 §4 |
| lists | Make numbered and bulleted lists with several levels. | 1b | CDM-019 (1b), FE-130 (1b) | 13 §2; 03 §7 |
| tables | Insert and edit tables, apply table styles and sort rows. | 1b | FE-040 (1b), FE-131 (1b) | 13 §2; 03 §4.3 |
| pictures | Insert pictures and figures and give them alternative text. | 1b | CDM-029 (1b), FE-132 (1b) | 13 §2; 03 §4.3, §4.4 |
| symbols | Insert a symbol by picking it. | 1b | FE-136 (1b) | 13 §2 |
| equations | Write and edit equations, and see them on screen and in the PDF. | 1b | CDM-030 (1b), EXP-052 (1b), FE-069 (1b), FE-070 (1b), FE-136 (1b) | 13 §2; 03 §4.4; 09 |
| headers-and-footers | Write the headers and footers of each page section. | 1b | FE-057 (1b), FE-137 (1b) | 13 §2; 02 §5.2 |
| page-numbers | Insert page numbers, and set where they start and how they are written. | 1b to 2 | FE-136 (1b), EXP-036 (2) | 13 §2; 03 §4.4 |
| columns | Set text in columns. | 1b | EXP-040 (1b), FE-135 (1b) | 13 §2 |
| breaks | Insert line, page, column and section breaks. | 1b | CDM-033 (1b), FE-135 (1b) | 13 §2; 03 §4 |
| footnotes | Insert footnotes and write them in a panel beside the page. | 1b | FE-058 (1b), FE-135 (1b) | 13 §2; 02 §5.2 |
| table-of-contents | Insert a table of contents that builds itself from the headings. | 1b | EXP-023 (1b), FE-136 (1b) | 13 §2; 03 §4.3 |
| captions-and-cross-references | Number figures and tables with captions, and refer to them by number. | 1b | FE-134 (1b) | 13 §2; 03 §7 |
| citations | Cite sources and produce a bibliography. | 1b | EXP-121 (1b), FE-140 (1b), UX-103 (1b) | 13 §2; 03 §13 |
| bookmarks | Mark a place in the document and link to it. | 1b | FE-133 (1b) | 13 §2 |
| links | Insert links and follow them. | 1b | FE-133 (1b) | 13 §2; 03 §4.4 |
| watermark | Print a watermark text on the pages of a section. | 1b to 2 | FE-137 (1b), EXP-036 (2) | 13 §2; 03 §4.1 |
| fields-and-forms | Add fields for roles to fill in, and fill in their own fields with guidance. | 1b | FRW-072 (1b), FRW-073 (1b), FRW-076 (1b) | 13 §2; 12 |
| comments | Comment on text or on a block, reply, resolve, mention people and assign a thread to someone as a task. | 2 | UX-028 (2), UX-029 (2), UX-030 (2), UX-031 (2), UX-032 (2) | 13 §2, §5 |
| suggestions | Suggest changes, and accept or reject suggestions one by one or all at once. | 2 | FE-042 (2), FE-046 (2), FE-047 (2), UX-035 (2), UX-036 (2), UX-037 (2) | 13 §2, §5; 02 §5.2 |
| version-history | Browse earlier versions, compare two of them and restore one. | 2 | HIS-006 (2), HIS-009 (2), HIS-010 (2), HIS-013 (2) | 13 §2; 08 |
| catch-up | See what changed and what was said in comments since their last visit. | 2 | HIS-027 (2), HIS-028 (2) | 13 §2, §5; 08 §10 |
| presence | See who else is in the document and where they are working. | 1a to 1b | UX-026 (1a), UX-027 (1b) | 13 §2, §5 |
| save-state | See at all times whether their work is saved, being saved, kept only on this device, or read-only. | 1a | FE-007 (1a), UX-016 (1a) | 13 §2, §3; 02 §2.2 |
| recovery-journal | Get back work after the page was closed or crashed, and content that was set aside. | 1b | FE-008 (1b), FE-009 (1b), FE-010 (1b), UX-017 (1b) | 13 §2, §9; 02 §2.2 |
| templates | Start a document from a template. | 4 | FRW-062 (4), UX-100 (4) | 13 §2, §11.2 |
| accessibility-checker | Find and fix accessibility problems in the document before exporting it. | 2 | UX-066 (2), UX-067 (2) | 13 §2, §8 |
| export-pdf | Export the document as a typeset PDF and look at it. | 1a to 1b | EXP-001 (1a), FE-071 (1a), EXP-004 (1b) | 13 §2; 09 |
| export-latex | Download the LaTeX source of the document. | 1b | EXP-085 (1b) | 13 §2; 09 |
| docx | Open a Word file and write it back as a Word file without losing what the editor cannot show. | 2 | EXP-090 (2), EXP-098 (2), EXP-118 (2) | 13 §2; ADR 0017 |
| export-html | Export the document as HTML. | 2 | EXP-087 (2) | 13 §2; 11 §5 |
| export-markdown | Export the document as Markdown. | 2 | EXP-088 (2) | 13 §2; 11 §5 |
| editing | Type and delete text, select the whole body, and undo and redo their own changes. | 1a to 1b | FE-032 (1a), FE-049 (1b), FE-066 (1b) | 02 §5.2 (body-scoped commands, history); 00 R1 |
| sharing | Ask the host application to share the document, in a dialog of its own. | 1b | PRO-089 (1b), UX-039 (1b) | 13 §5 (sharing); 05 §8.1 |
| keyboard-shortcuts | Run commands with the shortcuts word processors use, where the browser allows them, and look every shortcut up in a reference made from the shortcut table. | 1b | UX-013 (1b) | 13 §4 (shortcut table); 02 §3 (keyboard) |
| views | Switch between the views the build supports: the continuous web layout first, real pages once they exist. | 1b | FE-065 (1b), UX-007 (1b) | 02 §7; 13 §3 (modes and views); 05 §8.1 (view) |
| regions-and-permissions | See which parts of a document they may edit and who can edit the others, move to the next part they may edit, mark blocks as a region and give people roles on it. | 1b | PRM-026 (1b), PRM-027 (1b), PRM-033 (1b), PRM-035 (1b), PRM-036 (1b) | 07 §7; 13 §3 (permissions pane); 05 §6.2 (regions, grants) |

## Through ports and extensions

| Capability | What a user can do | Phase | Stories | Spec |
|---|---|---|---|---|
| spelling-and-grammar | Check spelling and grammar through a proofing service that the host or the backend provides. | 2 | UX-041 (2), UX-042 (2), UX-043 (2) | 13 §2, §6.1 |
| text-prediction | Get predictions of the next words while typing. | none | none | 13 §2 |
| assistant | Ask an assistant to draft, rewrite, summarise or answer questions; what it writes arrives as suggestions. | 2 | UX-044 (2), UX-045 (2), UX-046 (2), UX-047 (2), UX-048 (2) | 13 §2, §6.2 |
| translate | Translate text. | none | none | 13 §2 |
| read-aloud | Have the document read aloud. | none | none | 13 §2 |
| dictation | Dictate through the operating system, whose dictation types into the editing surface like a keyboard. | 1b | FE-066 (1b) | 13 §2; 02 §7, §8 |
| custom-blocks | Insert blocks and inline content that a host extension defines, with a fallback every writer can show. | 2 | UX-056 (2), UX-057 (2), UX-058 (2) | 13 §2, §7.3 |
| host-panels-and-commands | Use panels and commands of the host application inside the editor, under the same permissions and accessibility rules. | 2 | UX-050 (2), UX-051 (2), UX-052 (2) | 13 §2, §7.1 |

## Non-goals

| Capability | What a user can do | Spec |
|---|---|---|
| smartart | Cannot create or edit diagram graphics; those in imported Word files are kept and shown with their fallback. | 13 §2; ADR 0017 |
| charts | Cannot create or edit charts; those in imported Word files are kept and shown with their fallback. | 13 §2; ADR 0017 |
| shapes | Cannot draw or edit shapes; those in imported Word files are kept and shown with their fallback. | 13 §2; ADR 0017 |
| text-boxes-and-ink | Cannot create or edit text boxes or ink; those in imported Word files are kept and shown with their fallback. | 13 §2; ADR 0017 |
| mail-merge | Cannot merge a document with a list of recipients; filling fields by role is the supported way. | 13 §2; PRODUCT.md |
| macros | Cannot record or run macros. | 13 §2; PRODUCT.md |
| table-formulas | Cannot compute values in table cells; field rules compute field values instead. | 13 §2; 12 §5 |
| researcher-lookup | Cannot search outside sources from within the editor. | 13 §2 |
| transcription | Cannot transcribe recordings. | 13 §2 |
| offline-first | Cannot edit without a connection to the service; a lost connection is bridged by the recovery journal (owner decision A1). | 13 §2; ADR 0001; PRODUCT.md |

## Built-in commands

Every command of the built-in registry (UX-003) names the row it delivers; the build fails when the row is missing.

| Command | Capability |
|---|---|
| `edit.undo` | editing |
| `edit.redo` | editing |
| `edit.selectAll` | editing |
| `format.bold` | character-and-paragraph-formatting |
| `format.italic` | character-and-paragraph-formatting |
| `insert.footnote` | footnotes |
| `page.header` | headers-and-footers |
| `page.footer` | headers-and-footers |
| `format.applyStyle` | styles |
| `navigate.nextEditableRegion` | regions-and-permissions |
| `edit.insertRecovered` | recovery-journal |
| `edit.discardRecovered` | recovery-journal |
| `insert.caption` | editing |
| `edit.moveBlockUp` | editing |
| `edit.moveBlockDown` | editing |
| `insert.field.text` | fields-and-forms |
| `insert.field.number` | fields-and-forms |
| `insert.field.date` | fields-and-forms |
| `insert.field.checkbox` | fields-and-forms |
| `insert.field.choice` | fields-and-forms |
| `insert.field.signature` | fields-and-forms |
| `insert.field.initials` | fields-and-forms |
| `insert.field.dateSigned` | fields-and-forms |
| `insert.field.formula` | fields-and-forms |
| `view.outline` | navigation-pane |
| `view.comments` | comments |
| `view.catchUp` | catch-up |
| `view.history` | version-history |
| `document.share` | sharing |
| `view.find` | navigation-pane |
| `view.styles` | styles |
| `view.recovered` | recovery-journal |
| `view.shortcuts` | keyboard-shortcuts |
| `view.commandSearch` | command-search |
| `view.permissions` | regions-and-permissions |
| `view.checker` | accessibility-checker |
| `view.review` | suggestions |
| `view.assistant` | assistant |
| `view.sources` | citations |
| `view.fieldProperties` | fields-and-forms |
| `view.rules` | fields-and-forms |
| `view.roles` | fields-and-forms |
| `view.fillSummary` | fields-and-forms |
| `format.painter` | format-painter |
| `format.applyFormat` | format-painter |
| `format.language` | character-and-paragraph-formatting |
| `format.paragraph` | character-and-paragraph-formatting |
| `table.size` | editing |
| `insert.crossReference` | editing |
| `insert.citation` | citations |
| `insert.region` | regions-and-permissions |
| `history.nameVersion` | version-history |
| `workflow.send` | fields-and-forms |
| `review.comment` | comments |
| `document.export` | export-pdf |
| `document.import` | host-panels-and-commands |
| `document.print` | export-pdf |
| `proofing.next` | spelling-and-grammar |
| `proofing.previous` | spelling-and-grammar |
| `view.zoomIn` | zoom |
| `view.zoomOut` | zoom |
| `view.zoomReset` | zoom |
| `page.closeStory` | headers-and-footers |
| `mode.edit` | modes |
| `mode.review` | modes |
| `mode.view` | modes |
| `mode.fill` | modes |
| `review.markup.all` | suggestions |
| `review.markup.simple` | suggestions |
| `review.markup.none` | suggestions |
| `review.markup.original` | suggestions |
| `review.next` | suggestions |
| `review.previous` | suggestions |
| `review.accept` | suggestions |
| `review.reject` | suggestions |
| `review.acceptAll` | suggestions |
| `review.rejectAll` | suggestions |
| `view.layout.web` | views |
| `view.layout.read` | views |
| `view.layout.print` | views |
| `format.underline` | character-and-paragraph-formatting |
| `format.strike` | character-and-paragraph-formatting |
| `format.clear` | character-and-paragraph-formatting |
| `format.fontSize` | character-and-paragraph-formatting |
| `format.color` | character-and-paragraph-formatting |
| `format.highlight` | character-and-paragraph-formatting |
| `format.align.start` | character-and-paragraph-formatting |
| `format.align.center` | character-and-paragraph-formatting |
| `format.align.end` | character-and-paragraph-formatting |
| `format.align.justify` | character-and-paragraph-formatting |
| `format.bulletList` | lists |
| `format.numberList` | lists |
| `format.indentMore` | lists |
| `format.indentLess` | lists |

## Gaps

- **pictures**: Cropping has no story: the document model has no crop attributes (FE-132 notes).
- **text-prediction**: No port and no story: 13 §6 defines only a proofing and an assistant port (UX open questions).
- **translate**: No port and no story (UX open questions).
- **read-aloud**: No port and no story (UX open questions).
- **dictation**: No story tests dictation itself; the web view uses the browser input it relies on.
