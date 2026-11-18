# 03 Document model (CDM)

**Status:** draft 0.2, 2026-09-18, revised after the first review ([review](../review/2026-09-18-pitfall-review.md)). Normative.

The Canonical Document Model is the stored and transferred form of a document. The editor edits it, the authority validates it, the history records changes to it and every exporter reads it.

## 1. Principles

1. **One tree, one log.** Everything that defines a document lives in one node tree: content, style definitions, numbering definitions, page setups, role placeholders, rules, headers and footers. Every change therefore flows through the same commit log and gets the same permissions, history and undo behaviour.
2. **Plain JSON.** A CDM document serialises to the node JSON that ProseMirror uses: objects with `type`, optional `attrs`, optional `content`, and for text nodes `text` and optional `marks`. A consumer needs no ProseMirror code to read it.
3. **Word's concepts, not Word's package.** The model has named styles with inheritance, numbering definitions, page sections, fields and footnotes, because a Word-like experience needs them. It does not mirror the DOCX package. Since the owner's decision on A2 (2026-11-06), Word files must round-trip without loss. What the model does not represent is therefore kept by the preservation layer of section 4.6 and [ADR 0017](../adr/0017-lossless-docx-preservation-layer.md), not by making the model OOXML-shaped.
4. **Only what every writer can express.** A construct becomes editable in the model only when the LaTeX writer can typeset it and the DOCX writer can approximate it. Section 10 lists the support per writer. Preserved content (section 4.6) is the one exception: it can be moved or deleted only as a whole, and the LaTeX writer typesets its fallback.
5. **Formatting by reference.** Nodes point at styles. The formatting cascade is resolved at layout and export time and is never baked into content.
6. **Stable identifiers.** Every block-level node carries an `id` that never changes once set. Permissions, history, diagnostics, comments on blocks and page-break reconciliation all address blocks by `id`.
7. **No floating-point numbers.** Lengths and other quantities are integers; decimal values entered by users are strings. This keeps the canonical form, and every hash taken over it, identical across programming languages.

## 2. Envelope and canonical form

```json
{
  "cdm": 1,
  "requires": ["fields"],
  "doc": { "type": "doc", "content": [ "...defs", "...stories", "...body" ] }
}
```

- `cdm` is the major schema version.
- `requires` lists the optional features (section 11) this document uses. A reader that lacks one of them MUST refuse the document with a clear message; it MUST NOT open it and drop what it does not understand.
- Title, owner, timestamps and other metadata are not part of the CDM; they belong to the document resource in the control plane.

**Canonical form.** Wherever a hash of a document is taken, the input is the RFC 8785 serialisation of the envelope with these rules: an attribute whose value equals its schema default is omitted; marks on a text node are ordered by their position in the schema's mark list and then by the canonical serialisation of their attributes; adjacent text nodes with equal marks are merged. The conformance kit carries hash fixtures.

**Units.** Lengths are integers in twentieths of a point (1/1440 inch), including font sizes. `lineSpacing` under the `multiple` rule is an integer in thousandths (1150 means 1.15 lines). Colours are `#RRGGBB`.

## 3. Structure

```
doc
├── defs
│   ├── settings                 exactly one
│   ├── style_def*               paragraph, character and table styles
│   ├── numbering_def*
│   ├── page_setup+
│   ├── role_def*                role placeholders (12)
│   ├── rule_def*                field rules (12)
│   ├── source_def*              bibliographic sources
│   └── preserved_def*           shared preserved trees (4.6)
├── story*                       headers and footers
└── body
    └── ( block | region | section_break )+
```

`block` means one of `paragraph`, `table`, `figure`, `equation_block`, `toc`, `bibliography`, `extension_block`.

`defs` and `story` nodes are isolating and not selectable in the editing schema, and no selection, join or "select all" in the body may reach them. They are edited through dialogs and dedicated sub-editors (02).

## 4. Nodes

An attribute value of `null` means "not set here; inherit". Every node and mark also has an `ext` attribute (section 11.2).

### 4.1 Definition nodes

| Node | Content | Attributes |
|---|---|---|
| `defs` | `settings style_def* numbering_def* page_setup+ role_def* rule_def* source_def* preserved_def*` | none |
| `settings` | none | `lang`, `dir` (`ltr`, `rtl`), `defaultTabStop`, `hyphenation` (boolean), `defaultParagraphStyle`, `footnoteFormat`, `footnoteRestart` (`continuous`, `perPageSection`), `trackChanges` (`off`, `everyone`), `citationStyle` (`authorYear`, `numeric`; draft) |
| `style_def` | none | `id`, `kind` (`paragraph`, `character`, `table`), `name`, `basedOn`, `next`, `outlineLevel` (1 to 9 or null), `builtIn`, then the formatting properties in 4.5, one attribute per property |
| `numbering_def` | none | `id`, `name`, `levels`: up to nine objects with `format` (`decimal`, `lowerLetter`, `upperLetter`, `lowerRoman`, `upperRoman`, `bullet`, `none`), `text` (a template restricted to the placeholders `%1` to `%9` and the punctuation `. ( ) - § space`), `start`, `restartAfter`, `legal` (boolean: show all higher levels as decimals), `indentLeft`, `hanging`, `align`, `bulletChar` (one character from a published list), `runProps` |
| `page_setup` | none | `id`, `width`, `height`, `orientation`, `marginTop`, `marginRight`, `marginBottom`, `marginLeft`, `gutter`, `headerDistance`, `footerDistance`, `columns`, `columnGap`, `differentFirstPage`, `differentOddEven`, `headerDefault`, `headerFirst`, `headerEven`, `footerDefault`, `footerFirst`, `footerEven` (story identifiers or null), `pageNumberStart`, `pageNumberFormat`, `watermark` (text or null) |
| `role_def`, `rule_def` | none | Defined in 12 |
| `source_def` | none | Draft (section 4.7). `id`, `kind` (a CSL item type), `title`, `authors`, `editors` (lists of names), `issued`, `accessed` (dates as EDTF strings), `containerTitle`, `publisher`, `publisherPlace`, `edition`, `volume`, `issue`, `pages`, `number`, `doi`, `url`, `isbn`, `issn`, `language`, `note`, `extra` (further CSL variables) |
| `story` | `block+` | `id`, `kind` (`header`, `footer`) |

Built-in styles (`Normal`, `Heading1` to `Heading9`, `Caption`, `FootnoteText` and the like) have reserved identifiers and are present in every document. Every other definition gets a random identifier; its human-readable label is `name`. When pasted content brings a definition whose identifier already exists, the editing core maps it to the existing one instead of inserting a duplicate.

Formatting properties of a style are separate attributes so that two people changing different properties of the same style do not overwrite each other. `levels` in a numbering definition is one attribute; concurrent edits to the same numbering definition resolve to the later commit.

### 4.2 Body containers

| Node | Content | Attributes | Rules |
|---|---|---|---|
| `body` | `(block \| region \| section_break)+` | `pageSetup`: page setup of the first page section | |
| `region` | `block+` | `id`, `title`, `policy` (`inherit`, `restricted`, and `confidential` as proposed in ADR 0019) | Only a direct child of `body`. Not nestable. Isolating. The editing core keeps a body paragraph after every region, as Word does after a table, so there is always a place for the caret between and after regions |
| `section_break` | none | `id`, `pageSetup`, `start` (`nextPage`, `continuous`, `evenPage`, `oddPage`) | Only a direct child of `body` in version 1 |

### 4.3 Blocks

| Node | Content | Attributes |
|---|---|---|
| `paragraph` | `inline*` | `id`, `style`, `numbering` (`{ numberingId, level, listId }` or null), `numberingRestart` (number or null), and the paragraph properties in 4.5 as direct formatting |
| `table` | `table_row+` | `id`, `style`, `width` (`{ type: auto \| pct \| fixed, value }`), `align`, `grid` (column widths), `headerRows`, `borders`, `cellMargins` |
| `table_row` | `table_cell+` | `id`, `height`, `heightRule` (`auto`, `atLeast`, `exact`), `cantSplit` |
| `table_cell` | `(paragraph \| figure \| equation_block)+` | `id`, `colspan`, `rowspan`, `vAlign`, `shading`, `borders`, `margins` |
| `figure` | `caption?` | `id`, `asset`, `width`, `height`, `alt`, `align`, `placement` (`here`, `float`) |
| `caption` | `inline*` | none |
| `equation_block` | none (atom) | `id`, `latex`, `numbered`, `label` |
| `toc` | none (atom) | `id`, `minLevel`, `maxLevel`, `of` (`headings`, or a caption sequence name for a list of figures or tables). Entries are generated at layout and export time |
| `bibliography` | none (atom) | Draft (section 4.7). `id`, `include` (`cited`, `all`). Entries are generated at layout and export time |
| `extension_block` | none (atom) | `id`, `extension`, `payload` (JSON, at most 16 KiB), `fallbackAsset` or `fallbackText`. See 13, section 7.3 |

- Headings are paragraphs whose style has an `outlineLevel`.
- Lists are paragraphs with a `numbering` attribute, as in Word. `listId` identifies one list instance, so that two lists using the same definition number independently and a restart does not depend on a neighbouring paragraph surviving. A paragraph style may carry `numbering`, which is how headings are numbered.
- A table caption is an ordinary paragraph in the `Caption` style, kept with the table, containing a `seq` field (4.4). This is how Word models captions.
- Tables cannot contain tables in version 1.

### 4.4 Inline nodes

| Node | Attributes | Notes |
|---|---|---|
| `text` | none | Carries marks |
| `image` | `asset`, `width`, `height`, `alt` | Inline picture. `asset` is an asset identifier, never embedded data |
| `break` | `kind` (`line`, `page`, `column`) | |
| `tab` | none | |
| `equation` | `latex` | Atom |
| `footnote` | `id` | Atom in the flow with content `paragraph+`, exactly one paragraph in version 1 (CDM-001, ADR 0031) |
| `field` | `kind` (`page`, `pageCount`, `date`, `title`, `ref`, `styleRef`, `seq`, `formValue`), `format`, `target`, `name`, `cached` | Atom. `seq` numbers captions per `name` (Figure, Table, Equation). `ref` can target a bookmark, a heading, a numbered paragraph, a caption sequence or an equation label. `cached` holds the last computed text for consumers that cannot compute it |
| `citation` | `items` (cited sources, each with a prefix, suffix, locator and label), `mode` (`normal`, `narrative`, `suppressAuthor`), `cached` | Draft (section 4.7). Atom |
| `anchor` | `id`, `name` | Zero-width atom marking a bookmark |
| `form_field` | Defined in 12 | Atom |
| `extension_inline` | `extension`, `payload`, `fallbackText` | Atom |

Comments are not nodes or marks. A comment thread targets a text range or a block, and the document service keeps that range outside the document and maps it through every commit (07, section 6; 08, section 3). Commenting therefore never changes the document.

### 4.5 Formatting properties

Run properties: `fontFamily`, `fontSize`, `bold`, `italic`, `underline`, `strike`, `smallCaps`, `allCaps`, `vertAlign`, `color`, `highlight`, `lang`, `hidden`.

Paragraph properties: `align`, `dir`, `indentLeft`, `indentRight`, `indentFirstLine`, `spaceBefore`, `spaceAfter`, `contextualSpacing`, `lineSpacing`, `lineRule` (`multiple`, `exact`, `atLeast`), `keepNext`, `keepLines`, `pageBreakBefore`, `widowControl`, `tabs` (position, alignment `left`, `center`, `right`, `decimal`, and leader), `borders`, `shading`, `numbering` (styles only).

Table properties (table styles only): `borders`, `cellMargins`, `headerRowShading`, `bandedRows`.

### 4.6 Preserved content (feature `preserve`)

Draft, from [ADR 0017](../adr/0017-lossless-docx-preservation-layer.md). Spike S11 tests it before `cdm: 1` is frozen.

| Node or mark | Kind | Attributes | Notes |
|---|---|---|---|
| `preserved_block` | Block atom, in the `block` group and allowed in table cells | `id`, `label`, `fragment`, `fallbackAsset`, `fallbackText`, `width`, `height` | Content from an imported file that the model cannot represent: text boxes, shapes, charts, SmartArt, embedded objects, nested tables, floating pictures with wrap, unmapped content controls. `fragment` is an asset holding the original XML and the parts it relates to |
| `preserved_inline` | Inline atom | `label`, `fragment`, `tree`, `fallbackAsset`, `fallbackText`, `width`, `height` | The same, for content inside a paragraph. A small marker without relationships keeps its element in `tree` instead of a `fragment` asset (spike S11) |
| `preserved_def` | Definition node in `defs` | `id`, `tree` | One preserved tree that several nodes and marks share, kept once (spike S11). Without it a large Word document cannot be imported within the size limit of I7 |
| `preserved` | Mark | `props` | Run properties of the original file that the model does not represent |

Block and definition nodes also have a core attribute `preserved`, default null. It holds the attributes and child elements of the original element that the model does not represent.

- `props` and the attribute `preserved` hold JSON element trees: element names with a registered short prefix for the OOXML namespaces (`w:val`) and in Clark notation (`{namespace-uri}local-name`) for any other, attribute values and text as strings, depth at most 12, at most 16 KiB of canonical JSON each and 32 KiB on `style_def` (changes of spike S11). Instead of a tree they may hold `{ "ref": id }`, the tree of a `preserved_def`, which must exist (invariant I4).
- Inline atoms without a preserved fragment of their own (`image`, `equation`, `field`, `footnote`, `anchor`, `citation`) have a core attribute `origin`, default null: the fragment asset of the original element and the SHA-256 of the modelled attributes at import, so that the writer can tell an unedited atom from an edited one. The fragment is an attached asset (invariant I4); a non-null `origin` needs `preserve` in `requires` (SR-M10, spike S11).
- They never hold XML text. Identity-bound values of the original file, such as paragraph and revision-session identifiers, are not stored here; they stay in the source map outside the document.
- A document that contains a preserved node or mark, or a non-null `preserved` attribute, MUST list `preserve` in `requires` (invariant I1).
- `fragment` and `fallbackAsset` are assets attached to the document (invariant I4).
- Editors show the fallback. People may select, move, copy or delete a preserved node as a whole, but nothing edits inside it.

### 4.7 Sources, citations and bibliographies

Draft, from [ADR 0031](../adr/0031-cdm-1-model-completion.md) (proposed; CDM-052). They are core, not a feature, because both writers support them: LaTeX through `biblatex`, DOCX through Word's citations and sources part.

- A `source_def` in `defs` holds one bibliographic source. Each attribute maps to one CSL variable, so the data converts to and from CSL-JSON and concurrent edits to different variables do not collide. Dates are EDTF strings, never numbers.
- A `citation` is an inline atom naming one or more sources in order. Every cited source exists, and a source that is still cited cannot be deleted (invariant I4).
- A `bibliography` is a block atom. Its entries, like the text of a citation, are generated at layout and export time in the style `settings.citationStyle` names.

## 5. Marks

| Mark | Attributes | Notes |
|---|---|---|
| `bold`, `italic`, `strike`, `smallCaps`, `allCaps`, `hidden` | `value` (boolean) | `value: false` explicitly switches the property off when the style switches it on. Absence of the mark means inherit |
| `underline` | `style` (`single`, `double`, `dotted`, `none`) | |
| `vertAlign` | `value` (`super`, `sub`, `baseline`) | |
| `color`, `highlight`, `fontFamily`, `fontSize`, `lang` | `value` | |
| `charStyle` | `style` | Reference to a character style |
| `link` | `href`, `title` | `href` schemes are restricted (invariant I9) |
| `ins` | `id`, `user` | Suggested insertion |
| `del` | `id`, `user` | Suggested deletion. The text stays in the document until accepted |
| `fmt` | `id`, `user`, `before` | Suggested formatting change. `before` records the previous marks or attributes |

Marks apply to text and to inline atoms alike: an inline atom of 4.4 (a picture, an equation, a field and the rest) carries formatting and suggestion marks as text does, so that a suggested insertion of a picture is an `ins` mark on it (spike S11). On blocks, marks are node marks (below).

Rules for suggestion marks:

- They do not exclude other marks of the same type, so one person's suggestion can never replace another's on the same text.
- A suggestion `id` belongs to the user who first used it. The authority rejects its use by anyone else.
- The authority checks that `user` equals the submitting user. Marks carry no time; the time of a suggestion is the server time of the commit that introduced its `id`, which the service indexes.
- `ins`, `del` and `fmt` may also be applied to block nodes as node marks, to suggest a new or removed block or a change of paragraph style, alignment or list level. In version 1 this is limited to paragraphs, whole table rows and whole tables. The view renders block suggestions as decorations, never as wrapper elements, because a wrapper inside a table breaks its layout.

## 6. Formatting cascade

Writers and the layout engine MUST resolve formatting in this order, later entries overriding earlier ones:

1. Defaults from `settings` and the default paragraph style.
2. The table style, for content inside a table.
3. The paragraph style chain, from the root of the `basedOn` chain to the style itself.
4. The numbering level's paragraph properties, for numbered paragraphs. As in Word, the level's indent overrides the paragraph style's (owner decision 9, 2026-11-15).
5. Direct paragraph attributes.

For runs, continue with:

6. The run properties of the resolved paragraph style.
7. The character style chain.
8. Direct marks. A toggle mark with `value: false` switches the property off.

## 7. Layout semantics

The editor, the LaTeX writer and the DOCX writer must agree on more than formatting values. These rules are normative, and `packages/model` holds their one implementation and the shared fixtures. They are to be completed with fixtures during phases 0 and 1.

| Topic | Rule |
|---|---|
| Numbering | One algorithm computes every label from `numbering_def`, `numbering`, `listId`, `numberingRestart` and document order, across regions and tables. Writers print the computed label as literal text; they do not rely on their own counters. Cross-references to numbered items print the computed label too. Page numbers are the one exception, because only the typesetter knows them |
| Paragraph spacing | The gap between two paragraphs is the larger of the first one's `spaceAfter` and the second one's `spaceBefore`. With `contextualSpacing`, the gap between two paragraphs of the same style is zero |
| Line spacing | `multiple` applies per line to the height of the tallest run on that line; `exact` and `atLeast` are lengths |
| Header growth | A header taller than the space the page setup gives it pushes the body down |
| Tabs | Left, centre, right and decimal tab stops with leaders, measured from the left margin |
| Fields | `date` fields, and form fields of kind `dateSigned` (12, section 3.3), use the time zone of the workflow or of the export job, never the client's |

## 8. Invariants

The authority MUST reject a commit whose result violates any of these. `model.validate()` checks the same list. Checks apply to the result of every step type, including `attr` and mark steps.

| ID | Invariant |
|---|---|
| I1 | The document is valid against the schema for its `cdm` version and `requires` list |
| I2 | At the end of a commit, every node type that declares an `id` has a non-null one and identifiers are unique in the document. A non-null `id` never changes |
| I3 | Regions and section breaks appear only as direct children of `body`; regions do not nest; a region identifier that was ever removed from this document is not reused |
| I4 | Every reference resolves: `style`, `basedOn`, `next`, `numberingId`, `pageSetup`, header and footer story identifiers, `field.target`, the sources of a `citation`, and every `asset` (which must be attached to this document; 06, section 4.4). A definition that is still referenced cannot be deleted |
| I5 | `basedOn` chains have no cycles and are at most ten styles deep |
| I6 | In every table row the column spans add up to the length of `grid`; row spans do not run past the last row |
| I7 | Limits hold: canonical size at most 16 MiB, at most 500 regions, at most 63 table columns, nesting depth at most 12, `latex` attributes at most 4,000 characters |
| I8 | `latex` attributes pass the math gate in 09 |
| I9 | `link.href` uses an allowed scheme: `http`, `https`, `mailto`, or an in-document target |
| I10 | Forbidden combinations: a footnote inside a footnote or a caption; a figure with `placement: float` inside a table cell; page and column breaks inside cells, captions and footnotes; tables inside stories and footnotes; form fields inside stories and footnotes (12, section 3.2) |
| I11 | Every attribute value matches the grammar declared for it in the schema: type, range, length and pattern. Identifiers, names, templates, colours and lengths all have one. This is what keeps hostile strings out of the exporters (09) and out of the editor's styles |
| I12 | Reserved for the rules on extensions: the envelope of an extension node is valid and within its size limit |

I13 to I15 are defined in 12.

## 9. Identifiers

Node identifiers are 16-character strings over the URL-safe Base64 alphabet, generated randomly by the client that creates the node.

In the editing schema `id` defaults to null, because ProseMirror cannot create or fill nodes that have a required attribute. The identifier plugin sets missing identifiers in the same transaction, and invariant I2 is checked at the end of the commit. When a paragraph is split, the part that keeps the existing content keeps the identifier; pressing Enter at the start of a paragraph gives the fresh identifier to the new empty paragraph. Copies made by pasting or duplicating get fresh identifiers.

## 10. Writer support

| Construct | LaTeX (PDF) | DOCX | Notes |
|---|---|---|---|
| Named styles, direct formatting, fonts, colours | Yes | Yes | LaTeX uses macros generated from the styles |
| Multi-level numbering | Yes | Yes | Literal labels from the shared algorithm |
| Tables with spans, borders, shading, repeated header rows | Partial | Yes | Three table writers in LaTeX (09, section 3.2). A row taller than a page is split by the converter at paragraph boundaries. Tables inside multi-column sections, headers and footnotes cannot span pages |
| Inline images and block figures with captions | Yes | Yes | |
| Floating figures with text wrap | No | No | Not in the model in version 1 |
| Headers and footers, first and even pages, page fields | Yes | Yes | |
| Page sections with their own size, orientation and columns | Partial | Yes | Orientation and margin changes force a page break in LaTeX; a `continuous` break that changes margins is reported as unsupported |
| Footnotes | Yes | Yes | One paragraph each in version 1 |
| Table of contents, lists of figures and tables, bookmarks, cross-references | Yes | Yes | |
| Math | Yes | Partial | DOCX export converts LaTeX to Office math on the server; unsupported macros fall back to an image |
| Tab stops | Partial | Yes | The house class implements tab stops itself; decimal tabs inside justified text are approximate |
| Comments and suggestions | Optional | Yes | The PDF writer can render markup or a clean view; see 09 |
| Regions | Not visible | Content controls plus editable ranges | See 07 |
| Form fields | Flattened values | Content controls with data binding | See 12 |
| Extension nodes | Fallback | Fallback | |
| Sources, citations and bibliographies | Yes | Partial | Draft (section 4.7). `biblatex` in the style of `settings.citationStyle`; DOCX writes Word citations and the sources part, which Word renders in its own styles |

The writer-support table of every construct (each node type, mark, `field` kind and page-setup feature) is generated from the definition as `spec/cdm/cdm-1.writer-support.md` (CDM-046); rows this table does not give are proposed in ADR 0031.

## 11. Evolution

### 11.1 Versions and features

- `cdm` is an integer major version. A change that an old reader cannot handle increments it.
- Optional node types and marks belong to named features (`fields`, `extensions`, `preserve` and future ones). A document lists the features it uses in `requires`. A ProseMirror-based reader throws on unknown node types and marks, so a reader MUST check `requires` before parsing.
- A room accepts a commit that adds a feature to `requires` only when every attached client announced that feature. A client that connects later without it is refused with `unsupported_feature`.

### 11.2 Additive attributes

A ProseMirror schema silently drops attributes it does not declare. New optional attributes are therefore introduced inside `ext`, an object attribute present on every node and mark with default `{}`, under a namespaced key. Every reader preserves `ext` unchanged. An attribute moves out of `ext` only at the next major version.

### 11.3 Migration

- A migration is a pure function from a document at version n to a document at version n+1. It is recorded as a snapshot commit (04, section 3.2) with origin `migration`, with a checkpoint on each side.
- Migrations never run by themselves when a document is opened. An operator enables version n+1 for a tenant only when every service node and every component version the tenant still embeds supports it. The service supports versions n and n-1 side by side for a published window.
- Every commit records the schema version and engine version it was made with. Reading history older than a migration uses the checkpoint written before it and the matching older model package, which stays published and runnable for as long as the history is kept (owner decision 58, ADR 0384). History is never rewritten to a newer format. A version after the last migration is rebuilt from the checkpoint written after it and needs only the current package.

## 12. Example

```json
{
  "cdm": 1,
  "requires": [],
  "doc": {
    "type": "doc",
    "content": [
      { "type": "defs", "content": [
        { "type": "settings", "attrs": { "lang": "en-GB", "defaultTabStop": 720, "defaultParagraphStyle": "Normal" } },
        { "type": "style_def", "attrs": { "id": "Normal", "kind": "paragraph", "name": "Normal", "builtIn": true, "fontFamily": "Noto Serif", "fontSize": 220, "spaceAfter": 160, "lineSpacing": 1150, "lineRule": "multiple" } },
        { "type": "style_def", "attrs": { "id": "Heading1", "kind": "paragraph", "name": "Heading 1", "builtIn": true, "basedOn": "Normal", "next": "Normal", "outlineLevel": 1, "fontSize": 320, "bold": true, "keepNext": true } },
        { "type": "page_setup", "attrs": { "id": "ps1", "width": 11906, "height": 16838, "marginTop": 1440, "marginRight": 1440, "marginBottom": 1440, "marginLeft": 1440 } }
      ] },
      { "type": "body", "attrs": { "pageSetup": "ps1" }, "content": [
        { "type": "paragraph", "attrs": { "id": "p3Jq8sLw0aZx1VbN", "style": "Heading1" }, "content": [ { "type": "text", "text": "Scope" } ] },
        { "type": "region", "attrs": { "id": "rG7mK2pQ9xYt4HcD", "title": "Legal review", "policy": "restricted" }, "content": [
          { "type": "paragraph", "attrs": { "id": "pA1b2C3d4E5f6G7h", "style": "Normal" }, "content": [
            { "type": "text", "text": "Liability is limited to " },
            { "type": "text", "text": "direct", "marks": [ { "type": "bold", "attrs": { "value": true } } ] },
            { "type": "text", "text": " damages." }
          ] }
        ] },
        { "type": "paragraph", "attrs": { "id": "pZ9y8X7w6V5u4T3s", "style": "Normal" } }
      ] }
    ]
  }
}
```

## 13. Open issues

- The content of `footnote` is `paragraph+`, limited to one paragraph in version 1 (CDM-001, from the evidence of spike S1; ADR 0031, proposed). Lifting the limit later needs no new major version. Because a paragraph admits any inline node, `model.validate()` refuses a footnote inside a footnote (I10) instead of the content expression.
- Tables inside tables, floating figures with text wrap, text boxes and endnotes cannot be created or edited in version 1. Those in an imported Word file are kept as preserved content (section 4.6) and written back unchanged (A2). Each needs support in the layout engine and both writers before it can enter the model as editable content.
- Section breaks inside regions are excluded, so a region editor cannot insert a landscape page. Lifting this needs a rule for who may change page setup.
- Citations and a bibliography are a version 1 requirement since the owner's decision of 2026-11-06 that the first release serves all three candidate markets, academic writing included. Section 4.7 defines them as a draft (CDM-052; ADR 0031, proposed), and EXP-121 maps them to `biblatex`. The citation styles of the house class (`settings.citationStyle`) are proposed, not decided.
- `levels` of a numbering definition is one attribute. If concurrent edits to numbering definitions prove common, levels should become child nodes.
- Block-level suggestions for table cells and columns are not defined.
