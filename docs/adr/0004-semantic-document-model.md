# ADR 0004: A semantic document model built from Word's concepts, not a mirror of the DOCX package

**Status:** proposed, 2026-09-18; revised 2026-11-06. On that date the project owner confirmed assumption A4 (LaTeX is an export pipeline) and reversed assumption A2: Word files must round-trip without loss. The semantic model stands. A preservation layer is added by [ADR 0017](0017-lossless-docx-preservation-layer.md), which replaces the statements below about losses on import.

## Context

The editors that reach Word-level fidelity (ONLYOFFICE, Syncfusion, SuperDoc version 2, Eigenpal) use a model shaped like OOXML and keep the original package so that unknown content survives a save. Editors with HTML-like models (Tiptap, CKEditor) document their own losses. That argues for an OOXML-shaped model when Word fidelity is the goal.

This product's final output is LaTeX. A model that mirrors the DOCX package would carry constructs LaTeX cannot typeset and would commit the layout engine to chasing Word's undocumented layout behaviour.

## Decision

Define the Canonical Document Model (03): one tree holding definitions (settings, styles, numbering, page setups), header and footer stories, and the body. It uses Word's concepts where a Word-like experience needs them: named styles with inheritance, paragraph-level numbering, page sections, fields, footnotes, paired anchors. It admits a construct only when the LaTeX writer can typeset it and the DOCX writer can approximate it. It serialises to plain JSON in ProseMirror's node format. DOCX import and export are conversions with documented losses.

Definitions live in the tree as nodes with one attribute per property, so that all changes flow through one log and concurrent edits to different properties do not collide.

## Consequences

Good:
- One format for the editor, the authority, history and every exporter.
- The layout engine approximates a LaTeX class the project controls, not Word.
- A published capability table keeps scope honest.

Bad:
- Word files do not round-trip. Text boxes, shapes, floating objects, nested tables and unknown XML are dropped on import, with warnings.
- Some users will expect Word compatibility that the product does not promise.

## Alternatives considered

| Alternative | Why not |
|---|---|
| OOXML-shaped model with package retention | Right for a Word clone; wrong when LaTeX is the output. Much larger scope |
| HTML-like model | Cannot express style references against direct formatting, toggle properties that switch a style off, numbering definitions or page sections |
| LaTeX source as the model | Limits the editor to what a visual layer over LaTeX can express; page layout and named styles do not survive arbitrary LaTeX |
| Styles and numbering as document attributes or side tables | Concurrent edits would overwrite each other, and changes would bypass the log or need a second one |

## After the first review (2026-09-18)

- The model contains no floating-point numbers. Lengths are integers in twentieths of a point, and a canonical form is defined, so that hashes agree across programming languages.
- Every attribute has a grammar that is checked when it is set. User-chosen strings reach LaTeX, CSS and DOCX in many contexts, and rejecting hostile values at the model is the first line of defence.
- Numbering, paragraph spacing, line spacing, header growth and tabs get one normative definition shared by the editor and both writers, because three engines computing them separately will disagree. Writers print computed list labels as literal text.
- List paragraphs carry a list instance identifier, styles can carry numbering, captions use sequence fields as in Word, and a few cheap attributes were added now because adding them later is awkward.
- Form fields, role placeholders, rules and extension nodes are reserved in version 1.
- Comments left the model ([ADR 0015](0015-comments-as-mapped-ranges.md)).
- The original Word file of an import is kept, so that assumption A2 can still be revisited.

## After the owner's decisions (2026-11-06)

- A4 is confirmed. The CDM document stays the stored source of truth, so the model is still built for the LaTeX writer and the editor, not shaped like OOXML.
- A2 is reversed: Word files must round-trip without loss. The "Bad" consequence "Word files do not round-trip" no longer holds. [ADR 0017](0017-lossless-docx-preservation-layer.md) adds three things:
  - a source package and source map outside the document;
  - preserved properties inside the document;
  - preserved atoms that refer to fragment assets, for content the model cannot represent.
- Principle 4 of 03 ("only what every writer can express") still governs what can be edited. Preserved content is not editable inside, and the LaTeX writer typesets its fallback.

## Revisit when

Spike S11 (SPK-028) shows that the preservation layer of ADR 0017 cannot meet the lossless contract with a semantic model.
