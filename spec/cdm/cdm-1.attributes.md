# CDM 1 attributes (draft)

Generated from `packages/model/src/definition` by `pnpm generate`. Do not edit by hand. The rules behind the values are in docs/adr/0018-cdm-attribute-grammars.md; the canonical form omits every attribute equal to its default (03 §2).

## Features

- `fields`: Fillable fields, role placeholders and rules (12 §3).
- `extensions`: Host-registered extension nodes (13 §7.3).
- `preserve`: Content and properties preserved from an imported Word file (ADR 0017).

## Nodes

### `doc`

The root: definitions, header and footer stories, and the body. (03 §3)

content `defs story* body`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `defs`

Definitions: settings, styles, numbering, page setups, roles, rules, sources and shared preserved trees. Edited through dialogs, never selected. (03 §4.1)

content `settings style_def* numbering_def* page_setup+ role_def* rule_def* source_def* preserved_def*`; isolating; not selectable.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `settings`

Document-wide settings; exactly one. (03 §4.1)

no content; atom; not selectable.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `lang` | string or null | length 0 to 64; pattern `^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}\|[A-Za-z]{4,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}\|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}\|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?\|[Xx](?:-[A-Za-z0-9]{1,8})+)$` | `null` | Document language (BCP 47). |
| `dir` | enumeration | `ltr`, `rtl` | `"ltr"` | Default direction. |
| `defaultTabStop` | integer | 1 to 31680 | `720` | Default tab interval in twips. |
| `hyphenation` | boolean |  | `false` | Automatic hyphenation. |
| `defaultParagraphStyle` | reference (paragraphStyle) | pattern `^[A-Za-z0-9_-]{1,64}$` | `"Normal"` | Style of paragraphs whose `style` is null. |
| `footnoteFormat` | enumeration | `decimal`, `lowerRoman`, `upperRoman`, `lowerLetter`, `upperLetter`, `symbol` | `"decimal"` | Footnote mark format. |
| `footnoteRestart` | enumeration | `continuous`, `perPageSection` | `"continuous"` | Footnote numbering restart (values as written in 03 §4.1; see ADR 0018). |
| `trackChanges` | enumeration | `off`, `everyone` | `"off"` | With `everyone`, rule P4 applies to every user (07 §5.2). |
| `citationStyle` | enumeration | `authorYear`, `numeric` | `"authorYear"` | Citation style of the house class (A3): author and year, or numeric (CDM-052; ADR 0031, proposed). |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `style_def`

A paragraph, character or table style. One attribute per formatting property, so concurrent edits to different properties do not collide. (03 §4.1)

no content; atom; not selectable.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 64; pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Style identifier: a reserved built-in name or a random identifier. |
| `kind` | enumeration | `paragraph`, `character`, `table` | `"paragraph"` | Style kind. |
| `name` | string | length 1 to 255 | `null` | required in a stored document; Human-readable label. |
| `basedOn` | reference (anyStyle) or null | pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | Parent style of the same kind (I4, I5). |
| `next` | reference (paragraphStyle) or null | pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | Style of the paragraph after Enter. |
| `outlineLevel` | integer or null | 1 to 9 | `null` | Heading level; headings are paragraphs whose style has one. |
| `builtIn` | boolean |  | `false` | True for the built-in styles with reserved identifiers. |
| `fontFamily` | string or null | length 0 to 64; pattern `^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$` | `null` | Run property `fontFamily` (03 §4.5). |
| `fontSize` | integer or null | 20 to 32760 | `null` | Run property `fontSize` (03 §4.5). |
| `bold` | boolean or null |  | `null` | Run property `bold` (03 §4.5). |
| `italic` | boolean or null |  | `null` | Run property `italic` (03 §4.5). |
| `underline` | enumeration or null | `single`, `double`, `dotted`, `none` | `null` | Run property `underline` (03 §4.5). |
| `strike` | boolean or null |  | `null` | Run property `strike` (03 §4.5). |
| `smallCaps` | boolean or null |  | `null` | Run property `smallCaps` (03 §4.5). |
| `allCaps` | boolean or null |  | `null` | Run property `allCaps` (03 §4.5). |
| `vertAlign` | enumeration or null | `super`, `sub`, `baseline` | `null` | Run property `vertAlign` (03 §4.5). |
| `color` | string or null | length 0 to 7; pattern `^#[0-9A-F]{6}$` | `null` | Run property `color` (03 §4.5). |
| `highlight` | enumeration or null | `yellow`, `green`, `cyan`, `magenta`, `blue`, `red`, `darkBlue`, `darkCyan`, `darkGreen`, `darkMagenta`, `darkRed`, `darkYellow`, `darkGray`, `lightGray`, `black`, `white` | `null` | Run property `highlight` (03 §4.5). |
| `lang` | string or null | length 0 to 64; pattern `^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}\|[A-Za-z]{4,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}\|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}\|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?\|[Xx](?:-[A-Za-z0-9]{1,8})+)$` | `null` | Run property `lang` (03 §4.5). |
| `hidden` | boolean or null |  | `null` | Run property `hidden` (03 §4.5). |
| `align` | enumeration or null | `start`, `center`, `end`, `justify`, `distribute` | `null` | Alignment, logical (CDM-002). |
| `dir` | enumeration or null | `ltr`, `rtl` | `null` | Paragraph direction. |
| `indentLeft` | integer or null | -31680 to 31680 | `null` | Left indent in twips. |
| `indentRight` | integer or null | -31680 to 31680 | `null` | Right indent in twips. |
| `indentFirstLine` | integer or null | -31680 to 31680 | `null` | First-line indent in twips; negative for a hanging indent. |
| `spaceBefore` | integer or null | 0 to 31680 | `null` | Space before in twips. |
| `spaceAfter` | integer or null | 0 to 31680 | `null` | Space after in twips. |
| `contextualSpacing` | boolean or null |  | `null` | No space between paragraphs of the same style (03 §7). |
| `lineSpacing` | integer or null | 1 to 31680 | `null` | Thousandths of a line under `multiple`; twips under `exact` and `atLeast` (03 §2). |
| `lineRule` | enumeration or null | `multiple`, `exact`, `atLeast` | `null` | How `lineSpacing` is read. |
| `keepNext` | boolean or null |  | `null` | Keep with the next paragraph. |
| `keepLines` | boolean or null |  | `null` | Keep the lines of the paragraph together. |
| `pageBreakBefore` | boolean or null |  | `null` | Start on a new page. |
| `widowControl` | boolean or null |  | `null` | Avoid widows and orphans. |
| `tabs` | array of object or null | 0 to 64 items; items: `position`: integer 0 to 31680; `align`: enumeration `left`, `center`, `right`, `decimal`; `leader`: enumeration `none`, `dot`, `hyphen`, `underscore`, `middleDot`, `heavy` | `null` | Tab stops measured from the left margin (03 §7). |
| `borders` | object or null | `top`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `bottom`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `left`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `right`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `between`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `insideH`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `insideV`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620 | `null` | Paragraph borders, or table borders for table styles; `insideH` and `insideV` only on table styles. |
| `shading` | object or null | `fill`: string length 0 to 7; pattern `^#[0-9A-F]{6}$` | `null` | Paragraph shading. |
| `numbering` | object or null | `numberingId`: reference (numbering) pattern `^[A-Za-z0-9_-]{1,64}$`; `level`: integer 0 to 8; `listId`: string length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | Numbering carried by a paragraph style, which is how headings are numbered. |
| `cellMargins` | object or null | `top`?: integer 0 to 31680; `bottom`?: integer 0 to 31680; `left`?: integer 0 to 31680; `right`?: integer 0 to 31680 | `null` | Table styles only: default cell margins. |
| `headerRowShading` | object or null | `fill`: string length 0 to 7; pattern `^#[0-9A-F]{6}$` | `null` | Table styles only: header row shading. |
| `bandedRows` | boolean or null |  | `null` | Table styles only: banded rows. |
| `preserved` | element tree or null | at most 32768 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `numbering_def`

A numbering definition with one to nine levels. (03 §4.1)

no content; atom; not selectable.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 64; pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Definition identifier. |
| `name` | string or null | length 0 to 255 | `null` | Human-readable label. |
| `levels` | array of object | 1 to 9 items; items: `format`: enumeration `decimal`, `lowerLetter`, `upperLetter`, `lowerRoman`, `upperRoman`, `bullet`, `none`; `text`: string length 0 to 64; pattern `^(?:%[1-9]\|[.()§ -])*$`; `start`: integer 0 to 32767; `restartAfter`?: integer 0 to 8; `legal`?: boolean; `indentLeft`?: integer -31680 to 31680; `hanging`?: integer 0 to 31680; `align`?: enumeration `start`, `center`, `end`; `bulletChar`?: enumeration `•`, `◦`, `▪`, `■`, `□`, `●`, `○`, `–`, `—`, `➢`, `✓`, `♦`, `◆`, `*`, `-`; `runProps`?: object `fontFamily`?: string length 0 to 64; pattern `^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$`; `fontSize`?: integer 20 to 32760; `bold`?: boolean; `italic`?: boolean; `underline`?: enumeration `single`, `double`, `dotted`, `none`; `strike`?: boolean; `smallCaps`?: boolean; `allCaps`?: boolean; `vertAlign`?: enumeration `super`, `sub`, `baseline`; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `highlight`?: enumeration `yellow`, `green`, `cyan`, `magenta`, `blue`, `red`, `darkBlue`, `darkCyan`, `darkGreen`, `darkMagenta`, `darkRed`, `darkYellow`, `darkGray`, `lightGray`, `black`, `white`; `lang`?: string length 0 to 64; pattern `^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}\|[A-Za-z]{4,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}\|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}\|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?\|[Xx](?:-[A-Za-z0-9]{1,8})+)$`; `hidden`?: boolean | `[]` | required in a stored document; Levels 0 to 8, at least one; one attribute, so concurrent edits resolve to the later commit (03 §4.1). |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `page_setup`

Page size, margins, columns and header and footer slots of a page section. (03 §4.1)

no content; atom; not selectable.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 64; pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Definition identifier. |
| `width` | integer | 144 to 31680 | `11906` | Page width in twips (default A4). |
| `height` | integer | 144 to 31680 | `16838` | Page height in twips (default A4). |
| `orientation` | enumeration | `portrait`, `landscape` | `"portrait"` | Orientation. |
| `marginTop` | integer | 0 to 31680 | `1440` | Top margin. |
| `marginRight` | integer | 0 to 31680 | `1440` | Right margin. |
| `marginBottom` | integer | 0 to 31680 | `1440` | Bottom margin. |
| `marginLeft` | integer | 0 to 31680 | `1440` | Left margin. |
| `gutter` | integer | 0 to 31680 | `0` | Gutter. |
| `headerDistance` | integer | 0 to 31680 | `708` | Distance from the top edge to the header. |
| `footerDistance` | integer | 0 to 31680 | `708` | Distance from the bottom edge to the footer. |
| `columns` | integer | 1 to 16 | `1` | Number of text columns. |
| `columnGap` | integer | 0 to 31680 | `720` | Gap between columns. |
| `differentFirstPage` | boolean |  | `false` | Use the first-page header and footer. |
| `differentOddEven` | boolean |  | `false` | Use the even-page header and footer. |
| `headerDefault` | reference (headerStory) or null | pattern `^[A-Za-z0-9_-]{16}$` | `null` | Header story. |
| `headerFirst` | reference (headerStory) or null | pattern `^[A-Za-z0-9_-]{16}$` | `null` | First-page header story. |
| `headerEven` | reference (headerStory) or null | pattern `^[A-Za-z0-9_-]{16}$` | `null` | Even-page header story. |
| `footerDefault` | reference (footerStory) or null | pattern `^[A-Za-z0-9_-]{16}$` | `null` | Footer story. |
| `footerFirst` | reference (footerStory) or null | pattern `^[A-Za-z0-9_-]{16}$` | `null` | First-page footer story. |
| `footerEven` | reference (footerStory) or null | pattern `^[A-Za-z0-9_-]{16}$` | `null` | Even-page footer story. |
| `pageNumberStart` | integer or null | 0 to 32767 | `null` | First page number, or continue. |
| `pageNumberFormat` | enumeration | `decimal`, `lowerRoman`, `upperRoman`, `lowerLetter`, `upperLetter` | `"decimal"` | Page number format. |
| `watermark` | string or null | length 0 to 255 | `null` | Watermark text. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `role_def`

A role placeholder such as "Tenant"; fields and regions are assigned to roles, never to people. (12 §3.1)

no content; atom; not selectable; feature `fields`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 64; pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Role identifier; fields match roles by it alone (I13). |
| `name` | string | length 1 to 255 | `null` | required in a stored document; Role name. |
| `color` | string | length 0 to 7; pattern `^#[0-9A-F]{6}$` | `null` | required in a stored document; Role colour; always shown with an icon, never alone. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `rule_def`

A field rule in the typed JSON rules language (12 §5); the language itself is the rules package (FRW-015). (12 §3.5)

no content; atom; not selectable; feature `fields`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 64; pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Rule identifier. |
| `when` | JSON | at most 16384 bytes, depth 32, integers only | `null` | required in a stored document; Condition (12 §5). |
| `then` | JSON | at most 16384 bytes, depth 32, integers only | `null` | required in a stored document; Effects when the condition holds. |
| `else` | JSON or null | at most 16384 bytes, depth 32, integers only | `null` | Effects otherwise. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `source_def`

A bibliographic source that citations cite; one attribute per CSL variable, so concurrent edits to different variables do not collide. (03 §4.1; CDM-052)

no content; atom; not selectable.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 64; pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Source identifier; also the citation key in LaTeX output. |
| `kind` | enumeration | `article`, `article-journal`, `article-magazine`, `article-newspaper`, `bill`, `book`, `broadcast`, `chapter`, `classic`, `collection`, `dataset`, `document`, `entry`, `entry-dictionary`, `entry-encyclopedia`, `event`, `figure`, `graphic`, `hearing`, `interview`, `legal_case`, `legislation`, `manuscript`, `map`, `motion_picture`, `musical_score`, `pamphlet`, `paper-conference`, `patent`, `performance`, `periodical`, `personal_communication`, `post`, `post-weblog`, `regulation`, `report`, `review`, `review-book`, `software`, `song`, `speech`, `standard`, `thesis`, `treaty`, `webpage` | `"book"` | CSL item type (`type`). |
| `title` | string or null | length 0 to 1024 | `null` | Title (CSL `title`). |
| `authors` | array of object or null | 1 to 100 items; items: `family`?: string length 0 to 255; `given`?: string length 0 to 255; `particle`?: string length 0 to 64; `suffix`?: string length 0 to 64; `literal`?: string length 0 to 255 | `null` | Authors (CSL `author`), in order. |
| `editors` | array of object or null | 1 to 100 items; items: `family`?: string length 0 to 255; `given`?: string length 0 to 255; `particle`?: string length 0 to 64; `suffix`?: string length 0 to 64; `literal`?: string length 0 to 255 | `null` | Editors (CSL `editor`), in order. |
| `issued` | string or null | length 0 to 21; pattern `^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?(?:/[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?)?$` | `null` | Date of publication (CSL `issued`), EDTF level 0. |
| `accessed` | string or null | length 0 to 21; pattern `^[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?(?:/[0-9]{4}(?:-[0-9]{2}(?:-[0-9]{2})?)?)?$` | `null` | Date of access (CSL `accessed`), EDTF level 0. |
| `containerTitle` | string or null | length 0 to 1024 | `null` | Journal, book or site the source appears in (CSL `container-title`). |
| `publisher` | string or null | length 0 to 255 | `null` | Publisher (CSL `publisher`). |
| `publisherPlace` | string or null | length 0 to 255 | `null` | Place of publication (CSL `publisher-place`). |
| `edition` | string or null | length 0 to 64 | `null` | Edition (CSL `edition`). |
| `volume` | string or null | length 0 to 64 | `null` | Volume (CSL `volume`). |
| `issue` | string or null | length 0 to 64 | `null` | Issue (CSL `issue`). |
| `pages` | string or null | length 0 to 64 | `null` | Page range (CSL `page`). |
| `number` | string or null | length 0 to 64 | `null` | Report, patent or standard number (CSL `number`). |
| `doi` | string or null | length 0 to 255; pattern `^10\.[0-9]{4,9}/[!-~]{1,240}$` | `null` | DOI (CSL `DOI`). |
| `url` | string or null | length 0 to 2048; pattern `^https?://[^\s<>"{}\|\\^`]+$` | `null` | URL (CSL `URL`). |
| `isbn` | string or null | length 0 to 32; pattern `^(?:97[89][- ]?)?[0-9][0-9 -]{7,15}[0-9Xx]$` | `null` | ISBN (CSL `ISBN`). |
| `issn` | string or null | length 0 to 16; pattern `^[0-9]{4}-?[0-9]{3}[0-9Xx]$` | `null` | ISSN (CSL `ISSN`). |
| `language` | string or null | length 0 to 64; pattern `^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}\|[A-Za-z]{4,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}\|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}\|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?\|[Xx](?:-[A-Za-z0-9]{1,8})+)$` | `null` | Language of the source (CSL `language`). |
| `note` | string or null | length 0 to 2048 | `null` | Note (CSL `note`). |
| `extra` | JSON object | at most 4096 bytes, depth 4, integers only; keys `^[a-z][a-z0-9-]{0,63}$` | `{}` | Further CSL variables by their CSL names; strings and integers only. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `preserved_def`

A preserved element tree shared by every node and mark that refers to it, kept once (spike S11: without it a large Word document exceeds the canonical size of I7). (03 §4.6; ADR 0017; spike S11)

no content; atom; not selectable; feature `preserve`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 64; pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Identifier that `{ "ref": id }` trees refer to. |
| `tree` | element tree | at most 32768 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces | `null` | required in a stored document; The shared tree; it never refers to another. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `story`

A header or footer, edited in a sub-editor. Its content expression already forbids tables (I10). (03 §4.1)

content `story_block+`; isolating; not selectable; node marks on children: `ins del fmt`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `kind` | enumeration | `header`, `footer` | `"header"` | Header or footer. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `body`

The body. (03 §4.2)

content `(block | region | section_break)+`; node marks on children: `ins del fmt`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `pageSetup` | reference (pageSetup) | pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Page setup of the first page section. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `region`

A permission scope: a direct child of the body, never nested (I3). (03 §4.2)

content `block+`; isolating; node marks on children: `ins del fmt`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Region identifier; never reused once removed (I3). |
| `title` | string or null | length 0 to 255 | `null` | Region title. |
| `policy` | enumeration | `inherit`, `restricted`, `confidential` | `"inherit"` | Permission policy (07 §4); `confidential` also hides the content from readers without a grant (ADR 0019, proposed). |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `section_break`

Starts a new page section; a direct child of the body only. (03 §4.2)

no content; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `pageSetup` | reference (pageSetup) | pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Page setup of the section that follows. |
| `start` | enumeration | `nextPage`, `continuous`, `evenPage`, `oddPage` | `"nextPage"` | Where the new section starts. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `paragraph`

A paragraph; headings and list items are paragraphs. (03 §4.3)

content `inline*`; groups `block story_block cell_block`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `style` | reference (paragraphStyle) or null | pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | Paragraph style; null means the default paragraph style. |
| `numbering` | object or null | `numberingId`: reference (numbering) pattern `^[A-Za-z0-9_-]{1,64}$`; `level`: integer 0 to 8; `listId`: string length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | List membership: definition, level and list instance. |
| `numberingRestart` | integer or null | 0 to 32767 | `null` | Restart the list at this number. |
| `align` | enumeration or null | `start`, `center`, `end`, `justify`, `distribute` | `null` | Alignment, logical (CDM-002). |
| `dir` | enumeration or null | `ltr`, `rtl` | `null` | Paragraph direction. |
| `indentLeft` | integer or null | -31680 to 31680 | `null` | Left indent in twips. |
| `indentRight` | integer or null | -31680 to 31680 | `null` | Right indent in twips. |
| `indentFirstLine` | integer or null | -31680 to 31680 | `null` | First-line indent in twips; negative for a hanging indent. |
| `spaceBefore` | integer or null | 0 to 31680 | `null` | Space before in twips. |
| `spaceAfter` | integer or null | 0 to 31680 | `null` | Space after in twips. |
| `contextualSpacing` | boolean or null |  | `null` | No space between paragraphs of the same style (03 §7). |
| `lineSpacing` | integer or null | 1 to 31680 | `null` | Thousandths of a line under `multiple`; twips under `exact` and `atLeast` (03 §2). |
| `lineRule` | enumeration or null | `multiple`, `exact`, `atLeast` | `null` | How `lineSpacing` is read. |
| `keepNext` | boolean or null |  | `null` | Keep with the next paragraph. |
| `keepLines` | boolean or null |  | `null` | Keep the lines of the paragraph together. |
| `pageBreakBefore` | boolean or null |  | `null` | Start on a new page. |
| `widowControl` | boolean or null |  | `null` | Avoid widows and orphans. |
| `tabs` | array of object or null | 0 to 64 items; items: `position`: integer 0 to 31680; `align`: enumeration `left`, `center`, `right`, `decimal`; `leader`: enumeration `none`, `dot`, `hyphen`, `underscore`, `middleDot`, `heavy` | `null` | Tab stops measured from the left margin (03 §7). |
| `borders` | object or null | `top`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `bottom`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `left`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `right`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `between`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620 | `null` | Paragraph borders. |
| `shading` | object or null | `fill`: string length 0 to 7; pattern `^#[0-9A-F]{6}$` | `null` | Paragraph shading. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `table`

A table; tables do not nest in version 1. (03 §4.3)

content `table_row+`; groups `block`; node marks on children: `ins del fmt`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `style` | reference (tableStyle) or null | pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | Table style. |
| `width` | object or null | `type`: enumeration `auto`, `pct`, `fixed`; `value`: integer 0 to 31680 | `null` | Width: `pct` in hundredths of a percent, `fixed` in twips. |
| `align` | enumeration or null | `start`, `center`, `end` | `null` | Alignment. |
| `grid` | array of integer | 1 to 63 items; items: 0 to 31680 | `null` | required in a stored document; count problems are I7; Column widths in twips (I6); at most 63 columns (I7). |
| `headerRows` | integer | 0 to 32767 | `0` | Rows repeated at the top of each page; at most the number of rows (I6). |
| `borders` | object or null | `top`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `bottom`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `left`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `right`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `insideH`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `insideV`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620 | `null` | Table borders. |
| `cellMargins` | object or null | `top`?: integer 0 to 31680; `bottom`?: integer 0 to 31680; `left`?: integer 0 to 31680; `right`?: integer 0 to 31680 | `null` | Default cell margins. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `table_row`

A table row. (03 §4.3)

content `table_cell+`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `height` | integer or null | 0 to 31680 | `null` | Row height in twips. |
| `heightRule` | enumeration | `auto`, `atLeast`, `exact` | `"auto"` | How `height` applies. |
| `cantSplit` | boolean |  | `false` | Keep the row on one page. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `table_cell`

A table cell. (03 §4.3)

content `cell_block+`; isolating; node marks on children: `ins del fmt`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `colspan` | integer | 1 to 63 | `1` | Columns spanned. |
| `rowspan` | integer | 1 to 32767 | `1` | Rows spanned. |
| `vAlign` | enumeration or null | `top`, `center`, `bottom` | `null` | Vertical alignment. |
| `shading` | object or null | `fill`: string length 0 to 7; pattern `^#[0-9A-F]{6}$` | `null` | Cell shading. |
| `borders` | object or null | `top`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `bottom`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `left`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620; `right`?: object `style`: enumeration `none`, `single`, `double`, `dotted`, `dashed`, `thick`; `width`?: integer 0 to 240; `color`?: string length 0 to 7; pattern `^#[0-9A-F]{6}$`; `space`?: integer 0 to 620 | `null` | Cell borders. |
| `margins` | object or null | `top`?: integer 0 to 31680; `bottom`?: integer 0 to 31680; `left`?: integer 0 to 31680; `right`?: integer 0 to 31680 | `null` | Cell margins. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `figure`

A block picture with an optional caption. (03 §4.3)

content `caption?`; groups `block story_block cell_block`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `asset` | reference (asset) | pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | `null` | required in a stored document; Asset identifier; never embedded data. |
| `width` | integer | 1 to 31680 | `null` | required in a stored document; Display width in twips. |
| `height` | integer | 1 to 31680 | `null` | required in a stored document; Display height in twips. |
| `alt` | string or null | length 0 to 2048 | `null` | Alternative text. |
| `align` | enumeration or null | `start`, `center`, `end` | `null` | Alignment. |
| `placement` | enumeration | `here`, `float` | `"here"` | `float` is not allowed in table cells (I10). |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `caption`

A figure caption; footnotes are not allowed in it (I10). (03 §4.3)

content `caption_inline*`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `equation_block`

Display math, stored as LaTeX. (03 §4.3)

no content; groups `block story_block cell_block`; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `latex` | string | length 0 to 4000 | `""` | length problems are I7; LaTeX source of at most 4,000 characters (I7); passes the math gate (I8). |
| `numbered` | boolean |  | `false` | Numbered equation. |
| `label` | string or null | length 0 to 64; pattern `^[A-Za-z][A-Za-z0-9:_-]{0,63}$` | `null` | Label for cross-references; unique in the document. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `toc`

A table of contents or a list of figures or tables; entries are generated. (03 §4.3)

no content; groups `block story_block`; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `minLevel` | integer | 1 to 9 | `1` | Lowest outline level included; at most `maxLevel`. |
| `maxLevel` | integer | 1 to 9 | `3` | Highest outline level included. |
| `of` | string | length 0 to 32; pattern `^(?:headings\|[A-Za-z][A-Za-z0-9_-]{0,31})$` | `"headings"` | `headings`, or a caption sequence name. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `bibliography`

A bibliography; its entries are generated at layout and export time from the sources. (03 §4.3; CDM-052)

no content; groups `block`; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `include` | enumeration | `cited`, `all` | `"cited"` | `cited` lists the sources the document cites; `all` lists every source. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `extension_block`

A host-registered custom block; it has a fallback picture or text, or both (I12). (03 §4.3; 13 §7.3)

no content; groups `block story_block`; atom; feature `extensions`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `extension` | string | length 0 to 128; pattern `^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$` | `null` | required in a stored document; grammar problems are I12; Extension name. |
| `payload` | JSON or null | at most 16384 bytes, depth 32, integers only | `null` | grammar problems are I12; Extension data, at most 16 KiB (I12); never interpreted by the model. |
| `fallbackAsset` | reference (asset) or null | pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | `null` | grammar problems are I12; Fallback picture. |
| `fallbackText` | string or null | length 0 to 2048 | `null` | grammar problems are I12; Fallback text. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `preserved_block`

Content from an imported file that the model cannot represent; changed only as a whole. (03 §4.6; ADR 0017)

no content; groups `block story_block cell_block`; atom; feature `preserve`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `label` | string | length 1 to 64 | `null` | required in a stored document; Kind of content, for example "chart". |
| `fragment` | reference (asset) | pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | `null` | required in a stored document; Asset holding the original XML and its parts. |
| `fallbackAsset` | reference (asset) or null | pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | `null` | Fallback picture. |
| `fallbackText` | string or null | length 0 to 2048 | `null` | Fallback text. |
| `width` | integer or null | 0 to 31680 | `null` | Display width in twips. |
| `height` | integer or null | 0 to 31680 | `null` | Display height in twips. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `text`

Text; carries marks. (03 §4.4)

no content; groups `inline caption_inline`; inline.

No attributes.

### `image`

An inline picture. (03 §4.4)

no content; groups `inline caption_inline`; inline; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `asset` | reference (asset) | pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | `null` | required in a stored document; Asset identifier; never embedded data. |
| `width` | integer | 1 to 31680 | `null` | required in a stored document; Display width in twips. |
| `height` | integer | 1 to 31680 | `null` | required in a stored document; Display height in twips. |
| `alt` | string or null | length 0 to 2048 | `null` | Alternative text. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `origin` | object or null | `fragment`: reference (asset) pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; `hash`: string length 0 to 64; pattern `^[0-9a-f]{64}$` | `null` | feature `preserve`; The fragment of the imported file this atom came from, and the SHA-256 of its modelled attributes at import (spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `break`

A line, page or column break; page and column breaks are not allowed in cells, captions or footnotes (I10). (03 §4.4)

no content; groups `inline caption_inline`; inline; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `kind` | enumeration | `line`, `page`, `column` | `"line"` | Break kind. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `tab`

A tab character. (03 §4.4)

no content; groups `inline caption_inline`; inline; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `equation`

Inline math, stored as LaTeX. (03 §4.4)

no content; groups `inline caption_inline`; inline; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `latex` | string | length 0 to 4000 | `""` | length problems are I7; LaTeX source of at most 4,000 characters (I7); passes the math gate (I8). |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `origin` | object or null | `fragment`: reference (asset) pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; `hash`: string length 0 to 64; pattern `^[0-9a-f]{64}$` | `null` | feature `preserve`; The fragment of the imported file this atom came from, and the SHA-256 of its modelled attributes at import (spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `footnote`

A footnote: an atom in the flow whose content is paragraphs, exactly one in version 1 (CDM-001). Footnotes, form fields, tables, and page and column breaks are not allowed in it (I10). (03 §4.4; CDM-001)

content `paragraph+`; groups `inline`; inline; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `origin` | object or null | `fragment`: reference (asset) pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; `hash`: string length 0 to 64; pattern `^[0-9a-f]{64}$` | `null` | feature `preserve`; The fragment of the imported file this atom came from, and the SHA-256 of its modelled attributes at import (spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `field`

A computed field. (03 §4.4; 12 §3.4)

no content; groups `inline caption_inline`; inline; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `kind` | enumeration | `page`, `pageCount`, `date`, `title`, `ref`, `styleRef`, `seq`, `formValue` | `"page"` | value `formValue` needs feature `fields`; Field kind; `formValue` belongs to `fields`. |
| `format` | string or null | length 0 to 64; pattern `^[A-Za-z0-9 .,:;/()'-]{1,64}$` | `null` | Display format. |
| `target` | string or null | length 0 to 160; pattern `^(?:bookmark:[A-Za-z_][A-Za-z0-9_]{0,39}\|node:[A-Za-z0-9_-]{16}\|eq:[A-Za-z][A-Za-z0-9:_-]{0,63}\|style:[A-Za-z0-9_-]{1,64}\|field:[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)$` | `null` | What `ref`, `styleRef` and `formValue` point at, in the form of their kind (CDM-002); null for the other kinds. |
| `name` | string or null | length 0 to 32; pattern `^[A-Za-z][A-Za-z0-9_-]{0,31}$` | `null` | Sequence name of a `seq` field (without one it counts in no sequence); null for the other kinds. |
| `cached` | string or null | length 0 to 1024 | `null` | Last computed text for consumers that cannot compute it. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `origin` | object or null | `fragment`: reference (asset) pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; `hash`: string length 0 to 64; pattern `^[0-9a-f]{64}$` | `null` | feature `preserve`; The fragment of the imported file this atom came from, and the SHA-256 of its modelled attributes at import (spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `citation`

A citation of one or more sources; the text is generated at layout and export time from the citation style. (03 §4.4; CDM-052)

no content; groups `inline caption_inline`; inline; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `items` | array of object | 1 to 32 items; items: `source`: reference (source) pattern `^[A-Za-z0-9_-]{1,64}$`; `prefix`?: string length 0 to 255; `suffix`?: string length 0 to 255; `locator`?: string length 0 to 64; `label`?: enumeration `act`, `appendix`, `article-locator`, `book`, `canon`, `chapter`, `column`, `elocation`, `equation`, `figure`, `folio`, `issue`, `line`, `note`, `opus`, `page`, `paragraph`, `part`, `rule`, `scene`, `section`, `sub-verbo`, `supplement`, `table`, `timestamp`, `title-locator`, `verse`, `version`, `volume` | `null` | required in a stored document; The cited sources in order, each with an optional prefix, suffix, locator and locator label (I4). |
| `mode` | enumeration | `normal`, `narrative`, `suppressAuthor` | `"normal"` | `narrative` puts the authors in the text; `suppressAuthor` leaves them out. |
| `cached` | string or null | length 0 to 1024 | `null` | Last generated text, for consumers that cannot generate it. |
| `preserved` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | feature `preserve`; Attributes and child elements of the original Word element that the model does not represent, or a reference to a shared tree in `preserved_def` (ADR 0017, spike S11). |
| `origin` | object or null | `fragment`: reference (asset) pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; `hash`: string length 0 to 64; pattern `^[0-9a-f]{64}$` | `null` | feature `preserve`; The fragment of the imported file this atom came from, and the SHA-256 of its modelled attributes at import (spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `anchor`

A zero-width bookmark. (03 §4.4)

no content; groups `inline caption_inline`; inline; atom.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `name` | string | length 0 to 40; pattern `^[A-Za-z_][A-Za-z0-9_]{0,39}$` | `null` | required in a stored document; Bookmark name; unique in the document. |
| `origin` | object or null | `fragment`: reference (asset) pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`; `hash`: string length 0 to 64; pattern `^[0-9a-f]{64}$` | `null` | feature `preserve`; The fragment of the imported file this atom came from, and the SHA-256 of its modelled attributes at import (spike S11). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `form_field`

A fillable field assigned to a role placeholder; not allowed in headers, footers or footnotes (I10). (12 §3.2)

no content; groups `inline caption_inline`; inline; atom; feature `fields`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Node identifier; never changes once set (I2). |
| `key` | string | length 0 to 128; pattern `^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$` | `null` | required in a stored document; Data label, unique in the document (I13). |
| `kind` | enumeration | `text`, `number`, `date`, `checkbox`, `choice`, `signature`, `initials`, `dateSigned`, `formula` | `"text"` | Field kind. The kind `attachment` is reserved and refused in version 1 (12 §3.2). |
| `label` | string | length 1 to 255 | `null` | required in a stored document; Accessible name and summary text. |
| `assignee` | reference (role) or null | pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | Role placeholder that fills it, or null for a field only authors set (I13). |
| `required` | boolean |  | `false` | Static required flag; rules can also require a field. |
| `readOnly` | boolean |  | `false` | Static read-only flag; rules can also disable a field. |
| `value` | JSON or null | at most 8200 bytes, depth 2, integers only | `null` | grammar problems are I15; Current value, typed by kind; null means empty (12 §3.3; I15). Signature, initials, date-signed and formula values are set only by the server (P8). |
| `default` | JSON or null | at most 8200 bytes, depth 2, integers only | `null` | grammar problems are I15; Default value, typed like `value`. |
| `placeholder` | string or null | length 0 to 255 | `null` | Placeholder text. |
| `options` | array of object or null | 0 to 500 items; items: `id`: string length 0 to 64; pattern `^[A-Za-z0-9_-]{1,64}$`; `label`: string length 1 to 255 | `null` | Choices of a `choice` field; option identifiers are unique within the field. |
| `format` | object or null | `decimals`?: integer 0 to 10; `prefix`?: string length 0 to 16; `suffix`?: string length 0 to 16; `datePattern`?: string length 0 to 32 | `null` | Display format: decimals, prefix, suffix, date pattern. |
| `validation` | object or null | `min`?: string length 0 to 64; pattern `^-?(0\|[1-9][0-9]*)(\.[0-9]+)?$`; `max`?: string length 0 to 64; pattern `^-?(0\|[1-9][0-9]*)(\.[0-9]+)?$`; `minLength`?: integer 0 to 4096; `maxLength`?: integer 0 to 4096; `pattern`?: string length 0 to 256; `preset`?: enumeration `email`, `phone`, `postcode` | `null` | Static validation: decimal bounds, length bounds in Unicode code points, a restricted pattern (12 §5.2) and a preset. |
| `width` | integer or null | 0 to 31680 | `null` | Fixed width in twips, so filling moves no line break. |
| `sensitive` | boolean |  | `false` | When true, the value is readable only by the principals of the read rule (ADR 0019, proposed; FRW-088): every other reader gets the redaction marker in place of `value` and `default`. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `extension_inline`

A host-registered inline atom with a fallback text (I12). (03 §4.4)

no content; groups `inline caption_inline`; inline; atom; feature `extensions`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `extension` | string | length 0 to 128; pattern `^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$` | `null` | required in a stored document; grammar problems are I12; Extension name. |
| `payload` | JSON or null | at most 4096 bytes, depth 16, integers only | `null` | grammar problems are I12; Extension data, at most 4 KiB (CDM-002); never interpreted by the model. |
| `fallbackText` | string or null | length 0 to 2048 | `null` | grammar problems are I12; Fallback text; required in a stored document. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `preserved_inline`

Inline content from an imported file that the model cannot represent; changed only as a whole. It holds a fragment asset, or for a small marker without relationships an element tree (spike S11). (03 §4.6; ADR 0017)

no content; groups `inline caption_inline`; inline; atom; feature `preserve`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `label` | string | length 1 to 64 | `null` | required in a stored document; Kind of content, for example "text box". |
| `fragment` | reference (asset) or null | pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | `null` | Asset holding the original XML and its parts; or null when `tree` holds a small marker. |
| `tree` | element tree or null | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | The original element of a small marker without relationships, such as a bookmark Word alone uses (spike S11). |
| `fallbackAsset` | reference (asset) or null | pattern `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` | `null` | Fallback picture. |
| `fallbackText` | string or null | length 0 to 2048 | `null` | Fallback text. |
| `width` | integer or null | 0 to 31680 | `null` | Display width in twips. |
| `height` | integer or null | 0 to 31680 | `null` | Display height in twips. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

## Marks

In schema order; the order is part of the canonical form.

### `link`

A hyperlink; schemes are restricted (I9). (03 §5)

position 1; not inclusive.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `href` | string | length 0 to 2048; pattern `^(?:https?://[^\s<>"{}\|\\^`]+\|mailto:[^\s<>"]+\|#[A-Za-z0-9_:.-]{1,128})$` | `null` | required in a stored document; pattern problems are I9; http, https, mailto or an in-document target (I9). |
| `title` | string or null | length 0 to 255 | `null` | Title. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `charStyle`

Reference to a character style. (03 §5)

position 2.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `style` | reference (characterStyle) | pattern `^[A-Za-z0-9_-]{1,64}$` | `null` | required in a stored document; Character style identifier. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `bold`

Bold. (03 §5)

position 3.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | boolean |  | `true` | `false` switches the property off where the style switches it on. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `italic`

Italic. (03 §5)

position 4.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | boolean |  | `true` | `false` switches the property off where the style switches it on. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `underline`

Underline. (03 §5)

position 5.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `style` | enumeration | `single`, `double`, `dotted`, `none` | `"single"` | Underline style. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `strike`

Strikethrough. (03 §5)

position 6.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | boolean |  | `true` | `false` switches the property off where the style switches it on. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `smallCaps`

Small capitals. (03 §5)

position 7.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | boolean |  | `true` | `false` switches the property off where the style switches it on. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `allCaps`

All capitals. (03 §5)

position 8.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | boolean |  | `true` | `false` switches the property off where the style switches it on. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `vertAlign`

Superscript or subscript. (03 §5)

position 9.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | enumeration | `super`, `sub`, `baseline` | `null` | required in a stored document; Superscript or subscript. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `fontFamily`

Font family from the manifest. (03 §5)

position 10.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | string | length 0 to 64; pattern `^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$` | `null` | required in a stored document; Font family from the manifest. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `fontSize`

Font size in twips. (03 §5)

position 11.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | integer | 20 to 32760 | `null` | required in a stored document; Font size in twips. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `color`

Text colour. (03 §5)

position 12.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | string | length 0 to 7; pattern `^#[0-9A-F]{6}$` | `null` | required in a stored document; Text colour. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `highlight`

Highlight colour. (03 §5)

position 13.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | enumeration | `yellow`, `green`, `cyan`, `magenta`, `blue`, `red`, `darkBlue`, `darkCyan`, `darkGreen`, `darkMagenta`, `darkRed`, `darkYellow`, `darkGray`, `lightGray`, `black`, `white` | `null` | required in a stored document; Highlight colour. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `lang`

Language of the text. (03 §5)

position 14.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | string | length 0 to 64; pattern `^(?:(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}\|[A-Za-z]{4,8})(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}\|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}\|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?\|[Xx](?:-[A-Za-z0-9]{1,8})+)$` | `null` | required in a stored document; Language of the text. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `hidden`

Hidden text. (03 §5)

position 15.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `value` | boolean |  | `true` | `false` switches the property off where the style switches it on. |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `preserved`

Run properties of the original file that the model does not represent. (03 §4.6; ADR 0017)

position 16; feature `preserve`.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `props` | element tree | at most 16384 bytes, depth 12; names with a registered prefix, or in Clark notation for other namespaces; or `{ "ref": id }` of a shared tree | `null` | required in a stored document; Element tree (ADR 0017). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `ins`

Suggested insertion. (03 §5)

position 17; excludes nothing; not inclusive.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Suggestion identifier; belongs to the user who first used it (P4). |
| `user` | string | length 1 to 255 | `null` | required in a stored document; The suggesting user; must equal the submitting user (P4). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `del`

Suggested deletion; the text stays until accepted. (03 §5)

position 18; excludes nothing; not inclusive.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Suggestion identifier; belongs to the user who first used it (P4). |
| `user` | string | length 1 to 255 | `null` | required in a stored document; The suggesting user; must equal the submitting user (P4). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

### `fmt`

Suggested formatting change. (03 §5)

position 19; excludes nothing; not inclusive.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Suggestion identifier; belongs to the user who first used it (P4). |
| `user` | string | length 1 to 255 | `null` | required in a stored document; The suggesting user; must equal the submitting user (P4). |
| `before` | JSON | at most 4096 bytes, depth 6, integers only | `null` | required in a stored document; Previous state: `{ "marks": [mark JSON], "attrs": { name: value } }` (CDM-002); on a block, `attrs` names only `style`, `align` and `numbering` (CDM-040). |
| `ext` | JSON object | at most 4096 bytes, depth 8, integers only; keys `^[a-z0-9]+(?:[.-][a-z0-9]+)*:[A-Za-z][A-Za-z0-9_-]{0,63}$` | `{}` | Additive attributes under namespaced keys; every reader preserves it unchanged (03 §11.2). |

## Projections

Nodes that only a reader's projection contains (ADR 0019). A stored document or a commit never contains them, and `model.validate()` refuses them (I1). The projection schema is the CDM schema plus these nodes (spec/cdm/cdm-1.projection.json).

### `hidden_region`

Placeholder for a region the reader may not see: a block atom in the body, selectable whole, with no position inside it. Only in projections. (ADR 0019; CDM-053)

in the content of `body`; atom; selectable whole; no position inside it.

| Attribute | Type | Range, length or pattern | Default | Notes |
|---|---|---|---|---|
| `id` | string | length 0 to 16; pattern `^[A-Za-z0-9_-]{16}$` | `null` | required in a stored document; Identifier of the hidden region. |
| `title` | string or null | length 0 to 255 | `null` | Title of the hidden region, or null when the title is hidden too. |
