# CDM 1 writer support (draft)

Generated from `packages/model/src/definition/writer-support.ts` by `pnpm generate`. Do not edit by hand. What the LaTeX (PDF) writer and the DOCX writer do with each construct of the model (03 §10). No construct says "no": a construct enters the model only when LaTeX can typeset it and DOCX can approximate it (03 §1 principle 4). Rows whose source is `proposed` have no row in 03 §10; they are proposed in docs/adr/0031-cdm-1-model-completion.md.

## Nodes

| Construct | LaTeX (PDF) | DOCX | Notes | Source |
|---|---|---|---|---|
| `doc` | Supported | Supported |  | structure |
| `defs` | Supported | Supported |  | structure |
| `settings` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `style_def` | Supported | Supported | LaTeX uses macros generated from the styles. | Named styles, direct formatting, fonts, colours |
| `numbering_def` | Supported | Supported | Literal labels from the shared algorithm. | Multi-level numbering |
| `page_setup` | Partial | Supported |  | Page sections with their own size, orientation and columns |
| `role_def` | Not applicable | Supported | Roles do not print; DOCX keeps assignees in a custom part (12 §12). | Form fields |
| `rule_def` | Not applicable | Supported | Rules do not print; DOCX keeps them in a custom part (12 §12). | Form fields |
| `source_def` | Supported | Partial | LaTeX: biblatex in the house class style chosen by `settings.citationStyle`. DOCX: Word citations and the sources part; Word renders them in its own styles. | proposed (CDM-052) |
| `preserved_def` | Not applicable | Supported | A shared preserved tree prints nothing; the DOCX writer writes it back where it is referred to. | Preserved content (03 §4.6) |
| `story` | Supported | Supported |  | Headers and footers, first and even pages, page fields |
| `body` | Supported | Supported |  | structure |
| `region` | Not applicable | Supported | Not visible in the PDF; content controls plus editable ranges in DOCX (07). | Regions |
| `section_break` | Partial | Supported | Orientation and margin changes force a page break in LaTeX. A `continuous` break that changes margins is reported as unsupported. | Page sections with their own size, orientation and columns |
| `paragraph` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `table` | Partial | Supported | Three table writers in LaTeX (09 §3.2). A row taller than a page is split by the converter at paragraph boundaries. Tables inside multi-column sections, headers and footnotes cannot span pages. | Tables with spans, borders, shading, repeated header rows |
| `table_row` | Partial | Supported | Three table writers in LaTeX (09 §3.2). A row taller than a page is split by the converter at paragraph boundaries. Tables inside multi-column sections, headers and footnotes cannot span pages. | Tables with spans, borders, shading, repeated header rows |
| `table_cell` | Partial | Supported | Three table writers in LaTeX (09 §3.2). A row taller than a page is split by the converter at paragraph boundaries. Tables inside multi-column sections, headers and footnotes cannot span pages. | Tables with spans, borders, shading, repeated header rows |
| `figure` | Supported | Supported |  | Inline images and block figures with captions |
| `caption` | Supported | Supported |  | Inline images and block figures with captions |
| `equation_block` | Supported | Partial | DOCX export converts LaTeX to Office math on the server; unsupported macros fall back to an image. | Math |
| `toc` | Supported | Supported |  | Table of contents, lists of figures and tables, bookmarks, cross-references |
| `bibliography` | Supported | Partial | LaTeX: biblatex in the house class style chosen by `settings.citationStyle`. DOCX: Word citations and the sources part; Word renders them in its own styles. | proposed (CDM-052) |
| `extension_block` | Fallback | Fallback |  | Extension nodes |
| `preserved_block` | Fallback | Supported | The LaTeX writer typesets the fallback; the DOCX writer writes the original back unchanged (A2). | Preserved content (03 §4.6) |
| `text` | Supported | Supported |  | structure |
| `image` | Supported | Supported |  | Inline images and block figures with captions |
| `break` | Supported | Supported |  | proposed |
| `tab` | Partial | Supported | The house class implements tab stops itself; decimal tabs inside justified text are approximate. | Tab stops |
| `equation` | Supported | Partial | DOCX export converts LaTeX to Office math on the server; unsupported macros fall back to an image. | Math |
| `footnote` | Supported | Supported | One paragraph each in version 1. | Footnotes |
| `field` | Supported | Supported | See the support by field kind. | Headers and footers, first and even pages, page fields |
| `citation` | Supported | Partial | LaTeX: biblatex in the house class style chosen by `settings.citationStyle`. DOCX: Word citations and the sources part; Word renders them in its own styles. | proposed (CDM-052) |
| `anchor` | Supported | Supported |  | Table of contents, lists of figures and tables, bookmarks, cross-references |
| `form_field` | Partial | Supported | PDF: values are flattened into the text and tagged with their labels; no live form fields (12 §12). DOCX: content controls with data binding (12 §12). | Form fields |
| `extension_inline` | Fallback | Fallback |  | Extension nodes |
| `preserved_inline` | Fallback | Supported | The LaTeX writer typesets the fallback; the DOCX writer writes the original back unchanged (A2). | Preserved content (03 §4.6) |

## Marks

| Construct | LaTeX (PDF) | DOCX | Notes | Source |
|---|---|---|---|---|
| `link` | Supported | Supported | The URL emitter applies the scheme allow-list again (09 §4). | proposed |
| `charStyle` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `bold` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `italic` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `underline` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `strike` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `smallCaps` | Supported | Supported |  | proposed |
| `allCaps` | Supported | Supported |  | proposed |
| `vertAlign` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `fontFamily` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `fontSize` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `color` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `highlight` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `lang` | Supported | Supported |  | Named styles, direct formatting, fonts, colours |
| `hidden` | Supported | Supported | Hidden text is left out of the PDF. | proposed |
| `preserved` | Fallback | Supported | The LaTeX writer typesets the fallback; the DOCX writer writes the original back unchanged (A2). | Preserved content (03 §4.6) |
| `ins` | Supported | Supported | The PDF writer renders markup or a clean view (09). | Comments and suggestions |
| `del` | Supported | Supported | The PDF writer renders markup or a clean view (09). | Comments and suggestions |
| `fmt` | Supported | Supported | The PDF writer renders markup or a clean view (09). | Comments and suggestions |

## Field kinds

| Construct | LaTeX (PDF) | DOCX | Notes | Source |
|---|---|---|---|---|
| `page` | Supported | Supported | Only the typesetter knows page numbers (03 §7). | Headers and footers, first and even pages, page fields |
| `pageCount` | Supported | Supported |  | Headers and footers, first and even pages, page fields |
| `date` | Supported | Supported | In the time zone of the export job or workflow, never the client's (03 §7). | proposed |
| `title` | Supported | Supported | The title is control-plane metadata (03 §2); the export job supplies it. | proposed |
| `ref` | Supported | Supported | Prints the computed label as literal text (03 §7). | Table of contents, lists of figures and tables, bookmarks, cross-references |
| `styleRef` | Partial | Supported |  | proposed |
| `seq` | Supported | Supported | Prints the computed label as literal text (03 §7). | Table of contents, lists of figures and tables, bookmarks, cross-references |
| `formValue` | Supported | Supported | Prints the value of the target field; nothing when it is empty (FRW-006). | Form fields |

## Page-setup features

| Construct | LaTeX (PDF) | DOCX | Notes | Source |
|---|---|---|---|---|
| `size` (`width`, `height`) | Partial | Supported | A change of size at a section break forces a page break in LaTeX. | Page sections with their own size, orientation and columns |
| `orientation` (`orientation`) | Partial | Supported | Orientation changes force a page break in LaTeX. | Page sections with their own size, orientation and columns |
| `margins` (`marginTop`, `marginRight`, `marginBottom`, `marginLeft`) | Partial | Supported | Margin changes force a page break in LaTeX. A `continuous` break that changes margins is reported as unsupported. | Page sections with their own size, orientation and columns |
| `gutter` (`gutter`) | Supported | Supported |  | proposed |
| `headerFooterDistance` (`headerDistance`, `footerDistance`) | Supported | Supported |  | Headers and footers, first and even pages, page fields |
| `columns` (`columns`, `columnGap`) | Partial | Supported | Tables inside multi-column sections cannot span pages. | Page sections with their own size, orientation and columns |
| `differentFirstPage` (`differentFirstPage`) | Supported | Supported |  | Headers and footers, first and even pages, page fields |
| `differentOddEven` (`differentOddEven`) | Supported | Supported |  | Headers and footers, first and even pages, page fields |
| `headerFooterStories` (`headerDefault`, `headerFirst`, `headerEven`, `footerDefault`, `footerFirst`, `footerEven`) | Supported | Supported |  | Headers and footers, first and even pages, page fields |
| `pageNumbering` (`pageNumberStart`, `pageNumberFormat`) | Supported | Supported |  | proposed |
| `watermark` (`watermark`) | Supported | Supported |  | proposed |
