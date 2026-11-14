# S11 corpus: sources and licences

The real Word files that spike S11 (SPK-028) imports and exports. Every file here was checked for its licence at its source and for its content: files holding real-world third-party text or people's personal data were left out even when their licence allowed them (see "Candidates left out").

The SHA-256 column gives the first 16 hexadecimal digits of the file's hash, so that a copy can be checked against its source. "Generator" is what `docProps/app.xml` names; "not stated" means the package has no application name. The features column was produced by scanning the package parts.

All files were downloaded on 2026-11-06 from the repositories' raw-file URLs at the commits named below.

## Apache POI (`poi/`)

- **Repository:** https://github.com/apache/poi, commit `39edce935ef8ed746b4457062ecfa2670eabe49f` (2026-11-05), directory `test-data/document/`.
- **Licence:** Apache License 2.0. The repository's `legal/LICENSE` is the Apache License 2.0, and its sub-component list names no exception for `test-data/`. The test documents are contributions to the Apache POI work under section 5 of the licence. `legal/NOTICE` reads in part: "Apache POI. Copyright 2003-2026 The Apache Software Foundation. This product includes software developed at The Apache Software Foundation (https://www.apache.org/)." Redistribution keeps that notice; this file is where it is kept.
- The file names are POI's own; the path in the repository is `test-data/document/<file>`.

| File | Bytes | SHA-256 | Generator | Features |
|---|---|---|---|---|
| `58618.docx` | 10,045 | `393ac2f66113a3a8` | Microsoft Office Word 12.0000 | hyperlinks |
| `60316.docx` | 48,142 | `0bfd17f6ccbf1d41` | Microsoft Office Word 16.0000 | text boxes, shapes, content controls, complex fields |
| `61470.docx` | 12,523 | `abda850b3685027e` | Microsoft Office Word 16.0000 | text boxes (Japanese ruby text) |
| `61745.docx` | 37,030 | `ec54badce04b9fc3` | Microsoft Office Word 15.0000 | charts, embedded objects, stored entries |
| `Bug54771a.docx` | 44,431 | `e9f466580cd26098` | Microsoft Macintosh Word 14.0000 | content controls, complex fields, text effects, stored entries |
| `Bug54849.docx` | 27,566 | `f54182713ea5ce5d` | Microsoft Office Word 14.0000 | content controls, footnotes, endnotes |
| `Bug55142.docx` | 22,586 | `69828bfe8887125d` | Microsoft Office Word 14.0000 | content controls |
| `Bug60337.docx` | 13,463 | `87f983bdd93b3b5b` | Microsoft Office Word 14.0000 | tables |
| `ComplexNumberedLists.docx` | 14,458 | `297a085a7d433af2` | Microsoft Office Word 14.0000 | numbering |
| `DiffFirstPageHeadFoot.docx` | 14,204 | `e94332c7b86b1bbc` | Microsoft Office Word 12.0000 | first-page headers and footers |
| `EmbeddedDocument.docx` | 13,268 | `3cb521da0faab3b8` | Microsoft Office Word 12.0000 | shapes, embedded objects, data descriptors |
| `FieldCodes.docx` | 17,034 | `9247f85ab90b15f1` | Microsoft Office Word 14.0000 | complex fields |
| `FldSimple.docx` | 12,837 | `6cf7364676d465e7` | Microsoft Office Word 14.0000 | simple fields |
| `MultipleBodyBug.docx` | 102,103 | `7b34a3e9458daa3c` | Microsoft Office Word 14.0000 | complex fields |
| `Numbering.docx` | 13,808 | `776a59dcf0e290f1` | Microsoft Office Word 15.0000 | numbering |
| `PageSpecificHeadFoot.docx` | 22,994 | `90bb8251b18c9f94` | Microsoft Office Word 12.0000 | content controls, simple fields, headers and footers |
| `Styles.docx` | 10,905 | `63f3fe4c3b4fbdc2` | Microsoft Office Word 12.0000 | styles |
| `TestDocument.docx` | 10,861 | `527a906b3cc31d0a` | Microsoft Office Word 12.0000 | hyperlinks, run formatting |
| `VariousPictures.docx` | 103,677 | `c1eecbca7de9f99e` | Microsoft Office Word 12.0000 | pictures (JPEG, PNG, WMF, EMF, PICT), stored entries |
| `WithTabs.docx` | 14,190 | `c6460c33b3343b06` | Microsoft Office Word 14.0000 | tabs |
| `WordWithAttachments.docx` | 144,959 | `90352263823e6d3d` | Microsoft Office Word 12.0000 | text boxes, shapes, embedded objects, comments, complex fields, hyperlinks |
| `bookmarks.docx` | 10,405 | `9b93eef9e2ce1ad0` | Microsoft Office Word 12.0000 | bookmarks |
| `bug65738.docx` | 13,436 | `67797f5691cb5346` | Microsoft Office Word 12.0000 | nested tables, hyperlinks, stored entries |
| `chartex.docx` | 133,304 | `5d7f0ca9aa26d024` | Microsoft Office Word 16.0000 | charts and chartex charts, embedded objects, pictures, stored entries |
| `checkboxes.docx` | 20,800 | `06f1dc1370c772a0` | Microsoft Office Word 12.0000 | complex fields, legacy form fields |
| `comment.docx` | 4,926 | `23bbfe33e1acf707` | LibreOffice 6.0.7.3 | comments, data descriptors |
| `deep-table-cell.docx` | 17,198 | `31c5bfe1f68c9869` | not stated | 5,000 nested tables: a hostile file from POI's fuzzing tests, kept for robustness, not a real Word file |
| `delins.docx` | 17,720 | `7ecad102602586be` | Microsoft Office Word 12.0000 | tracked changes, complex fields, hyperlinks |
| `endnotes.docx` | 13,553 | `6e2e1b2dabb0ae6b` | Microsoft Office Word 12.0000 | endnotes |
| `footnotes.docx` | 12,823 | `9070094b27ff5201` | Microsoft Office Word 12.0000 | footnotes |
| `headerFooter.docx` | 28,423 | `0ad90c6ee8ec8b9f` | Microsoft Macintosh Word 12.0000 | headers and footers, stored entries |
| `heading123.docx` | 74,810 | `dac67500b9078110` | Microsoft Macintosh Word 12.0000 | headings, stored entries |
| `sample.docx` | 14,860 | `be4fc1bf778ad818` | Microsoft Office Word 12.0000 | headers and footers |
| `shapes-with-text.docx` | 27,520 | `1ef4d8cbfd5e2333` | Microsoft Office Word 16.0000 | text boxes, shapes |
| `table-alignment.docx` | 15,519 | `ee36729e0d050e52` | Microsoft Office Word 16.0000 | tables, stored entries |
| `table_footnotes.docx` | 13,177 | `69666500a7dd0060` | Microsoft Office Word 12.0000 | footnotes in tables |
| `testComment.docx` | 65,298 | `06b63b13f0b78a71` | Microsoft Office Word 16.0000 | comments, stored entries |

## docx4j (`docx4j/`)

- **Repository:** https://github.com/plutext/docx4j, commit `f960df59ef49f0d0a81f2ad7383b7dfaad14c46b` (2026-11-06, default branch `VERSION_17_3_6`).
- **Licence:** Apache License 2.0 (`legals/LICENSE`). `legals/NOTICE` begins: "docx4j. Copyright 2007-2025 Plutext Pty Ltd"; none of its exceptions covers the sample documents. Several files (the `cr043`, `cr068`, `review-for-word` and `76t52` families) were built by docx4j's own test builders and then edited or saved by Word, as their text says.
- Spaces in two file names were replaced with hyphens.

| File | Path in the repository | Bytes | SHA-256 | Generator | Features |
|---|---|---|---|---|---|
| `2010-mcAlternateContent.docx` | `docx4j-samples-docx4j/sample-docs/2010/` | 14,501 | `0f91c3125d9a9c7a` | Microsoft Office Word 12.0000 | shapes, comments, alternate content |
| `2016_image_with_text_effects.docx` | `docx4j-samples-docx4j/sample-docs/2016/` | 60,991 | `820a2ae3118f9a2d` | Microsoft Office Word 16.0000 | pictures with effects, stored entries |
| `76t52-round-8-control-word365.docx` | `docx4j-core-tests/src/test/resources/unknown-elements/` | 13,773 | `7cde70ce5419a485` | Microsoft Office Word 16.0000 | content controls, tracked changes, 2 sections, hyperlinks |
| `DrawingML_GraphicData_wps.docx` | `docx4j-samples-docx4j/sample-docs/2010/` | 32,032 | `8ae530b3462293b6` | Microsoft Office Word 16.0000 | text boxes, shapes, text effects, stored entries |
| `LegacyForms.docx` | `docx4j-core-tests/src/test/resources/` | 27,274 | `d482ac9efc23413e` | Microsoft Office Word 14.0000 | shapes, embedded objects (ActiveX), complex fields, legacy form fields |
| `binding-simple.docx` | `docx4j-samples-docx4j/sample-docs/databinding/` | 22,700 | `e656e6a889a9576a` | Microsoft Office Word 14.0000 | data-bound content controls, custom XML |
| `chart.docx` | `docx4j-samples-docx4j/sample-docs/` | 24,067 | `85ba6d56dc8484a0` | Microsoft Office Word 14.0000 | charts, embedded objects, stored entries |
| `comment-cards.docx` | `docx4j-core-tests/src/test/resources/revisions/cr068/` | 9,243 | `b13a97fc174c69c9` | not stated (built by docx4j) | tracked changes, comments |
| `cr043-tracked.docx` | `docx4j-core-tests/src/test/resources/revisions/cr043/` | 44,084 | `d09ba0adb56d9222` | Microsoft Office Word 16.0000 | text boxes, shapes, content controls, tracked changes including moves, comments, complex fields, 4 sections, endnotes, pictures, stored entries |
| `create-new-bitmap.docx` | `docx4j-core-tests/src/test/resources/OLE/create new bitmap.docx` | 18,568 | `49bbd8995906644b` | Microsoft Office Word 16.0000 | shapes, embedded objects |
| `equation-sample.docx` | `docx4j-export-fo-tests/src/test/resources/math/` | 13,502 | `8f703c651f33ea31` | Microsoft Office Word 14.0000 | Office math, text effects |
| `hyperlinks-internal.docx` | `docx4j-samples-docx4j/sample-docs/` | 13,972 | `e06670ede7135c32` | Microsoft Office Word 14.0000 | complex fields, internal hyperlinks |
| `inserted-doc.docx` | `docx4j-core-tests/src/test/resources/OLE/inserted doc.docx` | 23,772 | `6d6953c9a895933a` | Microsoft Office Word 16.0000 | shapes, embedded Word document |
| `mc-txbx-block-word365.docx` | `docx4j-core-tests/src/test/resources/mc-fun/` | 15,460 | `8401f35c26621f1c` | Microsoft Office Word 16.0000 | text boxes, shapes |
| `review-for-word-word2010.docx` | `docx4j-core-tests/src/test/resources/revisions/editor/review/` | 22,302 | `5bf3415e1ab4ea0f` | Microsoft Office Word 14.0000 | tracked changes, comments, complex fields, footnotes |
| `sample-docx.docx` | `docx4j-samples-docx4j/sample-docs/` | 142,893 | `f527fe32f4bf9e15` | Microsoft Office Word 14.0000 | docx4j's feature sample: tables, tracked changes, pictures, hyperlinks, stored entries |
| `sections_multiple.docx` | `docx4j-core-tests/src/test/resources/headers_footers/` | 20,525 | `e013190a08487720` | Microsoft Office Word 14.0000 | 2 sections |
| `tables.docx` | `docx4j-samples-docx4j/sample-docs/` | 433,587 | `50ea2fd62761aedc` | Microsoft Office Word 14.0000 | table features, pictures, stored entries |
| `textbox.docx` | `docx4j-core-tests/src/test/resources/vml/` | 58,948 | `11e16acb10335f77` | Microsoft Office Word 14.0000 | VML text boxes, shapes |
| `textbox_alternates_contrived.docx` | `docx4j-samples-docx-export-fo/sample-docs/word/` | 14,830 | `bdc80be35bfcd38e` | Microsoft Office Word 15.0000 | text boxes, shapes |
| `tracked-changes-equations.docx` | `docx4j-core-tests/src/test/resources/` | 17,241 | `bb9e7b6325ce5fa8` | Microsoft Office Word 16.0000 | tracked changes, Office math |
| `w14_texteffects.docx` | `docx4j-samples-docx4j/sample-docs/2010/` | 20,348 | `61892c44d892a47d` | Microsoft Office Word 14.0000 | text effects |
| `waterfall.docx` | `docx4j-core-tests/src/test/resources/charts/` | 33,148 | `34201b81f80ea345` | Microsoft Office Word 16.0000 | chartex chart, embedded objects, pictures, stored entries |

## python-docx (`python-docx/`)

- **Repository:** https://github.com/python-openxml/python-docx, commit `e45454602b53e8e572b179ccf1c91093ec9f4ed7` (2025-06-16), directory `features/steps/test_files/`.
- **Licence:** MIT. The notice the licence asks to keep with copies:

> The MIT License (MIT)
> Copyright (c) 2013 Steve Canny, https://github.com/scanny
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

| File | Bytes | SHA-256 | Generator | Features |
|---|---|---|---|---|
| `blk-containing-table.docx` | 25,142 | `5e036b49ff8d24f9` | Microsoft Macintosh Word 14.0000 | tables, stored entries |
| `blk-paras-and-tables.docx` | 15,649 | `93f40c8a23dbcbc7` | Microsoft Office Word 16.0000 | nested tables |
| `comments-rich-para.docx` | 20,023 | `8ee6b9bd84c59169` | Microsoft Office Word 16.0000 | comments, stored entries |
| `doc-access-sections.docx` | 25,591 | `871f058319e155fa` | Microsoft Macintosh Word 14.0000 | 3 sections, stored entries |
| `doc-odd-even-hdrs.docx` | 17,711 | `2c29ec565cc97174` | Microsoft Office Word 16.0000 | odd and even headers |
| `hdr-header-footer.docx` | 18,079 | `5a4cb270680d1365` | Microsoft Office Word 16.0000 | 2 sections, headers and footers |
| `num-having-numbering-part.docx` | 24,334 | `66b45ace7afa65ac` | Microsoft Macintosh Word 14.0000 | numbering, stored entries |
| `par-hyperlinks.docx` | 12,385 | `206539619eb347b1` | Microsoft Office Word 16.0000 | hyperlinks |
| `par-known-styles.docx` | 20,901 | `0a2155da9b7eb69a` | Microsoft Macintosh Word 14.0000 | styles; XML declarations with single quotes |
| `par-rendered-page-breaks.docx` | 12,244 | `a87b16cbd3b86bda` | Microsoft Office Word 16.0000 | last-rendered page breaks, hyperlinks |
| `run-char-style.docx` | 26,645 | `cd647c103be2a6f6` | Microsoft Macintosh Word 14.0000 | character styles, stored entries |
| `sct-section-props.docx` | 28,168 | `0d741b9f881f3a15` | Microsoft Macintosh Word 14.0000 | 5 sections, stored entries |
| `shp-inline-shape-access.docx` | 122,610 | `8fcf0f0433be0968` | Microsoft Macintosh Word 14.0000 | charts, SmartArt, embedded objects, pictures, stored entries |
| `tab-stops.docx` | 13,170 | `cf1ab27e6cf523b5` | Microsoft Macintosh Word 14.0000 | tab stops |
| `tbl-cell-access.docx` | 36,051 | `dc01708a24c5e940` | Microsoft Macintosh Word 14.0000 | merged cells, stored entries |
| `tbl-cell-props.docx` | 13,773 | `612ab03dfde00158` | Microsoft Macintosh Word 14.0000 | cell properties; XML declarations with single quotes |
| `tbl-having-tables.docx` | 32,010 | `5e23ecb6ec09b5db` | Microsoft Macintosh Word 14.0000 | tables, stored entries |
| `txt-font-props.docx` | 37,924 | `a5de256a9cd1598d` | Microsoft Macintosh Word 14.0000 | run formatting, stored entries |

## Candidates left out

Downloaded and tested (they pass R0 too), but not committed:

| Source | Files | Why |
|---|---|---|
| Apache POI | `60329.docx`, `Bug51170.docx`, `bug57031.docx`, `bug59058.docx`, `bug65649.docx`, `drawing.docx`, `form_footnotes.docx`, `IllustrativeCases.docx` | Real-world documents attached to bug reports: a clinical study protocol, an association's statutes, homework and a statistics report with people's names, a public contract with officials' names, press monitoring, a consular form, a tax publication. The repository's licence covers them as distributed, but their content belongs to third parties and some of it is personal data |
| Apache POI | `smarttag-snippet.docx`, `rtl.docx` | Text copied from third-party web pages (one from Wikipedia, under CC BY-SA) |
| docx4j | `toc.docx` | Holds the full text of a United Nations General Assembly resolution; the Word-authored files below cover a table of contents instead |
| docx4j | `Creating SmartArt with docx4j.docx` and others | Not needed: covered by other files |

`bug65649.docx` (474,844 bytes; `document.xml` 12.6 MB uncompressed) is still used in the S11 report as a measurement of size and time on a large file, by its public URL.

## Word-authored files: not built

`scripts/make-word-corpus.ps1` adds a table of contents, fields, cross-references, comments with replies, tracked changes, text boxes, shapes, SmartArt, pictures, Office math, nested tables, content controls, sections and notes with the installed Word, through COM, and scrubs the author's name from the saved packages. On the spike machine Word added every feature but then blocked inside `SaveAs2` without showing a prompt, so no Word-authored file is committed. The committed corpus therefore has no table of contents field; the S11 report lists that gap.
