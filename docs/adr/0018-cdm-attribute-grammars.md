# ADR 0018: CDM attribute grammars, defaults, references and canonical-form rules

**Status:** proposed, 2026-11-06. Records the decisions of stories CDM-002 and CDM-003 as a maintainer's proposal; the project owner has not reviewed them. The values live in one place, the definition in `packages/model/src/definition/cdm1.ts`. The generated table `spec/cdm/cdm-1.attributes.md` gives every attribute's type, range, length, pattern and default.

## Context

03 names most attributes but not their grammars or defaults. Invariant I11 needs a grammar for every attribute, and the canonical form (03 §2) omits every value equal to its default. Two implementations therefore agree on a document's bytes and hash only if both are written down. The story writers listed the gaps (CDM-002, CDM-003; findings note §3).

## Decision

### Grammars and defaults (CDM-002)

| Topic | Decision |
|---|---|
| Every attribute | Has a grammar (type, range, length, pattern) and a default. The generator fails when one is missing (CDM-006). The default is what the canonical form omits |
| Required values | `id` and a few others (`figure.asset`, `style_def.name`, `body.pageSetup`) are marked "required in a stored document". Their default is null only so that ProseMirror can create the node (03 §9). Invariant I2 (for `id`) or I11 (for the others) refuses null at the end of a commit |
| Integers | Every range lies inside the interoperable range of RFC 8785. Lengths are at most 22 inches (31,680 twips), font sizes 1 to 1,638 points |
| Colours | `#RRGGBB` in upper case |
| Strings | Lengths count Unicode code points, as JSON Schema does. Free text refuses C0 and C1 control characters other than tab and line feed. Patterns are ASCII regular expressions that behave the same in ECMAScript and Python |
| Paragraph alignment | `start`, `center`, `end`, `justify`, `distribute`. These are logical values, because paragraphs have a direction. Tables and numbering levels use `start`, `center`, `end` |
| Tab stops | `left`, `center`, `right`, `decimal`, measured from the left margin as 03 §7 says, with the leaders `none`, `dot`, `hyphen`, `underscore`, `middleDot`, `heavy` |
| Borders | `{ style, width, color, space }`. Style is one of `none`, `single`, `double`, `dotted`, `dashed`, `thick`; width is 0 to 240 twips; color null means automatic; space is 0 to 620 twips. Paragraph borders have `top`, `bottom`, `left`, `right`, `between`; tables add `insideH` and `insideV`; cells have the four sides |
| Shading | `{ fill }`, an object so that a pattern can be added later without a new attribute |
| Other enumerations | `orientation`: `portrait`, `landscape`. `pageNumberFormat`: `decimal`, `lowerRoman`, `upperRoman`, `lowerLetter`, `upperLetter`. `footnoteFormat`: the same plus `symbol`. `vAlign`: `top`, `center`, `bottom`. `highlight`: the sixteen named highlight colours Word files use, so that imports round-trip (A2). `lang`: well-formed BCP 47 |
| Built-in styles | Reserved identifiers, each with its kind: `Normal`, `Heading1` to `Heading9`, `Title`, `Subtitle`, `Quote`, `IntenseQuote`, `ListParagraph`, `NoSpacing`, `Caption`, `FootnoteText`, `Header`, `Footer`, `TOCHeading`, `TOC1` to `TOC9` (paragraph); `DefaultParagraphFont`, `FootnoteReference`, `Hyperlink`, `Strong`, `Emphasis` (character); `TableNormal`, `TableGrid` (table). A reserved identifier may be used only by a built-in style of its kind. A document defines the built-in styles it uses, not all of them: the example of 03 §12 defines two, so "present in every document" (03 §4.1) is read as "available to every document" |
| Bullets | The published list: • ◦ ▪ ■ □ ● ○ – — ➢ ✓ ♦ ◆ * - |
| Definition identifiers | Any `[A-Za-z0-9_-]{1,64}`, so the `ps1` of the example is valid. The editor gives new definitions 16-character random identifiers (03 §4.1) |
| Node identifiers | 16 characters of URL-safe Base64 (03 §9). When a paragraph is split in the middle, the first half keeps the identifier, as at the end of a paragraph. That keeps the identifier with the start of the content, which is what comments on blocks and diagnostics point at |
| `field.target` | One form per target kind: `bookmark:<name>`, `node:<paragraph id>` (headings, numbered paragraphs and captions), `eq:<label>`, `style:<style id>` for `styleRef`, `field:<key>` for `formValue` |
| `link.href` | `http`, `https`, `mailto`, or `#<name>` for an in-document target (I9) |
| Uniqueness | Bookmark names and equation labels are unique in the document, because references target them |
| `listId` | A 16-character random identifier. Who gives a pasted list a fresh one is the editing core's rule (CDM-012) |
| `ext` | An object whose keys are `vendor.example:name`, at most 4 KiB of canonical JSON and 8 levels deep, integers only |
| `fmt.before` | `{ "marks": [mark JSON], "attrs": { name: value } }`, at most 4 KiB |
| Payloads | `extension_block` up to 16 KiB (I12), `extension_inline` up to 4 KiB, never non-integer numbers |
| Preserved data | Element trees (ADR 0017) of at most 16 KiB and 8 levels, with names in Clark notation. They may be non-null only with the feature `preserve` |

### Content expressions carry what they can of I10

The schema forbids, by its content expressions:

- tables in stories (`story_block+`);
- footnotes in captions (`caption_inline*`);
- footnotes and form fields in footnotes (`note_inline*`);
- tables in table cells (`cell_block+`).

Bans that depend on an attribute stay in `model.validate()` under I10: page and column breaks in cells, captions and footnotes, floating figures in cells, and form fields in headers and footers.

ProseMirror allows node marks on every child of a node that permits them. `body`, `region`, `story` and `table_cell` permit `ins`, `del` and `fmt` on their children, and `table` permits them on its rows. `model.validate()` then refuses them on any node other than `paragraph`, `table_row` and `table` (03 §5).

### Table geometry (I6)

With row spans, positions covered from above have no cell. Each row's column spans, plus the columns covered by cells spanning down from earlier rows, must add up to the length of `grid` without overlap. Row spans may not run past the last row.

### Canonical form (CDM-003)

| Question | Decision |
|---|---|
| Empty `content`, `marks`, `attrs` | Omitted, as the example of 03 §12 omits `content` on an empty paragraph |
| `requires` | Sorted by UTF-16 code units, without duplicates |
| Defaults inside object attributes | Not stripped. The object is compared with the attribute's default as a whole |
| Mark order | Position in the schema's mark list, then the RFC 8785 text of the canonical attributes. Node marks follow the same rule. The mark list order is part of the published schema and of its hash (CDM-008) |
| Subtrees | The canonical form of a node alone, without the envelope, under the same rules. Approvals (07 §11) hash a region this way |
| Versioning | The rules carry `CANONICAL_FORM_VERSION = 1`. Commits and checkpoints record it next to every hash they store, so that hashes stay checkable after the rules change |
| Bytes | The UTF-8 encoding of the RFC 8785 text, hashed with SHA-256 |

## Consequences

- The JSON Schema, the ProseMirror schema, the types and the attribute table are generated from one definition, and CI checks that the published files equal a fresh generation.
- A validator in another language reproduces the JSON Schema verdicts. A test runs Python's `jsonschema` beside Ajv.
- The hash of the 03 §12 example is pinned and identical in Node.js, Chromium, Firefox, WebKit and Edge.

## Open questions

- `settings.footnoteRestart` keeps the two values written in 03 §4.1, `continuous` and `perPageSection`. The second looks like two values run together (`perPage`, `perSection`); the spec should say.
- Lossless DOCX import (A2, ADR 0017): Word's numbering level text can contain words ("Article %1"), which the template grammar of 03 §4.1 refuses. The grammar must widen before import, with typed emitters keeping LaTeX safe. Spike S11 decides.
- Tab stops cannot clear an inherited stop, which Word files use and which the cascade needs (S11).
- `caption` has no `id` (principle 6), and the `title` field has no data source in the CDM. Both are unchanged here.
- The footnote content model stays `inline*`, as drafted, minus footnotes and form fields, until CDM-001 records the S1 evidence.
